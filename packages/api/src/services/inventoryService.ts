import { prisma } from '../lib/prisma.js';
import type { Prisma, PrismaClient, $Enums } from '@prisma/client';
import { toNum } from '../utils/decimal.js';
import { isDispatchDebitEnabled } from '../utils/inventoryFlags.js';
import { startOfUtcDay } from '../utils/dateOnly.js';

type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

/**
 * Create an immutable inventory event. All inventory changes go through this function.
 */
export async function createInventoryEvent(
  tx: TxClient,
  data: {
    distributorId: string;
    cylinderTypeId: string;
    eventType: string;
    fullsChange: number;
    emptiesChange: number;
    eventDate: Date;
    referenceId?: string;
    referenceType?: string;
    documentType?: string;
    documentNumber?: string;
    documentDate?: Date;
    vehicleNumber?: string;
    driverName?: string;
    // WI-1.4 — captured by the Incoming Fulls / Outgoing Empties modals
    amount?: number;
    condition?: 'good' | 'defective';
    authorizationRef?: string;
    notes?: string;
    createdBy: string;
  }
) {
  return tx.inventoryEvent.create({
    data: {
      distributorId: data.distributorId,
      cylinderTypeId: data.cylinderTypeId,
      eventType: data.eventType as $Enums.InventoryEventType,
      fullsChange: data.fullsChange,
      emptiesChange: data.emptiesChange,
      eventDate: data.eventDate,
      referenceId: data.referenceId || null,
      referenceType: data.referenceType || null,
      documentType: data.documentType || null,
      documentNumber: data.documentNumber || null,
      documentDate: data.documentDate || null,
      vehicleNumber: data.vehicleNumber || null,
      driverName: data.driverName || null,
      amount: data.amount ?? null,
      condition: data.condition ?? null,
      authorizationRef: data.authorizationRef ?? null,
      notes: data.notes || null,
      createdBy: data.createdBy,
    },
  });
}

/**
 * Compute inventory summary for a specific date by aggregating all events.
 * This is the core event-sourcing computation.
 */
