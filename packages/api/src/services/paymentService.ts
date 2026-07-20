import { prisma } from '../lib/prisma.js';
import type { Prisma, $Enums } from '@prisma/client';
import type { CustomerLedgerRow, CustomerLedgerResponse } from '@gaslink/shared';
import { toNum } from '../utils/decimal.js';

export async function listPayments(
  distributorId: string,
  filters: {
    customerId?: string; paymentMethod?: string;
    allocationStatus?: string | string[];
    dateFrom?: string; dateTo?: string;
    // 2026-07-17: entry-date filter operates on PaymentTransaction.createdAt
    // (the DB insert timestamp). Stacks with dateFrom/dateTo which filter on
    // transactionDate (the business date the customer paid). Ops uses this
    // to reconcile "what got entered today" separately from "what payments
    // are attributed to today's business date".
    entryDateFrom?: string; entryDateTo?: string;
    page?: number; pageSize?: number;
    // 2026-07-19: added 'customerName' — pseudo-key that translates to
    // { customer: { customerName: dir } } nested orderBy at query time.
    sortBy?: 'createdAt' | 'amount' | 'transactionDate' | 'customerName';
    sortOrder?: 'asc' | 'desc';
    // Free-text: customer.customerName, referenceNumber. If the search
    // token parses as a positive number, also exact-match on amount.
    search?: string;
  }
) {
  const where: Prisma.PaymentTransactionWhereInput = { distributorId, deletedAt: null };
  if (filters.customerId) where.customerId = filters.customerId;
  if (filters.paymentMethod) where.paymentMethod = filters.paymentMethod as $Enums.PaymentMethod;
  if (filters.allocationStatus) {
    const list = Array.isArray(filters.allocationStatus) ? filters.allocationStatus : [filters.allocationStatus];
    where.allocationStatus = { in: list as $Enums.PaymentAllocationStatus[] };
  }
  if (filters.dateFrom || filters.dateTo) {
    where.transactionDate = {};
    if (filters.dateFrom) where.transactionDate.gte = new Date(filters.dateFrom);
    if (filters.dateTo) where.transactionDate.lte = new Date(filters.dateTo);
  }
  if (filters.entryDateFrom || filters.entryDateTo) {
    where.createdAt = {};
    if (filters.entryDateFrom) where.createdAt.gte = new Date(filters.entryDateFrom);
    if (filters.entryDateTo) {
      // Include the entire "To" day — same convention Payment Date uses via
      // `lte: new Date(dateTo)` (which coerces to 00:00 of that day). For
      // createdAt (a full timestamp, not a date column) we bump to 23:59:59
      // so the day filter is inclusive on both edges.
      const end = new Date(filters.entryDateTo);
      end.setHours(23, 59, 59, 999);
      where.createdAt.lte = end;
    }
  }
  const search = filters.search?.trim();
  if (search) {
    const orClauses: Prisma.PaymentTransactionWhereInput[] = [
      { referenceNumber: { contains: search, mode: 'insensitive' } },
      { customer: { customerName: { contains: search, mode: 'insensitive' } } },
    ];
    // Numeric tokens also exact-match the amount column. Treat NaN /
    // <=0 as text-only (no amount match) so a customer named "001"
    // doesn't silently land on every ₹1 payment.
    const numeric = Number(search);
    if (Number.isFinite(numeric) && numeric > 0) {
      orClauses.push({ amount: numeric });
    }
    where.OR = orClauses;
  }

  const page = filters.page || 1;
  const pageSize = filters.pageSize || 25;
  const sortBy = filters.sortBy ?? 'createdAt';
  const sortOrder = filters.sortOrder ?? 'desc';
  const orderBy: Prisma.PaymentTransactionOrderByWithRelationInput = sortBy === 'customerName'
    ? { customer: { customerName: sortOrder } }
    : ({ [sortBy]: sortOrder } as Prisma.PaymentTransactionOrderByWithRelationInput);

  const [payments, total] = await Promise.all([
    prisma.paymentTransaction.findMany({
      where,
      include: {
        customer: { select: { id: true, customerName: true } },
        allocations: {
          include: { invoice: { select: { id: true, invoiceNumber: true, issueDate: true } } },
        },
      },
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.paymentTransaction.count({ where }),
  ]);

  // Compute allocated/unallocated amounts
  const enriched = payments.map(p => {
    const allocatedAmount = p.allocations.reduce((sum, a) => sum + toNum(a.allocatedAmount), 0);
    return {
      ...p,
      allocatedAmount,
      unallocatedAmount: toNum(p.amount) - allocatedAmount,
    };
  });

  return {
    data: enriched,
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

// WI-PENDING-PAYMENTS: shared shape for createPayment + createPaymentInTx.
// Exported so paymentSubmissionService.verifySubmission can construct it.
export interface CreatePaymentData {
  customerId: string;
  amount: number;
  paymentMethod: string;
  referenceNumber?: string;
  transactionDate: string;
  // Optional free-text note (2026-07-14). Persists to
  // payment_transactions.notes — column pre-existed; the create path
  // now exposes it. One note per payment (applies to all allocated
  // invoices on bulk payments).
  notes?: string;
  allocations?: { invoiceId: string; amount: number }[];
  // Phase F (2026-06-12): when the payment came from the customer-
  // portal Razorpay "Pay Now" flow, the route passes the forensic
  // ids through here. The service writes them onto the
  // PaymentTransaction row but doesn't otherwise change behaviour —
  // allocation logic + ledger update + invoice flip are identical
  // to a manually-recorded payment. razorpaySignature is stored
  // for audit / dispute investigation; mappers/utils never surface
  // it in API responses.
  razorpay?: {
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  };
}

/**
 * WI-PENDING-PAYMENTS: createPayment as a transaction-client function so
 * an OUTER caller (paymentSubmissionService.verifySubmission) can run
 * the payment-recording + the submission-status flip atomically in ONE
 * Prisma transaction.
 *
 * Validates that the customer belongs to `distributorId`; the validation
 * uses `tx` so it sees the same snapshot as the writes that follow.
 * Direct API callers should still use `createPayment` (below) which
 * just wraps this in `prisma.$transaction(...)`.
 */
export async function createPaymentInTx(
  tx: Prisma.TransactionClient,
  distributorId: string,
  userId: string | null,
  data: CreatePaymentData,
) {
  // Validate customer belongs to distributor
  const customer = await tx.customer.findFirst({
    where: { id: data.customerId, distributorId, deletedAt: null },
  });
  if (!customer) throw new PaymentError('Customer not found', 404);

  const payment = await tx.paymentTransaction.create({
      data: {
        distributorId,
        customerId: data.customerId,
        amount: data.amount,
        paymentMethod: data.paymentMethod as $Enums.PaymentMethod,
        referenceNumber: data.referenceNumber || null,
        transactionDate: new Date(data.transactionDate),
        allocationStatus: 'unallocated',
        receivedBy: userId,
        notes: data.notes || null,
        razorpayOrderId: data.razorpay?.razorpayOrderId ?? null,
        razorpayPaymentId: data.razorpay?.razorpayPaymentId ?? null,
        razorpaySignature: data.razorpay?.razorpaySignature ?? null,
      },
    });

    let totalAllocated = 0;

    if (data.allocations && data.allocations.length > 0) {
      // Manual allocation
      for (const alloc of data.allocations) {
        if (totalAllocated + alloc.amount > data.amount) {
          throw new PaymentError('Total allocation exceeds payment amount', 400);
        }

        const invoice = await tx.invoice.findFirst({
          where: { id: alloc.invoiceId, distributorId, deletedAt: null },
        });
        if (!invoice) throw new PaymentError(`Invoice ${alloc.invoiceId} not found`, 404);
        if (alloc.amount > toNum(invoice.outstandingAmount)) {
          throw new PaymentError(`Allocation exceeds outstanding amount for invoice ${invoice.invoiceNumber}`, 400);
        }

        await tx.paymentAllocation.create({
          data: {
            paymentId: payment.id,
            invoiceId: alloc.invoiceId,
            allocatedAmount: alloc.amount,
          },
        });

        // Update invoice
        const newOutstanding = toNum(invoice.outstandingAmount) - alloc.amount;
        const newAmountPaid = toNum(invoice.amountPaid) + alloc.amount;
        await tx.invoice.update({
          where: { id: alloc.invoiceId },
          data: {
            outstandingAmount: newOutstanding,
            amountPaid: newAmountPaid,
            status: newOutstanding <= 0 ? 'paid' : 'partially_paid',
            closedAt: newOutstanding <= 0 ? new Date() : null,
          },
        });

        totalAllocated += alloc.amount;
      }
    } else {
      // Auto-allocate to oldest invoices
      const outstandingInvoices = await tx.invoice.findMany({
        where: {
          distributorId,
          customerId: data.customerId,
          outstandingAmount: { gt: 0 },
          deletedAt: null,
          status: { in: ['issued', 'partially_paid', 'overdue'] },
        },
        orderBy: { issueDate: 'asc' },
      });

      let remaining = data.amount;
      for (const invoice of outstandingInvoices) {
        if (remaining <= 0) break;

        const allocAmount = Math.min(remaining, toNum(invoice.outstandingAmount));
        await tx.paymentAllocation.create({
          data: {
            paymentId: payment.id,
            invoiceId: invoice.id,
            allocatedAmount: allocAmount,
          },
        });

        const newOutstanding = toNum(invoice.outstandingAmount) - allocAmount;
        const newAmountPaid = toNum(invoice.amountPaid) + allocAmount;
        await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            outstandingAmount: newOutstanding,
            amountPaid: newAmountPaid,
            status: newOutstanding <= 0 ? 'paid' : 'partially_paid',
            closedAt: newOutstanding <= 0 ? new Date() : null,
          },
        });

        remaining -= allocAmount;
        totalAllocated += allocAmount;
      }
    }

    // Update payment allocation status
    const allocationStatus = totalAllocated >= data.amount
      ? 'fully_allocated'
      : totalAllocated > 0
        ? 'partially_allocated'
        : 'unallocated';

    const updatedPayment = await tx.paymentTransaction.update({
      where: { id: payment.id },
      data: { allocationStatus: allocationStatus as $Enums.PaymentAllocationStatus },
      include: {
        customer: { select: { id: true, customerName: true } },
        allocations: {
          include: { invoice: { select: { id: true, invoiceNumber: true, issueDate: true } } },
        },
      },
    });

    // Create ledger entry
    await tx.customerLedgerEntry.create({
      data: {
        distributorId,
        customerId: data.customerId,
        entryType: 'payment_entry',
        referenceId: payment.id,
        amountDelta: -data.amount,
        narration: `Payment received via ${data.paymentMethod}${data.referenceNumber ? ` (Ref: ${data.referenceNumber})` : ''}`,
        entryDate: new Date(data.transactionDate),
        createdBy: userId,
      },
    });

  return {
    ...updatedPayment,
    allocatedAmount: totalAllocated,
    unallocatedAmount: data.amount - totalAllocated,
  };
}

/**
 * Public createPayment — opens its own `prisma.$transaction` and delegates
 * to `createPaymentInTx`. Existing callers (routes, Razorpay webhook,
 * verify-payment endpoint) keep the same signature.
 */
export async function createPayment(
  distributorId: string,
  userId: string | null,
  data: CreatePaymentData,
) {
  return prisma.$transaction((tx) => createPaymentInTx(tx, distributorId, userId, data));
}

/**
 * WI-092: allocate (part of) an already-recorded payment to an open invoice.
 *
 * Unallocated payment amount is otherwise stuck — there was no way to apply
 * it to an invoice raised after the payment was taken. `unallocatedAmount`
 * is not stored; it's `amount − Σ allocations`, so we recompute it and only
 * persist the derived `allocationStatus`.
 */
export async function allocatePayment(
  distributorId: string,
  userId: string,
  paymentId: string,
  data: { invoiceId: string; amount: number },
) {
  const payment = await prisma.paymentTransaction.findFirst({
    where: { id: paymentId, distributorId, deletedAt: null },
    include: { allocations: true },
  });
  if (!payment) throw new PaymentError('Payment not found', 404);

  const amount = data.amount;
  if (!(amount > 0)) throw new PaymentError('Allocation amount must be positive', 400);

  const allocated = payment.allocations.reduce((sum, a) => sum + toNum(a.allocatedAmount), 0);
  const unallocated = toNum(payment.amount) - allocated;
  if (amount > unallocated + 1e-9) {
    throw new PaymentError('Allocation exceeds unallocated payment amount', 400);
  }

  const invoice = await prisma.invoice.findFirst({
    where: { id: data.invoiceId, distributorId, deletedAt: null },
  });
  if (!invoice) throw new PaymentError('Invoice not found', 404);
  if (invoice.customerId !== payment.customerId) {
    throw new PaymentError('Invoice belongs to a different customer', 400);
  }
  if (amount > toNum(invoice.outstandingAmount) + 1e-9) {
    throw new PaymentError('Allocation exceeds invoice outstanding amount', 400);
  }

  return prisma.$transaction(async (tx) => {
    await tx.paymentAllocation.create({
      data: { paymentId: payment.id, invoiceId: invoice.id, allocatedAmount: amount },
    });

    const newOutstanding = toNum(invoice.outstandingAmount) - amount;
    const newAmountPaid = toNum(invoice.amountPaid) + amount;
    const updatedInvoice = await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        outstandingAmount: newOutstanding,
        amountPaid: newAmountPaid,
        status: newOutstanding <= 0 ? 'paid' : 'partially_paid',
        closedAt: newOutstanding <= 0 ? new Date() : null,
      },
    });

    const newUnallocated = unallocated - amount;
    const allocationStatus = newUnallocated <= 1e-9 ? 'fully_allocated' : 'partially_allocated';
    const updatedPayment = await tx.paymentTransaction.update({
      where: { id: payment.id },
      data: { allocationStatus: allocationStatus as $Enums.PaymentAllocationStatus },
      include: {
        customer: { select: { id: true, customerName: true } },
        allocations: {
          include: { invoice: { select: { id: true, invoiceNumber: true, issueDate: true } } },
        },
      },
    });

    // WI-092: NO ledger entry here. Allocation only distributes money that
    // was already recorded (and already written to customer_ledger_entries)
    // when the payment was first created. Writing another entry here would
    // double-count the payment against the customer's balance.
    const newAllocated = allocated + amount;
    return {
      payment: {
        ...updatedPayment,
        allocatedAmount: newAllocated,
        unallocatedAmount: toNum(updatedPayment.amount) - newAllocated,
      },
      invoice: updatedInvoice,
    };
  });
}

