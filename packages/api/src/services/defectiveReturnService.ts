/**
 * defectiveReturnService.ts
 *
 * F1 — Defective Cylinder Returns (2026-08-06).
 * See docs/F1-DEFECTIVE-RETURNS-DESIGN.md for the full spec.
 *
 * Office-entered flow, mirrors empties-return in shape but with a NEW
 * two-step (capture → raise-CN) dance. Suneel spec: office picks the
 * source invoice at capture time, then reviews the updated ledger, then
 * clicks Raise CN which fires the credit note atomically.
 *
 * Invariants enforced across the service (see anti-pattern refs in
 * CLAUDE.md):
 *   - Every write is scoped by req.user.distributorId (anti-pattern #13).
 *   - `CustomerLedgerEntry.entryType='defective_collected'` MUST always
 *     have amountDelta=0 and invoiceId=null — mirrors the empties_return
 *     rules from anti-pattern #24 (pinned by tests T4 + T4a of the
 *     empties-return suite; new mirror tests land alongside this service).
 *   - The `defective_return_from_customer` InventoryEvent's fullsChange
 *     is stored NEGATIVE (the full "left" the customer's holding). The
 *     computeSummaryForDate aggregator sums Math.abs() into defectiveFullsIn.
 *   - The CN raised on Step 2 goes through the standard
 *     invoiceService.createCreditNote + approveCreditNote pipeline —
 *     hits NIC IRN CRN for B2B on live/sandbox, silently skips NIC for
 *     B2C and gstMode='disabled' (per gstService.ts:1069-1082).
 *   - Cross-invoice defective claims must be split into separate DR
 *     capture sessions — one capture = one source invoice (Suneel Q4).
 */
import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';
import { createInventoryEvent, recalculateSummariesFromDate } from './inventoryService.js';
import { createCreditNote, approveCreditNote } from './invoiceService.js';
import { allocateNumber, type DocNumberType } from './numberingService.js';
import type {
  CaptureDefectiveReturnInput,
  RaiseDefectiveCnInput,
  CreateDefectiveBatchInput,
  CancelDefectiveReturnInput,
  DefectiveEligibleInvoice,
  DefectiveDepotBucketRow,
} from '@gaslink/shared';

export class DefectiveReturnError extends Error {
  constructor(message: string, public statusCode: number = 400) {
    super(message);
    this.name = 'DefectiveReturnError';
  }
}

const toNum = (v: unknown): number => (v == null ? 0 : Number(v));

// ─── Step 0 — invoice picker for the New Entry UI ────────────────────────────
// Returns the customer's invoices from the last N days (default 90) with
// per-line defective-eligible qty (invoice line qty minus already-claimed).
// Empty result = no eligible invoice; UI shows a "no invoices in window"
// hint. Office cannot capture without picking one (Q4 = one DR = one source).
export async function listDefectiveEligibleInvoices(
  distributorId: string,
  customerId: string,
  windowDays = 90,
): Promise<DefectiveEligibleInvoice[]> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!customer) throw new DefectiveReturnError('Customer not found', 404);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  cutoff.setHours(0, 0, 0, 0);

  const invoices = await prisma.invoice.findMany({
    where: {
      distributorId,
      customerId,
      deletedAt: null,
      issueDate: { gte: cutoff },
    },
    orderBy: { issueDate: 'desc' },
    select: {
      id: true,
      invoiceNumber: true,
      issueDate: true,
      totalAmount: true,
      status: true,
      items: {
        select: {
          id: true,
          cylinderTypeId: true,
          quantity: true,
          unitPrice: true,
          totalPrice: true,
          cylinderType: { select: { typeName: true } },
        },
      },
    },
  });

  if (invoices.length === 0) return [];

  // Sum already-claimed defective qty per (invoiceId, cylinderTypeId) to
  // subtract from each line's remainingQty. One DR row = one invoice line,
  // but multiple DR rows can hit the same line over time — we sum ALL
  // non-cancelled rows regardless of status (collected / cn_issued / sent /
  // credit_received). Only status='cancelled' rows are excluded.
  const claimed = await prisma.defectiveCylinderLedger.groupBy({
    by: ['sourceInvoiceId', 'cylinderTypeId'],
    where: {
      distributorId,
      sourceInvoiceId: { in: invoices.map((i) => i.id) },
      status: { not: 'cancelled' },
    },
    _sum: { quantity: true },
  });
  const claimedMap = new Map<string, number>();
  for (const c of claimed) {
    claimedMap.set(`${c.sourceInvoiceId}|${c.cylinderTypeId}`, c._sum.quantity ?? 0);
  }

  return invoices.map((inv) => ({
    invoiceId: inv.id,
    invoiceNumber: inv.invoiceNumber,
    issueDate: inv.issueDate.toISOString().slice(0, 10),
    totalAmount: toNum(inv.totalAmount),
    paymentStatus: String(inv.status),
    lines: inv.items
      // Only cylinder-typed lines are defective-eligible (no cyl type =
      // charges, deposits, etc. — can't be "defective").
      .filter((it) => it.cylinderTypeId != null)
      .map((it) => {
        const already = claimedMap.get(`${inv.id}|${it.cylinderTypeId!}`) ?? 0;
        // Per-cyl rate = totalPrice / quantity, which is the exact post-
        // discount inclusive per-cyl amount the customer paid (see F1
        // design doc, anti-pattern #16 refinement). Guarantees CN preview
        // matches the customer's statement figure.
        const perCyl = it.quantity > 0 ? toNum(it.totalPrice) / it.quantity : 0;
        return {
          invoiceItemId: it.id,
          cylinderTypeId: it.cylinderTypeId!,
          cylinderTypeName: it.cylinderType?.typeName ?? '—',
          perCylRate: Math.round(perCyl * 100) / 100,
          qty: it.quantity,
          alreadyClaimedQty: already,
          remainingQty: Math.max(0, it.quantity - already),
        };
      }),
  }));
}

