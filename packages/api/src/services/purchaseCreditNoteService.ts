/**
 * F8 Supplier Ledger (2026-08-06) — Purchase Credit Note service.
 *
 * A PurchaseCreditNote records a CN the DISTRIBUTOR received from an OMC
 * supplier (volume incentive, quality claim, freight reimbursement, etc.).
 * Distinct from `CreditNote` (customer-side, distributor-issued).
 *
 * Per Suneel 2026-08-06:
 *   • Every CN is a financial incentive (no GST/ITC handling). No
 *     type=gst|financial toggle.
 *   • OMCs do NOT issue CNs for defective returns — that path is out of
 *     scope. Defective loss is absorbed in the next incoming invoice's
 *     smaller quantity.
 *   • Every CN MUST be allocated to one or more specific PurchaseEntry
 *     rows. No on-account state. Sum(allocations) == totalAmount.
 *
 * Tenant scoping: distributorId always sourced from `req.user.distributorId`;
 * every query filters on distributorId (anti-pattern #13). PurchaseEntry
 * FKs on allocations are re-verified in the transaction to prevent
 * cross-tenant leakage.
 *
 * Numbering: uses allocateNumber(type='X') when the distributor has a
 * docCode set; falls back to unstructured `PCN-<time36>` otherwise (same
 * pattern as F1 DefectiveReturnBatch).
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

// F8 v2 (2026-08-06) — no allocateNumber import. Per Suneel: OMC issues
// the CN and gives us their reference number. We're pure data-entry; we
// don't generate our own internal CN number.

export class PurchaseCreditNoteError extends Error {
  constructor(message: string, public statusCode: number, public code?: string) {
    super(message);
    this.name = 'PurchaseCreditNoteError';
  }
}

const purchaseCreditNoteSelect = {
  id: true,
  distributorId: true,
  sourceDistributorId: true,
  sourceDistributorName: true,
  creditNoteNumber: true,
  supplierDocumentNumber: true,
  creditNoteDate: true,
  receivedDate: true,
  totalAmount: true,
  reason: true,
  notes: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  allocations: {
    select: {
      id: true,
      purchaseCreditNoteId: true,
      purchaseEntryId: true,
      amount: true,
      createdAt: true,
      purchaseEntry: {
        select: {
          purchaseNumber: true,
          purchaseDate: true,
          supplierDocumentNumber: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.PurchaseCreditNoteSelect;

type PurchaseCreditNoteRow = Prisma.PurchaseCreditNoteGetPayload<{
  select: typeof purchaseCreditNoteSelect;
}>;

function toWire(row: PurchaseCreditNoteRow) {
  return {
    id: row.id,
    distributorId: row.distributorId,
    sourceDistributorId: row.sourceDistributorId,
    sourceDistributorName: row.sourceDistributorName,
    creditNoteNumber: row.creditNoteNumber,
    supplierDocumentNumber: row.supplierDocumentNumber,
    creditNoteDate: row.creditNoteDate,
    receivedDate: row.receivedDate,
    totalAmount: Number(row.totalAmount),
    reason: row.reason,
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    allocations: row.allocations.map((a) => ({
      id: a.id,
      purchaseCreditNoteId: a.purchaseCreditNoteId,
      purchaseEntryId: a.purchaseEntryId,
      purchaseEntryNumber: a.purchaseEntry?.purchaseNumber ?? undefined,
      purchaseEntryDate: a.purchaseEntry?.purchaseDate ?? undefined,
      amount: Number(a.amount),
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

export async function createPurchaseCreditNote(
  distributorId: string,
  userId: string,
  data: {
    sourceDistributorId: string;
    // F8 v2 (2026-08-06) — CN number as printed on OMC's physical CN
    // document. Required; we don't auto-generate. Unique per tenant.
    creditNoteNumber: string;
    creditNoteDate: string;
    receivedDate: string;
    supplierDocumentNumber?: string; // kept for backward-compat; usually same as creditNoteNumber
    totalAmount: number;
    reason:
      | 'volume_incentive'
      | 'quality_incentive'
      | 'scheme_incentive'
      | 'rate_differential'
      | 'freight_reimbursement'
      | 'other';
    notes?: string;
    allocations: Array<{ purchaseEntryId: string; amount: number }>;
  },
) {
  // Guardrail 1 — supplier must belong to this tenant (anti-pattern #13).
  const supplier = await prisma.sourceDistributor.findFirst({
    where: { id: data.sourceDistributorId, distributorId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!supplier) {
    throw new PurchaseCreditNoteError('Supplier not found', 404, 'SUPPLIER_NOT_FOUND');
  }

  // Guardrail 2 — allocations must sum to totalAmount (2-decimal tolerance).
  // The zod schema already checks this at the route boundary; we defend
  // again inside the service so any programmatic caller stays honest.
  if (data.allocations.length === 0) {
    throw new PurchaseCreditNoteError(
      'At least one allocation is required',
      400,
      'ALLOCATIONS_EMPTY',
    );
  }
  const allocSum = data.allocations.reduce((s, a) => s + a.amount, 0);
  if (Math.abs(allocSum - data.totalAmount) > 0.01) {
    throw new PurchaseCreditNoteError(
      `Sum of allocations (${allocSum.toFixed(2)}) must equal totalAmount (${data.totalAmount.toFixed(2)})`,
      400,
      'ALLOCATION_SUM_MISMATCH',
    );
  }

  // Guardrail 3 — every allocation must reference a PurchaseEntry owned by
  // this tenant + issued to THIS supplier (a CN from HPCL cannot offset an
  // IOCL invoice). Cross-tenant OR cross-supplier IDs → 404.
  const entryIds = Array.from(new Set(data.allocations.map((a) => a.purchaseEntryId)));
  const entries = await prisma.purchaseEntry.findMany({
    where: {
      id: { in: entryIds },
      distributorId,
      sourceDistributorId: supplier.id,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (entries.length !== entryIds.length) {
    throw new PurchaseCreditNoteError(
      'One or more allocations reference an invalid or cross-supplier PurchaseEntry',
      400,
      'INVALID_ALLOCATION_TARGET',
    );
  }

  // Guardrail 4 — every allocation.amount must be strictly positive. Zod
  // enforces this too but the service defends the invariant.
  if (data.allocations.some((a) => !(a.amount > 0))) {
    throw new PurchaseCreditNoteError(
      'Every allocation amount must be positive',
      400,
      'ALLOCATION_NON_POSITIVE',
    );
  }

  // F8 v2 (2026-08-06) — OMC's CN number, entered by operator. Uniqueness
  // guarded by DB unique index (distributorId, creditNoteNumber); catch
  // Prisma P2002 to surface a friendly 409 to the caller.
  const creditNoteNumber = data.creditNoteNumber.trim();
  if (!creditNoteNumber) {
    throw new PurchaseCreditNoteError(
      'CN number (from OMC document) is required',
      400,
      'CREDIT_NOTE_NUMBER_REQUIRED',
    );
  }
  const existing = await prisma.purchaseCreditNote.findFirst({
    where: { distributorId, creditNoteNumber, deletedAt: null },
    select: { id: true },
  });
  if (existing) {
    throw new PurchaseCreditNoteError(
      `A credit note with number '${creditNoteNumber}' already exists for this tenant`,
      409,
      'DUPLICATE_CREDIT_NOTE_NUMBER',
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    const cn = await tx.purchaseCreditNote.create({
      data: {
        distributorId,
        sourceDistributorId: supplier.id,
        sourceDistributorName: supplier.name,
        creditNoteNumber,
        supplierDocumentNumber: data.supplierDocumentNumber?.trim() || null,
        creditNoteDate: data.creditNoteDate,
        receivedDate: data.receivedDate,
        totalAmount: data.totalAmount,
        reason: data.reason,
        notes: data.notes?.trim() || null,
        createdBy: userId,
        allocations: {
          create: data.allocations.map((a) => ({
            purchaseEntryId: a.purchaseEntryId,
            amount: a.amount,
          })),
        },
      },
      select: purchaseCreditNoteSelect,
    });

    return cn;
  });

  return toWire(created);
}

/** List CNs for a tenant. Optional supplier + date-range filters. */
export async function listPurchaseCreditNotes(
  distributorId: string,
  filters: { sourceDistributorId?: string; from?: string; to?: string } = {},
) {
  const rows = await prisma.purchaseCreditNote.findMany({
    where: {
      distributorId,
      deletedAt: null,
      ...(filters.sourceDistributorId ? { sourceDistributorId: filters.sourceDistributorId } : {}),
      ...(filters.from || filters.to
        ? {
            creditNoteDate: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
    },
    select: purchaseCreditNoteSelect,
    orderBy: [{ creditNoteDate: 'desc' }, { createdAt: 'desc' }],
    take: 200,
  });
  return rows.map(toWire);
}

/** Fetch a single CN by id, scoped to tenant. */
export async function getPurchaseCreditNote(distributorId: string, id: string) {
  const row = await prisma.purchaseCreditNote.findFirst({
    where: { id, distributorId, deletedAt: null },
    select: purchaseCreditNoteSelect,
  });
  if (!row) return null;
  return toWire(row);
}

/**
 * Soft-delete + reverse a CN. Cascades: PurchaseCreditNoteAllocation rows
 * are removed via onDelete: Cascade on the FK, but soft-delete of the
 * parent leaves them intact for audit. If a caller needs a real hard
 * reversal (rare — office wrote the CN by mistake), the same operation
 * runs inside a tx and the FKs cascade on hard delete.
 *
 * Policy: soft-delete only — a CN reversal is a real business event, not
 * a "never happened" fix. The soft-deleted CN drops OUT of the supplier
 * ledger reader v2, so the running balance restores automatically.
 */
export async function reversePurchaseCreditNote(distributorId: string, id: string) {
  const cn = await prisma.purchaseCreditNote.findFirst({
    where: { id, distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!cn) {
    throw new PurchaseCreditNoteError('Credit note not found', 404, 'NOT_FOUND');
  }
  await prisma.purchaseCreditNote.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  return { id, reversed: true };
}