/**
 * Group 1 (2026-06-11): rewritten to read from CustomerLedgerEntry, which
 * is now the single source of truth across:
 *   - in-app modal (GET /payments/ledger/:customerId)
 *   - Customer Statement report (reportsService.customer-statement)
 *   - Customer Statement PDF (customerLedgerPdfService — via this function)
 *
 * Previously this read Order + PaymentTransaction, so opening-balance entries
 * (which have no Order) were invisible in the PDF while showing up in the
 * modal and report — see anti-pattern #17.
 *
 * Per-cylinder-type empties tracking is preserved by joining each ledger
 * entry's linked invoice → order → orderItems (for delivered qty, empties
 * collected). Entries with no linked invoice (payments, adjustments) and
 * opening-balance invoices (no items) emit single summary rows.
 *
 * `summary.overdueAmount` deliberately EXCLUDES opening-balance debits so
 * the value stays consistent with computeCustomerOverdue (which still reads
 * Order+Payment, the dashboard/order-gate path). Opening balance shows in
 * `dueAmount` via the b/f row but does not count as "overdue" for credit
 * gating purposes — pre-go-live debt is informational here, not an order
 * blocker.
 */
export async function getCustomerLedger(
  distributorId: string,
  customerId: string,
  range?: { from?: string; to?: string },
): Promise<CustomerLedgerResponse> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, distributorId, deletedAt: null },
    select: { id: true, creditPeriodDays: true },
  });
  if (!customer) throw new PaymentError('Customer not found', 404);

  // Pull ALL ledger entries (not range-filtered yet) so we can compute the
  // carry-forward "Opening Balance b/f" amount from pre-range entries.
  const allEntries = await prisma.customerLedgerEntry.findMany({
    where: { distributorId, customerId },
    orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }],
  });

  // Pre-load referenced invoices + empty prices then delegate to the
  // stateless processor. This factoring (Feature A, 2026-07-15) exists
  // so the group-portal service can prefetch entries for N customer
  // buckets in a single query and run the processor per bucket without
  // additional round-trips. The old flow (fetch → process inline) is
  // preserved exactly here: same DB reads, same output.
  const invoiceMap = await loadInvoicesForLedger(allEntries);
  const emptyPriceMap = await loadEmptyPricesForLedger(distributorId);
  return processLedgerEntries({
    entries: allEntries,
    invoiceMap,
    emptyPriceMap,
    creditPeriodDays: customer.creditPeriodDays,
    range,
  });
}

