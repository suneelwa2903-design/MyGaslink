/**
 * Mini-Operator (2026-07-16) — Purchase Entry service.
 *
 * A PurchaseEntry is a mini-operator's record of stock received from a
 * source distributor on a given date. Each item may have non-zero
 * `fullsReceived`, non-zero `emptiesGivenOut`, or both.
 *
 * Every write is wrapped in a `prisma.$transaction` so the entry, its
 * items, and the derived InventoryEvent rows commit atomically:
 *   1. allocateNumber(tx, distributorId, 'P', ...) — atomic sequence
 *      from the shared invoice_counters table.
 *   2. Resolve `sourceDistributorName` snapshot from the FK.
 *   3. Create PurchaseEntry + PurchaseEntryItem rows.
 *   4. For each item with fullsReceived > 0 → `incoming_fulls` event
 *      (fullsChange=+received, emptiesChange=0).
 *   5. For each item with emptiesGivenOut > 0 → `outgoing_empties` event
 *      (fullsChange=0, emptiesChange=−given). Sign convention matches
 *      inventoryService.recordOutgoingEmpties + the aggregation code at
 *      computeSummaryForDate.
 *
 * Reverse-out on delete: creates negating events so InventorySummary
 * self-heals the next time it's recomputed (see recomputeSummary or the
 * lazy on-demand path via GET /api/inventory/summary).
 */
import { prisma } from '../lib/prisma.js';
import type { Prisma, PrismaClient } from '@prisma/client';
import { allocateNumber } from './numberingService.js';
import { createInventoryEvent, recalculateSummariesFromDate } from './inventoryService.js';

type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

const purchaseEntryItemSelect = {
  id: true,
  purchaseEntryId: true,
  cylinderTypeId: true,
  fullsReceived: true,
  emptiesGivenOut: true,
  unitPrice: true,
  cylinderType: { select: { id: true, typeName: true } },
} satisfies Prisma.PurchaseEntryItemSelect;

const purchaseEntrySelect = {
  id: true,
  purchaseNumber: true,
  distributorId: true,
  sourceDistributorId: true,
  sourceDistributorName: true,
  purchaseDate: true,
  notes: true,
  // Mini-Operator 2026-07-19: expose the running amountPaid so the
  // mobile Purchases list can render a paid/owed chip per entry.
  // Consumers compare against sum(items.unitPrice * items.fullsReceived)
  // to compute outstanding.
  amountPaid: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  items: { select: purchaseEntryItemSelect },
} satisfies Prisma.PurchaseEntrySelect;

export class PurchaseEntryError extends Error {
  constructor(message: string, public statusCode: number, public code?: string) {
    super(message);
    this.name = 'PurchaseEntryError';
  }
}

type PurchaseItemInput = {
  cylinderTypeId: string;
  fullsReceived: number;
  emptiesGivenOut: number;
  /// Per-unit price (INR, GST-inclusive). Defaults to 0 when the client
  /// omits it — old clients still work, existing rows keep their default.
  unitPrice?: number;
};

export type CreatePurchaseEntryData = {
  sourceDistributorId?: string;
  purchaseDate: string;
  notes?: string;
  items: PurchaseItemInput[];
};

export type UpdatePurchaseEntryData = CreatePurchaseEntryData;

/**
 * Emit the incoming_fulls / outgoing_empties inventory events for a single
 * purchase-entry item. Shared with the delete path (which passes negated
 * quantities to reverse the movement). eventDate is the same DB Date the
 * inventory summary keys on so a same-day re-derive picks up the effect.
 */
async function emitInventoryEventsForItem(
  tx: TxClient,
  args: {
    distributorId: string;
    cylinderTypeId: string;
    fullsChange: number;
    emptiesGivenOut: number;
    eventDate: Date;
    referenceId: string;
    documentNumber: string;
    createdBy: string;
  },
): Promise<void> {
  const { distributorId, cylinderTypeId, fullsChange, emptiesGivenOut, eventDate, referenceId, documentNumber, createdBy } = args;
  if (fullsChange !== 0) {
    await createInventoryEvent(tx, {
      distributorId,
      cylinderTypeId,
      eventType: 'incoming_fulls',
      fullsChange,
      emptiesChange: 0,
      eventDate,
      referenceId,
      referenceType: 'purchase_entry',
      documentType: 'purchase_entry',
      documentNumber,
      createdBy,
    });
  }
  if (emptiesGivenOut !== 0) {
    await createInventoryEvent(tx, {
      distributorId,
      cylinderTypeId,
      eventType: 'outgoing_empties',
      fullsChange: 0,
      // Sign convention (see inventoryService.recordOutgoingEmpties): the
      // event stores emptiesChange as a negative for outbound, and the
      // summary aggregator takes Math.abs() to compute the outgoingEmpties
      // bucket. `emptiesGivenOut` is +N in the incoming direction so we
      // negate here.
      emptiesChange: -emptiesGivenOut,
      eventDate,
      referenceId,
      referenceType: 'purchase_entry',
      documentType: 'purchase_entry',
      documentNumber,
      createdBy,
    });
  }
}