export async function computeSummaryForDate(
  distributorId: string,
  cylinderTypeId: string,
  date: Date
): Promise<{
  openingFulls: number;
  openingEmpties: number;
  incomingFulls: number;
  outgoingEmpties: number;
  deliveredQty: number;
  dispatchedQty: number;
  collectedEmpties: number;
  emptiesReturnedVerified: number;
  cancelledStockQty: number;
  manualAdjustment: number;
  closingFulls: number;
  closingEmpties: number;
}> {
  // Get opening balance from previous day's closing
  const prevSummary = await prisma.inventorySummary.findFirst({
    where: {
      distributorId,
      cylinderTypeId,
      summaryDate: { lt: date },
    },
    orderBy: { summaryDate: 'desc' },
    select: { closingFulls: true, closingEmpties: true },
  });

  const openingFulls = prevSummary?.closingFulls ?? 0;
  const openingEmpties = prevSummary?.closingEmpties ?? 0;

  // Aggregate all events for this date
  const events = await prisma.inventoryEvent.findMany({
    where: {
      distributorId,
      cylinderTypeId,
      eventDate: date,
    },
  });

  let incomingFulls = 0;
  let outgoingEmpties = 0;
  let deliveredQty = 0;
  let collectedEmpties = 0;
  // Inventory model rework — separates "empties collected at doorstep" (audit
  // only) from "empties supervisor-verified returned to depot" (drives depot
  // closing-empties). `reconciliation_empties_return` events feed this bucket;
  // `collection` / `returns_collection` events keep feeding `collectedEmpties`
  // for the Vehicle Ledger and customer-balance views.
  let emptiesReturnedVerified = 0;
  let cancelledStockQty = 0;
  let manualAdjustment = 0;
  // WI-3: manual_adjustment events now carry both fullsChange AND
  // emptiesChange (Adjust Stock supports the Empties bucket). Track the
  // empties side separately so the closingEmpties formula has its own
  // bucket — keeping the existing closingFulls calc byte-for-byte intact.
  let manualEmpties = 0;
  // WI-106: dispatch-debit accumulators. Always computed (cheap); only used by
  // the flag-on closingFulls formula below. When the flag is off there are no
  // `dispatch` events and the old formula ignores these, so flag-off totals are
  // byte-for-byte unchanged.
  let dispatchedQty = 0; // Σ |dispatch.fullsChange| — fulls that left the depot
  let returnedQty = 0;   // Σ cancellation_return.fullsChange — fulls that came back
  // WI-083: initial_balance events carry an emptiesChange (set during onboarding).
  // The closingEmpties formula only has collectedEmpties and outgoingEmpties, so
  // the initial empties were silently ignored. Track them separately to avoid
  // polluting the "Collected Empties" display column.
  let initialEmpties = 0;

  for (const event of events) {
    switch (event.eventType) {
      case 'incoming_fulls':
        incomingFulls += event.fullsChange;
        break;
      case 'outgoing_empties':
        outgoingEmpties += Math.abs(event.emptiesChange);
        break;
      case 'delivery':
        deliveredQty += Math.abs(event.fullsChange);
        break;
      case 'collection':
        collectedEmpties += event.emptiesChange;
        break;
      case 'dispatch':
        // WI-106: cylinders leaving the depot onto a vehicle (fullsChange is
        // negative). Only produced when the flag is on.
        dispatchedQty += Math.abs(event.fullsChange);
        break;
      case 'cancellation':
        cancelledStockQty += event.fullsChange;
        break;
      case 'cancellation_return':
        // WI-083a2 — GAP 3: cancelled stock returned from vehicle belongs in the
        // Cancelled column, not Incoming. Both buckets add to closingFulls equally
        // (formula: + cancelledStockQty), so the balance is unchanged — only the
        // display column changes. Incoming is for Corporation refills; this is a return.
        cancelledStockQty += event.fullsChange;
        // WI-106: under the flag-on formula this is the ONLY credit for returned
        // stock (the `cancellation` event is no longer produced).
        returnedQty += event.fullsChange;
        break;
      case 'manual_adjustment':
        // WI-3: a single manual_adjustment event may carry fullsChange OR
        // emptiesChange (the Adjust Stock modal toggles between them). We
        // sum each onto its own bucket so the closingFulls calc stays
        // byte-for-byte intact while closingEmpties picks up the new
        // manualEmpties term.
        manualAdjustment += event.fullsChange;
        manualEmpties += event.emptiesChange;
        break;
      case 'initial_balance':
        // Fulls portion → manual adjustment column; empties tracked separately.
        manualAdjustment += event.fullsChange;
        initialEmpties += event.emptiesChange;
        break;
      case 'write_off':
        manualAdjustment += event.fullsChange; // negative
        break;
      case 'returns_collection':
        // Returns-only orders: empties collected from customer
        collectedEmpties += event.emptiesChange;
        break;
      case 'reconciliation_empties_return':
        // Empties physically verified returned to depot at trip reconciliation
        // (positive emptiesChange). Under the new inventory model this is the
        // ONLY event that credits depot closing-empties — delivery-time
        // `collection` / `returns_collection` no longer feed the balance, only
        // the supervisor's verified count at reconcile does. Prevents the
        // earlier double-count where the same empty incremented closing twice.
        emptiesReturnedVerified += event.emptiesChange;
        break;
    }
  }

  // WI-106: dispatch-based closing when the flag is on — fulls are debited at
  // dispatch (− dispatchedQty), credited back on return (+ returnedQty), and
  // `delivery` no longer drives the balance (it's display-only). When off, the
  // original delivered-based formula runs unchanged.
  const closingFulls = isDispatchDebitEnabled(distributorId)
    ? openingFulls + incomingFulls - dispatchedQty + returnedQty + manualAdjustment
    : openingFulls + incomingFulls - deliveredQty + cancelledStockQty + manualAdjustment;
  // New-model closing-empties: supervisor-verified returns at reconcile +
  // onboarding initial balance + WI-3 inventory-team manual adjustments
  // (Adjust Stock → Empties bucket) feed the depot balance; delivery-time
  // collection no longer does. Equivalent under the old model only when
  // verified == collected (rarely true — old formula over-credited).
  const closingEmpties = openingEmpties + emptiesReturnedVerified + initialEmpties + manualEmpties - outgoingEmpties;

  return {
    openingFulls,
    openingEmpties,
    incomingFulls,
    outgoingEmpties,
    deliveredQty,
    dispatchedQty,
    collectedEmpties,
    emptiesReturnedVerified,
    cancelledStockQty,
    manualAdjustment,
    closingFulls,
    closingEmpties,
  };
}

/**
 * Recalculate inventory summaries from a given date forward.
 * Fixes the carry-forward chain when historical data changes.
 */
export async function recalculateSummariesFromDate(
  distributorId: string,
  cylinderTypeId: string,
  fromDate: Date
) {
  // Get all dates with events from fromDate forward
  const events = await prisma.inventoryEvent.findMany({
    where: {
      distributorId,
      cylinderTypeId,
      eventDate: { gte: fromDate },
    },
    select: { eventDate: true },
    distinct: ['eventDate'],
    orderBy: { eventDate: 'asc' },
  });

  const dates = events.map(e => e.eventDate);

  // Also include existing summary dates that may need updating
  const existingSummaries = await prisma.inventorySummary.findMany({
    where: {
      distributorId,
      cylinderTypeId,
      summaryDate: { gte: fromDate },
      isLocked: false,
    },
    select: { summaryDate: true },
    orderBy: { summaryDate: 'asc' },
  });

  const allDates = new Set<number>();
  for (const d of dates) allDates.add(d.getTime());
  for (const s of existingSummaries) allDates.add(s.summaryDate.getTime());

  const sortedDates = Array.from(allDates).sort().map(t => new Date(t));

  for (const date of sortedDates) {
    // Lock-skip guard: a row marked isLocked=true is the authoritative close
    // for that day — never overwrite it, even if new events arrive on that
    // date later. Without this, a future event on a locked date would silently
    // re-derive the snapshot under the current (possibly newer) formula and
    // erase the locked close. Closes the hole in the earlier behaviour where
    // only the existing-summary-dates query filtered on isLocked while the
    // event-dates path bypassed the filter.
    const existing = await prisma.inventorySummary.findUnique({
      where: {
        distributorId_cylinderTypeId_summaryDate: {
          distributorId,
          cylinderTypeId,
          summaryDate: date,
        },
      },
      select: { isLocked: true },
    });
    if (existing?.isLocked) continue;

    const summary = await computeSummaryForDate(distributorId, cylinderTypeId, date);

    await prisma.inventorySummary.upsert({
      where: {
        distributorId_cylinderTypeId_summaryDate: {
          distributorId,
          cylinderTypeId,
          summaryDate: date,
        },
      },
      create: {
        distributorId,
        cylinderTypeId,
        summaryDate: date,
        ...summary,
      },
      update: summary,
    });
  }
}

