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
import { sumChargesIncl } from '../utils/purchaseCharges.js';

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

/** Sum a PurchaseEntry's lines to get the total money owed for goods received.
 *
 * F8 (2026-08-06): also folds in `charges` (freight/handling/testing/insurance/
 * other) when the caller selected them. `charges` is defaulted to [] so
 * pre-F8 readers that don't select the field see identical behaviour to the
 * pre-F8 implementation. */
function entryTotal(entry: {
  items: Array<{ unitPrice: Prisma.Decimal | number; fullsReceived: number }>;
  charges?: Array<{ amount: Prisma.Decimal | number; gstRate?: Prisma.Decimal | number | null }>;
}): number {
  const items = entry.items.reduce((s, it) => s + toNum(it.unitPrice) * it.fullsReceived, 0);
  // Payables side: charges are GST-INCLUSIVE — you pay the OMC the full invoice
  // (freight base + freight GST). See utils/purchaseCharges (anti-pattern #16).
  const charges = sumChargesIncl(entry.charges ?? []);
  return items + charges;
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
  // F8 v2 (2026-08-06) — extended kind union with 'debit_note',
  // 'deposit', 'erv_empties', 'erv_defective'. ERV rows carry zero
  // money — they surface physical activity on the same timeline for the
  // "one place" corp view Suneel asked for.
  kind:
    | 'purchase'
    | 'payment'
    | 'credit_note'
    | 'debit_note'
    | 'deposit'
    | 'erv_empties'
    | 'erv_defective';
  documentId: string;
  documentNumber: string | null;
  // F8 (2026-08-06) — OMC's own reference (supplier_document_number) when
  // available, else null. Falls back to `documentNumber` (our internal) on
  // the PDF's "Doc No" column.
  supplierDocumentNumber?: string | null;
  narration: string;
  debit: number;
  credit: number;
  balance: number;
  // F8 v2 (2026-08-06) — physical qty on ERV rows (empties or defective).
  // Zero on money rows. Optional to keep the wire compact for money-only
  // consumers (statement PDF ignores this field).
  physicalQty?: number;
  cylinderTypeName?: string;
  // F8 v2 (2026-08-06) — plant name on purchase / deposit rows so the
  // ledger narration can read "PURCHASE INVOICE — Sanaswadi" without
  // the reader forcing plant lookup from a join.
  plantName?: string | null;
}