/**
 * Feature A (2026-07-15): load the invoice-detail map required by
 * processLedgerEntries. Extracted from getCustomerLedger so the group
 * ledger flow can reuse the exact same shape — same select tree so
 * every consumer processes the same fields.
 */
export async function loadInvoicesForLedger(
  entries: Array<{ invoiceId: string | null }>,
): Promise<Map<string, LedgerInvoiceRow>> {
  const invoiceIds = Array.from(
    new Set(entries.map((e) => e.invoiceId).filter((x): x is string => !!x)),
  );
  if (invoiceIds.length === 0) return new Map();
  const invoices = await prisma.invoice.findMany({
    where: { id: { in: invoiceIds } },
    select: LEDGER_INVOICE_SELECT,
  });
  return new Map(invoices.map((i) => [i.id, i]));
}

export async function loadEmptyPricesForLedger(distributorId: string): Promise<Map<string, number>> {
  const emptyPrices = await prisma.emptyCylinderPrice.findMany({ where: { distributorId } });
  return new Map<string, number>(
    emptyPrices.map((ep) => [ep.cylinderTypeId, toNum(ep.emptyCylinderPrice)] as const),
  );
}

// Narrow select shape shared by getCustomerLedger + the group-portal
// loader — the processor closes over invoiceMap's shape.
const LEDGER_INVOICE_SELECT = {
  id: true,
  // LIVE invoice number — supersedes the frozen text in
  // CustomerLedgerEntry.narration. When an invoice is reissued
  // (delivery mismatch / regenerate), gstReissueService updates
  // invoice.invoiceNumber in-place from ISHD… → RSHD… but the
  // narration text stays at the original ISHD value. The ledger
  // now renders the live number so it stays aligned with the
  // billing list, GSTR-1, and the PDF download.
  invoiceNumber: true,
  isOpeningBalance: true,
  orderId: true,
  items: {
    select: {
      quantity: true,
      unitPrice: true,
      discountPerUnit: true,
      cylinderTypeId: true,
      cylinderType: { select: { id: true, typeName: true } },
    },
  },
  order: {
    select: {
      items: {
        select: {
          cylinderTypeId: true,
          quantity: true,
          deliveredQuantity: true,
          emptiesCollected: true,
        },
      },
    },
  },
} as const;