/**
 * Record incoming fulls (manual entry for any corporation).
 */
export async function recordIncomingFulls(
  distributorId: string,
  userId: string,
  data: {
    cylinderTypeId: string;
    quantity: number;
    documentType: string;
    documentNumber: string;
    documentDate: string;
    vehicleNumber?: string;
    driverName?: string;
    amount?: number;
    notes?: string;
  }
) {
  const eventDate = new Date(data.documentDate);

  const event = await prisma.$transaction(async (tx) => {
    return createInventoryEvent(tx, {
      distributorId,
      cylinderTypeId: data.cylinderTypeId,
      eventType: 'incoming_fulls',
      fullsChange: data.quantity,
      emptiesChange: 0,
      eventDate,
      documentType: data.documentType,
      documentNumber: data.documentNumber,
      documentDate: eventDate,
      vehicleNumber: data.vehicleNumber,
      driverName: data.driverName,
      amount: data.amount,
      createdBy: userId,
      notes: data.notes,
    });
  });

  // Recalculate AFTER the transaction commits: recalculateSummariesFromDate
  // uses the global prisma client, which cannot see events written via `tx`
  // while the transaction is still open (read-committed isolation).
  await recalculateSummariesFromDate(distributorId, data.cylinderTypeId, eventDate);
  return event;
}

/**
 * Record outgoing empties (manual entry).
 */
export async function recordOutgoingEmpties(
  distributorId: string,
  userId: string,
  data: {
    cylinderTypeId: string;
    quantity: number;
    documentType: string;
    documentNumber: string;
    documentDate: string;
    vehicleNumber?: string;
    driverName?: string;
    authorizationRef?: string;
    amount?: number;
    condition?: 'good' | 'defective';
    notes?: string;
  }
) {
  const eventDate = new Date(data.documentDate);

  const event = await prisma.$transaction(async (tx) => {
    return createInventoryEvent(tx, {
      distributorId,
      cylinderTypeId: data.cylinderTypeId,
      eventType: 'outgoing_empties',
      fullsChange: 0,
      emptiesChange: -data.quantity,
      eventDate,
      documentType: data.documentType,
      documentNumber: data.documentNumber,
      documentDate: eventDate,
      vehicleNumber: data.vehicleNumber,
      driverName: data.driverName,
      authorizationRef: data.authorizationRef,
      amount: data.amount,
      condition: data.condition,
      createdBy: userId,
      notes: data.notes,
    });
  });

  // Recalculate AFTER the transaction commits: recalculateSummariesFromDate
  // uses the global prisma client, which cannot see events written via `tx`
  // while the transaction is still open (read-committed isolation).
  await recalculateSummariesFromDate(distributorId, data.cylinderTypeId, eventDate);
  return event;
}

/**
 * Group 2 (2026-06-11): structured error thrown when a duplicate opening-
 * stock entry is submitted without `replaceExisting`. The route handler
 * catches it and maps to 409 + per-cylinder-type existing values so the
 * web modal can show a confirmation dialog.
 */
export class InitialBalanceConflictError extends Error {
  conflicts: { cylinderTypeId: string; fulls: number; empties: number; eventDate: string }[];
  constructor(conflicts: InitialBalanceConflictError['conflicts']) {
    super('Opening stock already entered. Set replaceExisting=true to override.');
    this.name = 'InitialBalanceConflictError';
    this.conflicts = conflicts;
  }
}

/**
 * Record opening-stock balances (one InventoryEvent per cylinder type) as
 * the distributor's starting fulls/empties counts. Used by the onboarding
 * "Enter opening stock" flow. Skips entries where both fulls and empties are 0.
 *
 * Group 2 (2026-06-11): if an `initial_balance` event already exists for a
 * given cylinder type, the call fails with InitialBalanceConflictError
 * UNLESS `replaceExisting=true`, in which case the prior event(s) are
 * hard-deleted before the new one is written. Empirically confirmed during
 * Group H validation: hitting this endpoint twice with the same payload
 * silently doubled the opening stock.
 */