// ─── Step 1 — capture defective return ───────────────────────────────────────
// Office picks customer + source invoice + per-cyl-type qty. This writes
// the DR ledger rows at status='collected' (CN not yet raised), decrements
// customer's withCustomerQty, fires defective_return_from_customer events,
// and writes a per-cyl-type CustomerLedgerEntry defective_collected row so
// the "check ledger" button between capture and raise-cn shows the physical
// return. No CN, no NIC involvement at this step.
export async function captureDefectiveReturn(
  distributorId: string,
  actorUserId: string,
  data: CaptureDefectiveReturnInput,
): Promise<{ defectiveIds: string[]; cnAmountPreview: number }> {
  const customer = await prisma.customer.findFirst({
    where: { id: data.customerId, distributorId, deletedAt: null },
    select: { id: true, customerName: true },
  });
  if (!customer) throw new DefectiveReturnError('Customer not found', 404);

  const invoice = await prisma.invoice.findFirst({
    where: {
      id: data.sourceInvoiceId,
      distributorId,
      customerId: data.customerId,
      deletedAt: null,
    },
    select: {
      id: true,
      invoiceNumber: true,
      issueDate: true,
      totalAmount: true,
      items: {
        select: {
          id: true,
          cylinderTypeId: true,
          quantity: true,
          totalPrice: true,
          cylinderType: { select: { typeName: true } },
        },
      },
    },
  });
  if (!invoice) {
    // Guard: source invoice must exist AND belong to this customer AND
    // this distributor. Prevents cross-tenant/-customer defective claims.
    throw new DefectiveReturnError('Source invoice not found for this customer', 404);
  }

  // Enforce the 90-day source-invoice window (Q3 answer). Prevents office
  // from claiming defective on year-old invoices where NIC CN cut-off
  // (typically September following FY end) may have expired anyway.
  const invoiceAgeMs = Date.now() - invoice.issueDate.getTime();
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  if (invoiceAgeMs > NINETY_DAYS_MS) {
    throw new DefectiveReturnError(
      `Source invoice ${invoice.invoiceNumber} is older than 90 days; defective claim not allowed`,
      400,
    );
  }

  // Pre-compute already-claimed qty per (invoice, cylType) to enforce the
  // per-line remaining qty guard.
  const priorClaims = await prisma.defectiveCylinderLedger.groupBy({
    by: ['cylinderTypeId'],
    where: {
      distributorId,
      sourceInvoiceId: invoice.id,
      status: { not: 'cancelled' },
    },
    _sum: { quantity: true },
  });
  const priorByType = new Map<string, number>();
  for (const p of priorClaims) {
    priorByType.set(p.cylinderTypeId, p._sum.quantity ?? 0);
  }

  // Validate each input line + build the ledger row batch.
  interface Prepared {
    cylinderTypeId: string;
    cylinderTypeName: string;
    quantity: number;
    invoiceItemId: string | null;
    perCylRate: number;
    cnAmount: number;
  }
  const prepared: Prepared[] = [];
  for (const item of data.items) {
    // Find the invoice line for this cyl type. If the invoice has multiple
    // lines for the same cyl type (rare but possible with dispatches split
    // across trips), take the first one — the CN amount uses that line's
    // per-cyl rate (may differ from other lines under discount). Office
    // must be aware; UI shows the perCylRate for each line.
    const line = invoice.items.find((it) => it.cylinderTypeId === item.cylinderTypeId);
    if (!line) {
      throw new DefectiveReturnError(
        `Cylinder type ${item.cylinderTypeId} not present on invoice ${invoice.invoiceNumber}`,
        400,
      );
    }
    const prior = priorByType.get(item.cylinderTypeId) ?? 0;
    const remaining = line.quantity - prior;
    if (item.quantity > remaining) {
      throw new DefectiveReturnError(
        `Defective qty ${item.quantity} exceeds remaining ${remaining} for ${line.cylinderType?.typeName ?? item.cylinderTypeId} on invoice ${invoice.invoiceNumber}`,
        400,
      );
    }
    const perCyl = line.quantity > 0 ? toNum(line.totalPrice) / line.quantity : 0;
    const perCylRounded = Math.round(perCyl * 100) / 100;
    prepared.push({
      cylinderTypeId: item.cylinderTypeId,
      cylinderTypeName: line.cylinderType?.typeName ?? '—',
      quantity: item.quantity,
      invoiceItemId: line.id,
      perCylRate: perCylRounded,
      cnAmount: Math.round(perCylRounded * item.quantity * 100) / 100,
    });
  }
  if (prepared.length === 0) {
    throw new DefectiveReturnError('At least one cylinder-type row required', 400);
  }

  const collectedDate = new Date(`${data.collectedDate}T00:00:00.000Z`);
  const cnAmountPreview = prepared.reduce((s, r) => s + r.cnAmount, 0);

  const defectiveIds: string[] = [];
  const cylTypesTouched = new Set<string>();

  await prisma.$transaction(async (tx) => {
    for (const p of prepared) {
      cylTypesTouched.add(p.cylinderTypeId);
      const row = await tx.defectiveCylinderLedger.create({
        data: {
          distributorId,
          customerId: customer.id,
          cylinderTypeId: p.cylinderTypeId,
          quantity: p.quantity,
          sourceInvoiceId: invoice.id,
          sourceInvoiceItemId: p.invoiceItemId,
          perCylRate: p.perCylRate,
          cnAmount: p.cnAmount,
          reason: data.reason ?? null,
          notes: data.notes ?? null,
          status: 'collected',
          collectedDate,
          collectedBy: actorUserId,
        },
      });
      defectiveIds.push(row.id);

      // Physical event — defective full leaves customer, arrives at depot's
      // defective bucket. fullsChange NEGATIVE (matches outgoing-empties
      // sign convention). Aggregator sums abs(fullsChange) into
      // defectiveFullsIn.
      await createInventoryEvent(tx, {
        distributorId,
        cylinderTypeId: p.cylinderTypeId,
        eventType: 'defective_return_from_customer',
        fullsChange: -p.quantity,
        emptiesChange: 0,
        eventDate: collectedDate,
        referenceId: row.id,
        referenceType: 'defective_return',
        documentType: 'defective_return',
        documentNumber: invoice.invoiceNumber,
        createdBy: actorUserId,
        notes: `Defective: ${p.quantity}× ${p.cylinderTypeName} from ${customer.customerName} (INV ${invoice.invoiceNumber})`,
      });

      // Customer holding count decrements — same math as an empty return.
      // The physical cylinder left customer premises. On the "next invoice
      // consumes prior credit" side there's no coupling here; that lands
      // when the CN fires.
      await tx.customerInventoryBalance.upsert({
        where: {
          customerId_cylinderTypeId: {
            customerId: customer.id,
            cylinderTypeId: p.cylinderTypeId,
          },
        },
        create: {
          customerId: customer.id,
          cylinderTypeId: p.cylinderTypeId,
          withCustomerQty: -p.quantity,
        },
        update: {
          withCustomerQty: { decrement: p.quantity },
        },
      });

      // Stock-only ledger row — amountDelta=0, invoiceId=null (mirrors
      // empties_return anti-pattern #24 rules). Narration format is fixed
      // for the customer statement PDF renderer:
      // "Defective: N× {typeName} from INV-XXXX (pending CN)".
      await tx.customerLedgerEntry.create({
        data: {
          distributorId,
          customerId: customer.id,
          entryType: 'defective_collected',
          referenceId: row.id,
          invoiceId: null,
          amountDelta: 0,
          narration: `Defective: ${p.quantity}× ${p.cylinderTypeName} from ${invoice.invoiceNumber} (pending CN)`,
          entryDate: collectedDate,
          createdBy: actorUserId,
        },
      });
    }
  });

  // Cascade summary recompute per touched cyl type — outside the tx so the
  // events are visible. Same pattern as emptiesReturnService.
  for (const cylTypeId of cylTypesTouched) {
    await recalculateSummariesFromDate(distributorId, cylTypeId, collectedDate);
  }

  return { defectiveIds, cnAmountPreview: Math.round(cnAmountPreview * 100) / 100 };
}

