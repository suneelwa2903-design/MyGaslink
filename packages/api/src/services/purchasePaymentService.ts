/**
 * Mini-Operator (2026-07-19) — Purchase Payments service.
 *
 * A PurchasePayment is a mini-operator's record of cash paid to a source
 * distributor. Every payment is broken down into one or more
 * PurchasePaymentAllocation rows — each allocation targets a specific
 * PurchaseEntry that was previously received from the same source.
 *
 * Allocation policy:
 *   • Default = FIFO. Called with no `allocations` array, the service
 *     auto-fills against the oldest unpaid entries (by purchaseDate ASC,
 *     then createdAt ASC) for that source until the payment amount is
 *     consumed. Any residual (customer overpaid) sits as an unallocated
 *     credit — recorded on the payment but not tied to an entry.
 *   • Manual override = client supplies { purchaseEntryId, amount }
 *     tuples. Service validates ∑amount === payment.amount and every
 *     entry belongs to the same (distributor, source) scope.
 *
 * Every write is wrapped in a single `prisma.$transaction` so the payment,
 * its allocations, and the running `PurchaseEntry.amountPaid` updates
 * commit atomically. Same pattern as invoiceService's allocatePayment.
 *
 * Reverse (soft-delete) does the inverse: subtracts each allocation from
 * its purchaseEntry.amountPaid, deletes allocations (cascade), stamps
 * deletedAt on the payment. NOT a hard delete — audit trail preserved.
 *
 * Ledger view (getSupplierLedger) merges purchase entries (debits) and
 * payments (credits) chronologically with a running balance. That's the
 * "money owed to supplier X" statement the mobile UI reads.
 */
import { prisma } from '../lib/prisma.js';
import type { Prisma, PrismaClient } from '@prisma/client';

type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

export class PurchasePaymentError extends Error {
  constructor(message: string, public statusCode: number, public code?: string) {
    super(message);
    this.name = 'PurchasePaymentError';
  }
}

// Mirrors the DB enum PaymentMethod (see schema.prisma). Kept as a local
// constant so the route zod schema and this service agree without dragging
// prisma runtime types into the shared package.
const PAYMENT_METHOD_VALUES = ['cash', 'cheque', 'online', 'upi', 'bank_transfer', 'credit'] as const;
type PaymentMethodValue = (typeof PAYMENT_METHOD_VALUES)[number];