type LedgerInvoiceRow = {
  id: string;
  invoiceNumber: string;
  isOpeningBalance: boolean;
  orderId: string | null;
  items: Array<{
    quantity: number;
    unitPrice: import('@prisma/client/runtime/library').Decimal;
    discountPerUnit: import('@prisma/client/runtime/library').Decimal;
    cylinderTypeId: string | null;
    cylinderType: { id: string; typeName: string } | null;
  }>;
  order: {
    items: Array<{
      cylinderTypeId: string;
      quantity: number;
      deliveredQuantity: number | null;
      emptiesCollected: number | null;
    }>;
  } | null;
};

type LedgerEntryRow = Awaited<
  ReturnType<typeof prisma.customerLedgerEntry.findMany>
>[number];

export interface LedgerProcessingInput {
  entries: LedgerEntryRow[];
  invoiceMap: Map<string, LedgerInvoiceRow>;
  emptyPriceMap: Map<string, number>;
  creditPeriodDays: number;
  range?: { from?: string; to?: string };
}

/**
 * Feature A (2026-07-15): stateless ledger processor.
 *
 * Given pre-loaded entries + related invoices + empty prices +
 * per-customer creditPeriodDays, apply the two-pass FIFO / opening-
 * balance / running-balance state machine and return the display rows
 * + summary. Zero DB access inside — every input is passed in — so the
 * group ledger flow can call this once per customerId bucket against a
 * single shared DB fetch.
 *
 * getCustomerLedger is now a thin wrapper: load, then delegate. This
 * refactor preserves the exact previous behaviour for the single-
 * customer path (verified by re-running the full test suite in the
 * commit that introduced it).
 *
 * Enters here already having the money-column state (`cumulative*`),
 * FIFO deliveries list, and pending-empties map local to this call —
 * different customers processed by the group flow keep their state
 * strictly separated.
 */