// ─── Step 2 — raise credit note ──────────────────────────────────────────────
// Office reviews the ledger after capture, then clicks Raise CN. Fires
// the standard createCreditNote + approveCreditNote pipeline (which handles
// NIC IRN CRN for B2B, silently skips for B2C and gstMode='disabled').
// One CN per raise-cn call, aggregating all DR rows into a single amount.
export async function raiseDefectiveCn(
  distributorId: string,
  actorUserId: string,
  data: RaiseDefectiveCnInput,
): Promise<{ creditNoteId: string; cnNumber: string; cnAmount: number }> {
  if (data.defectiveIds.length === 0) {
    throw new DefectiveReturnError('At least one defective id required', 400);
  }

  const rows = await prisma.defectiveCylinderLedger.findMany({
    where: {
      id: { in: data.defectiveIds },
      distributorId,
    },
    select: {
      id: true,
      customerId: true,
      sourceInvoiceId: true,
      status: true,
      cnAmount: true,
      quantity: true,
      cylinderTypeId: true,
      // F1-FIX-8 — need typeName for the post-CN narration ("Defective:
      // 1× 19 KG · CN CSHD…") so it fits inside the PDF Narration column
      // without truncating to "(se…".
      cylinderType: { select: { typeName: true } },
    },
  });

  if (rows.length !== data.defectiveIds.length) {
    throw new DefectiveReturnError(
      'One or more defective ids not found for this distributor',
      404,
    );
  }
  // All rows must share the same customer + source invoice — Q4 rule
  // (one raise-cn call = one CN = one source invoice).
  const customerIds = new Set(rows.map((r) => r.customerId));
  const invoiceIds = new Set(rows.map((r) => r.sourceInvoiceId));
  if (customerIds.size > 1) {
    throw new DefectiveReturnError('All defective rows must share the same customer', 400);
  }
  if (invoiceIds.size > 1) {
    throw new DefectiveReturnError('All defective rows must share the same source invoice', 400);
  }
  // All rows must be in the 'collected' state — no double-CN, no CN on
  // cancelled rows.
  const badStatus = rows.find((r) => r.status !== 'collected');
  if (badStatus) {
    throw new DefectiveReturnError(
      `Defective row ${badStatus.id} is in status '${badStatus.status}', not 'collected'`,
      400,
    );
  }

  // Cumulative-CN guard (createCreditNote doesn't check this itself — see
  // trace notes and anti-pattern #16). Sum existing NON-rejected CN amounts
  // against this invoice + the new amount and fail if > invoice total.
  const invoice = await prisma.invoice.findUnique({
    where: { id: rows[0].sourceInvoiceId },
    select: { id: true, totalAmount: true, invoiceNumber: true, customerId: true },
  });
  if (!invoice) throw new DefectiveReturnError('Source invoice missing', 404);

  const existingCnSum = await prisma.creditNote.aggregate({
    where: {
      invoiceId: invoice.id,
      status: { notIn: ['rejected_cn'] },
    },
    _sum: { totalAmount: true },
  });
  const cnAmount = rows.reduce((s, r) => s + toNum(r.cnAmount), 0);
  const cumulative = toNum(existingCnSum._sum.totalAmount) + cnAmount;
  if (cumulative > toNum(invoice.totalAmount) + 0.01) {
    throw new DefectiveReturnError(
      `Cumulative CN (₹${cumulative.toFixed(2)}) would exceed invoice total (₹${toNum(invoice.totalAmount).toFixed(2)}) on ${invoice.invoiceNumber}`,
      400,
    );
  }

  // Fire the CN via existing service. `createCreditNote` writes the CN
  // row + allocates a 'C' number; `approveCreditNote` flips it to
  // approved, updates invoice.outstandingAmount, writes CustomerLedgerEntry
  // credit_note, and fires processCreditNoteGst (fire-and-forget; NIC CRN
  // for B2B on live/sandbox, skip for B2C + disabled).
  const reason = (data.reason ?? '').trim() || 'Defective cylinder return';
  const cn = await createCreditNote(distributorId, actorUserId, {
    invoiceId: invoice.id,
    reason,
    amount: Math.round(cnAmount * 100) / 100,
  });
  await approveCreditNote(cn.id, distributorId, actorUserId);

  const cnRecord = await prisma.creditNote.findUnique({
    where: { id: cn.id },
    select: { id: true, creditNoteNumber: true, totalAmount: true },
  });
  const cnNumber = cnRecord?.creditNoteNumber ?? cn.id;

  // Update DR rows: status='cn_issued', creditNoteId, cnRaisedAt, cnRaisedBy.
  // Also refresh the earlier 'defective_collected' ledger narration to
  // append " → CN <cnNumber>" so the customer statement PDF's stale
  // "(pending CN)" note becomes accurate.
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.defectiveCylinderLedger.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: {
        status: 'cn_issued',
        creditNoteId: cn.id,
        cnRaisedAt: now,
        cnRaisedBy: actorUserId,
      },
    });
    // Refresh narration on each DR row's ledger entry.
    // F1-FIX-8 (2026-08-06) — keep it short so the PDF Narration column
    // (~20 chars) doesn't truncate. Format: "Defective: 1× 19 KG · CN CSHD…".
    for (const r of rows) {
      await tx.customerLedgerEntry.updateMany({
        where: {
          distributorId,
          customerId: r.customerId,
          entryType: 'defective_collected',
          referenceId: r.id,
        },
        data: {
          narration: {
            set: `Defective: ${r.quantity}× ${r.cylinderType.typeName} · CN ${cnNumber}`,
          },
        },
      });
    }
  });

  return {
    creditNoteId: cn.id,
    cnNumber,
    cnAmount: toNum(cnRecord?.totalAmount ?? cnAmount),
  };
}

