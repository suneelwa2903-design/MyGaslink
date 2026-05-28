/**
 * WI-4 — Stock Mismatch Records (Report Mismatch + Mismatch Log).
 *
 * One submission = one logical "report" = N rows in stock_mismatch_records
 * sharing a reportId UUID. The denormalized shape lets each row be
 * independently filterable by cylinder / mismatchType / status in the log
 * UI; the grouping reportId is only there so the consumer can collapse a
 * single submission visually if desired.
 *
 * createMismatchReport additionally:
 *   • Posts an inventory event that CLEARS the gap immediately (per-line):
 *       - empties_short  → reconciliation_empties_return with
 *                          emptiesChange = +qty
 *       - fulls_short    → cancellation_return with
 *                          fullsChange = +qty
 *   • Creates one STOCK_MISMATCH pending action carrying the full
 *     structured payload (not the legacy generic "Stock mismatch detected"
 *     string), so the PA detail page can render the breakdown.
 *   • Recomputes the daily summary for every affected cylinder type so
 *     "Empties on Vehicle" / "Fulls on Vehicle" clears in the same
 *     request.
 *
 * Cross-tenant: every read/write filters by distributorId per the
 * platform's single-DB multi-tenant rules.
 */
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { toNum } from '../utils/decimal.js';
import { createInventoryEvent, recalculateSummariesFromDate } from './inventoryService.js';
import { aggregateActiveTripCollections } from './deliveryWorkflowService.js';

export class StockMismatchError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface MismatchLineInput {
  mismatchType: 'empties_short' | 'fulls_short' | 'both';
  cylinderTypeId: string;
  qtyUnaccounted: number;
  unitAmount: number;     // empty-deposit price (empties_short) or cylinder+deposit (fulls_short)
  totalAmount: number;    // qty × unitAmount (recomputed server-side for safety)
}

export interface CreateMismatchReportInput {
  vehicleId: string;
  tripDate: string;       // ISO yyyy-mm-dd
  accountableParty: 'driver' | 'customer';
  driverId?: string;
  customerId?: string;
  resolutionAction: 'write_off' | 'settle_against_due';
  resolutionNotes: string;
  lines: MismatchLineInput[];
}

interface MismatchReportRow {
  recordId: string;
  reportId: string;
  vehicleId: string;
  vehicleNumber: string;
  driverId: string | null;
  customerId: string | null;
  tripDate: string;
  mismatchType: 'empties_short' | 'fulls_short' | 'both';
  cylinderTypeId: string;
  cylinderTypeName: string;
  qtyUnaccounted: number;
  unitAmount: number;
  totalAmount: number;
  accountableParty: 'driver' | 'customer';
  resolutionAction: 'write_off' | 'settle_against_due';
  resolutionNotes: string;
  status: 'open' | 'resolved';
  resolvedAt: Date | null;
  resolvedBy: string | null;
  createdBy: string;
  createdAt: Date;
}

