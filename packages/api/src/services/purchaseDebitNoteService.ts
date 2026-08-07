/**
 * F8 v2 Supplier Ledger (2026-08-06) — Purchase Debit Note service.
 *
 * Mirror of purchaseCreditNoteService.ts. OMC issues a DN (rare: short-
 * supply detected at plant, damage during storage, late-payment interest,
 * rate diff true-up). We're pure data-entry — OMC gives us their number,
 * we type it in. No auto-generation.
 *
 * Every DN MUST be allocated across one or more PurchaseEntry rows
 * belonging to the SAME supplier + tenant. Sum(allocations) == totalAmount.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export class PurchaseDebitNoteError extends Error {
  constructor(message: string, public statusCode: number, public code?: string) {
    super(message);
    this.name = 'PurchaseDebitNoteError';
  }
}

const purchaseDebitNoteSelect = {
  id: true,
  distributorId: true,
  sourceDistributorId: true,
  sourceDistributorName: true,
  debitNoteNumber: true,
  supplierDocumentNumber: true,
  debitNoteDate: true,
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
      purchaseDebitNoteId: true,
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
} satisfies Prisma.PurchaseDebitNoteSelect;

type Row = Prisma.PurchaseDebitNoteGetPayload<{ select: typeof purchaseDebitNoteSelect }>;

function toWire(row: Row) {
  return {
    id: row.id,
    distributorId: row.distributorId,
    sourceDistributorId: row.sourceDistributorId,
    sourceDistributorName: row.sourceDistributorName,
    debitNoteNumber: row.debitNoteNumber,
    supplierDocumentNumber: row.supplierDocumentNumber,
    debitNoteDate: row.debitNoteDate,
    receivedDate: row.receivedDate,
    totalAmount: Number(row.totalAmount),
    reason: row.reason,
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    allocations: row.allocations.map((a) => ({
      id: a.id,
      purchaseDebitNoteId: a.purchaseDebitNoteId,
      purchaseEntryId: a.purchaseEntryId,
      purchaseEntryNumber: a.purchaseEntry?.purchaseNumber ?? undefined,
      purchaseEntryDate: a.purchaseEntry?.purchaseDate ?? undefined,
      amount: Number(a.amount),
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

export async function createPurchaseDebitNote(
  distributorId: string,
  userId: string,
  data: {
    sourceDistributorId: string;
    debitNoteNumber: string;
    debitNoteDate: string;
    receivedDate: string;
    supplierDocumentNumber?: string;
    totalAmount: number;
    reason:
      | 'short_supply'
      | 'damaged_at_plant'
      | 'late_payment_interest'
      | 'rate_differential'
      | 'other';
    notes?: string;
    allocations: Array<{ purchaseEntryId: string; amount: number }>;
  },
) {
  const supplier = await prisma.sourceDistributor.findFirst({
    where: { id: data.sourceDistributorId, distributorId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!supplier) {
    throw new PurchaseDebitNoteError('Supplier not found', 404, 'SUPPLIER_NOT_FOUND');
  }

  if (data.allocations.length === 0) {
    throw new PurchaseDebitNoteError(
      'At least one allocation is required',
      400,
      'ALLOCATIONS_EMPTY',
    );
  }
  const allocSum = data.allocations.reduce((s, a) => s + a.amount, 0);
  if (Math.abs(allocSum - data.totalAmount) > 0.01) {
    throw new PurchaseDebitNoteError(
      `Sum of allocations (${allocSum.toFixed(2)}) must equal totalAmount (${data.totalAmount.toFixed(2)})`,
      400,
      'ALLOCATION_SUM_MISMATCH',
    );
  }

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
    throw new PurchaseDebitNoteError(
      'One or more allocations reference an invalid or cross-supplier PurchaseEntry',
      400,
      'INVALID_ALLOCATION_TARGET',
    );
  }
  if (data.allocations.some((a) => !(a.amount > 0))) {
    throw new PurchaseDebitNoteError(
      'Every allocation amount must be positive',
      400,
      'ALLOCATION_NON_POSITIVE',
    );
  }

  const debitNoteNumber = data.debitNoteNumber.trim();
  if (!debitNoteNumber) {
    throw new PurchaseDebitNoteError(
      'DN number (from OMC document) is required',
      400,
      'DEBIT_NOTE_NUMBER_REQUIRED',
    );
  }
  const dup = await prisma.purchaseDebitNote.findFirst({
    where: { distributorId, debitNoteNumber, deletedAt: null },
    select: { id: true },
  });
  if (dup) {
    throw new PurchaseDebitNoteError(
      `A debit note with number '${debitNoteNumber}' already exists for this tenant`,
      409,
      'DUPLICATE_DEBIT_NOTE_NUMBER',
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    const dn = await tx.purchaseDebitNote.create({
      data: {
        distributorId,
        sourceDistributorId: supplier.id,
        sourceDistributorName: supplier.name,
        debitNoteNumber,
        supplierDocumentNumber: data.supplierDocumentNumber?.trim() || null,
        debitNoteDate: data.debitNoteDate,
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
      select: purchaseDebitNoteSelect,
    });
    return dn;
  });
  return toWire(created);
}

export async function listPurchaseDebitNotes(
  distributorId: string,
  filters: { sourceDistributorId?: string; from?: string; to?: string } = {},
) {
  const rows = await prisma.purchaseDebitNote.findMany({
    where: {
      distributorId,
      deletedAt: null,
      ...(filters.sourceDistributorId ? { sourceDistributorId: filters.sourceDistributorId } : {}),
      ...(filters.from || filters.to
        ? {
            debitNoteDate: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
    },
    select: purchaseDebitNoteSelect,
    orderBy: [{ debitNoteDate: 'desc' }, { createdAt: 'desc' }],
    take: 200,
  });
  return rows.map(toWire);
}

export async function reversePurchaseDebitNote(distributorId: string, id: string) {
  const dn = await prisma.purchaseDebitNote.findFirst({
    where: { id, distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!dn) throw new PurchaseDebitNoteError('Debit note not found', 404, 'NOT_FOUND');
  await prisma.purchaseDebitNote.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  return { id, reversed: true };
}