export async function createPurchaseEntry(
  distributorId: string,
  createdBy: string,
  data: CreatePurchaseEntryData,
) {
  // Sanity: at least one item must carry a non-zero movement — a purchase
  // entry with every item at 0/0 is a no-op that would clutter reports.
  const hasMovement = data.items.some(
    (i) => (i.fullsReceived ?? 0) > 0 || (i.emptiesGivenOut ?? 0) > 0,
  );
  if (!hasMovement) {
    throw new PurchaseEntryError(
      'Purchase entry must include at least one non-zero item movement',
      400,
      'EMPTY_MOVEMENT',
    );
  }

  // Resolve source distributor + capture the name snapshot BEFORE opening
  // the transaction (tenant validation is cheap and doesn't need the tx).
  let sourceDistributorName: string | null = null;
  if (data.sourceDistributorId) {
    const src = await prisma.sourceDistributor.findFirst({
      where: {
        id: data.sourceDistributorId,
        distributorId, // tenant scoping — cross-tenant IDs return null
        deletedAt: null,
      },
      select: { id: true, name: true },
    });
    if (!src) {
      throw new PurchaseEntryError(
        'Source distributor not found for this tenant',
        400,
        'SOURCE_DISTRIBUTOR_NOT_FOUND',
      );
    }
    sourceDistributorName = src.name;
  }

  // Guard: every cylinderType must belong to this distributor. The FK on
  // PurchaseEntryItem doesn't check tenant — we do so explicitly.
  const cylinderTypeIds = Array.from(new Set(data.items.map((i) => i.cylinderTypeId)));
  const validTypes = await prisma.cylinderType.findMany({
    where: { id: { in: cylinderTypeIds }, distributorId, isActive: true },
    select: { id: true },
  });
  if (validTypes.length !== cylinderTypeIds.length) {
    throw new PurchaseEntryError(
      'One or more cylinder types are invalid for this tenant',
      400,
      'INVALID_CYLINDER_TYPES',
    );
  }

  // Fetch docCode for structured numbering — allocate inside the tx.
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { docCode: true },
  });
  if (!distributor?.docCode) {
    throw new PurchaseEntryError(
      'Distributor has no docCode configured — set one under Distributor settings before recording purchases',
      400,
      'NO_DOC_CODE',
    );
  }

  const purchaseDateObj = new Date(data.purchaseDate);
  if (Number.isNaN(purchaseDateObj.getTime())) {
    throw new PurchaseEntryError('Invalid purchase date', 400, 'INVALID_DATE');
  }

  return prisma.$transaction(async (tx) => {
    const purchaseNumber = await allocateNumber(
      tx,
      distributorId,
      'P',
      purchaseDateObj,
      distributor.docCode!,
    );

    const created = await tx.purchaseEntry.create({
      data: {
        purchaseNumber,
        distributorId,
        sourceDistributorId: data.sourceDistributorId ?? null,
        sourceDistributorName,
        purchaseDate: data.purchaseDate,
        notes: data.notes?.trim() || null,
        createdBy,
        items: {
          create: data.items.map((i) => ({
            cylinderTypeId: i.cylinderTypeId,
            fullsReceived: Math.max(0, Math.floor(i.fullsReceived ?? 0)),
            emptiesGivenOut: Math.max(0, Math.floor(i.emptiesGivenOut ?? 0)),
            unitPrice: Math.max(0, Number(i.unitPrice ?? 0)),
          })),
        },
      },
      select: purchaseEntrySelect,
    });

    for (const item of created.items) {
      await emitInventoryEventsForItem(tx, {
        distributorId,
        cylinderTypeId: item.cylinderTypeId,
        fullsChange: item.fullsReceived,
        emptiesGivenOut: item.emptiesGivenOut,
        eventDate: purchaseDateObj,
        referenceId: created.id,
        documentNumber: purchaseNumber,
        createdBy,
      });
    }

    return created;
  });
}