// ─── Reads ──────────────────────────────────────────────────────────────────

interface HistoryFilters {
  status?: string;
  customerId?: string;
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
}

export async function listDefectiveHistory(
  distributorId: string,
  filters: HistoryFilters = {},
) {
  const where: Prisma.DefectiveCylinderLedgerWhereInput = { distributorId };
  if (filters.status) {
    where.status = filters.status as Prisma.EnumDefectiveReturnStatusFilter;
  }
  if (filters.customerId) where.customerId = filters.customerId;
  if (filters.from || filters.to) {
    where.collectedDate = {};
    if (filters.from) (where.collectedDate as Prisma.DateTimeFilter).gte = new Date(`${filters.from}T00:00:00.000Z`);
    if (filters.to)   (where.collectedDate as Prisma.DateTimeFilter).lte = new Date(`${filters.to}T23:59:59.999Z`);
  }

  const rows = await prisma.defectiveCylinderLedger.findMany({
    where,
    orderBy: { collectedAt: 'desc' },
    take: 500,
    include: {
      customer: { select: { customerName: true } },
      cylinderType: { select: { typeName: true } },
      sourceInvoice: { select: { invoiceNumber: true, totalAmount: true } },
      creditNote: { select: { creditNoteNumber: true, totalAmount: true } },
      batch: { select: { batchNumber: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    distributorId: r.distributorId,
    customerId: r.customerId,
    customerName: r.customer?.customerName ?? '—',
    cylinderTypeId: r.cylinderTypeId,
    cylinderTypeName: r.cylinderType?.typeName ?? '—',
    quantity: r.quantity,
    sourceInvoiceId: r.sourceInvoiceId,
    sourceInvoiceNumber: r.sourceInvoice?.invoiceNumber ?? null,
    sourceInvoiceAmount: r.sourceInvoice ? toNum(r.sourceInvoice.totalAmount) : null,
    sourceInvoiceItemId: r.sourceInvoiceItemId,
    perCylRate: toNum(r.perCylRate),
    cnAmount: toNum(r.cnAmount),
    reason: r.reason,
    notes: r.notes,
    status: r.status,
    creditNoteId: r.creditNoteId,
    creditNoteNumber: r.creditNote?.creditNoteNumber ?? null,
    batchId: r.batchId,
    batchNumber: r.batch?.batchNumber ?? null,
    collectedAt: r.collectedAt.toISOString(),
    collectedDate: r.collectedDate.toISOString().slice(0, 10),
    collectedBy: r.collectedBy,
    cnRaisedAt: r.cnRaisedAt?.toISOString() ?? null,
    cnRaisedBy: r.cnRaisedBy,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancelledBy: r.cancelledBy,
    cancelReason: r.cancelReason,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function getPendingCnCount(distributorId: string): Promise<number> {
  return prisma.defectiveCylinderLedger.count({
    where: { distributorId, status: 'collected' },
  });
}

// Depot bucket = defective fulls sitting at depot, ready to ship to corp.
// These are rows with status='cn_issued' (CN raised, physically at depot,
// awaiting outbound batch). Rows at 'collected' are also physically at
// depot but haven't been financially cleared yet; we surface only the
// ship-ready ones in the depot bucket to avoid shipping unsettled stock.
export async function getDefectiveDepotBucket(
  distributorId: string,
): Promise<DefectiveDepotBucketRow[]> {
  const rows = await prisma.defectiveCylinderLedger.groupBy({
    by: ['cylinderTypeId'],
    where: { distributorId, status: 'cn_issued' },
    _sum: { quantity: true },
  });
  if (rows.length === 0) return [];
  const cylTypes = await prisma.cylinderType.findMany({
    where: { id: { in: rows.map((r) => r.cylinderTypeId) } },
    select: { id: true, typeName: true },
  });
  const nameMap = new Map(cylTypes.map((c) => [c.id, c.typeName]));
  return rows.map((r) => ({
    cylinderTypeId: r.cylinderTypeId,
    cylinderTypeName: nameMap.get(r.cylinderTypeId) ?? '—',
    qty: r._sum.quantity ?? 0,
  }));
}

// ─── Cancel a captured DR row (before CN) ───────────────────────────────────
// If CN already raised, use the standard CN void flow instead.
export async function cancelDefectiveReturn(
  distributorId: string,
  actorUserId: string,
  defectiveId: string,
  data: CancelDefectiveReturnInput,
): Promise<void> {
  const row = await prisma.defectiveCylinderLedger.findFirst({
    where: { id: defectiveId, distributorId },
    select: {
      id: true, status: true, customerId: true, cylinderTypeId: true,
      quantity: true, collectedDate: true,
    },
  });
  if (!row) throw new DefectiveReturnError('Defective return not found', 404);
  if (row.status !== 'collected') {
    throw new DefectiveReturnError(
      `Cannot cancel — row is in status '${row.status}'. After CN, use the standard CN void flow.`,
      400,
    );
  }

  await prisma.$transaction(async (tx) => {
    // Reverse the physical event with a compensating manual_adjustment.
    // We do NOT emit a "negative defective_return_from_customer" — the
    // aggregator uses Math.abs so a negative would still ADD, not subtract.
    // Instead we set the DR row's status='cancelled' (excluded from
    // aggregator via the reader-side filter) and write a compensating
    // event that puts the cylinder back at customer's holding.
    // Cleanest approach: write a positive manual_adjustment on fullsChange=0
    // and emptiesChange=0 for audit, then revert customer balance directly.
    // Actually simplest: soft-flip the row and directly undo the two
    // side-effects (customer balance decrement + defective_return event).
    // We WRITE a reversal event so aggregator naturally recomputes.
    await createInventoryEvent(tx, {
      distributorId,
      cylinderTypeId: row.cylinderTypeId,
      // Use manual_adjustment for reversal — the aggregator sums signed
      // manual_adjustment.fullsChange into manualAdjustment which feeds
      // closingFulls. But we don't want closingFulls affected either.
      // Cleanest option: emit an INVERSE defective_return_from_customer
      // event with POSITIVE fullsChange. The aggregator uses Math.abs on
      // fullsChange for defective, so this would ALSO increment
      // defectiveFullsIn. That's wrong.
      // Correct approach: cancel path uses a NEW event type or repurposes
      // an existing type. For v1 simplicity we use defective_return_to_corporation
      // with POSITIVE fullsChange (a "un-return" — Math.abs still increments
      // defectiveFullsOut, subtracting from closingDefectiveFulls). This
      // matches physical reality: the defective is being sent back OUT of
      // the depot bucket, restored to customer holding.
      eventType: 'defective_return_to_corporation',
      fullsChange: row.quantity, // POSITIVE — reversal signal
      emptiesChange: 0,
      eventDate: row.collectedDate,
      referenceId: row.id,
      referenceType: 'defective_return_cancel',
      documentType: 'defective_return_cancel',
      documentNumber: `CANCEL-${row.id.slice(0, 8)}`,
      createdBy: actorUserId,
      notes: `Cancel: ${data.reason}`,
    });

    // Restore customer's holding — put the cylinder back on their side.
    await tx.customerInventoryBalance.update({
      where: {
        customerId_cylinderTypeId: {
          customerId: row.customerId,
          cylinderTypeId: row.cylinderTypeId,
        },
      },
      data: { withCustomerQty: { increment: row.quantity } },
    });

    // Update the customer ledger entry's narration to reflect cancellation
    // (the row itself stays for audit history).
    await tx.customerLedgerEntry.updateMany({
      where: {
        distributorId,
        customerId: row.customerId,
        entryType: 'defective_collected',
        referenceId: row.id,
      },
      data: {
        narration: { set: `Defective capture CANCELLED: ${data.reason}` },
      },
    });

    // Flip the row status
    await tx.defectiveCylinderLedger.update({
      where: { id: row.id },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledBy: actorUserId,
        cancelReason: data.reason,
      },
    });
  });

  await recalculateSummariesFromDate(distributorId, row.cylinderTypeId, row.collectedDate);
}

// ─── Slice 5 — send defective batch to corporation ──────────────────────────
export async function createDefectiveReturnBatch(
  distributorId: string,
  actorUserId: string,
  data: CreateDefectiveBatchInput,
): Promise<{ batchId: string; batchNumber: string; totalQuantity: number }> {
  if (data.defectiveIds.length === 0) {
    throw new DefectiveReturnError('At least one defective id required', 400);
  }

  const rows = await prisma.defectiveCylinderLedger.findMany({
    where: {
      id: { in: data.defectiveIds },
      distributorId,
    },
    select: {
      id: true, cylinderTypeId: true, quantity: true, status: true,
      collectedDate: true,
    },
  });
  if (rows.length !== data.defectiveIds.length) {
    throw new DefectiveReturnError(
      'One or more defective ids not found for this distributor',
      404,
    );
  }
  // Only cn_issued rows can be batched to corp (CN cleared, ready to ship).
  const wrongStatus = rows.find((r) => r.status !== 'cn_issued');
  if (wrongStatus) {
    throw new DefectiveReturnError(
      `Defective row ${wrongStatus.id} is not ready to ship (status='${wrongStatus.status}', required 'cn_issued')`,
      400,
    );
  }

  // Optional FK: if sourceDistributorId provided, verify tenant-scoped ownership.
  if (data.sourceDistributorId) {
    const sd = await prisma.sourceDistributor.findFirst({
      where: {
        id: data.sourceDistributorId,
        distributorId,
        deletedAt: null,
      },
      select: { id: true, name: true },
    });
    if (!sd) throw new DefectiveReturnError('Source distributor not found', 404);
  }

  // Optional vehicleId — validate tenant scoping.
  if (data.vehicleId) {
    const v = await prisma.vehicle.findFirst({
      where: { id: data.vehicleId, distributorId, deletedAt: null },
      select: { id: true },
    });
    if (!v) throw new DefectiveReturnError('Vehicle not found', 404);
  }

  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { docCode: true },
  });
  const totalQuantity = rows.reduce((s, r) => s + r.quantity, 0);
  const now = new Date();
  const challanDate = data.challanDate ? new Date(`${data.challanDate}T00:00:00.000Z`) : null;

  const cylTypesTouched = new Set<string>();

  const batchId = await prisma.$transaction(async (tx) => {
    const batchNumber = distributor?.docCode
      ? await allocateNumber(tx, distributorId, 'F' as DocNumberType, now, distributor.docCode)
      : `DR-BATCH-${Date.now().toString(36).toUpperCase()}`;

    const batch = await tx.defectiveReturnBatch.create({
      data: {
        distributorId,
        batchNumber,
        sourceDistributorId: data.sourceDistributorId ?? null,
        corporationName: data.corporationName,
        vehicleId: data.vehicleId ?? null,
        challanNumber: data.challanNumber ?? null,
        challanDate,
        totalQuantity,
        status: 'sent',
        notes: data.notes ?? null,
        createdBy: actorUserId,
      },
    });

    // Link DR rows to the batch + advance status
    await tx.defectiveCylinderLedger.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: {
        status: 'sent_to_corporation',
        batchId: batch.id,
      },
    });

    // Fire physical events: defective full leaves depot → corp. fullsChange
    // NEGATIVE (matches outgoing_empties sign convention). Aggregator sums
    // abs into defectiveFullsOut → closingDefectiveFulls decrements.
    // One event per cyl-type sum for clean aggregation.
    const perCyl = new Map<string, number>();
    for (const r of rows) {
      perCyl.set(r.cylinderTypeId, (perCyl.get(r.cylinderTypeId) ?? 0) + r.quantity);
      cylTypesTouched.add(r.cylinderTypeId);
    }
    for (const [cylTypeId, qty] of perCyl) {
      await createInventoryEvent(tx, {
        distributorId,
        cylinderTypeId: cylTypeId,
        eventType: 'defective_return_to_corporation',
        fullsChange: -qty,
        emptiesChange: 0,
        eventDate: now,
        referenceId: batch.id,
        referenceType: 'defective_return_batch',
        documentType: 'defective_return_batch',
        documentNumber: batchNumber,
        createdBy: actorUserId,
        notes: `Batch ${batchNumber} → ${data.corporationName} (${qty}× cyl)`,
      });
    }

    return batch.id;
  });

  const finalBatch = await prisma.defectiveReturnBatch.findUniqueOrThrow({
    where: { id: batchId },
    select: { id: true, batchNumber: true, totalQuantity: true },
  });

  for (const cylTypeId of cylTypesTouched) {
    await recalculateSummariesFromDate(distributorId, cylTypeId, now);
  }

  return {
    batchId: finalBatch.id,
    batchNumber: finalBatch.batchNumber,
    totalQuantity: finalBatch.totalQuantity,
  };
}

export async function markBatchCorpCreditReceived(
  distributorId: string,
  actorUserId: string,
  batchId: string,
  corpCreditAmount: number,
): Promise<void> {
  const batch = await prisma.defectiveReturnBatch.findFirst({
    where: { id: batchId, distributorId },
    select: { id: true, status: true },
  });
  if (!batch) throw new DefectiveReturnError('Batch not found', 404);
  if (batch.status !== 'sent') {
    throw new DefectiveReturnError(`Batch status is '${batch.status}', not 'sent'`, 400);
  }
  if (corpCreditAmount < 0) {
    throw new DefectiveReturnError('Corp credit amount must be >= 0', 400);
  }

  await prisma.$transaction(async (tx) => {
    await tx.defectiveReturnBatch.update({
      where: { id: batchId },
      data: {
        status: 'corp_credit_received',
        corpCreditAmount,
        corpCreditReceivedAt: new Date(),
      },
    });
    // Cascade DR row status
    await tx.defectiveCylinderLedger.updateMany({
      where: { batchId, distributorId },
      data: { status: 'corporation_credit_received' },
    });
    // Actor is captured on the DR rows via the earlier cn_issued flip; the
    // batch row's createdBy carries the original operator. We just need
    // an audit trail; actorUserId used for audit_logs middleware.
  });

  // No summary recompute needed — the physical event fired at batch creation.
  // actorUserId is captured by the auditLog middleware at the route layer;
  // no explicit use needed here (kept in the signature for symmetry with
  // other DR service functions and future in-service audit emits).
  void actorUserId;
}