export async function createMismatchReport(
  distributorId: string,
  userId: string,
  data: CreateMismatchReportInput,
): Promise<{ reportId: string; rows: MismatchReportRow[] }> {
  // ── Validation ────────────────────────────────────────────────────────────
  if (!data.vehicleId) throw new StockMismatchError('vehicleId is required');
  if (!data.accountableParty) {
    throw new StockMismatchError('Accountable party is required');
  }
  if (data.accountableParty === 'driver' && !data.driverId) {
    throw new StockMismatchError('driverId is required when accountableParty is driver');
  }
  if (data.accountableParty === 'customer' && !data.customerId) {
    throw new StockMismatchError('customerId is required when accountableParty is customer');
  }
  if (!data.resolutionNotes?.trim()) {
    throw new StockMismatchError('Resolution notes are required');
  }
  if (!Array.isArray(data.lines) || data.lines.length === 0) {
    throw new StockMismatchError('At least one mismatch line is required');
  }
  for (const line of data.lines) {
    if (!Number.isInteger(line.qtyUnaccounted) || line.qtyUnaccounted <= 0) {
      throw new StockMismatchError('qtyUnaccounted must be a positive integer');
    }
    if (line.unitAmount < 0 || line.totalAmount < 0) {
      throw new StockMismatchError('unitAmount and totalAmount must be non-negative');
    }
  }

  // ── Tenant scope: vehicle must belong to this distributor ─────────────────
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: data.vehicleId, distributorId, deletedAt: null },
    select: { id: true, vehicleNumber: true },
  });
  if (!vehicle) throw new StockMismatchError('Vehicle not found', 404);

  // ── "Actual gap" guard per line ───────────────────────────────────────────
  // - empties_short: bounded by collected-empties on this vehicle's active
  //   trip (aggregateActiveTripCollections).
  // - fulls_short: bounded by on-vehicle cancelled-stock for this cylinder.
  const { collectedByType } = await aggregateActiveTripCollections(
    data.vehicleId, distributorId, vehicle.vehicleNumber,
  );
  const cseRows = await prisma.cancelledStockEvent.groupBy({
    by: ['cylinderTypeId'],
    where: { vehicleId: data.vehicleId, distributorId, status: 'on_vehicle' },
    _sum: { quantity: true },
  });
  const fullsOnVehicleByType = new Map(
    cseRows.map((r) => [r.cylinderTypeId, r._sum.quantity ?? 0]),
  );

  for (const line of data.lines) {
    if (line.mismatchType === 'empties_short' || line.mismatchType === 'both') {
      const gap = collectedByType.get(line.cylinderTypeId) ?? 0;
      if (line.qtyUnaccounted > gap) {
        throw new StockMismatchError(
          `qtyUnaccounted (${line.qtyUnaccounted}) exceeds actual empties gap (${gap}) for the selected cylinder type`,
        );
      }
    }
    if (line.mismatchType === 'fulls_short' || line.mismatchType === 'both') {
      const gap = fullsOnVehicleByType.get(line.cylinderTypeId) ?? 0;
      if (line.qtyUnaccounted > gap) {
        throw new StockMismatchError(
          `qtyUnaccounted (${line.qtyUnaccounted}) exceeds actual fulls gap (${gap}) for the selected cylinder type`,
        );
      }
    }
  }

  // ── Persist + post inventory-clearing events in a transaction ─────────────
  const reportId = randomUUID();
  const tripDate = new Date(data.tripDate);
  const affectedCylinderTypeIds = new Set<string>();

  const insertedIds: string[] = await prisma.$transaction(async (tx) => {
    const ids: string[] = [];
    for (const line of data.lines) {
      const id = randomUUID();
      ids.push(id);
      const computedTotal = Math.round(line.qtyUnaccounted * line.unitAmount * 100) / 100;
      await tx.stockMismatchRecord.create({
        data: {
          id,
          reportId,
          distributorId,
          vehicleId: data.vehicleId,
          vehicleNumber: vehicle.vehicleNumber,
          driverId: data.driverId ?? null,
          customerId: data.customerId ?? null,
          tripDate,
          mismatchType: line.mismatchType,
          cylinderTypeId: line.cylinderTypeId,
          qtyUnaccounted: line.qtyUnaccounted,
          unitAmount: line.unitAmount,
          totalAmount: computedTotal,
          accountableParty: data.accountableParty,
          resolutionAction: data.resolutionAction,
          resolutionNotes: data.resolutionNotes,
          // Write-off resolutions clear inventory + close the record in the
          // same request; settle_against_due leaves the record open so
          // Finance can mark it resolved when the payment lands.
          status: data.resolutionAction === 'write_off' ? 'resolved' : 'open',
          resolvedAt: data.resolutionAction === 'write_off' ? new Date() : null,
          resolvedBy: data.resolutionAction === 'write_off' ? userId : null,
          createdBy: userId,
        },
      });

      // Post the inventory event that CLEARS the gap. We post both events
      // when mismatchType is 'both'.
      if (line.mismatchType === 'empties_short' || line.mismatchType === 'both') {
        await createInventoryEvent(tx, {
          distributorId,
          cylinderTypeId: line.cylinderTypeId,
          eventType: 'reconciliation_empties_return',
          fullsChange: 0,
          emptiesChange: line.qtyUnaccounted,
          eventDate: tripDate,
          referenceId: id,
          referenceType: 'stock_mismatch_record',
          createdBy: userId,
          notes: `Mismatch write-off (empties): ${data.resolutionNotes}`,
        });
        affectedCylinderTypeIds.add(line.cylinderTypeId);
      }
      if (line.mismatchType === 'fulls_short' || line.mismatchType === 'both') {
        await createInventoryEvent(tx, {
          distributorId,
          cylinderTypeId: line.cylinderTypeId,
          eventType: 'cancellation_return',
          fullsChange: line.qtyUnaccounted,
          emptiesChange: 0,
          eventDate: tripDate,
          referenceId: id,
          referenceType: 'stock_mismatch_record',
          createdBy: userId,
          notes: `Mismatch write-off (fulls): ${data.resolutionNotes}`,
        });
        affectedCylinderTypeIds.add(line.cylinderTypeId);
      }
    }

    // Structured STOCK_MISMATCH pending action (one per report, not per
    // line). Per anti-pattern #9 the description is structured JSON so the
    // PA detail page can render a real breakdown — the legacy generic
    // "Physical stock mismatch on vehicle X" string is replaced.
    const lineSummary = data.lines.map((l) =>
      `${l.mismatchType}:${l.qtyUnaccounted}×₹${l.unitAmount}`
    ).join(' | ');
    await tx.pendingAction.create({
      data: {
        distributorId,
        module: 'inventory',
        actionType: 'STOCK_MISMATCH',
        entityId: data.vehicleId,
        entityType: 'vehicle',
        description: `Vehicle ${vehicle.vehicleNumber} mismatch — ${lineSummary} — accountable: ${data.accountableParty} — resolution: ${data.resolutionAction}`,
        severity: 'high',
        status: data.resolutionAction === 'write_off' ? 'resolved' : 'open',
        resolvedAt: data.resolutionAction === 'write_off' ? new Date() : null,
        resolutionNotes: data.resolutionAction === 'write_off' ? data.resolutionNotes : null,
      },
    });

    return ids;
  });

  // Summary recompute happens AFTER the transaction commits — same
  // pattern as the other inventory writers (recalculateSummariesFromDate
  // uses the global prisma client and can't see uncommitted tx writes).
  for (const ctId of affectedCylinderTypeIds) {
    await recalculateSummariesFromDate(distributorId, ctId, tripDate);
  }

  // Read back the inserted rows with the cylinder-type name hydrated so
  // the caller can render the log immediately.
  const rowsFromDb = await prisma.stockMismatchRecord.findMany({
    where: { id: { in: insertedIds } },
    include: { cylinderType: { select: { typeName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const rows: MismatchReportRow[] = rowsFromDb.map((r) => ({
    recordId: r.id,
    reportId: r.reportId,
    vehicleId: r.vehicleId,
    vehicleNumber: r.vehicleNumber,
    driverId: r.driverId,
    customerId: r.customerId,
    tripDate: r.tripDate.toISOString().slice(0, 10),
    mismatchType: r.mismatchType,
    cylinderTypeId: r.cylinderTypeId,
    cylinderTypeName: r.cylinderType?.typeName ?? '—',
    qtyUnaccounted: r.qtyUnaccounted,
    unitAmount: toNum(r.unitAmount),
    totalAmount: toNum(r.totalAmount),
    accountableParty: r.accountableParty,
    resolutionAction: r.resolutionAction,
    resolutionNotes: r.resolutionNotes,
    status: r.status,
    resolvedAt: r.resolvedAt,
    resolvedBy: r.resolvedBy,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  }));

  return { reportId, rows };
}

// ─── Mismatch Log query ──────────────────────────────────────────────────────

export async function listMismatchReports(
  distributorId: string,
  filters: {
    vehicleId?: string;
    driverId?: string;
    customerId?: string;
    status?: 'open' | 'resolved';
    mismatchType?: 'empties_short' | 'fulls_short' | 'both';
    dateFrom?: string;
    dateTo?: string;
    page?: number;
    pageSize?: number;
  },
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50));

  const where: Prisma.StockMismatchRecordWhereInput = { distributorId };
  if (filters.vehicleId) where.vehicleId = filters.vehicleId;
  if (filters.driverId) where.driverId = filters.driverId;
  if (filters.customerId) where.customerId = filters.customerId;
  if (filters.status) where.status = filters.status;
  if (filters.mismatchType) where.mismatchType = filters.mismatchType;
  if (filters.dateFrom || filters.dateTo) {
    where.tripDate = {};
    if (filters.dateFrom) where.tripDate.gte = new Date(filters.dateFrom);
    if (filters.dateTo) where.tripDate.lte = new Date(filters.dateTo);
  }

  const [rows, total] = await Promise.all([
    prisma.stockMismatchRecord.findMany({
      where,
      include: {
        cylinderType: { select: { typeName: true } },
        driver: { select: { driverName: true } },
        customer: { select: { customerName: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.stockMismatchRecord.count({ where }),
  ]);

  return {
    data: rows.map((r) => ({
      recordId: r.id,
      reportId: r.reportId,
      vehicleId: r.vehicleId,
      vehicleNumber: r.vehicleNumber,
      driverName: r.driver?.driverName ?? null,
      customerName: r.customer?.customerName ?? null,
      accountableParty: r.accountableParty,
      tripDate: r.tripDate.toISOString().slice(0, 10),
      mismatchType: r.mismatchType,
      cylinderTypeId: r.cylinderTypeId,
      cylinderTypeName: r.cylinderType?.typeName ?? '—',
      qtyUnaccounted: r.qtyUnaccounted,
      unitAmount: toNum(r.unitAmount),
      totalAmount: toNum(r.totalAmount),
      resolutionAction: r.resolutionAction,
      resolutionNotes: r.resolutionNotes,
      status: r.status,
      createdAt: r.createdAt,
    })),
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

// ─── Admin notes/resolution edit (within 24h of creation) ────────────────────

export async function updateMismatchReport(
  distributorId: string,
  recordId: string,
  data: { resolutionNotes?: string; resolutionAction?: 'write_off' | 'settle_against_due' },
) {
  const existing = await prisma.stockMismatchRecord.findFirst({
    where: { id: recordId, distributorId },
  });
  if (!existing) throw new StockMismatchError('Mismatch record not found', 404);
  const ageMs = Date.now() - existing.createdAt.getTime();
  if (ageMs > 24 * 3600 * 1000) {
    throw new StockMismatchError('Mismatch records can only be edited within 24 hours of creation');
  }
  const update: Prisma.StockMismatchRecordUpdateInput = {};
  if (data.resolutionNotes !== undefined) update.resolutionNotes = data.resolutionNotes;
  if (data.resolutionAction !== undefined) update.resolutionAction = data.resolutionAction;
  return prisma.stockMismatchRecord.update({ where: { id: recordId }, data: update });
}