export async function recordInitialBalance(
  distributorId: string,
  userId: string,
  data: {
    entries: { cylinderTypeId: string; openingFulls: number; openingEmpties: number }[];
    eventDate?: string;
    replaceExisting?: boolean;
  },
) {
  const eventDate = data.eventDate ? new Date(data.eventDate) : new Date();
  const replace = data.replaceExisting === true;

  // Pre-flight: enumerate any existing initial_balance events for the
  // submitted cylinder types. Bails out with a structured error if
  // duplicates exist and replace is off.
  const cylinderTypeIds = data.entries.map((e) => e.cylinderTypeId);
  const existing = await prisma.inventoryEvent.findMany({
    where: {
      distributorId,
      eventType: 'initial_balance',
      cylinderTypeId: { in: cylinderTypeIds },
    },
    select: {
      id: true,
      cylinderTypeId: true,
      fullsChange: true,
      emptiesChange: true,
      eventDate: true,
    },
  });

  if (!replace && existing.length > 0) {
    // Aggregate per cylinderTypeId so the response carries the
    // sum-of-current-events (in case there are legacy duplicates).
    const aggByType = new Map<string, { fulls: number; empties: number; eventDate: string }>();
    for (const ev of existing) {
      const prev = aggByType.get(ev.cylinderTypeId);
      const evDate = ev.eventDate.toISOString().split('T')[0];
      if (prev) {
        prev.fulls += ev.fullsChange;
        prev.empties += ev.emptiesChange;
        // Keep the latest eventDate for context
        if (evDate > prev.eventDate) prev.eventDate = evDate;
      } else {
        aggByType.set(ev.cylinderTypeId, {
          fulls: ev.fullsChange,
          empties: ev.emptiesChange,
          eventDate: evDate,
        });
      }
    }
    throw new InitialBalanceConflictError(
      Array.from(aggByType.entries()).map(([cylinderTypeId, v]) => ({
        cylinderTypeId, ...v,
      })),
    );
  }

  const created: { cylinderTypeId: string; eventId: string }[] = [];
  const replacedCount = existing.length;
  // Track the earliest affected eventDate so we recalc summaries from
  // there (existing event date may be older than the new eventDate).
  let earliestRecalcDate = eventDate;

  await prisma.$transaction(async (tx) => {
    if (replace && existing.length > 0) {
      for (const ev of existing) {
        if (ev.eventDate < earliestRecalcDate) earliestRecalcDate = ev.eventDate;
      }
      await tx.inventoryEvent.deleteMany({
        where: { id: { in: existing.map((e) => e.id) } },
      });
    }

    for (const entry of data.entries) {
      const fulls = Math.max(0, Math.floor(entry.openingFulls));
      const empties = Math.max(0, Math.floor(entry.openingEmpties));
      if (fulls === 0 && empties === 0) continue;

      const event = await createInventoryEvent(tx, {
        distributorId,
        cylinderTypeId: entry.cylinderTypeId,
        eventType: 'initial_balance',
        fullsChange: fulls,
        emptiesChange: empties,
        eventDate,
        createdBy: userId,
        notes: replace ? 'Opening balance entry (replaced)' : 'Opening balance entry',
      });
      created.push({ cylinderTypeId: entry.cylinderTypeId, eventId: event.id });
    }
  });

  // Summaries are recalculated outside the transaction (they themselves use
  // their own transaction internally). Use the earliest affected date so a
  // replace at a later date still rebuilds correctly from the old date.
  for (const c of created) {
    await recalculateSummariesFromDate(distributorId, c.cylinderTypeId, earliestRecalcDate);
  }
  // If a replace removed events but the new payload had only zero-zero
  // entries, the deleted cylinder types still need a recalc.
  if (replace) {
    const recalcedTypeIds = new Set(created.map((c) => c.cylinderTypeId));
    const orphanedTypeIds = Array.from(new Set(existing.map((e) => e.cylinderTypeId)))
      .filter((id) => !recalcedTypeIds.has(id));
    for (const cylinderTypeId of orphanedTypeIds) {
      await recalculateSummariesFromDate(distributorId, cylinderTypeId, earliestRecalcDate);
    }
  }

  return { created: created.length, replaced: replacedCount };
}

/**
 * Manual adjustment (add or subtract).
 */
export async function recordManualAdjustment(
  distributorId: string,
  userId: string,
  data: {
    cylinderTypeId: string;
    // WI-3 — defaults to 'fulls' for backward-compat with the original
    // modal which only adjusted fulls. The Empties bucket flows through
    // the computeSummaryForDate manualEmpties term.
    bucket?: 'fulls' | 'empties';
    adjustmentType: 'add' | 'subtract';
    quantity: number;
    reason: string;
    adjustmentDate: string;
  }
) {
  const eventDate = new Date(data.adjustmentDate);
  const bucket = data.bucket ?? 'fulls';
  const change = data.adjustmentType === 'add' ? data.quantity : -data.quantity;

  const event = await prisma.$transaction(async (tx) => {
    return createInventoryEvent(tx, {
      distributorId,
      cylinderTypeId: data.cylinderTypeId,
      eventType: 'manual_adjustment',
      fullsChange: bucket === 'fulls' ? change : 0,
      emptiesChange: bucket === 'empties' ? change : 0,
      eventDate,
      createdBy: userId,
      notes: data.reason,
    });
  });

  // Recalculate AFTER the transaction commits: recalculateSummariesFromDate
  // uses the global prisma client, which cannot see events written via `tx`
  // while the transaction is still open (read-committed isolation).
  await recalculateSummariesFromDate(distributorId, data.cylinderTypeId, eventDate);
  return event;
}