export async function listPurchaseEntries(
  distributorId: string,
  filters: {
    from?: string;
    to?: string;
    sourceDistributorId?: string;
    page?: number;
    pageSize?: number;
  },
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));

  const where: Prisma.PurchaseEntryWhereInput = {
    distributorId,
    deletedAt: null,
  };
  if (filters.sourceDistributorId) {
    where.sourceDistributorId = filters.sourceDistributorId;
  }
  if (filters.from || filters.to) {
    where.purchaseDate = {};
    if (filters.from) (where.purchaseDate as { gte?: string }).gte = filters.from;
    if (filters.to) (where.purchaseDate as { lte?: string }).lte = filters.to;
  }

  const [total, rows] = await Promise.all([
    prisma.purchaseEntry.count({ where }),
    prisma.purchaseEntry.findMany({
      where,
      select: purchaseEntrySelect,
      orderBy: [{ purchaseDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return {
    data: rows,
    meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}

export async function getPurchaseEntry(
  distributorId: string,
  purchaseEntryId: string,
) {
  return prisma.purchaseEntry.findFirst({
    // Both clauses always — anti-pattern #13.
    where: { id: purchaseEntryId, distributorId, deletedAt: null },
    select: purchaseEntrySelect,
  });
}

/**
 * Update = delete-and-recreate. The write path is:
 *   1. Load the existing entry (tenant scoped) — 404 if missing.
 *   2. Hard-delete every InventoryEvent that references this entry
 *      (same rationale as the delete path — reversal events would double
 *      the outgoingEmpties bucket because the aggregator uses Math.abs).
 *   3. Delete every PurchaseEntryItem row (they get re-created below).
 *   4. Update header fields (sourceDistributorId, sourceDistributorName
 *      snapshot, purchaseDate, notes) + re-create items with the new
 *      quantities + unit prices.
 *   5. Re-emit incoming_fulls / outgoing_empties InventoryEvent rows
 *      for the new items (movement magnitude driven by the new values).
 *   6. Recompute InventorySummary for every cylinder type touched by
 *      EITHER the old OR the new item list so cached rows self-heal.
 *
 * purchaseNumber is preserved (audit trail continuity) — the caller does
 * NOT provide it.
 */
export async function updatePurchaseEntry(
  distributorId: string,
  purchaseEntryId: string,
  createdBy: string,
  data: UpdatePurchaseEntryData,
) {
  const hasMovement = data.items.some(
    (i) => (i.fullsReceived ?? 0) > 0 || (i.emptiesGivenOut ?? 0) > 0,
  );
  if (!hasMovement) {
    throw new PurchaseEntryError(
      'Purchase entry must include at least one non-zero item movement',
      400,
      'EMPTY_MOVEMENT',
    );
  }

  // Resolve source distributor + capture the name snapshot BEFORE the tx.
  let sourceDistributorName: string | null = null;
  if (data.sourceDistributorId) {
    const src = await prisma.sourceDistributor.findFirst({
      where: {
        id: data.sourceDistributorId,
        distributorId,
        deletedAt: null,
      },
      select: { id: true, name: true },
    });
    if (!src) {
      throw new PurchaseEntryError(
        'Source distributor not found for this tenant',
        400,
        'SOURCE_DISTRIBUTOR_NOT_FOUND',
      );
    }
    sourceDistributorName = src.name;
  }

  const cylinderTypeIds = Array.from(new Set(data.items.map((i) => i.cylinderTypeId)));
  const validTypes = await prisma.cylinderType.findMany({
    where: { id: { in: cylinderTypeIds }, distributorId, isActive: true },
    select: { id: true },
  });
  if (validTypes.length !== cylinderTypeIds.length) {
    throw new PurchaseEntryError(
      'One or more cylinder types are invalid for this tenant',
      400,
      'INVALID_CYLINDER_TYPES',
    );
  }

  const existing = await prisma.purchaseEntry.findFirst({
    where: { id: purchaseEntryId, distributorId, deletedAt: null },
    select: purchaseEntrySelect,
  });
  if (!existing) {
    throw new PurchaseEntryError('Purchase entry not found', 404, 'NOT_FOUND');
  }

  const purchaseDateObj = new Date(data.purchaseDate);
  if (Number.isNaN(purchaseDateObj.getTime())) {
    throw new PurchaseEntryError('Invalid purchase date', 400, 'INVALID_DATE');
  }
  const oldPurchaseDateObj = new Date(existing.purchaseDate);

  const updated = await prisma.$transaction(async (tx) => {
    // 1) Nuke the old InventoryEvent rows tied to this entry.
    await tx.inventoryEvent.deleteMany({
      where: {
        distributorId,
        referenceId: purchaseEntryId,
        referenceType: 'purchase_entry',
      },
    });

    // 2) Nuke the old items — Prisma has no cascade at model layer, we do
    // it explicitly. FK to PurchaseEntry stays valid because we just wipe
    // the child rows.
    await tx.purchaseEntryItem.deleteMany({
      where: { purchaseEntryId },
    });

    // 3) Update header + create new items.
    const next = await tx.purchaseEntry.update({
      where: { id: purchaseEntryId },
      data: {
        sourceDistributorId: data.sourceDistributorId ?? null,
        sourceDistributorName,
        purchaseDate: data.purchaseDate,
        notes: data.notes?.trim() || null,
        items: {
          create: data.items.map((i) => ({
            cylinderTypeId: i.cylinderTypeId,
            fullsReceived: Math.max(0, Math.floor(i.fullsReceived ?? 0)),
            emptiesGivenOut: Math.max(0, Math.floor(i.emptiesGivenOut ?? 0)),
            unitPrice: Math.max(0, Number(i.unitPrice ?? 0)),
          })),
        },
      },
      select: purchaseEntrySelect,
    });

    // 4) Re-emit InventoryEvent rows for the new state.
    for (const item of next.items) {
      await emitInventoryEventsForItem(tx, {
        distributorId,
        cylinderTypeId: item.cylinderTypeId,
        fullsChange: item.fullsReceived,
        emptiesGivenOut: item.emptiesGivenOut,
        eventDate: purchaseDateObj,
        referenceId: next.id,
        documentNumber: next.purchaseNumber,
        createdBy,
      });
    }

    return next;
  });

  // 5) Recompute InventorySummary for every cylinder type touched by the
  // OLD or NEW item lists (a type could have been removed on edit — its
  // cached summary still needs a refresh). Start from the EARLIER of the
  // two dates so a moved-earlier entry sweeps forward correctly.
  const affectedTypes = new Set<string>([
    ...existing.items.map((i) => i.cylinderTypeId),
    ...updated.items.map((i) => i.cylinderTypeId),
  ]);
  const sweepFrom = purchaseDateObj < oldPurchaseDateObj ? purchaseDateObj : oldPurchaseDateObj;
  for (const cylinderTypeId of affectedTypes) {
    await recalculateSummariesFromDate(distributorId, cylinderTypeId, sweepFrom);
  }

  return updated;
}

export async function deletePurchaseEntry(
  distributorId: string,
  purchaseEntryId: string,
) {
  const existing = await prisma.purchaseEntry.findFirst({
    where: { id: purchaseEntryId, distributorId, deletedAt: null },
    select: purchaseEntrySelect,
  });
  if (!existing) {
    throw new PurchaseEntryError('Purchase entry not found', 404, 'NOT_FOUND');
  }

  const purchaseDateObj = new Date(existing.purchaseDate);
  const affectedTypes = Array.from(new Set(existing.items.map((i) => i.cylinderTypeId)));

  // Rationale for hard-delete of derived events (not "emit reversal events"):
  //
  // The `outgoing_empties` summary aggregator at inventoryService.ts uses
  // `Math.abs(event.emptiesChange)` — so a naive reversal event with +N
  // emptiesChange would still increment the outgoingEmpties bucket instead
  // of undoing the original debit. Hard-deleting the derived rows via
  // (distributorId, referenceId, referenceType) is unambiguous — those
  // rows exist solely because of this purchase entry — and lets the summary
  // recompute pass restore the correct closing values. The PurchaseEntry
  // itself is soft-deleted so the audit trail keeps the header + line items.
  await prisma.$transaction(async (tx) => {
    await tx.inventoryEvent.deleteMany({
      where: {
        distributorId,
        referenceId: purchaseEntryId,
        referenceType: 'purchase_entry',
      },
    });
    await tx.purchaseEntry.update({
      where: { id: purchaseEntryId },
      data: { deletedAt: new Date() },
    });
  });

  // Recompute cached InventorySummary rows for each affected cylinder type
  // from the purchase date forward — cached rows would otherwise still
  // include the deleted events' effect on `closingFulls` / `closingEmpties`.
  for (const cylinderTypeId of affectedTypes) {
    await recalculateSummariesFromDate(distributorId, cylinderTypeId, purchaseDateObj);
  }
}