export interface SupplierLedgerResponse {
  source: { id: string; name: string };
  rows: SupplierLedgerRow[];
  summary: {
    totalPurchased: number;
    totalPaid: number;
    // F8 (2026-08-06) — supplier CNs reduce what we owe, so treat them the
    // same as payments in the netOutstanding calc: total owed = purchased,
    // total settled = paid + CN offsets.
    totalCreditNotes: number;
    // F8 v2 (2026-08-06) — DNs add to what we owe; deposits are tracked
    // separately (own summary field) because they're refundable + should
    // NOT net into gas-account outstanding.
    totalDebitNotes: number;
    totalDeposits: number;
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

  const [entries, payments, creditNotes, debitNotes, ervEvents] = await Promise.all([
    prisma.purchaseEntry.findMany({
      where: { distributorId, sourceDistributorId, deletedAt: null },
      select: {
        id: true,
        purchaseNumber: true,
        purchaseDate: true,
        createdAt: true,
        supplierDocumentNumber: true,
        plantName: true,
        documentType: true,
        items: {
          select: {
            unitPrice: true,
            fullsReceived: true,
            cylinderType: { select: { typeName: true } },
          },
        },
        // F8 (2026-08-06) — freight/handling/etc. add to the entry's debit.
        charges: { select: { amount: true, gstRate: true } },
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
    // F8 (2026-08-06) — supplier-side CNs reduce what we owe.
    prisma.purchaseCreditNote.findMany({
      where: { distributorId, sourceDistributorId, deletedAt: null },
      select: {
        id: true,
        creditNoteNumber: true,
        supplierDocumentNumber: true,
        creditNoteDate: true,
        totalAmount: true,
        reason: true,
        createdAt: true,
      },
    }),
    // F8 v2 (2026-08-06) — supplier-side DNs add to what we owe.
    prisma.purchaseDebitNote.findMany({
      where: { distributorId, sourceDistributorId, deletedAt: null },
      select: {
        id: true,
        debitNoteNumber: true,
        supplierDocumentNumber: true,
        debitNoteDate: true,
        totalAmount: true,
        reason: true,
        createdAt: true,
      },
    }),
    // F8 v2 (2026-08-06) — Empties Return Voucher (ERV) physical rows.
    // Pulled from InventoryEvent (outgoing_empties + defective_return_to_
    // corporation event types). Filtered by documentNumber convention —
    // outgoing empties destined for THIS supplier's plant carry the ERV
    // challan number. We can't join InventoryEvent to SourceDistributor
    // directly (event schema pre-dates supplier linkage) so we scope by
    // date + distributor + type; the Corp Ledger UI adds a supplier
    // filter dropdown when a tenant has multiple OMCs.
    prisma.inventoryEvent.findMany({
      where: {
        distributorId,
        eventType: {
          in: ['outgoing_empties', 'defective_return_to_corporation'],
        },
      },
      select: {
        id: true,
        eventDate: true,
        eventType: true,
        emptiesChange: true,
        fullsChange: true,
        documentNumber: true,
        vehicleNumber: true,
        driverName: true,
        createdAt: true,
        cylinderType: { select: { typeName: true } },
      },
    }),
  ]);

  // F8v2-FIX (2026-08-06 later) — defective outgoing rows land here with
  // documentNumber = the F1 auto batch number (e.g. "FSHD26270000002").
  // Suneel: never surface our internally-generated batch number on the
  // ledger — show only what the user physically wrote on the OMC return
  // challan (DefectiveReturnBatch.challanNumber). If the operator didn't
  // record one, the Doc No column reads "—" for that row.
  const defectiveBatchNumbers = ervEvents
    .filter((ev) => ev.eventType === 'defective_return_to_corporation' && ev.documentNumber)
    .map((ev) => ev.documentNumber as string);
  const defectiveBatches = defectiveBatchNumbers.length
    ? await prisma.defectiveReturnBatch.findMany({
        where: { distributorId, batchNumber: { in: defectiveBatchNumbers } },
        select: { batchNumber: true, challanNumber: true },
      })
    : [];
  const challanByBatch = new Map(
    defectiveBatches.map((b) => [b.batchNumber, b.challanNumber ?? null]),
  );

  // Build the all-time totals BEFORE date-range filtering.
  // F8 v2: split entries by documentType — deposits track separately + do
  // NOT net into gas-outstanding (they're refundable container fees).
  const invoiceEntries = entries.filter((e) => e.documentType !== 'deposit_invoice');
  const depositEntries = entries.filter((e) => e.documentType === 'deposit_invoice');
  const totalPurchased = round2(invoiceEntries.reduce((s, e) => s + entryTotal(e), 0));
  const totalDeposits = round2(depositEntries.reduce((s, e) => s + entryTotal(e), 0));
  const totalPaid = round2(payments.reduce((s, p) => s + toNum(p.amount), 0));
  const totalCreditNotes = round2(creditNotes.reduce((s, c) => s + toNum(c.totalAmount), 0));
  const totalDebitNotes = round2(debitNotes.reduce((s, d) => s + toNum(d.totalAmount), 0));
  // Gas-only outstanding: DNs add, CNs + payments subtract. Deposits are
  // a separate pool (their own summary field) — payments made against a
  // deposit invoice DO count in `totalPaid` however since we don't tag
  // payments by target document today. This is a known simplification;
  // in v2.1 we can introduce PurchasePaymentAllocation.documentType to
  // separate deposit-payments from gas-payments if needed.
  const netOutstanding = round2(
    totalPurchased + totalDebitNotes - totalPaid - totalCreditNotes,
  );

  const inRange = (d: string): boolean => {
    if (filters?.from && d < filters.from) return false;
    if (filters?.to && d > filters.to) return false;
    return true;
  };

  // Interleave. Sort key = (date, createdAt) so same-day rows keep the
  // insert order — matches the customer-side ledger convention.
  type Merged =
    | { kind: 'purchase'; sortDate: string; createdAt: Date; row: (typeof entries)[number]; total: number }
    | { kind: 'deposit'; sortDate: string; createdAt: Date; row: (typeof entries)[number]; total: number }
    | { kind: 'payment'; sortDate: string; createdAt: Date; row: (typeof payments)[number] }
    | { kind: 'credit_note'; sortDate: string; createdAt: Date; row: (typeof creditNotes)[number] }
    | { kind: 'debit_note'; sortDate: string; createdAt: Date; row: (typeof debitNotes)[number] }
    | { kind: 'erv'; sortDate: string; createdAt: Date; row: (typeof ervEvents)[number] };

  const merged: Merged[] = [
    ...invoiceEntries.map((e): Merged => ({
      kind: 'purchase',
      sortDate: e.purchaseDate,
      createdAt: e.createdAt,
      row: e,
      total: round2(entryTotal(e)),
    })),
    ...depositEntries.map((e): Merged => ({
      kind: 'deposit',
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
    ...creditNotes.map((c): Merged => ({
      kind: 'credit_note',
      sortDate: c.creditNoteDate,
      createdAt: c.createdAt,
      row: c,
    })),
    ...debitNotes.map((d): Merged => ({
      kind: 'debit_note',
      sortDate: d.debitNoteDate,
      createdAt: d.createdAt,
      row: d,
    })),
    ...ervEvents.map((ev): Merged => ({
      kind: 'erv',
      // eventDate is a DateTime; convert to yyyy-mm-dd for chronological
      // interleaving with the yyyy-mm-dd string columns from the money side.
      sortDate: ev.eventDate.toISOString().slice(0, 10),
      createdAt: ev.createdAt,
      row: ev,
    })),
  ];
  merged.sort((a, b) => {
    if (a.sortDate !== b.sortDate) return a.sortDate.localeCompare(b.sortDate);
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  // F8v2-FIX (2026-08-06) — build a compact "N× type" cyl summary for
  // invoice + deposit rows so the narration + Physical Activity table
  // show what actually came in. Single-line: "100× 19 KG"; multi-line:
  // "100× 19 KG + 50× 5 KG".
  function cylSummary(items: Array<{ fullsReceived: number; cylinderType: { typeName: string } | null }>): string {
    return items
      .filter((it) => it.fullsReceived > 0)
      .map((it) => `${it.fullsReceived}× ${it.cylinderType?.typeName ?? '?'}`)
      .join(' + ');
  }
  function totalQty(items: Array<{ fullsReceived: number }>): number {
    return items.reduce((s, it) => s + (it.fullsReceived || 0), 0);
  }

  let running = 0;
  const rows: SupplierLedgerRow[] = [];
  for (const m of merged) {
    if (m.kind === 'purchase') {
      running = round2(running + m.total);
      if (!inRange(m.sortDate)) continue;
      // F8v2-FIX (2026-08-06 final) — Doc No column shows ONLY what the
      // operator typed from the OMC document (supplierDocumentNumber).
      // Our internal PurchaseEntry auto-number (PSHD…) is never surfaced
      // to the ledger — same principle as the defective batch FSHD fix:
      // Suneel wants nothing invented. The internal number stays as
      // documentId for click-through / drill-down; the user-facing Doc
      // No is blank when no OMC ref was captured.
      const docNoShown = m.row.supplierDocumentNumber ?? null;
      // NOTHING invented, anywhere — Doc No column AND narration. An earlier
      // pass fixed only the column and left the narration falling back to
      // the internal PSHD auto-number, so it kept leaking. If the operator
      // captured no OMC reference, the narration simply carries none.
      const refSuffix = docNoShown ? ` · ${docNoShown}` : '';
      const plantSuffix = m.row.plantName ? ` · ${m.row.plantName}` : '';
      const summary = cylSummary(m.row.items);
      const qty = totalQty(m.row.items);
      const cylLabel =
        m.row.items.filter((it) => it.fullsReceived > 0).length === 1
          ? (m.row.items.find((it) => it.fullsReceived > 0)?.cylinderType?.typeName ?? '—')
          : `${m.row.items.length} lines`;
      rows.push({
        entryDate: m.sortDate,
        kind: 'purchase',
        documentId: m.row.id,
        documentNumber: docNoShown,
        supplierDocumentNumber: m.row.supplierDocumentNumber ?? null,
        plantName: m.row.plantName ?? null,
        narration: `PURCHASE INVOICE${summary ? ' — ' + summary : ''}${plantSuffix}${refSuffix}`,
        debit: m.total,
        credit: 0,
        balance: running,
        physicalQty: qty,
        cylinderTypeName: cylLabel,
      });
    } else if (m.kind === 'deposit') {
      if (!inRange(m.sortDate)) continue;
      // Same principle as purchase rows — only OMC's deposit-invoice ref
      // is user-facing. Internal PSHD auto-number stays as documentId.
      const docNoShown = m.row.supplierDocumentNumber ?? null;
      // Same rule as purchase rows — no internal PSHD in the narration either.
      const refSuffix = docNoShown ? ` · ${docNoShown}` : '';
      const plantSuffix = m.row.plantName ? ` · ${m.row.plantName}` : '';
      const summary = cylSummary(m.row.items);
      const qty = totalQty(m.row.items);
      const cylLabel =
        m.row.items.filter((it) => it.fullsReceived > 0).length === 1
          ? (m.row.items.find((it) => it.fullsReceived > 0)?.cylinderType?.typeName ?? '—')
          : `${m.row.items.length} lines`;
      rows.push({
        entryDate: m.sortDate,
        kind: 'deposit',
        documentId: m.row.id,
        documentNumber: docNoShown,
        supplierDocumentNumber: m.row.supplierDocumentNumber ?? null,
        plantName: m.row.plantName ?? null,
        narration: `CYLINDER DEPOSIT${summary ? ' — ' + summary : ''}${plantSuffix}${refSuffix}`,
        debit: m.total,
        credit: 0,
        balance: running, // unchanged — deposit doesn't affect gas balance
        physicalQty: qty,
        cylinderTypeName: cylLabel,
      });
    } else if (m.kind === 'payment') {
      running = round2(running - toNum(m.row.amount));
      if (!inRange(m.sortDate)) continue;
      const method = String(m.row.paymentMethod).replace(/_/g, ' ');
      const ref = m.row.referenceNumber ? ` · ref ${m.row.referenceNumber}` : '';
      rows.push({
        entryDate: m.sortDate,
        kind: 'payment',
        documentId: m.row.id,
        documentNumber: null,
        supplierDocumentNumber: null,
        narration: `PAYMENT (${method})${ref}`,
        debit: 0,
        credit: toNum(m.row.amount),
        balance: running,
      });
    } else if (m.kind === 'credit_note') {
      const cnAmount = toNum(m.row.totalAmount);
      running = round2(running - cnAmount);
      if (!inRange(m.sortDate)) continue;
      const reasonLabel = String(m.row.reason)
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      // F8v2-FIX (2026-08-06 final) — CN/DN modals already require the
      // operator to type the OMC's own number into `creditNoteNumber` /
      // `debitNoteNumber` at record time. That IS the OMC reference —
      // there's no separate internal number to hide. Fine to expose.
      // `supplierDocumentNumber` is a legacy dupe field kept for wire
      // compat; when both are set we prefer supplierDocumentNumber.
      const docNoShown = m.row.supplierDocumentNumber ?? m.row.creditNoteNumber;
      rows.push({
        entryDate: m.sortDate,
        kind: 'credit_note',
        documentId: m.row.id,
        documentNumber: docNoShown,
        supplierDocumentNumber: m.row.supplierDocumentNumber ?? null,
        narration: `CREDIT NOTE — ${reasonLabel} · ${docNoShown}`,
        debit: 0,
        credit: cnAmount,
        balance: running,
      });
    } else if (m.kind === 'debit_note') {
      // F8 v2 — supplier DN adds to what we owe.
      const dnAmount = toNum(m.row.totalAmount);
      running = round2(running + dnAmount);
      if (!inRange(m.sortDate)) continue;
      const reasonLabel = String(m.row.reason)
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      const docNoShown = m.row.supplierDocumentNumber ?? m.row.debitNoteNumber;
      rows.push({
        entryDate: m.sortDate,
        kind: 'debit_note',
        documentId: m.row.id,
        documentNumber: docNoShown,
        supplierDocumentNumber: m.row.supplierDocumentNumber ?? null,
        narration: `DEBIT NOTE — ${reasonLabel} · ${docNoShown}`,
        debit: dnAmount,
        credit: 0,
        balance: running,
      });
    } else {
      // F8 v2 — ERV physical row. No money impact — running balance
      // unchanged. Debit/Credit both zero; UI reads `physicalQty` +
      // `cylinderTypeName` to render "12× 47.5KG empty return".
      if (!inRange(m.sortDate)) continue;
      const isDefective = m.row.eventType === 'defective_return_to_corporation';
      const qty = Math.abs(isDefective ? m.row.fullsChange : m.row.emptiesChange);
      const cylName = m.row.cylinderType?.typeName ?? '—';
      const truck = m.row.vehicleNumber ? ` · ${m.row.vehicleNumber}` : '';
      // F8v2-FIX (2026-08-06 final) — Doc No column shows ONLY what the
      // operator physically wrote on the OMC's challan/document. Never
      // our internally-generated batch/reference:
      //   • outgoing_empties event: documentNumber = user-typed challan
      //     (from OutgoingEmptiesModal) — show as-is.
      //   • defective_return_to_corporation event: documentNumber is F1's
      //     auto batch number (FSHD…). Suneel doesn't want it. Look up
      //     the batch's user-typed challan (DefectiveReturnBatch.challanNumber)
      //     and show that instead. Falls back to "—" when the operator
      //     didn't record a challan on the batch.
      const docShown = isDefective
        ? (m.row.documentNumber ? challanByBatch.get(m.row.documentNumber) ?? null : null)
        : m.row.documentNumber ?? null;
      rows.push({
        entryDate: m.sortDate,
        kind: isDefective ? 'erv_defective' : 'erv_empties',
        documentId: m.row.id,
        documentNumber: docShown,
        supplierDocumentNumber: null,
        narration: isDefective
          ? `OUTGOING (DEFECTIVE) — ${qty}× ${cylName}${truck}`
          : `OUTGOING EMPTIES — ${qty}× ${cylName}${truck}`,
        debit: 0,
        credit: 0,
        balance: running,
        physicalQty: qty,
        cylinderTypeName: cylName,
      });
    }
  }

  return {
    source,
    rows,
    summary: {
      totalPurchased,
      totalPaid,
      totalCreditNotes,
      totalDebitNotes,
      totalDeposits,
      netOutstanding,
    },
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
  // F8 (2026-08-06) — total supplier CNs, reduces `outstanding` alongside
  // `totalPaid`. Defaulted to 0 for tenants with no CN activity so the
  // pre-F8 UI reads keep working without any client change.
  totalCreditNotes: number;
  // F8 v2 (2026-08-06) — DN adds to outstanding; deposits track separately
  // (own field) since they're refundable and shouldn't net into gas debt.
  totalDebitNotes: number;
  totalDeposits: number;
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
          documentType: true,
          items: { select: { unitPrice: true, fullsReceived: true } },
          charges: { select: { amount: true, gstRate: true } },
        },
      },
      purchasePayments: {
        where: { deletedAt: null },
        select: { transactionDate: true, amount: true },
      },
      // F8 (2026-08-06) — supplier CN totals net into outstanding.
      purchaseCreditNotes: {
        where: { deletedAt: null },
        select: { totalAmount: true },
      },
      // F8 v2 (2026-08-06) — supplier DN totals add to outstanding.
      purchaseDebitNotes: {
        where: { deletedAt: null },
        select: { totalAmount: true },
      },
    },
  });
  return sources
    .map((s): SupplierBalanceRow => {
      // F8 v2: split gas vs deposit entries.
      const invoiceEntries = s.purchaseEntries.filter(
        (e) => e.documentType !== 'deposit_invoice',
      );
      const depositEntries = s.purchaseEntries.filter(
        (e) => e.documentType === 'deposit_invoice',
      );
      const totalPurchased = round2(invoiceEntries.reduce((sum, e) => sum + entryTotal(e), 0));
      const totalDeposits = round2(depositEntries.reduce((sum, e) => sum + entryTotal(e), 0));
      const totalPaid = round2(s.purchasePayments.reduce((sum, p) => sum + toNum(p.amount), 0));
      const totalCreditNotes = round2(s.purchaseCreditNotes.reduce((sum, c) => sum + toNum(c.totalAmount), 0));
      const totalDebitNotes = round2(s.purchaseDebitNotes.reduce((sum, d) => sum + toNum(d.totalAmount), 0));
      const outstanding = round2(
        totalPurchased + totalDebitNotes - totalPaid - totalCreditNotes,
      );
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
        totalCreditNotes,
        totalDebitNotes,
        totalDeposits,
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
  // F8 (2026-08-06) — OMC's own reference (shown as canonical id in
  // the Record CN modal picker) + CN offsets so callers can pick
  // truly-remaining outstanding invoices (payment + CN both reduce it).
  supplierDocumentNumber?: string | null;
  /** 'invoice' (gas) | 'deposit_invoice' — CN/DN modals exclude deposits. */
  documentType?: string;
  totalCreditNotes?: number;
  amountRemaining?: number;
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
      supplierDocumentNumber: true,
      // 2026-08-15 — expose documentType so the CN/DN modals can exclude
      // deposit invoices (CNs/DNs are gas-only; deposits are refundable and
      // must not be reduced by a volume-incentive CN — Suneel).
      documentType: true,
      items: { select: { unitPrice: true, fullsReceived: true } },
      // F8 (2026-08-06) — freight/handling/etc. counted into the entry total.
      charges: { select: { amount: true, gstRate: true } },
      // F8 (2026-08-06) — CN offsets already applied to this entry.
      cnAllocations: {
        where: { purchaseCreditNote: { deletedAt: null } },
        select: { amount: true },
      },
    },
    orderBy: [{ purchaseDate: 'asc' }, { createdAt: 'asc' }],
  });
  return entries
    .map((e): OutstandingEntryRow => {
      const total = round2(entryTotal(e));
      const paid = round2(toNum(e.amountPaid));
      const cn = round2(e.cnAllocations.reduce((s, a) => s + toNum(a.amount), 0));
      const remaining = round2(total - paid - cn);
      return {
        purchaseEntryId: e.id,
        purchaseNumber: e.purchaseNumber,
        purchaseDate: e.purchaseDate,
        total,
        amountPaid: paid,
        outstanding: round2(total - paid),
        supplierDocumentNumber: e.supplierDocumentNumber,
        documentType: e.documentType,
        totalCreditNotes: cn,
        amountRemaining: remaining,
      };
    })
    .filter((e) => (e.amountRemaining ?? e.outstanding) > 0.005);
}