// WI-3 — Adjustment History query. Returns all manual_adjustment events
// for this distributor with filters and pagination. The createdBy column
// is a user id; we look up the user inline so the consumer can render
// "Entered By" without a second round-trip per row.
export async function listManualAdjustments(
  distributorId: string,
  filters: {
    bucket?: 'fulls' | 'empties' | 'all';
    cylinderTypeId?: string;
    dateFrom?: string;
    dateTo?: string;
    page?: number;
    pageSize?: number;
  },
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50));

  const where: Prisma.InventoryEventWhereInput = {
    distributorId,
    eventType: 'manual_adjustment',
  };
  if (filters.cylinderTypeId) where.cylinderTypeId = filters.cylinderTypeId;
  if (filters.dateFrom || filters.dateTo) {
    where.eventDate = {};
    if (filters.dateFrom) where.eventDate.gte = new Date(filters.dateFrom);
    if (filters.dateTo) where.eventDate.lte = new Date(filters.dateTo);
  }
  // bucket filter: a manual_adjustment row is in the Fulls bucket if
  // fullsChange != 0, Empties bucket if emptiesChange != 0. 'all' = no
  // bucket filter.
  if (filters.bucket === 'fulls') where.fullsChange = { not: 0 };
  else if (filters.bucket === 'empties') where.emptiesChange = { not: 0 };

  const [rows, total] = await Promise.all([
    prisma.inventoryEvent.findMany({
      where,
      include: { cylinderType: { select: { typeName: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.inventoryEvent.count({ where }),
  ]);

  // Hydrate createdBy → firstName/lastName for the "Entered By" column.
  const userIds = Array.from(new Set(rows.map((r) => r.createdBy).filter(Boolean)));
  const users = userIds.length === 0
    ? []
    : await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, firstName: true, lastName: true, email: true },
      });
  const userMap = new Map(users.map((u) => [u.id, u]));

  return {
    data: rows.map((r) => {
      const bucket: 'fulls' | 'empties' = r.fullsChange !== 0 ? 'fulls' : 'empties';
      const quantity = bucket === 'fulls' ? r.fullsChange : r.emptiesChange;
      const user = userMap.get(r.createdBy);
      return {
        eventId: r.id,
        cylinderTypeId: r.cylinderTypeId,
        cylinderTypeName: r.cylinderType?.typeName ?? '—',
        bucket,
        quantity,
        reason: r.notes ?? '',
        eventDate: r.eventDate,
        createdAt: r.createdAt,
        enteredByUserId: r.createdBy,
        enteredByName: user ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email : '—',
      };
    }),
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

// WI-3 — admin-only edit of a manual_adjustment's notes (reason) field,
// within 24 hours of creation. The numeric change (qty/bucket) is
// immutable so the closing summary stays consistent — only the
// human-readable rationale can be corrected.
export async function updateManualAdjustmentNotes(
  distributorId: string,
  eventId: string,
  notes: string,
) {
  const existing = await prisma.inventoryEvent.findFirst({
    where: { id: eventId, distributorId, eventType: 'manual_adjustment' },
  });
  if (!existing) throw new InventoryError('Adjustment not found', 404);
  const ageMs = Date.now() - existing.createdAt.getTime();
  if (ageMs > 24 * 3600 * 1000) {
    throw new InventoryError('Adjustments can only be edited within 24 hours of creation', 400);
  }
  return prisma.inventoryEvent.update({
    where: { id: eventId },
    data: { notes },
  });
}

class InventoryError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Return cancelled stock to depot.
 */
export async function returnCancelledStock(
  distributorId: string,
  userId: string,
  data: { eventIds: string[]; returnDate: string; notes?: string }
) {
  const returnDate = new Date(data.returnDate);
  // Collect cylinder types affected inside the tx, then recompute AFTER commit
  // (recalculateSummariesFromDate uses the global prisma client and cannot see
  // the cancellation_return events written via `tx` while the tx is open).
  const affected: { cylinderTypeId: string; eventDate: Date }[] = [];

  const results = await prisma.$transaction(async (tx) => {
    const inner: { eventId: string; status: string }[] = [];
    for (const eventId of data.eventIds) {
      const cse = await tx.cancelledStockEvent.findFirst({
        where: { id: eventId, distributorId, status: 'on_vehicle' },
      });
      if (!cse) continue;

      await tx.cancelledStockEvent.update({
        where: { id: eventId },
        data: { status: 'returned_to_depot', returnedDate: returnDate },
      });

      // Create inventory event for the return.
      // CRITICAL: pin eventDate to cse.cancellationDate (= the trip's
      // deliveryDate when the CSE was created). The matching dispatch
      // event lives on that date; writing the return on `returnDate`
      // (operator-supplied, almost always "today") splits the trip
      // across two daily-summary rows when the admin clicks "Return
      // Cancelled Stock" on a day later than the trip. Both rows then
      // never zero out: dispatch-day shows on-vehicle=+qty forever,
      // return-day shows on-vehicle=−qty forever. Pin to source date.
      await createInventoryEvent(tx, {
        distributorId,
        cylinderTypeId: cse.cylinderTypeId,
        eventType: 'cancellation_return',
        fullsChange: cse.quantity,
        emptiesChange: 0,
        eventDate: cse.cancellationDate,
        referenceId: eventId,
        referenceType: 'cancelled_stock',
        createdBy: userId,
        notes: data.notes || 'Cancelled stock returned to depot',
      });

      affected.push({ cylinderTypeId: cse.cylinderTypeId, eventDate: cse.cancellationDate });
      inner.push({ eventId, status: 'returned_to_depot' });
    }
    return inner;
  });

  for (const { cylinderTypeId, eventDate } of affected) {
    await recalculateSummariesFromDate(distributorId, cylinderTypeId, eventDate);
  }
  return results;
}

/**
 * Get inventory summary for a date.
 */
export async function getInventorySummary(distributorId: string, date: string) {
  const summaryDate = new Date(date);

  const cylinderTypes = await prisma.cylinderType.findMany({
    where: { distributorId, isActive: true },
    select: { id: true, typeName: true, capacity: true, unit: true },
  });

  const summaries = [];
  for (const ct of cylinderTypes) {
    let summary = await prisma.inventorySummary.findUnique({
      where: {
        distributorId_cylinderTypeId_summaryDate: {
          distributorId,
          cylinderTypeId: ct.id,
          summaryDate,
        },
      },
      include: {
        cylinderType: { select: { id: true, typeName: true, capacity: true, unit: true } },
      },
    });

    if (!summary) {
      // Compute on-the-fly
      const computed = await computeSummaryForDate(distributorId, ct.id, summaryDate);
      summary = {
        id: '',
        distributorId,
        cylinderTypeId: ct.id,
        summaryDate,
        ...computed,
        isLocked: false,
        lockedAt: null,
        lockedBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        cylinderType: { id: ct.id, typeName: ct.typeName, capacity: ct.capacity, unit: ct.unit },
      };
    }

    // Get thresholds
    const threshold = await prisma.cylinderThreshold.findUnique({
      where: { distributorId_cylinderTypeId: { distributorId, cylinderTypeId: ct.id } },
    });

    // Derived UI fields for the new inventory model. inFlightFulls drains to
    // zero when every dispatched cylinder is either delivered or returned;
    // emptiesOnVehicle drains to zero when every collected empty is supervisor-
    // verified at reconcile. Non-zero at end-of-day = real anomaly to surface.
    const inFlightFulls =
      (summary.dispatchedQty ?? 0) - (summary.deliveredQty ?? 0) - (summary.cancelledStockQty ?? 0);
    const emptiesOnVehicle =
      (summary.collectedEmpties ?? 0) - (summary.emptiesReturnedVerified ?? 0);
    summaries.push({
      ...summary,
      inFlightFulls,
      emptiesOnVehicle,
      cylinderType: { id: ct.id, typeName: ct.typeName, capacity: ct.capacity, unit: ct.unit },
      cylinderTypeName: ct.typeName,
      thresholdWarning: threshold?.warningLevel ?? null,
      thresholdCritical: threshold?.criticalLevel ?? null,
    });
  }

  return summaries;
}

/**
 * Get cancelled stock events.
 */
export async function getCancelledStock(
  distributorId: string,
  filters: { status?: string; vehicleId?: string; driverId?: string }
) {
  const where: Prisma.CancelledStockEventWhereInput = { distributorId };
  if (filters.status) where.status = filters.status as $Enums.CancelledStockStatus;
  if (filters.vehicleId) where.vehicleId = filters.vehicleId;
  if (filters.driverId) where.driverId = filters.driverId;

  return prisma.cancelledStockEvent.findMany({
    where,
    include: {
      order: { select: { orderNumber: true } },
      vehicle: { select: { vehicleNumber: true } },
      driver: { select: { driverName: true } },
      cylinderType: { select: { typeName: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Check thresholds and return alerts.
 */
export async function checkThresholds(distributorId: string) {
  // summaryDate is @db.Date — must compare against UTC-midnight, not
  // local-midnight (the old `setHours(0,0,0,0)` produced IST midnight,
  // which is the PREVIOUS UTC day; rows with summary_date=today were
  // excluded by `lte: today`, leaving the alert pinned to yesterday's
  // closing stock. Same family as the wipe-script + driver-list bugs,
  // see dateOnly.ts header comment.) — fixed 2026-06-01.
  const today = startOfUtcDay();

  const thresholds = await prisma.cylinderThreshold.findMany({
    where: { distributorId, alertEnabled: true },
    include: { cylinderType: { select: { typeName: true } } },
  });

  const alerts = [];
  for (const threshold of thresholds) {
    const summary = await prisma.inventorySummary.findFirst({
      where: {
        distributorId,
        cylinderTypeId: threshold.cylinderTypeId,
        summaryDate: { lte: today },
      },
      orderBy: { summaryDate: 'desc' },
    });

    const closingFulls = summary?.closingFulls ?? 0;
    if (closingFulls <= threshold.criticalLevel) {
      alerts.push({
        cylinderTypeId: threshold.cylinderTypeId,
        cylinderTypeName: threshold.cylinderType.typeName,
        currentStock: closingFulls,
        level: 'critical',
        threshold: threshold.criticalLevel,
      });
    } else if (closingFulls <= threshold.warningLevel) {
      alerts.push({
        cylinderTypeId: threshold.cylinderTypeId,
        cylinderTypeName: threshold.cylinderType.typeName,
        currentStock: closingFulls,
        level: 'warning',
        threshold: threshold.warningLevel,
      });
    }
  }

  return alerts;
}

/**
 * Get customer inventory balances.
 */
export async function getCustomerBalances(distributorId: string, customerId?: string) {
  const where: Prisma.CustomerInventoryBalanceWhereInput = {};
  if (customerId) where.customerId = customerId;
  // Filter by distributor through customer relation
  where.customer = { distributorId, deletedAt: null };

  const rows = await prisma.customerInventoryBalance.findMany({
    where,
    include: {
      customer: { select: { id: true, customerName: true } },
      cylinderType: { select: { typeName: true } },
    },
  });

  // WI-080: enrich each row with (a) the current price for that cylinder
  // type and (b) the date of the customer's most recent delivery, so the
  // Customer Balances tab can value outstanding cylinders and show how
  // long they've been held without extra round-trips.

  // Latest price per cylinder type (effectiveDate desc → first wins).
  const priceMap = new Map<string, number>();
  {
    const prices = await prisma.cylinderPrice.findMany({
      where: { distributorId },
      orderBy: { effectiveDate: 'desc' },
      select: { cylinderTypeId: true, price: true },
    });
    for (const p of prices) {
      if (!priceMap.has(p.cylinderTypeId)) priceMap.set(p.cylinderTypeId, toNum(p.price));
    }
  }

  // WI-080 amendment: empty cylinder (container replacement) price per
  // type, from the EmptyCylinderPrice table — used to value outstanding
  // cylinders on the Customer Balances tab.
  const emptyPriceMap = new Map<string, number>();
  {
    const emptyPrices = await prisma.emptyCylinderPrice.findMany({
      where: { distributorId },
      select: { cylinderTypeId: true, emptyCylinderPrice: true },
    });
    for (const e of emptyPrices) emptyPriceMap.set(e.cylinderTypeId, toNum(e.emptyCylinderPrice));
  }

  // Most recent delivered order per customer.
  const lastDeliveryMap = new Map<string, Date | null>();
  const customerIds = [...new Set(rows.map((r) => r.customerId))];
  if (customerIds.length > 0) {
    const deliveries = await prisma.order.groupBy({
      by: ['customerId'],
      where: {
        distributorId,
        customerId: { in: customerIds },
        status: { in: ['delivered', 'modified_delivered'] },
        deletedAt: null,
      },
      _max: { deliveryDate: true },
    });
    for (const d of deliveries) lastDeliveryMap.set(d.customerId, d._max.deliveryDate ?? null);
  }

  // Flatten to the shared CustomerInventoryBalance shape — both the
  // Inventory > Customer Balances tab and the Customers detail modal
  // read flat customerName / cylinderTypeName, not the nested relations.
  return rows.map((b) => ({
    customerId: b.customerId,
    customerName: b.customer.customerName,
    cylinderTypeId: b.cylinderTypeId,
    cylinderTypeName: b.cylinderType.typeName,
    withCustomerQty: b.withCustomerQty,
    pendingReturns: b.pendingReturns,
    missingQty: b.missingQty,
    lastUpdated: b.lastUpdated,
    // WI-080 additions:
    cylinderPrice: priceMap.get(b.cylinderTypeId) ?? null,
    emptyCylinderPrice: emptyPriceMap.get(b.cylinderTypeId) ?? null,
    lastDeliveryDate: lastDeliveryMap.get(b.customerId) ?? null,
  }));
}

/**
 * Lock/unlock daily summary.
 */
export async function lockSummary(
  distributorId: string,
  cylinderTypeId: string,
  date: string,
  userId: string,
  lock: boolean
) {
  const summaryDate = new Date(date);

  return prisma.inventorySummary.upsert({
    where: {
      distributorId_cylinderTypeId_summaryDate: {
        distributorId,
        cylinderTypeId,
        summaryDate,
      },
    },
    create: {
      distributorId,
      cylinderTypeId,
      summaryDate,
      isLocked: lock,
      lockedAt: lock ? new Date() : null,
      lockedBy: lock ? userId : null,
    },
    update: {
      isLocked: lock,
      lockedAt: lock ? new Date() : null,
      lockedBy: lock ? userId : null,
    },
  });
}

/**
 * Lock or unlock ALL inventory summaries for a given date (day-level).
 * Mirrors the per-cylinder-type lockSummary() above, but operates on every
 * summary row for the date — this is what the "Lock Day" button on the
 * Inventory page drives.
 */
export async function setSummaryLockForDate(
  distributorId: string,
  date: string,
  userId: string,
  lock: boolean
) {
  const summaryDate = new Date(date);

  const result = await prisma.inventorySummary.updateMany({
    where: { distributorId, summaryDate },
    data: {
      isLocked: lock,
      lockedAt: lock ? new Date() : null,
      lockedBy: lock ? userId : null,
    },
  });

  return { affectedCount: result.count, date, locked: lock };
}

/**
 * Unlock all inventory summaries for a given date.
 */
export async function unlockSummariesForDate(
  distributorId: string,
  date: string,
  _userId: string
) {
  const summaryDate = new Date(date);

  const result = await prisma.inventorySummary.updateMany({
    where: {
      distributorId,
      summaryDate,
      isLocked: true,
    },
    data: {
      isLocked: false,
      lockedAt: null,
      lockedBy: null,
    },
  });

  return { unlockedCount: result.count, date };
}

/**
 * Inventory forecast using simple moving average from last 30 days.
 */
export async function getInventoryForecast(distributorId: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const cylinderTypes = await prisma.cylinderType.findMany({
    where: { distributorId, isActive: true },
    select: { id: true, typeName: true },
  });

  const forecasts = [];
  for (const ct of cylinderTypes) {
    // Get delivery events from last 30 days
    const deliveryEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId,
        cylinderTypeId: ct.id,
        eventType: 'delivery',
        eventDate: { gte: thirtyDaysAgo, lte: today },
      },
      select: { fullsChange: true, eventDate: true },
    });

    const totalDelivered = deliveryEvents.reduce((sum, e) => sum + Math.abs(e.fullsChange), 0);
    const daysWithData = new Set(deliveryEvents.map(e => e.eventDate.toISOString().split('T')[0])).size;
    const avgDailyDemand = daysWithData > 0 ? totalDelivered / 30 : 0;

    // Get current stock
    const latestSummary = await prisma.inventorySummary.findFirst({
      where: { distributorId, cylinderTypeId: ct.id },
      orderBy: { summaryDate: 'desc' },
    });
    const currentStock = latestSummary?.closingFulls ?? 0;
    const daysOfStockRemaining = avgDailyDemand > 0 ? Math.floor(currentStock / avgDailyDemand) : 999;

    // Determine trend
    const firstHalf = deliveryEvents.filter(e => e.eventDate < new Date(today.getTime() - 15 * 86400000));
    const secondHalf = deliveryEvents.filter(e => e.eventDate >= new Date(today.getTime() - 15 * 86400000));
    const firstHalfAvg = firstHalf.length > 0 ? firstHalf.reduce((s, e) => s + Math.abs(e.fullsChange), 0) / 15 : 0;
    const secondHalfAvg = secondHalf.length > 0 ? secondHalf.reduce((s, e) => s + Math.abs(e.fullsChange), 0) / 15 : 0;
    let trendDirection: 'increasing' | 'stable' | 'decreasing' = 'stable';
    if (secondHalfAvg > firstHalfAvg * 1.1) trendDirection = 'increasing';
    else if (secondHalfAvg < firstHalfAvg * 0.9) trendDirection = 'decreasing';

    forecasts.push({
      cylinderTypeId: ct.id,
      cylinderTypeName: ct.typeName,
      currentStock,
      averageDailyDemand: Math.round(avgDailyDemand * 100) / 100,
      daysOfStockRemaining,
      forecastedDemand7Days: Math.round(avgDailyDemand * 7),
      forecastedDemand30Days: Math.round(avgDailyDemand * 30),
      recommendedReorderQty: Math.max(Math.round(avgDailyDemand * 14) - currentStock, 0),
      trendDirection,
    });
  }

  return forecasts;
}

/**
 * WI-080: opening stock recorded at onboarding. Returns the
 * `initial_balance` InventoryEvent rows for the distributor, flattened
 * to { cylinderTypeName, openingFulls, openingEmpties, dateSet }.
 * Read-only — drives the "Stock at Onboarding" tab.
 */
export async function getOnboardingStock(distributorId: string) {
  const events = await prisma.inventoryEvent.findMany({
    where: { distributorId, eventType: 'initial_balance' },
    include: { cylinderType: { select: { typeName: true } } },
    orderBy: [{ eventDate: 'asc' }, { createdAt: 'asc' }],
  });
  return events.map((e) => ({
    cylinderTypeId: e.cylinderTypeId,
    cylinderTypeName: e.cylinderType.typeName,
    openingFulls: e.fullsChange,
    openingEmpties: e.emptiesChange,
    dateSet: e.eventDate,
  }));
}

/**
 * Get depot history: paginated incoming_fulls and outgoing_empties events.
 */
export async function getDepotHistory(
  distributorId: string,
  filters: {
    page?: number;
    pageSize?: number;
    eventType?: 'incoming_fulls' | 'outgoing_empties';
    dateFrom?: string;
    dateTo?: string;
  }
) {
  const page = filters.page ?? 1;
  const pageSize = Math.min(filters.pageSize ?? 20, 100);
  const skip = (page - 1) * pageSize;

  const where: Prisma.InventoryEventWhereInput = {
    distributorId,
    eventType: { in: ['incoming_fulls', 'outgoing_empties'] },
  };

  if (filters.eventType) {
    where.eventType = filters.eventType as $Enums.InventoryEventType;
  }

  if (filters.dateFrom || filters.dateTo) {
    where.eventDate = {};
    if (filters.dateFrom) where.eventDate.gte = new Date(filters.dateFrom);
    if (filters.dateTo) where.eventDate.lte = new Date(filters.dateTo);
  }

  const [events, total] = await Promise.all([
    prisma.inventoryEvent.findMany({
      where,
      include: {
        cylinderType: { select: { typeName: true } },
      },
      orderBy: [{ eventDate: 'desc' }, { createdAt: 'desc' }],
      skip,
      take: pageSize,
    }),
    prisma.inventoryEvent.count({ where }),
  ]);

  return {
    events,
    meta: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}

/**
 * Get reconciliation dashboard data.
 */
export async function getReconciliationDashboard(distributorId: string) {
  const [pendingReturn, onVehicle, returnedToDepot] = await Promise.all([
    prisma.cancelledStockEvent.count({ where: { distributorId, status: 'pending_return' } }),
    prisma.cancelledStockEvent.count({ where: { distributorId, status: 'on_vehicle' } }),
    prisma.cancelledStockEvent.count({ where: { distributorId, status: 'returned_to_depot' } }),
  ]);

  const cancelledByType = await prisma.cancelledStockEvent.groupBy({
    by: ['cylinderTypeId', 'status'],
    where: { distributorId },
    _sum: { quantity: true },
  });

  return { pendingReturn, onVehicle, returnedToDepot, cancelledByType };
}