export function processLedgerEntries(input: LedgerProcessingInput): CustomerLedgerResponse {
  const { entries: allEntries, invoiceMap, emptyPriceMap, creditPeriodDays: creditDays, range } = input;

  const fromDate = range?.from ? new Date(range.from) : null;
  const toDate = range?.to ? new Date(range.to) : null;

  // Mutating state shared across pre-range accumulation and in-range emission.
  let cumulativeInvoiceAmount = 0;
  let cumulativeReceivedAmount = 0;
  // 2026-07-20 — separate period-scoped accumulators so the group
  // ledger's Opening + Debited(period) + Received(period) + Closing
  // tiles reconcile against the visible rows. Only incremented during
  // Pass 2 (in-range emit). The existing cumulative variables stay
  // cumulative-through-`to` so the customer PDF's existing 4-tile
  // summary still reads the same (backward-compat).
  let periodDebited = 0;
  let periodReceived = 0;
  const pendingEmptiesPerType = new Map<string, number>();
  // Only NON-OB invoice debits enter this list — preserves overdueAmount
  // contract with computeCustomerOverdue.
  const unpaidDeliveries: { date: Date; amount: number }[] = [];
  const today = new Date();

  // 2026-07-20 — accepts an as-of date so per-row snapshots reflect the
  // OVERDUE state at THAT row's moment, not at report-generation time.
  // Previously used `today.getTime()` for every row, which made an
  // invoice on 14-Jul (0-day credit) that was paid same-day still show
  // overdue at its invoice row when the report was pulled on 20-Jul —
  // confusing the HQ reader (Banjara Hills same-day scenario reported
  // by Suneel 2026-07-20). The summary.overdueAmount at the end of
  // the function keeps passing `today` so the CURRENT overdue reads
  // correctly.
  function rebuildOverdueOnState(asOfDate: Date): number {
    let overdue = 0;
    let remaining = cumulativeReceivedAmount;
    for (const ud of unpaidDeliveries) {
      if (remaining >= ud.amount) { remaining -= ud.amount; continue; }
      const unpaid = ud.amount - remaining;
      remaining = 0;
      const days = Math.floor((asOfDate.getTime() - ud.date.getTime()) / (1000 * 60 * 60 * 24));
      if (days > creditDays) overdue += unpaid;
    }
    return overdue;
  }

  const rows: CustomerLedgerRow[] = [];

  function emitRow(
    // 2026-07-20 — as-of date for the row's overdue snapshot. See the
    // rebuildOverdueOnState() comment above.
    asOfDate: Date,
    partial: Partial<CustomerLedgerRow> & {
      orderDate: string; kind: CustomerLedgerRow['kind']; narration: string;
    },
  ): void {
    const dueAmount = cumulativeInvoiceAmount - cumulativeReceivedAmount;
    rows.push({
      orderDate: partial.orderDate,
      cylinderType: partial.cylinderType ?? '',
      fullCylsDelivered: partial.fullCylsDelivered ?? 0,
      amount: Math.round((partial.amount ?? 0) * 100) / 100,
      emptyCylsCollected: partial.emptyCylsCollected ?? 0,
      pendingEmptyCyls: partial.pendingEmptyCyls ?? 0,
      emptyCylsCost: Math.round((partial.emptyCylsCost ?? 0) * 100) / 100,
      totalAmount: Math.round(cumulativeInvoiceAmount * 100) / 100,
      receivedAmount: Math.round((partial.receivedAmount ?? 0) * 100) / 100,
      dueAmount: Math.round(dueAmount * 100) / 100,
      creditDays,
      overDueAmount: Math.round(rebuildOverdueOnState(asOfDate) * 100) / 100,
      narration: partial.narration,
      kind: partial.kind,
    });
  }

  // Process a single CustomerLedgerEntry: mutate cumulative state and
  // optionally emit one or more output rows.
  function processEntry(entry: typeof allEntries[number], emit: boolean): void {
    const delta = toNum(entry.amountDelta);
    const inv = entry.invoiceId ? invoiceMap.get(entry.invoiceId) ?? null : null;

    // 2026-07-19 defence — orphan invoice_entry rows (entry.invoiceId set
    // but no matching row in invoices table) MUST NOT be counted in the
    // totals. This is the shape CLAUDE.md anti-pattern #7 produces on
    // shared dev DBs: the GST integration tests hard-delete their invoice
    // fixtures but the customer_ledger_entries rows are keyed to the
    // deleted invoice_ids and left behind, silently inflating every
    // downstream reader's totalAmount / dueAmount / netOutstanding.
    // Group HQ Dashboard vs Ledger reconcile bug (2026-07-19) — Alpha
    // group showed ₹5,86,100 in the ledger vs ₹2,44,100 on the Dashboard;
    // the diff was 171 orphan rows totalling ₹3,42,000. Skip such rows
    // here so the totals stay right even if the pollution reappears. We
    // deliberately do NOT log per-entry to avoid a flood; the ledger's
    // consumers can compare rowCount vs entriesConsidered to detect it.
    if (entry.entryType === 'invoice_entry' && entry.invoiceId && !inv) {
      return;
    }

    const dateStr = entry.entryDate.toISOString().split('T')[0];

    // Update pending-empties from any joined order items (BEFORE emit so
    // the emitted row shows the post-delivery pending count, matching the
    // legacy behaviour).
    if (inv?.order?.items?.length) {
      for (const it of inv.order.items) {
        const delivered = it.deliveredQuantity ?? it.quantity;
        const collected = it.emptiesCollected ?? 0;
        const cur = pendingEmptiesPerType.get(it.cylinderTypeId) ?? 0;
        pendingEmptiesPerType.set(it.cylinderTypeId, Math.max(0, cur + delivered - collected));
      }
    }

    switch (entry.entryType) {
      case 'invoice_entry': {
        cumulativeInvoiceAmount += delta;
        const isOB = !!inv?.isOpeningBalance;
        // Fix C (2026-06-11): OB now ENTERS the unpaid-deliveries FIFO so
        // summary.overdueAmount stays aligned with computeCustomerOverdue.
        // Both functions now count opening-balance debt as overdue once
        // it's past the customer's credit window. Pre-fix the two values
        // disagreed by exactly the OB total.
        if (delta > 0) {
          unpaidDeliveries.push({ date: entry.entryDate, amount: delta });
        }

        // Group 1 fixup (2026-06-11): OB invoices are ALWAYS folded into
        // the carry-forward "Opening Balance b/f" row at the top of the
        // period — never emitted in chronological order. The importer
        // stamps OB rows with today's entryDate which would otherwise
        // push them to the bottom of the period view.
        if (isOB) return;

        if (!emit) return;
        // In-range invoice → contributes to the period debit total.
        if (delta > 0) periodDebited += delta;

        // Narration: prefer the LIVE invoice number from the joined Invoice
        // row over the frozen ledger-entry text. After a reissue the entry
        // narration still says "Invoice ISHD…" but invoice.invoiceNumber
        // has flipped to "RSHD…" — the billing list shows the new number,
        // so the ledger must too. Falls back to entry.narration when the
        // invoice row isn't found (orphaned ledger entry — shouldn't happen
        // but defended against).
        const liveInvoiceNarration = inv?.invoiceNumber
          ? `Invoice ${inv.invoiceNumber}`
          : (entry.narration ?? 'Invoice');

        if (!inv?.items?.length) {
          emitRow(entry.entryDate, {
            orderDate: dateStr,
            cylinderType: '',
            amount: delta,
            narration: liveInvoiceNarration,
            kind: 'invoice',
          });
          return;
        }

        // Per-cylinder-type rows so the PDF table stays readable. Empties
        // collected come from OrderItem; revenue from InvoiceItem.
        const orderItems = inv.order?.items ?? [];
        type Agg = { delivered: number; collected: number; amount: number; name: string };
        const aggByType = new Map<string, Agg>();
        for (const it of inv.items) {
          // InvoiceItem.cylinderTypeId is nullable in the schema (write-off /
          // manual lines). Skip those — they carry no empties accounting and
          // can't be aggregated by cylinder type.
          if (!it.cylinderTypeId || !it.cylinderType) continue;
          const cylinderTypeId = it.cylinderTypeId;
          const oi = orderItems.find((o) => o.cylinderTypeId === cylinderTypeId);
          const delivered = oi?.deliveredQuantity ?? oi?.quantity ?? it.quantity;
          const collected = oi?.emptiesCollected ?? 0;
          const lineAmount = delivered * (toNum(it.unitPrice) - toNum(it.discountPerUnit));
          const prev = aggByType.get(cylinderTypeId);
          if (prev) {
            prev.delivered += delivered;
            prev.collected += collected;
            prev.amount += lineAmount;
          } else {
            aggByType.set(cylinderTypeId, {
              delivered, collected, amount: lineAmount, name: it.cylinderType.typeName,
            });
          }
        }
        for (const [typeId, agg] of aggByType) {
          const pendingForType = pendingEmptiesPerType.get(typeId) ?? 0;
          const emptyPrice = emptyPriceMap.get(typeId) ?? 0;
          emitRow(entry.entryDate, {
            orderDate: dateStr,
            cylinderType: agg.name,
            fullCylsDelivered: agg.delivered,
            amount: agg.amount,
            emptyCylsCollected: agg.collected,
            pendingEmptyCyls: pendingForType,
            emptyCylsCost: pendingForType * emptyPrice,
            // Live invoice number — see liveInvoiceNarration above.
            narration: liveInvoiceNarration,
            kind: 'invoice',
          });
        }
        return;
      }
      case 'payment_entry': {
        const credit = Math.abs(delta);
        cumulativeReceivedAmount += credit;
        if (!emit) return;
        // In-range payment → contributes to the period received total.
        periodReceived += credit;
        emitRow(entry.entryDate, {
          orderDate: dateStr,
          receivedAmount: credit,
          narration: entry.narration ?? 'Payment received',
          kind: 'payment',
        });
        return;
      }
      case 'credit_note': {
        const credit = Math.abs(delta);
        cumulativeReceivedAmount += credit;
        if (!emit) return;
        // Credit note reduces what's owed — treat as period received
        // for the period-scoped tile so Opening + Debited − Received
        // still equals Closing.
        periodReceived += credit;
        emitRow(entry.entryDate, {
          orderDate: dateStr,
          receivedAmount: credit,
          narration: entry.narration ?? 'Credit note',
          kind: 'credit_note',
        });
        return;
      }
      case 'debit_note': {
        cumulativeInvoiceAmount += delta;
        if (delta > 0) unpaidDeliveries.push({ date: entry.entryDate, amount: delta });
        if (!emit) return;
        // Debit note adds to what's owed — counts as period debit.
        if (delta > 0) periodDebited += delta;
        emitRow(entry.entryDate, {
          orderDate: dateStr,
          amount: delta,
          narration: entry.narration ?? 'Debit note',
          kind: 'debit_note',
        });
        return;
      }
      case 'adjustment': {
        if (delta >= 0) {
          cumulativeInvoiceAmount += delta;
          if (delta > 0) unpaidDeliveries.push({ date: entry.entryDate, amount: delta });
        } else {
          cumulativeReceivedAmount += -delta;
        }
        if (!emit) return;
        // Positive adjustment = debit; negative = credit. Route to the
        // matching period counter.
        if (delta > 0) periodDebited += delta;
        else if (delta < 0) periodReceived += -delta;
        emitRow(entry.entryDate, {
          orderDate: dateStr,
          amount: delta >= 0 ? delta : 0,
          receivedAmount: delta < 0 ? -delta : 0,
          narration: entry.narration ?? 'Adjustment',
          kind: 'adjustment',
        });
        return;
      }
      case 'empties_return': {
        // Q3 (2026-07-09) — pure stock movement. amountDelta is 0 (writer
        // enforces this); it does NOT touch cumulativeInvoiceAmount or
        // cumulativeReceivedAmount so the running balance stays as-is.
        // The row emits with the narration ("Returned 50× 19 KG empties")
        // and no money fields — PDF + web/mobile ledger surfaces render
        // amount as "—" in a neutral colour.
        if (!emit) return;
        emitRow(entry.entryDate, {
          orderDate: dateStr,
          amount: 0,
          receivedAmount: 0,
          narration: entry.narration ?? 'Empties return',
          kind: 'empties_return',
        });
        return;
      }
    }
  }

  // Pass 1 — accumulate pre-range state + ALL OB entries, no emit.
  // Group 1 fixup: OB entries are always treated as pre-range carry-forward
  // regardless of their entryDate, so they roll into the b/f row at the
  // top of the period view.
  for (const entry of allEntries) {
    const isBeforeRange = !!fromDate && entry.entryDate < fromDate;
    const inv = entry.invoiceId ? invoiceMap.get(entry.invoiceId) : null;
    const isOB = entry.entryType === 'invoice_entry' && !!inv?.isOpeningBalance;
    if (isBeforeRange || isOB) processEntry(entry, false);
  }

  const openingBalance = cumulativeInvoiceAmount - cumulativeReceivedAmount;
  const showOpeningRow = Math.abs(openingBalance) > 0.005;

  if (showOpeningRow) {
    // Carry-forward row — sits at the top of the period before any
    // in-range transaction. dueAmount equals the opening balance; no
    // debit/credit split, no per-row overdue contribution.
    //
    // Date convention: report-start − 1 day so the reader sees it's
    // carried forward from BEFORE the period, not created on the start
    // date. If no range was supplied, fall back to (earliest in-range
    // entry − 1 day) or today − 1 day if there are none.
    const firstInRange = allEntries.find((e) => {
      const inRange = (!fromDate || e.entryDate >= fromDate) && (!toDate || e.entryDate <= toDate);
      const isOB = e.entryType === 'invoice_entry' && !!(e.invoiceId && invoiceMap.get(e.invoiceId)?.isOpeningBalance);
      return inRange && !isOB;
    });
    const bfAnchor = fromDate ?? firstInRange?.entryDate ?? new Date();
    const bfDate = new Date(bfAnchor);
    bfDate.setDate(bfDate.getDate() - 1);

    rows.push({
      orderDate: bfDate.toISOString().split('T')[0],
      cylinderType: 'Opening Balance b/f',
      fullCylsDelivered: 0,
      amount: 0,
      emptyCylsCollected: 0,
      pendingEmptyCyls: 0,
      emptyCylsCost: 0,
      totalAmount: Math.round(cumulativeInvoiceAmount * 100) / 100,
      receivedAmount: Math.round(cumulativeReceivedAmount * 100) / 100,
      dueAmount: Math.round(openingBalance * 100) / 100,
      creditDays,
      overDueAmount: 0,
      narration: 'Opening Balance b/f',
      kind: 'opening',
    });
  }

  // Pass 2 — emit in-range, NON-OB entries. OB invoices were already
  // accumulated into the b/f row in Pass 1; skipping them here avoids
  // double-counting cumulativeInvoiceAmount.
  for (const entry of allEntries) {
    const inRange =
      (!fromDate || entry.entryDate >= fromDate) &&
      (!toDate || entry.entryDate <= toDate);
    const inv = entry.invoiceId ? invoiceMap.get(entry.invoiceId) : null;
    const isOB = entry.entryType === 'invoice_entry' && !!inv?.isOpeningBalance;
    if (inRange && !isOB) processEntry(entry, true);
  }

  let totalEmptyCylsCost = 0;
  for (const [typeId, pending] of pendingEmptiesPerType) {
    const price = emptyPriceMap.get(typeId) ?? 0;
    totalEmptyCylsCost += pending * price;
  }

  const summary = {
    totalAmount: Math.round(cumulativeInvoiceAmount * 100) / 100,
    receivedAmount: Math.round(cumulativeReceivedAmount * 100) / 100,
    dueAmount: Math.round((cumulativeInvoiceAmount - cumulativeReceivedAmount) * 100) / 100,
    // Summary overdue reads AS OF TODAY — this is the current overdue
    // for the CURRENT balance, not a historical row snapshot. Per-row
    // overdue uses each row's own date (see rebuildOverdueOnState).
    overdueAmount: Math.round(rebuildOverdueOnState(today) * 100) / 100,
    emptyCylsCost: Math.round(totalEmptyCylsCost * 100) / 100,
    openingBalance: showOpeningRow ? Math.round(openingBalance * 100) / 100 : 0,
    // 2026-07-20 — period-scoped totals so the group ledger tiles
    // (Opening + Debited + Received + Closing) reconcile to visible
    // rows even when the customer has pre-range entries. Individual
    // customer PDF still reads `totalAmount` / `receivedAmount` for
    // backward compat.
    periodDebited: Math.round(periodDebited * 100) / 100,
    periodReceived: Math.round(periodReceived * 100) / 100,
  };

  return { rows, summary };
}