function toNum(v: Prisma.Decimal | number | string | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  return v.toNumber();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Sum a PurchaseEntry's lines to get the total money owed for goods received. */
function entryTotal(entry: { items: Array<{ unitPrice: Prisma.Decimal | number; fullsReceived: number }> }): number {
  return entry.items.reduce((s, it) => s + toNum(it.unitPrice) * it.fullsReceived, 0);
}

export interface AllocationInput {
  purchaseEntryId: string;
  amount: number;
}

export interface CreatePurchasePaymentData {
  sourceDistributorId: string;
  transactionDate: string; // yyyy-mm-dd
  amount: number;
  paymentMethod?: PaymentMethodValue;
  referenceNumber?: string;
  notes?: string;
  /** When omitted → FIFO auto-allocate. When supplied → manual, must sum to `amount`. */
  allocations?: AllocationInput[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Load every PurchaseEntry for (distributorId, sourceDistributorId) still
 * carrying an outstanding balance, oldest first. `outstanding = total −
 * amountPaid`. Also returns the total for cheap consumption downstream.
 * Excludes soft-deleted entries.
 */
async function loadOutstandingEntries(
  tx: TxClient,
  distributorId: string,
  sourceDistributorId: string,
): Promise<Array<{ id: string; total: number; amountPaid: number; outstanding: number }>> {
  const entries = await tx.purchaseEntry.findMany({
    where: { distributorId, sourceDistributorId, deletedAt: null },
    select: {
      id: true,
      amountPaid: true,
      purchaseDate: true,
      createdAt: true,
      items: { select: { unitPrice: true, fullsReceived: true } },
    },
    orderBy: [{ purchaseDate: 'asc' }, { createdAt: 'asc' }],
  });
  return entries
    .map((e) => {
      const total = round2(entryTotal(e));
      const paid = round2(toNum(e.amountPaid));
      return { id: e.id, total, amountPaid: paid, outstanding: round2(total - paid) };
    })
    .filter((e) => e.outstanding > 0.005);
}

/**
 * Given a payment amount and a set of (distributor, source)-scoped
 * outstanding entries in FIFO order, produce one allocation per entry
 * until the amount is exhausted. Any residual is returned as
 * `unallocated` — the caller can decide whether to persist the payment
 * with a credit balance or reject it.
 */
function computeFifoAllocations(
  amount: number,
  entries: Array<{ id: string; outstanding: number }>,
): { allocations: AllocationInput[]; unallocated: number } {
  const allocations: AllocationInput[] = [];
  let remaining = round2(amount);
  for (const e of entries) {
    if (remaining <= 0.005) break;
    const take = round2(Math.min(remaining, e.outstanding));
    if (take > 0.005) {
      allocations.push({ purchaseEntryId: e.id, amount: take });
      remaining = round2(remaining - take);
    }
  }
  return { allocations, unallocated: remaining };
}

/**
 * Validate a manual-override allocation list:
 *   • every entryId belongs to (distributor, source)
 *   • every amount ≤ that entry's current outstanding
 *   • total across all rows === payment amount (±0.01 rounding)
 * Returns the load map so the caller can update entries without a
 * second round-trip.
 */
async function validateManualAllocations(
  tx: TxClient,
  distributorId: string,
  sourceDistributorId: string,
  paymentAmount: number,
  allocations: AllocationInput[],
): Promise<Map<string, { total: number; amountPaid: number; outstanding: number }>> {
  if (allocations.length === 0) {
    throw new PurchasePaymentError('At least one allocation is required', 400, 'EMPTY_ALLOCATIONS');
  }
  const uniqueIds = new Set(allocations.map((a) => a.purchaseEntryId));
  if (uniqueIds.size !== allocations.length) {
    throw new PurchasePaymentError(
      'Duplicate purchaseEntryId in allocations — collapse into one row',
      400,
      'DUPLICATE_ALLOCATION',
    );
  }
  const total = round2(allocations.reduce((s, a) => s + a.amount, 0));
  if (Math.abs(total - round2(paymentAmount)) > 0.01) {
    throw new PurchasePaymentError(
      `Allocations sum ${total} does not match payment amount ${paymentAmount}`,
      400,
      'ALLOCATION_MISMATCH',
    );
  }
  const rows = await tx.purchaseEntry.findMany({
    where: {
      id: { in: Array.from(uniqueIds) },
      distributorId,
      sourceDistributorId,
      deletedAt: null,
    },
    select: {
      id: true,
      amountPaid: true,
      items: { select: { unitPrice: true, fullsReceived: true } },
    },
  });
  if (rows.length !== uniqueIds.size) {
    throw new PurchasePaymentError(
      'One or more purchaseEntryIds do not belong to this source',
      400,
      'FOREIGN_ENTRY',
    );
  }
  const outstandingMap = new Map<string, { total: number; amountPaid: number; outstanding: number }>();
  for (const r of rows) {
    const t = round2(entryTotal(r));
    const paid = round2(toNum(r.amountPaid));
    outstandingMap.set(r.id, { total: t, amountPaid: paid, outstanding: round2(t - paid) });
  }
  for (const a of allocations) {
    const info = outstandingMap.get(a.purchaseEntryId)!;
    if (a.amount < 0.005) {
      throw new PurchasePaymentError(
        `Allocation amount for ${a.purchaseEntryId} must be > 0`,
        400,
        'ZERO_ALLOCATION',
      );
    }
    if (a.amount - info.outstanding > 0.01) {
      throw new PurchasePaymentError(
        `Allocation ${a.amount} to ${a.purchaseEntryId} exceeds its outstanding ${info.outstanding}`,
        400,
        'OVER_ALLOCATION',
      );
    }
  }
  return outstandingMap;
}

// ─── Public API ─────────────────────────────────────────────────────────

export async function createPurchasePayment(
  distributorId: string,
  createdBy: string,
  data: CreatePurchasePaymentData,
) {
  if (!data.sourceDistributorId) {
    throw new PurchasePaymentError('sourceDistributorId is required', 400, 'MISSING_SOURCE');
  }
  const amount = round2(data.amount);
  if (!(amount > 0)) {
    throw new PurchasePaymentError('amount must be greater than zero', 400, 'INVALID_AMOUNT');
  }
  const method: PaymentMethodValue = data.paymentMethod && PAYMENT_METHOD_VALUES.includes(data.paymentMethod)
    ? data.paymentMethod
    : 'cash';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.transactionDate)) {
    throw new PurchasePaymentError(
      'transactionDate must be yyyy-mm-dd',
      400,
      'INVALID_DATE',
    );
  }

  // Verify source belongs to this tenant BEFORE opening the transaction —
  // cheap check and gives a friendlier error path.
  const source = await prisma.sourceDistributor.findFirst({
    where: { id: data.sourceDistributorId, distributorId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!source) {
    throw new PurchasePaymentError(
      'Source distributor not found or not accessible',
      404,
      'SOURCE_NOT_FOUND',
    );
  }

  return prisma.$transaction(async (tx) => {
    // Resolve allocations — either validate manual or auto-FIFO.
    let allocations: AllocationInput[];
    let unallocated = 0;
    if (data.allocations && data.allocations.length > 0) {
      await validateManualAllocations(
        tx as unknown as TxClient,
        distributorId,
        data.sourceDistributorId,
        amount,
        data.allocations,
      );
      allocations = data.allocations.map((a) => ({
        purchaseEntryId: a.purchaseEntryId,
        amount: round2(a.amount),
      }));
    } else {
      const outstandingEntries = await loadOutstandingEntries(
        tx as unknown as TxClient,
        distributorId,
        data.sourceDistributorId,
      );
      const fifo = computeFifoAllocations(amount, outstandingEntries);
      allocations = fifo.allocations;
      unallocated = fifo.unallocated;
    }

    // Persist the payment row first so allocations have a FK target.
    const payment = await tx.purchasePayment.create({
      data: {
        distributorId,
        sourceDistributorId: data.sourceDistributorId,
        sourceDistributorName: source.name,
        transactionDate: data.transactionDate,
        amount,
        paymentMethod: method,
        referenceNumber: data.referenceNumber?.trim() || null,
        notes: data.notes?.trim() || null,
        createdBy,
      },
    });

    if (allocations.length > 0) {
      await tx.purchasePaymentAllocation.createMany({
        data: allocations.map((a) => ({
          paymentId: payment.id,
          purchaseEntryId: a.purchaseEntryId,
          amount: a.amount,
        })),
      });
      // Bump every touched PurchaseEntry.amountPaid inside the same tx
      // so downstream readers never see a mismatch between allocation
      // rows and the running total.
      for (const a of allocations) {
        await tx.purchaseEntry.update({
          where: { id: a.purchaseEntryId },
          data: { amountPaid: { increment: a.amount } },
        });
      }
    }

    return { payment, allocations, unallocated };
  });
}

export interface ListPurchasePaymentsFilters {
  sourceDistributorId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export async function listPurchasePayments(
  distributorId: string,
  filters: ListPurchasePaymentsFilters,
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50));
  const where: Prisma.PurchasePaymentWhereInput = {
    distributorId,
    deletedAt: null,
  };
  if (filters.sourceDistributorId) where.sourceDistributorId = filters.sourceDistributorId;
  if (filters.from || filters.to) {
    where.transactionDate = {};
    if (filters.from) (where.transactionDate as { gte?: string }).gte = filters.from;
    if (filters.to) (where.transactionDate as { lte?: string }).lte = filters.to;
  }
  const [total, rows] = await Promise.all([
    prisma.purchasePayment.count({ where }),
    prisma.purchasePayment.findMany({
      where,
      orderBy: [{ transactionDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        allocations: {
          select: { id: true, purchaseEntryId: true, amount: true },
        },
      },
    }),
  ]);
  return {
    data: rows.map((r) => ({
      id: r.id,
      distributorId: r.distributorId,
      sourceDistributorId: r.sourceDistributorId,
      sourceDistributorName: r.sourceDistributorName,
      transactionDate: r.transactionDate,
      amount: toNum(r.amount),
      paymentMethod: r.paymentMethod,
      referenceNumber: r.referenceNumber,
      notes: r.notes,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      allocations: r.allocations.map((a) => ({
        id: a.id,
        purchaseEntryId: a.purchaseEntryId,
        amount: toNum(a.amount),
      })),
    })),
    meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}

/**
 * Reverse (soft-delete) a payment. Subtracts each allocation from its
 * purchaseEntry.amountPaid, deletes the allocation rows via cascade
 * (see model schema), stamps deletedAt on the payment. Idempotent —
 * calling on an already-reversed payment throws so the caller sees the
 * inconsistency instead of a silent no-op.
 */
export async function reversePurchasePayment(
  distributorId: string,
  paymentId: string,
) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.purchasePayment.findFirst({
      where: { id: paymentId, distributorId },
      include: { allocations: true },
    });
    if (!payment) {
      throw new PurchasePaymentError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
    }
    if (payment.deletedAt) {
      throw new PurchasePaymentError('Payment already reversed', 409, 'ALREADY_REVERSED');
    }
    // Roll back the running amountPaid on each touched entry.
    for (const a of payment.allocations) {
      await tx.purchaseEntry.update({
        where: { id: a.purchaseEntryId },
        data: { amountPaid: { decrement: toNum(a.amount) } },
      });
    }
    await tx.purchasePaymentAllocation.deleteMany({ where: { paymentId } });
    return tx.purchasePayment.update({
      where: { id: paymentId },
      data: { deletedAt: new Date() },
    });
  });
}

// ─── Supplier ledger ────────────────────────────────────────────────────

export interface SupplierLedgerRow {
  entryDate: string;
  kind: 'purchase' | 'payment';
  documentId: string;
  documentNumber: string | null;
  narration: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface SupplierLedgerResponse {
  source: { id: string; name: string };
  rows: SupplierLedgerRow[];
  summary: {
    totalPurchased: number;
    totalPaid: number;
    netOutstanding: number;
  };
  filters: { from: string | null; to: string | null };
}

/**
 * Chronological merged view: PurchaseEntry rows as debits (money the
 * mini-op owes for goods received) + PurchasePayment rows as credits
 * (money paid to source). Running `balance` = cumulative debits −
 * cumulative credits. All-time totals sit in `summary` regardless of
 * the date-range filter so the reader always sees the true position.
 */
export async function getSupplierLedger(
  distributorId: string,
  sourceDistributorId: string,
  filters?: { from?: string; to?: string },
): Promise<SupplierLedgerResponse> {
  const source = await prisma.sourceDistributor.findFirst({
    where: { id: sourceDistributorId, distributorId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!source) {
    throw new PurchasePaymentError(
      'Source distributor not found or not accessible',
      404,
      'SOURCE_NOT_FOUND',
    );
  }

  const [entries, payments] = await Promise.all([
    prisma.purchaseEntry.findMany({
      where: { distributorId, sourceDistributorId, deletedAt: null },
      select: {
        id: true,
        purchaseNumber: true,
        purchaseDate: true,
        createdAt: true,
        items: { select: { unitPrice: true, fullsReceived: true } },
      },
    }),
    prisma.purchasePayment.findMany({
      where: { distributorId, sourceDistributorId, deletedAt: null },
      select: {
        id: true,
        transactionDate: true,
        amount: true,
        paymentMethod: true,
        referenceNumber: true,
        notes: true,
        createdAt: true,
      },
    }),
  ]);

  // Build the all-time totals BEFORE date-range filtering.
  const totalPurchased = round2(entries.reduce((s, e) => s + entryTotal(e), 0));
  const totalPaid = round2(payments.reduce((s, p) => s + toNum(p.amount), 0));
  const netOutstanding = round2(totalPurchased - totalPaid);

  const inRange = (d: string): boolean => {
    if (filters?.from && d < filters.from) return false;
    if (filters?.to && d > filters.to) return false;
    return true;
  };

  // Interleave. Sort key = (date, createdAt) so same-day rows keep the
  // insert order — matches the customer-side ledger convention.
  type Merged =
    | { kind: 'purchase'; sortDate: string; createdAt: Date; row: (typeof entries)[number]; total: number }
    | { kind: 'payment'; sortDate: string; createdAt: Date; row: (typeof payments)[number] };

  const merged: Merged[] = [
    ...entries.map((e): Merged => ({
      kind: 'purchase',
      sortDate: e.purchaseDate,
      createdAt: e.createdAt,
      row: e,
      total: round2(entryTotal(e)),
    })),
    ...payments.map((p): Merged => ({
      kind: 'payment',
      sortDate: p.transactionDate,
      createdAt: p.createdAt,
      row: p,
    })),
  ];
  merged.sort((a, b) => {
    if (a.sortDate !== b.sortDate) return a.sortDate.localeCompare(b.sortDate);
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  let running = 0;
  const rows: SupplierLedgerRow[] = [];
  for (const m of merged) {
    if (m.kind === 'purchase') {
      running = round2(running + m.total);
      if (!inRange(m.sortDate)) continue;
      rows.push({
        entryDate: m.sortDate,
        kind: 'purchase',
        documentId: m.row.id,
        documentNumber: m.row.purchaseNumber,
        narration: `Goods received (${m.row.purchaseNumber})`,
        debit: m.total,
        credit: 0,
        balance: running,
      });
    } else {
      running = round2(running - toNum(m.row.amount));
      if (!inRange(m.sortDate)) continue;
      const method = String(m.row.paymentMethod).replace(/_/g, ' ');
      const ref = m.row.referenceNumber ? ` · ref ${m.row.referenceNumber}` : '';
      rows.push({
        entryDate: m.sortDate,
        kind: 'payment',
        documentId: m.row.id,
        documentNumber: null,
        narration: `Payment (${method})${ref}`,
        debit: 0,
        credit: toNum(m.row.amount),
        balance: running,
      });
    }
  }

  return {
    source,
    rows,
    summary: { totalPurchased, totalPaid, netOutstanding },
    filters: { from: filters?.from ?? null, to: filters?.to ?? null },
  };
}

/**
 * Per-source rollup — one row per SourceDistributor with the current
 * "how much do we owe them" balance. Used by the mobile Purchases tab
 * to show a supplier list with outstanding chips.
 */
export interface SupplierBalanceRow {
  sourceDistributorId: string;
  name: string;
  totalPurchased: number;
  totalPaid: number;
  outstanding: number;
  lastPurchaseDate: string | null;
  lastPaymentDate: string | null;
}

export async function listSupplierBalances(
  distributorId: string,
): Promise<SupplierBalanceRow[]> {
  const sources = await prisma.sourceDistributor.findMany({
    where: { distributorId, deletedAt: null },
    select: {
      id: true,
      name: true,
      purchaseEntries: {
        where: { deletedAt: null },
        select: {
          purchaseDate: true,
          items: { select: { unitPrice: true, fullsReceived: true } },
        },
      },
      purchasePayments: {
        where: { deletedAt: null },
        select: { transactionDate: true, amount: true },
      },
    },
  });
  return sources
    .map((s): SupplierBalanceRow => {
      const totalPurchased = round2(s.purchaseEntries.reduce((sum, e) => sum + entryTotal(e), 0));
      const totalPaid = round2(s.purchasePayments.reduce((sum, p) => sum + toNum(p.amount), 0));
      const outstanding = round2(totalPurchased - totalPaid);
      const lastPurchaseDate = s.purchaseEntries.length
        ? s.purchaseEntries.map((e) => e.purchaseDate).sort().at(-1) ?? null
        : null;
      const lastPaymentDate = s.purchasePayments.length
        ? s.purchasePayments.map((p) => p.transactionDate).sort().at(-1) ?? null
        : null;
      return {
        sourceDistributorId: s.id,
        name: s.name,
        totalPurchased,
        totalPaid,
        outstanding,
        lastPurchaseDate,
        lastPaymentDate,
      };
    })
    .sort((a, b) => {
      // Suppliers we owe money to first, then alphabetical.
      if (a.outstanding !== b.outstanding) return b.outstanding - a.outstanding;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Per-entry outstanding drill-down for a source. Used by the mobile
 * Record Payment flow: shows every unpaid entry with its outstanding
 * so the user can manually override the default FIFO if they want.
 */
export interface OutstandingEntryRow {
  purchaseEntryId: string;
  purchaseNumber: string;
  purchaseDate: string;
  total: number;
  amountPaid: number;
  outstanding: number;
}

export async function listOutstandingEntries(
  distributorId: string,
  sourceDistributorId: string,
): Promise<OutstandingEntryRow[]> {
  const source = await prisma.sourceDistributor.findFirst({
    where: { id: sourceDistributorId, distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!source) {
    throw new PurchasePaymentError(
      'Source distributor not found or not accessible',
      404,
      'SOURCE_NOT_FOUND',
    );
  }
  const entries = await prisma.purchaseEntry.findMany({
    where: { distributorId, sourceDistributorId, deletedAt: null },
    select: {
      id: true,
      purchaseNumber: true,
      purchaseDate: true,
      amountPaid: true,
      items: { select: { unitPrice: true, fullsReceived: true } },
    },
    orderBy: [{ purchaseDate: 'asc' }, { createdAt: 'asc' }],
  });
  return entries
    .map((e): OutstandingEntryRow => {
      const total = round2(entryTotal(e));
      const paid = round2(toNum(e.amountPaid));
      return {
        purchaseEntryId: e.id,
        purchaseNumber: e.purchaseNumber,
        purchaseDate: e.purchaseDate,
        total,
        amountPaid: paid,
        outstanding: round2(total - paid),
      };
    })
    .filter((e) => e.outstanding > 0.005);
}