/**
 * WI-122: the single canonical "overdue" amount for a customer.
 *
 * Replicates getCustomerLedger's (unranged) summary.overdueAmount exactly:
 * total payments are FIFO-allocated to the oldest delivered amounts first,
 * and any unpaid portion whose delivery date is older than the customer's
 * credit period counts as overdue. This is the source of truth for the
 * dashboard, collections, and the order-placement gate — replacing the
 * fragile invoice.status === 'overdue' flag (which only flips when the
 * supplementary markOverdueInvoices job runs).
 *
 * Fix C (2026-06-11): opening-balance invoices (`isOpeningBalance=true`,
 * created by the OB CSV importer) now count toward the credit-gate
 * overdue total. Pre-fix they were silently excluded because this
 * function reads from Order — and OB invoices have no Order. A
 * customer with ₹15,000 pre-go-live debt could place a new order even
 * when their credit was fully consumed; Suneel saw this on Vanasthali
 * dry-runs. We treat each OB invoice as a synthetic delivery dated at
 * its issueDate so the same FIFO + credit-period logic applies.
 */
export async function computeCustomerOverdue(
  distributorId: string,
  customerId: string,
  asOf: Date = new Date(),
): Promise<number> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, distributorId, deletedAt: null },
    select: { creditPeriodDays: true },
  });
  if (!customer) return 0;
  const creditDays = customer.creditPeriodDays;

  const [orders, openingInvoices, payments] = await Promise.all([
    prisma.order.findMany({
      where: {
        distributorId, customerId,
        status: { in: ['delivered', 'modified_delivered'] },
        deletedAt: null,
      },
      include: { items: true },
      orderBy: { deliveryDate: 'asc' },
    }),
    // Fix C: include opening-balance invoices (no Order). Use the
    // remaining outstanding so partial payments via PaymentAllocation
    // are already accounted for before we re-apply FIFO below.
    prisma.invoice.findMany({
      where: {
        distributorId, customerId,
        isOpeningBalance: true,
        deletedAt: null,
        status: { not: 'cancelled' },
      },
      select: {
        issueDate: true, totalAmount: true, outstandingAmount: true,
      },
      orderBy: { issueDate: 'asc' },
    }),
    prisma.paymentTransaction.findMany({
      where: { distributorId, customerId, deletedAt: null },
      select: { amount: true },
    }),
  ]);

  // Delivered amounts oldest-first: deliveredQty * (unitPrice - discount).
  const deliveries: { date: Date; amount: number }[] = [];
  for (const order of orders) {
    const date = order.deliveryDate ?? order.orderDate;
    for (const item of order.items) {
      const delivered = item.deliveredQuantity ?? item.quantity;
      const amount = delivered * (toNum(item.unitPrice) - toNum(item.discountPerUnit));
      if (amount > 0) deliveries.push({ date, amount });
    }
  }
  // Fix C: each OB invoice becomes a synthetic "delivery" so the FIFO
  // pass below treats it identically to a real delivery. Using
  // totalAmount keeps the bookkeeping symmetric with the deliveries
  // branch (payments are summed separately below and FIFO-allocated
  // against the merged list).
  for (const ob of openingInvoices) {
    const amount = toNum(ob.totalAmount);
    if (amount > 0) deliveries.push({ date: ob.issueDate, amount });
  }
  deliveries.sort((a, b) => a.date.getTime() - b.date.getTime());

  const totalReceived = payments.reduce((s, p) => s + toNum(p.amount), 0);

  let remainingPayments = totalReceived;
  let overdue = 0;
  for (const d of deliveries) {
    if (remainingPayments >= d.amount) {
      remainingPayments -= d.amount;
      continue;
    }
    const unpaidPortion = d.amount - remainingPayments;
    remainingPayments = 0;
    const daysSinceDelivery = Math.floor((asOf.getTime() - d.date.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSinceDelivery > creditDays) overdue += unpaidPortion;
  }
  return Math.round(overdue * 100) / 100;
}

export class PaymentError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'PaymentError';
  }
}
