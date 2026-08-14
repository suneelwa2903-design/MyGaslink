import { prisma } from '../lib/prisma.js';
import type { Prisma, $Enums } from '@prisma/client';
import type { CustomerLedgerRow, CustomerLedgerResponse } from '@gaslink/shared';
import { localTodayISO } from '@gaslink/shared';
import { toNum } from '../utils/decimal.js';
import { allocateNumber } from './numberingService.js';

// Change L v2 (2026-07-31): try-allocate a V voucher number if the
// distributor has a docCode set, else return null so the PDF falls back
// to DEP-<uuid-prefix>. Never throws — a numbering failure MUST NOT
// break deposit recording. Called inside the same tx as the ledger
// create so a rollback frees the sequence number.
async function tryAllocateVoucherNumber(
  tx: Prisma.TransactionClient,
  distributorId: string,
  entryDate: Date,
): Promise<string | null> {
  const dist = await tx.distributor.findUnique({
    where: { id: distributorId },
    select: { docCode: true },
  });
  if (!dist?.docCode) return null;
  try {
    return await allocateNumber(tx, distributorId, 'V', entryDate, dist.docCode);
  } catch {
    return null;
  }
}

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
    if (filters.entryDateFrom) {
      // Anti-pattern #21: `new Date("YYYY-MM-DD")` parses as UTC midnight,
      // but the caller means server-local midnight (TZ=Asia/Kolkata) —
      // otherwise createdAt rows between 00:00-05:30 IST on the "From" day
      // are silently excluded because they're still in the previous UTC day.
      const start = new Date(filters.entryDateFrom);
      start.setHours(0, 0, 0, 0);
      where.createdAt.gte = start;
    }
    if (filters.entryDateTo) {
      // Include the entire "To" day — bump to 23:59:59.999 in local TZ so
      // the day filter is inclusive on both edges regardless of caller TZ.
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
  // Deposit ledger (2026-07-31): optional per-cylinder-type deposit
  // breakdown for the portion of this payment that is a refundable
  // cylinder deposit (not payment against invoices). Each entry emits a
  // companion `deposit_charged` ledger row AND reduces
  // CustomerInventoryBalance.withCustomerQty for that type by qty (those
  // cylinders now count as "paid-for-on-deposit" not "owed-back-empty").
  //
  // Invariant enforced in the service:
  //   sum(deposits[].amount) + sum(allocations[].amount) <= data.amount
  //   sum(deposits[].amount) === deposits[].reduce((s,d) => s + d.qty * emptyCylinderPrice(d.cylinderTypeId), 0)
  // The second invariant is soft — operator can override the auto-fill
  // amount, but a warning is written to `notes` if it diverges.
  deposits?: {
    cylinderTypeId: string;
    qty: number;
    amount: number;
  }[];
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
      // Auto-allocate to oldest invoices — but RESERVE the deposit portion
      // first so a payment that's partly deposit doesn't over-allocate into
      // invoices. Without this, a deposit-only payment on a customer with
      // any outstanding invoice fails with "Total (allocations X + deposits
      // Y) exceeds payment amount" because auto-allocation consumes the
      // full amount before the deposit branch runs.
      // Deposit ledger (2026-07-31).
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

      const reservedForDeposits = (data.deposits ?? []).reduce((s, d) => s + d.amount, 0);
      let remaining = data.amount - reservedForDeposits;
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

    // Deposit ledger (2026-07-31 refinement): a cylinder deposit is a
    // REFUNDABLE LIABILITY (we owe it back to the customer if they return
    // cylinders). It is NOT an invoice payment and MUST NOT reduce
    // customer receivables. The physical PaymentTransaction.amount stays
    // at data.amount (real cash received) — but the payment_entry ledger
    // row that drives `cumulativeReceivedAmount` (and thus dueAmount)
    // gets the NON-DEPOSIT portion only.
    //
    // Three cases:
    //   (a) No deposits → emit payment_entry with amountDelta=-amount (unchanged)
    //   (b) Mixed (partial deposit) → emit payment_entry with amountDelta=-(amount-depositTotal)
    //   (c) Pure deposit (depositTotal == amount) → skip payment_entry
    //       entirely. The deposit_charged rows carry the full accounting
    //       and no invoice-receivable movement is warranted.
    //
    // Effect on the ledger view:
    //   - dueAmount = cumulativeInvoiceAmount - cumulativeReceivedAmount
    //     now excludes the deposit portion → customer's invoice dues stay
    //     intact, deposit exposure surfaces separately in Deposits Held.
    //   - PaymentTransaction.amount unchanged → Tally / bank recon /
    //     analytics cash-in still see full cash movement.
    //   - computeCustomerOverdue reads PaymentTransaction.amount directly,
    //     so it ALSO needs to subtract the deposit portion — see the
    //     paired fix in that function.
    const depositTotal = (data.deposits ?? []).reduce((s, d) => s + d.amount, 0);
    const invoiceReceipt = data.amount - depositTotal;
    if (invoiceReceipt > 0.005) {
      await tx.customerLedgerEntry.create({
        data: {
          distributorId,
          customerId: data.customerId,
          entryType: 'payment_entry',
          referenceId: payment.id,
          amountDelta: -invoiceReceipt,
          narration: `Payment received via ${data.paymentMethod}${data.referenceNumber ? ` (Ref: ${data.referenceNumber})` : ''}`,
          entryDate: new Date(data.transactionDate),
          createdBy: userId,
        },
      });
    }

    // Deposit ledger (2026-07-31): if the operator flagged part of this
    // payment as a cylinder deposit, emit one companion `deposit_charged`
    // ledger row per cylinder type AND reduce
    // CustomerInventoryBalance.withCustomerQty for that type by qty
    // (those cylinders now count as "paid-for-on-deposit", not
    // "owed-back-empty" — so `Pend E` drops correctly).
    //
    // Validation:
    //   - Sum of allocations + sum of deposits must not exceed payment amount
    //   - Every cylinder type referenced must belong to this distributor
    //   - Qty must be > 0
    //
    // The `payment_entry` row above already carries the full -amount
    // debit. The `deposit_charged` rows carry amountDelta=+ve for the
    // deposit portion AND qtyDelta so the "Dep Given" column and
    // per-type breakdown display can render from a single source.
    // NOTE: deposit_charged.amountDelta is INFORMATIONAL — it is NOT
    // summed into any receivable / dues calculation. The credit gate
    // (computeCustomerOverdue), Tally export, aging KPI, and dashboard
    // Collections KPI all filter by entryType and exclude the deposit
    // rows. Verified by the anti-pattern audit — see docs/DEPOSIT-LEDGER.md.
    if (data.deposits && data.deposits.length > 0) {
      const totalDepositAmount = data.deposits.reduce((s, d) => s + d.amount, 0);
      if (totalAllocated + totalDepositAmount > data.amount + 0.01) {
        throw new PaymentError(
          `Total (allocations ${totalAllocated} + deposits ${totalDepositAmount}) exceeds payment amount ${data.amount}`,
          400,
        );
      }

      // Preload cylinder types owned by this distributor for validation + name lookup
      const typeIds = Array.from(new Set(data.deposits.map((d) => d.cylinderTypeId)));
      const types = await tx.cylinderType.findMany({
        where: { id: { in: typeIds }, distributorId },
        select: { id: true, typeName: true },
      });
      const typeById = new Map(types.map((t) => [t.id, t]));
      for (const d of data.deposits) {
        if (!typeById.has(d.cylinderTypeId)) {
          throw new PaymentError(
            `Cylinder type ${d.cylinderTypeId} not found for this distributor`,
            400,
          );
        }
        if (d.qty <= 0) {
          throw new PaymentError('Deposit qty must be greater than 0', 400);
        }
        if (d.amount <= 0) {
          throw new PaymentError('Deposit amount must be greater than 0', 400);
        }
      }

      for (const d of data.deposits) {
        const t = typeById.get(d.cylinderTypeId)!;
        const entryDate = new Date(data.transactionDate);
        const voucherNumber = await tryAllocateVoucherNumber(tx, distributorId, entryDate);
        await tx.customerLedgerEntry.create({
          data: {
            distributorId,
            customerId: data.customerId,
            entryType: 'deposit_charged',
            referenceId: payment.id,
            cylinderTypeId: d.cylinderTypeId,
            qtyDelta: d.qty,
            amountDelta: d.amount,
            voucherNumber,
            // 2026-07-31 v8: compact narration "qty × N (rate)". Strips
            // "KG" suffix from typeName + drops "@ Rs." prefix + drops
            // .00 cents. Saves ~10-15 chars — critical for the 18-char
            // Narration column cap so multi-type deposits don't
            // ellipsise. Example: "2 × 19 KG @ Rs. 1950.00" → "2 × 19 (1950)".
            narration: `${d.qty} × ${t.typeName.replace(/\s*kg\s*/i, '').trim()} (${Math.round(d.amount / d.qty)})`,
            entryDate,
            createdBy: userId,
          },
        });

        // Reduce empties held (they're now on deposit, not on refill loan).
        // Use upsert so first-time deposit for a customer/type still works.
        const existing = await tx.customerInventoryBalance.findUnique({
          where: {
            customerId_cylinderTypeId: {
              customerId: data.customerId,
              cylinderTypeId: d.cylinderTypeId,
            },
          },
        });
        if (existing) {
          await tx.customerInventoryBalance.update({
            where: {
              customerId_cylinderTypeId: {
                customerId: data.customerId,
                cylinderTypeId: d.cylinderTypeId,
              },
            },
            data: {
              withCustomerQty: Math.max(0, existing.withCustomerQty - d.qty),
            },
          });
        }
        // No else branch — if the customer wasn't holding any of this
        // type per the snapshot, the deposit is still valid (they took
        // N brand-new cylinders under deposit). Analytics
        // (amountInMarket / customerPortal.emptyCylinders) reads
        // withCustomerQty as the "refundable owed-back count" — a
        // deposit on cylinders never seen before doesn't add to that
        // count.
        //
        // The ledger's Pend E column is computed separately by
        // processLedgerEntries — it walks CustomerLedgerEntry rows in
        // date order and this deposit_charged row is subtracted from
        // the per-type running total there (see the
        // `case 'deposit_charged'` branch).
      }
    }

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
 * Deposit ledger (2026-07-31) — refund a cylinder deposit.
 *
 * Called from the "Refund Deposit" action on the customer detail page.
 * Two shapes based on `method`:
 *   - 'cash': books a NEGATIVE PaymentTransaction (money out) + emits
 *     the deposit_refunded ledger row. The negative payment shows in
 *     the `Received` column as a debit; the ledger's Due Amt goes UP
 *     (customer's account is credited less because we paid out).
 *   - 'credit_note': books a CreditNote with reasonCode='deposit_refund'
 *     against a specified invoice OR unallocated (future invoice will
 *     absorb it). Emits the deposit_refunded ledger row alongside.
 *
 * Restores CustomerInventoryBalance.withCustomerQty for the affected
 * cylinder type (cylinders come back into refill circulation OR the
 * customer physically returned them at refund time; both flows treat
 * the count the same).
 *
 * Validation:
 *   - Distributor must own the customer + cylinder type
 *   - Qty > 0
 *   - Amount > 0
 *   - Cannot refund more qty than the customer currently has on deposit
 *     (sum of deposit_charged.qtyDelta − deposit_refunded.qtyDelta for
 *     that customer+type)
 */
export interface RefundDepositData {
  customerId: string;
  cylinderTypeId: string;
  qty: number;
  amount: number;
  method: 'cash' | 'credit_note';
  // 'cash' path: which PaymentMethod row to book against (upi/cash/bank/etc)
  paymentMethod?: string;
  // 'cash' path: transaction date (defaults to today if omitted)
  transactionDate?: string;
  // 'credit_note' path: invoice the credit note attaches to
  creditNoteInvoiceId?: string;
  referenceNumber?: string;
  notes?: string;
}

export async function refundDeposit(
  distributorId: string,
  userId: string | null,
  data: RefundDepositData,
): Promise<{
  ledgerEntryId: string;
  paymentId?: string;
  creditNoteId?: string;
}> {
  if (data.qty <= 0) throw new PaymentError('Refund qty must be > 0', 400);
  if (data.amount <= 0) throw new PaymentError('Refund amount must be > 0', 400);
  if (data.method === 'cash' && !data.paymentMethod) {
    throw new PaymentError('paymentMethod is required for cash refund', 400);
  }
  if (data.method === 'credit_note' && !data.creditNoteInvoiceId) {
    throw new PaymentError('creditNoteInvoiceId is required for credit_note refund', 400);
  }

  return prisma.$transaction(async (tx) => {
    // Validate customer belongs to distributor
    const customer = await tx.customer.findFirst({
      where: { id: data.customerId, distributorId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) throw new PaymentError('Customer not found', 404);

    // Validate cylinder type belongs to distributor
    const type = await tx.cylinderType.findFirst({
      where: { id: data.cylinderTypeId, distributorId },
      select: { id: true, typeName: true },
    });
    if (!type) throw new PaymentError('Cylinder type not found', 404);

    // Refundable qty guard — check total on deposit for this customer+type.
    // Sum qty from deposit_charged minus deposit_refunded rows.
    const depositRows = await tx.customerLedgerEntry.findMany({
      where: {
        distributorId,
        customerId: data.customerId,
        cylinderTypeId: data.cylinderTypeId,
        entryType: { in: ['deposit_charged', 'deposit_refunded'] },
      },
      select: { entryType: true, qtyDelta: true },
    });
    const onDeposit = depositRows.reduce((sum, r) => {
      const q = r.qtyDelta ?? 0;
      return r.entryType === 'deposit_charged' ? sum + q : sum - q;
    }, 0);
    if (data.qty > onDeposit) {
      throw new PaymentError(
        `Cannot refund ${data.qty} × ${type.typeName} — customer only has ${onDeposit} on deposit`,
        400,
      );
    }

    // 2026-08-04 (anti-pattern #21) — `new Date().toISOString().slice(0, 10)`
    // is banned everywhere; it returns UTC-truncated date which drifts a
    // day in the IST evening window. localTodayISO returns YYYY-MM-DD in
    // the operator's local TZ. Same fix applied across the codebase.
    const txDate = data.transactionDate ?? localTodayISO();
    let paymentId: string | undefined;
    let creditNoteId: string | undefined;

    if (data.method === 'cash') {
      // Negative PaymentTransaction — cash out.
      const negativePayment = await tx.paymentTransaction.create({
        data: {
          distributorId,
          customerId: data.customerId,
          amount: -data.amount,
          paymentMethod: data.paymentMethod as $Enums.PaymentMethod,
          referenceNumber: data.referenceNumber || null,
          transactionDate: new Date(txDate),
          allocationStatus: 'unallocated',
          receivedBy: userId,
          notes: data.notes ?? `Deposit refund: ${data.qty} × ${type.typeName}`,
        },
      });
      paymentId = negativePayment.id;

      // 2026-07-31 v3 accounting correction: refund of a cylinder
      // deposit is a "Refundable Deposit Payable" liability write-down,
      // NOT an invoice-side transaction. It does NOT reduce the
      // customer's invoice dues. We deliberately DO NOT emit a
      // payment_entry ledger row here — that would make
      // cumulativeReceivedAmount go up (see the payment_entry branch in
      // processLedgerEntries) which drops Due Amt on the ledger view.
      //
      // What's still tracked:
      //   - PaymentTransaction row above (amount = -data.amount) — the
      //     physical cash movement. Bank recon / Tally / cash-flow all
      //     see it.
      //   - deposit_refunded ledger row below — reduces Deposits Held
      //     in the summary block and shows the event on the ledger
      //     timeline (with per-type Pend E display).
      //   - computeCustomerOverdue subtracts net-deposit-held from
      //     total cash-in, so the negative payment doesn't wrongly
      //     inflate the customer's advance-credit.
    } else {
      // credit_note path — issue a credit against the specified invoice.
      // Bookkeeping shape follows the existing CreditNote model
      // (uses reasonCode 'D' — "Deficiency in service"; there is no
      // NIC GSTR-1 code for "deposit refund", so 'D' is the closest
      // semantic and matches how manual deposit adjustments have been
      // recorded pre-Deposit-Ledger).
      const invoice = await tx.invoice.findFirst({
        where: { id: data.creditNoteInvoiceId!, distributorId, deletedAt: null },
        select: { id: true, invoiceNumber: true },
      });
      if (!invoice) throw new PaymentError('Invoice not found for credit note', 404);

      const cn = await tx.creditNote.create({
        data: {
          invoiceId: invoice.id,
          totalAmount: data.amount,
          reason: `Deposit refund: ${data.qty} × ${type.typeName}`,
          note: data.notes ?? null,
          status: 'pending_cn',
          reasonCode: 'D',
          issuedBy: userId,
        },
      });
      creditNoteId = cn.id;
    }

    // Emit the deposit_refunded ledger row — cylinderTypeId + qtyDelta
    // populated so processLedgerEntries can (a) restore Pend E for
    // that type by qty and (b) subtract from the running Dep Given
    // total.
    const refundEntryDate = new Date(txDate);
    const voucherNumber = await tryAllocateVoucherNumber(tx, distributorId, refundEntryDate);
    const depositRow = await tx.customerLedgerEntry.create({
      data: {
        distributorId,
        customerId: data.customerId,
        entryType: 'deposit_refunded',
        referenceId: paymentId ?? creditNoteId!,
        cylinderTypeId: data.cylinderTypeId,
        qtyDelta: data.qty,
        amountDelta: data.amount,
        voucherNumber,
        // 2026-07-31 v8: compact narration (matches deposit_charged).
        // Format: "qty × N (method)". Strips "KG" from typeName so it
        // fits the 18-char Narration column cap for multi-cyl-type
        // refund events.
        narration: `${data.qty} × ${type.typeName.replace(/\s*kg\s*/i, '').trim()} (${data.method === 'cash' ? 'cash' : 'credit note'})`,
        entryDate: refundEntryDate,
        createdBy: userId,
      },
    });

    // Restore snapshot count so analytics + customer portal see the
    // cylinders as pending-empties again.
    // 2026-07-31 v2 semantics: a refund event means the customer
    // PHYSICALLY returned N cylinders to the depot (and received their
    // deposit back). The cylinders are at the depot after the event, NOT
    // at the customer's site. Therefore:
    //   - withCustomerQty must NOT increase (customer no longer holds them)
    //   - No new CustomerInventoryBalance row needs to be created
    //   - The deposit_refunded ledger row already carries the qty audit
    //
    // No-op left intentionally — leaving the withCustomerQty snapshot
    // where it is. If the operator issued a deposit for a customer who
    // never actually held any of the type (`withCustomerQty=0` at charge
    // time), it's still 0 now — correct. If the operator issued a
    // deposit while customer had 5 held, then charge dropped it to 2
    // (deposit for 3), then refund of 1 → still 2 (customer still has
    // 2 held + returned 1 that went to depot). Also correct.

    return { ledgerEntryId: depositRow.id, paymentId, creditNoteId };
  });
}

/**
 * Change G (2026-07-31 v6) — list deposits for the /app/billing-payments
 * Deposits tab. Reads CustomerLedgerEntry rows where entryType IN
 * ('deposit_charged', 'deposit_refunded') and joins:
 *   - Customer name
 *   - CylinderType.typeName
 *   - PaymentTransaction (via referenceId) for the paymentMethod
 *   - CreditNote (via referenceId) for the credit-note-refund flow
 *
 * Returns rows + paging meta + summary (totalHeld, customerCount,
 * cylinderCount) so the header KPI strip renders in one round-trip.
 *
 * RBAC gate at the route layer — same tier as list payments.
 */
export interface DepositListFilters {
  customerId?: string;
  cylinderTypeId?: string;
  eventType?: 'charged' | 'refunded' | 'all';
  dateFrom?: string;
  dateTo?: string;
  method?: string;
  page?: number;
  pageSize?: number;
  sortOrder?: 'asc' | 'desc';
}

export interface DepositListRow {
  id: string;
  entryDate: string;
  customerId: string;
  customerName: string;
  eventType: 'charged' | 'refunded';
  cylinderTypeId: string | null;
  cylinderTypeName: string | null;
  qty: number;
  amount: number;
  paymentMethod: string | null;
  referenceType: 'payment' | 'credit_note' | null;
  referenceNumber: string | null;
  narration: string | null;
  // Change L v2 (2026-07-31): sequential voucher number for the proof-of-
  // deposit PDF. Null for legacy rows or no-docCode tenants — the PDF
  // then falls back to DEP-<uuid-prefix>.
  voucherNumber: string | null;
}

export async function listDeposits(
  distributorId: string,
  filters: DepositListFilters,
): Promise<{
  data: DepositListRow[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
  summary: { totalHeld: number; customerCount: number; cylinderCount: number };
}> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 25));
  const sortOrder = filters.sortOrder ?? 'desc';

  const where: Prisma.CustomerLedgerEntryWhereInput = {
    distributorId,
    entryType: filters.eventType === 'charged'
      ? 'deposit_charged'
      : filters.eventType === 'refunded'
        ? 'deposit_refunded'
        : { in: ['deposit_charged', 'deposit_refunded'] },
  };
  if (filters.customerId) where.customerId = filters.customerId;
  if (filters.cylinderTypeId) where.cylinderTypeId = filters.cylinderTypeId;
  if (filters.dateFrom || filters.dateTo) {
    where.entryDate = {
      ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
      ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {}),
    };
  }

  // Fetch rows + total in parallel. Joins pulled inline so the shape
  // reaches the route in one query.
  const [rows, total] = await Promise.all([
    prisma.customerLedgerEntry.findMany({
      where,
      orderBy: [{ entryDate: sortOrder }, { createdAt: sortOrder }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        entryDate: true,
        customerId: true,
        entryType: true,
        cylinderTypeId: true,
        qtyDelta: true,
        amountDelta: true,
        referenceId: true,
        narration: true,
        voucherNumber: true,
        customer: { select: { customerName: true } },
        cylinderType: { select: { typeName: true } },
      },
    }),
    prisma.customerLedgerEntry.count({ where }),
  ]);

  // Enrich with paymentMethod (from PaymentTransaction) OR reference to
  // a CreditNote (credit-note refund path). Two lookups, one per source.
  const refIds = rows.map((r) => r.referenceId).filter((x): x is string => !!x);
  const [paymentRefs, creditNoteRefs] = await Promise.all([
    refIds.length === 0
      ? Promise.resolve([] as Array<{ id: string; paymentMethod: string; referenceNumber: string | null }>)
      : prisma.paymentTransaction.findMany({
          where: { id: { in: refIds }, distributorId },
          select: { id: true, paymentMethod: true, referenceNumber: true },
        }),
    refIds.length === 0
      ? Promise.resolve([] as Array<{ id: string; creditNoteNumber: string | null }>)
      : prisma.creditNote.findMany({
          where: { id: { in: refIds } },
          select: { id: true, creditNoteNumber: true },
        }),
  ]);
  const paymentByRef = new Map(paymentRefs.map((p) => [p.id, p]));
  const cnByRef = new Map(creditNoteRefs.map((c) => [c.id, c]));

  const data: DepositListRow[] = rows.map((r) => {
    const paymentRow = paymentByRef.get(r.referenceId);
    const cnRow = cnByRef.get(r.referenceId);
    // Apply method-filter here (post-join) — done in-memory because
    // filtering by paymentMethod requires the paymentTransaction join
    // which Prisma doesn't compose cleanly with the ledger where.
    const paymentMethod = paymentRow?.paymentMethod ?? (cnRow ? 'credit_note' : null);
    return {
      id: r.id,
      entryDate: r.entryDate.toISOString().slice(0, 10),
      customerId: r.customerId,
      customerName: r.customer?.customerName ?? '',
      eventType: r.entryType === 'deposit_charged' ? 'charged' : 'refunded',
      cylinderTypeId: r.cylinderTypeId,
      cylinderTypeName: r.cylinderType?.typeName ?? null,
      qty: r.qtyDelta ?? 0,
      amount: toNum(r.amountDelta),
      paymentMethod,
      referenceType: paymentRow ? 'payment' : cnRow ? 'credit_note' : null,
      referenceNumber: paymentRow?.referenceNumber ?? cnRow?.creditNoteNumber ?? null,
      narration: r.narration,
      voucherNumber: r.voucherNumber,
    };
  });
  const filteredData = filters.method ? data.filter((d) => d.paymentMethod === filters.method) : data;

  // Summary: aggregate across ALL charged/refunded rows for this
  // distributor (NOT paged, NOT filtered by row filters — the whole
  // held-deposits picture). One query, tiny result.
  const [chargedAgg, refundedAgg, customerRows] = await Promise.all([
    prisma.customerLedgerEntry.aggregate({
      where: { distributorId, entryType: 'deposit_charged' },
      _sum: { amountDelta: true, qtyDelta: true },
    }),
    prisma.customerLedgerEntry.aggregate({
      where: { distributorId, entryType: 'deposit_refunded' },
      _sum: { amountDelta: true, qtyDelta: true },
    }),
    prisma.customerLedgerEntry.groupBy({
      by: ['customerId'],
      where: { distributorId, entryType: { in: ['deposit_charged', 'deposit_refunded'] } },
      _count: { customerId: true },
    }),
  ]);
  const totalHeld = toNum(chargedAgg._sum.amountDelta ?? 0) - toNum(refundedAgg._sum.amountDelta ?? 0);
  const cylinderCount = (chargedAgg._sum.qtyDelta ?? 0) - (refundedAgg._sum.qtyDelta ?? 0);
  const summary = {
    totalHeld: Math.round(totalHeld * 100) / 100,
    customerCount: customerRows.length,
    cylinderCount: Math.max(0, cylinderCount),
  };

  return {
    data: filteredData,
    meta: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
    summary,
  };
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
  options?: {
    // 2026-07-28 — hide cancelled-order pairs from the returned rows and from
    // the running-balance calc. Both the original invoice_entry row AND its
    // paired 'adjustment' reversal row are dropped, so the customer statement
    // reads as though the cancelled order never happened. DB rows are
    // untouched — every non-hiding reader (in-app operator ledger table,
    // aging queries, analytics) still sees them. Used by mini-op tenants
    // only: customerLedgerPdfService.generateCustomerLedgerPdf/generateGroupLedgerPdf
    // gate this on distributor.accountType === 'mini_operator'.
    hideCancelledInvoices?: boolean;
  },
): Promise<CustomerLedgerResponse> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, distributorId, deletedAt: null },
    select: { id: true, creditPeriodDays: true },
  });
  if (!customer) throw new PaymentError('Customer not found', 404);

  // Pull ALL ledger entries (not range-filtered yet) so we can compute the
  // carry-forward "Opening Balance b/f" amount from pre-range entries.
  const rawEntries = await prisma.customerLedgerEntry.findMany({
    where: { distributorId, customerId },
    orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }],
  });

  // Pre-load referenced invoices + empty prices then delegate to the
  // stateless processor. This factoring (Feature A, 2026-07-15) exists
  // so the group-portal service can prefetch entries for N customer
  // buckets in a single query and run the processor per bucket without
  // additional round-trips. The old flow (fetch → process inline) is
  // preserved exactly here: same DB reads, same output.
  const invoiceMap = await loadInvoicesForLedger(rawEntries);

  // 2026-07-28 — hideCancelledInvoices: drop the original invoice_entry row
  // for every cancelled invoice AND the paired 'adjustment' reversal row
  // (identified by narration starting with 'Cancelled:'). Both drops must
  // happen atomically or the running balance goes off — the original alone
  // being present would leave a debit that never gets undone, and the
  // reversal alone being present would credit a debit that isn't there.
  // Anything else stays: payments to the cancelled invoice (still real
  // money in), empties_return rows tied to the cancelled order (already
  // reversed by the same cancel flow via a separate empties event, if the
  // order was delivered).
  const allEntries = options?.hideCancelledInvoices
    ? rawEntries.filter((e) => {
        if (e.entryType === 'invoice_entry' && e.invoiceId) {
          const inv = invoiceMap.get(e.invoiceId);
          if (inv?.status === 'cancelled') return false;
        }
        if (
          e.entryType === 'adjustment'
          && (e.narration ?? '').startsWith('Cancelled:')
        ) {
          return false;
        }
        return true;
      })
    : rawEntries;
  const emptyPriceMap = await loadEmptyPricesForLedger(distributorId);
  const cylinderTypeNameMap = await loadCylinderTypeNamesForLedger(distributorId);
  // 2026-07-27 — Fix 1. Pre-load the standalone empties-return inventory
  // events so processLedgerEntries can decrement the running Pend E counter
  // on each empties_return ledger row. The writer at
  // emptiesReturnService.recordEmptiesReturn emits two paired inventory
  // events per return (`returns_collection` + `reconciliation_empties_return`)
  // with identical `emptiesChange`, so we fetch `returns_collection` only
  // to avoid double-counting. Key: `${dateISO}|${qty}` because a customer
  // can legitimately have multiple returns of different cylinder types on
  // the same date; the ledger entry's narration ("Empties: {qty}× {type}")
  // is the discriminator (see parse in processLedgerEntries).
  const emptiesReturnEvents = await prisma.inventoryEvent.findMany({
    where: {
      distributorId,
      referenceType: 'empties_return',
      referenceId: customerId,
      eventType: 'returns_collection',
    },
    select: { eventDate: true, cylinderTypeId: true, emptiesChange: true, cylinderType: { select: { typeName: true } } },
  });
  const emptiesReturnByKey = new Map<string, { cylinderTypeId: string; typeName: string; qty: number }>();
  for (const ev of emptiesReturnEvents) {
    const key = `${ev.eventDate.toISOString().slice(0, 10)}|${ev.emptiesChange}`;
    // If two returns of identical qty on same date for different cyl types
    // exist, the later one overwrites — a caveat callers should be aware of.
    // No such collisions in prod as of the 2026-07-27 audit (6 returns total,
    // all with distinct qty+date signatures).
    emptiesReturnByKey.set(key, {
      cylinderTypeId: ev.cylinderTypeId,
      typeName: ev.cylinderType?.typeName ?? '',
      qty: ev.emptiesChange,
    });
  }
  // 2026-07-21 opening-state seed: load the OB empties snapshot with
  // cylinder type NAMES so the Ledger can emit one OB row per seeded
  // cylinder type. `openingSeedQty=0` rows are skipped (map stays
  // lean for legacy customers).
  const seedRows = await prisma.customerInventoryBalance.findMany({
    where: { customerId, openingSeedQty: { gt: 0 } },
    select: {
      cylinderTypeId: true,
      openingSeedQty: true,
      cylinderType: { select: { typeName: true } },
    },
  });
  const openingEmptiesByType = new Map<string, { typeName: string; qty: number }>(
    seedRows.map((r) => [r.cylinderTypeId, {
      typeName: r.cylinderType?.typeName ?? '',
      qty: r.openingSeedQty,
    }]),
  );
  return processLedgerEntries({
    entries: allEntries,
    invoiceMap,
    emptyPriceMap,
    creditPeriodDays: customer.creditPeriodDays,
    range,
    openingEmptiesByType,
    emptiesReturnByKey,
    cylinderTypeNameMap,
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

/**
 * Deposit ledger (2026-07-31): preload cylinder-type names by id so the
 * summary.depositBreakdown block can render `19.2KG METAL: 30 × ₹1,950
 * = ₹58,500` without a per-row join. Cheap one-off query — a distributor
 * usually has 3-8 active types.
 */
export async function loadCylinderTypeNamesForLedger(
  distributorId: string,
): Promise<Map<string, string>> {
  const types = await prisma.cylinderType.findMany({
    where: { distributorId },
    select: { id: true, typeName: true },
  });
  return new Map(types.map((t) => [t.id, t.typeName]));
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
  // 2026-07-28 — needed by getCustomerLedger's hideCancelledInvoices option
  // to filter out cancelled invoice_entry rows for mini-op statement PDFs.
  status: true,
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
  status: string;
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
  // 2026-07-21 opening-state seed: per-cylinder-type OB empties
  // count + type-name (customer_inventory_balances.opening_seed_qty
  // joined to cylinder_types.type_name). When non-empty the
  // synthesised OB block emits ONE row per cylinder type, each row
  // showing the type name in the Type column + qty in Pend E.
  // The running empties counter is ALSO initialized from these
  // values so subsequent delivery rows carry-forward correctly.
  // Legacy customers (never seeded) → undefined → single aggregate
  // OB row with blank Type + Pend E blank (previous behaviour).
  openingEmptiesByType?: Map<string, { typeName: string; qty: number }>;
  // 2026-07-27 — Fix 1. Pre-loaded map of standalone empties-return
  // inventory-event details, keyed by `${dateISO}|${qty}`. Populated by
  // getCustomerLedger from `inventoryEvent` rows with
  // referenceType='empties_return' (writer: emptiesReturnService).
  // Enables the reader to (a) decrement the running Pend E counter on
  // each empties_return ledger row and (b) attach the returned qty +
  // cylinder-type name to the emitted row so the PDF Total picks it up.
  // Undefined when no returns exist for the customer.
  emptiesReturnByKey?: Map<string, { cylinderTypeId: string; typeName: string; qty: number }>;
  // Deposit ledger (2026-07-31): cylinder-type-id → typeName map used
  // to render summary.depositBreakdown ("19.2KG METAL: 30 × ₹1,950").
  // Optional for backward compat with any external callers that don't
  // preload it; when absent, breakdown entries fall back to '' names.
  cylinderTypeNameMap?: Map<string, string>;
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
  const { entries: allEntries, invoiceMap, emptyPriceMap, creditPeriodDays: creditDays, range, openingEmptiesByType, emptiesReturnByKey, cylinderTypeNameMap } = input;

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
  // 2026-07-21 opening-state seed: initialize the running-empties
  // counter from the OB snapshot so the "Pend E" column starts at the
  // seeded baseline (not zero) on subsequent delivery rows. Legacy
  // customers (no seed) → empty map → zero baseline preserved.
  const pendingEmptiesPerType = new Map<string, number>();
  if (openingEmptiesByType) {
    for (const [typeId, { qty }] of openingEmptiesByType) {
      if (qty > 0) pendingEmptiesPerType.set(typeId, qty);
    }
  }
  // 2026-07-29 — Track the naive (unclamped-per-step) totals per type so
  // summary.emptyCylsCost matches the Total-row Pend E rendered by the
  // PDF. Previously summary.emptyCylsCost read the running clamped state
  // — which loses "over-return" credits at each `max(0, cur+d-c)` step —
  // and diverged from the naive Total formula the PDF uses
  // (`max(0, opening + Σdelivered − Σcollected)`). Symptom: a statement
  // could show Total Pend E = 1 next to Emp Cost = ₹7,200 (= 3 × price),
  // where the 3 came from the clamped final and the 1 from the naive sum.
  // These accumulators use the same math the Total row does, so the
  // summary always agrees with the visible bottom-row.
  const openingPerType = new Map<string, number>();
  const deliveredPerType = new Map<string, number>();
  const collectedPerType = new Map<string, number>();
  // Deposit ledger (2026-07-31): running ₹ + qty on deposit per type.
  // Positive = customer has paid deposit; negative should never happen
  // (deposit_refunded events subtract, clamped >= 0 for qty at read time).
  // These drive the "Dep Given" column + per-type breakdown box at the
  // top of the ledger PDF and web view.
  const depositGivenPerType = new Map<string, number>();
  const depositQtyPerType = new Map<string, number>();
  if (openingEmptiesByType) {
    for (const [typeId, { qty }] of openingEmptiesByType) {
      if (qty > 0) openingPerType.set(typeId, qty);
    }
  }
  const openingEmptySeedEntries = openingEmptiesByType
    ? [...openingEmptiesByType.entries()].filter(([, v]) => v.qty > 0)
    : [];
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
      depositGiven: Math.round((partial.depositGiven ?? 0) * 100) / 100,
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
    //
    // 2026-08-14 — MUST be gated to `invoice_entry`. A delivery's physical
    // cylinder movement is recorded exactly once, on the invoice_entry row.
    // Other entry types (adjustment, credit_note, debit_note) legitimately
    // carry the SAME invoiceId as a linkage, and inv.order.items is the
    // shared order — so without this gate the pre-pass re-walked those items
    // and double-counted delivered/collected. Live symptom: a cancelled
    // walk-in (invoice_entry + paired 'Cancelled:' adjustment, both pointing
    // at the same invoice) counted its 5 cylinders TWICE → Total-row Pend E
    // and Emp Cost were inflated (₹38,500 instead of ₹3,500 on the Taj
    // Deccan Cafe statement, 2026-08-14). Money columns were never affected
    // (this block only touches the physical/empties accumulators), so this
    // is a display-integrity fix with zero balance impact. Guard test:
    // customer-statement-cancelled-invoice.test.ts.
    if (entry.entryType === 'invoice_entry' && inv?.order?.items?.length) {
      for (const it of inv.order.items) {
        const delivered = it.deliveredQuantity ?? it.quantity;
        const collected = it.emptiesCollected ?? 0;
        const cur = pendingEmptiesPerType.get(it.cylinderTypeId) ?? 0;
        // 2026-07-29 — no per-step clamp. Previously we clamped at every
        // update (`max(0, cur + d − c)`) which capped an empties return at
        // "what's currently pending" and dropped the "over-return credit"
        // that should offset the NEXT delivery. Symptom: 5 opening → 3
        // pending, customer returns 4, pending shows 0 (should be −1);
        // next delivery of 3 fulls shows pending 3 (should be 2). Now we
        // let the counter carry the signed net; display sites clamp at
        // emit time so the reader still sees a non-negative Pend E.
        pendingEmptiesPerType.set(it.cylinderTypeId, cur + delivered - collected);
        // Per-type naive accumulators (unchanged) — feed summary.emptyCylsCost
        // via the Total-row formula (see openingPerType comment).
        deliveredPerType.set(it.cylinderTypeId, (deliveredPerType.get(it.cylinderTypeId) ?? 0) + delivered);
        collectedPerType.set(it.cylinderTypeId, (collectedPerType.get(it.cylinderTypeId) ?? 0) + collected);
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
          // 2026-07-29 — signed running counter; clamp at display so the
          // over-return credit still flows to the NEXT delivery (which
                // will surface it as `cur + delivered − collected` = the
                // net-positive pending) but individual rows never render
                // a negative Pend E on-screen.
          const pendingForType = Math.max(0, pendingEmptiesPerType.get(typeId) ?? 0);
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
        //
        // 2026-07-27 — Fix 1. Attach the returned qty + type name so the
        // PDF Total row's Pend E formula picks up standalone returns (it
        // previously only saw invoice-row collections and over-reported
        // pending empties by the returned qty). Also decrement the running
        // pendingEmptiesPerType counter so the row itself shows the
        // updated Pend E (was blank on empties_return rows).
        // Match key: `${dateISO}|${qty}` — see the emptiesReturnByKey
        // build site in getCustomerLedger for the format.
        let matched: { cylinderTypeId: string; typeName: string; qty: number } | undefined;
        if (emptiesReturnByKey) {
          const narrMatch = /^Empties:\s*(\d+)/.exec(entry.narration ?? '');
          const parsedQty = narrMatch ? parseInt(narrMatch[1], 10) : NaN;
          if (Number.isFinite(parsedQty)) {
            const key = `${entry.entryDate.toISOString().slice(0, 10)}|${parsedQty}`;
            matched = emptiesReturnByKey.get(key);
          }
        }
        if (matched) {
          // 2026-07-29 — no clamp. An over-return (customer hands back more
          // empties than currently pending) becomes a negative counter that
          // offsets the next delivery. See the delivery-branch comment for
          // the rationale. Display sites clamp at emit.
          const cur = pendingEmptiesPerType.get(matched.cylinderTypeId) ?? 0;
          pendingEmptiesPerType.set(matched.cylinderTypeId, cur - matched.qty);
          // Mirror into the naive collected counter so summary.emptyCylsCost
          // reconciles with the Total-row formula for standalone returns too.
          collectedPerType.set(matched.cylinderTypeId, (collectedPerType.get(matched.cylinderTypeId) ?? 0) + matched.qty);
        }
        if (!emit) return;
        // 2026-07-31 v5 (Change F): empties_return row now emits
        // PER-TYPE Pend E + per-type Emp Cost, matching the invoice-row
        // and deposit-row pattern. Pre-v5 the row emitted aggregate
        // Pend E and a blank Emp Cost — inconsistent with everything
        // else on the ledger and made the "which type dropped by how
        // much" question hard to answer from the ledger alone.
        let perTypePending = 0;
        let perTypeEmpCost = 0;
        if (matched) {
          perTypePending = Math.max(0, pendingEmptiesPerType.get(matched.cylinderTypeId) ?? 0);
          const emptyPrice = emptyPriceMap.get(matched.cylinderTypeId) ?? 0;
          perTypeEmpCost = perTypePending * emptyPrice;
        }
        emitRow(entry.entryDate, {
          orderDate: dateStr,
          amount: 0,
          receivedAmount: 0,
          // Populated when the pre-fetch found the matching inventoryEvent;
          // falls back to 0/blank if it didn't (defensive — PDF renders "-"
          // for zero, same as before this fix). The PDF Total sums this
          // column, so having the real qty here is what closes the bug.
          emptyCylsCollected: matched?.qty ?? 0,
          cylinderType: matched?.typeName ?? '',
          // v5 (Change F): per-type snapshot for the returned type only
          // (not aggregate across all types). Renderer's Total-row Pend E
          // uses its own accumulator so aggregate stays correct.
          pendingEmptyCyls: perTypePending,
          emptyCylsCost: perTypeEmpCost,
          narration: entry.narration ?? 'Empties return',
          kind: 'empties_return',
        });
        return;
      }
      case 'defective_collected': {
        // F1 (2026-08-06) — physical-only row when office captures a
        // defective full picked up from customer. amountDelta=0 (writer
        // enforces), invoiceId=null (writer enforces), so this branch
        // MUST NOT touch cumulativeInvoiceAmount / cumulativeReceivedAmount.
        // Unlike empties_return, this row does NOT decrement
        // pendingEmptiesPerType — a defective full is a separate physical
        // category from an "empty owed back". Suneel spec explicitly wants
        // these tracked as different buckets. When the CN is later raised
        // for this row, a SEPARATE `credit_note` ledger row fires with
        // negative amountDelta — that row handles the money side.
        if (!emit) return;
        emitRow(entry.entryDate, {
          orderDate: dateStr,
          amount: 0,
          receivedAmount: 0,
          // No empties fields — this is defective FULL, not empty.
          // Renderer shows "-" in Emp C / Pend E for this row.
          emptyCylsCollected: 0,
          pendingEmptyCyls: 0,
          emptyCylsCost: 0,
          cylinderType: '',
          narration: entry.narration ?? 'Defective returned',
          kind: 'defective_collected',
        });
        return;
      }
      case 'deposit_charged': {
        // Deposit ledger (2026-07-31, per-type refinement 2026-07-31 v2).
        // Customer paid a refundable cylinder deposit for a SPECIFIC
        // cylinder type — Pend E for that type drops by qty. The row
        // now emits PER-TYPE Pend E / Emp Cost values (matching the
        // invoice-row pattern at line 1035-1049), NOT an aggregate
        // sum across all types. Reader sees "on this date: 3 of 19KG
        // went on deposit → 19KG pending: 7→4 → 19KG exposure: ₹7,800".
        //
        // Two accountings are maintained:
        //   (1) pendingEmptiesPerType — running per-type Pend E, used by
        //       invoice rows AND now deposit rows for per-row display.
        //   (2) depositGivenPerType / depositQtyPerType — running deposit
        //       ₹ + qty per type, used by the summary.depositBreakdown
        //       block that renders below the table.
        //
        // amountDelta is INFORMATIONAL for this branch — it does NOT
        // flow into cumulativeReceivedAmount (which drives Due Amt).
        // The invoice-side payment amount is already captured in the
        // companion payment_entry row (only emitted for mixed payments;
        // pure-deposit payments emit no payment_entry — see
        // createPaymentInTx).
        const typeId = entry.cylinderTypeId;
        const qty = entry.qtyDelta ?? 0;
        let cylinderTypeName = '';
        let perTypePending = 0;
        let perTypeEmpCost = 0;
        if (typeId && qty > 0) {
          const cur = pendingEmptiesPerType.get(typeId) ?? 0;
          pendingEmptiesPerType.set(typeId, cur - qty);
          collectedPerType.set(typeId, (collectedPerType.get(typeId) ?? 0) + qty);
          depositGivenPerType.set(
            typeId,
            (depositGivenPerType.get(typeId) ?? 0) + toNum(entry.amountDelta),
          );
          depositQtyPerType.set(typeId, (depositQtyPerType.get(typeId) ?? 0) + qty);
          cylinderTypeName = cylinderTypeNameMap?.get(typeId) ?? '';
          perTypePending = Math.max(0, pendingEmptiesPerType.get(typeId) ?? 0);
          const emptyPrice = emptyPriceMap.get(typeId) ?? 0;
          perTypeEmpCost = perTypePending * emptyPrice;
        }
        if (!emit) return;
        emitRow(entry.entryDate, {
          orderDate: dateStr,
          amount: 0,
          receivedAmount: 0,
          emptyCylsCollected: qty,       // qty of THIS type going on deposit
          cylinderType: cylinderTypeName, // Type column shows the type
          pendingEmptyCyls: perTypePending, // per-type snapshot (not aggregate)
          emptyCylsCost: perTypeEmpCost,    // per-type ₹ (not aggregate)
          depositGiven: toNum(entry.amountDelta),
          narration: entry.narration ?? 'Deposit received',
          kind: 'deposit_charged',
        });
        return;
      }
      case 'deposit_refunded': {
        // Deposit refund semantics (2026-07-31 v2 correction):
        //   - Customer physically returns N cylinders to the depot AND
        //     collects the deposit ₹ back (cash-refund path) OR credit-
        //     notes it against an invoice (credit-note path).
        //   - The cylinders are AT THE DEPOT after the event — they are
        //     NOT sitting with the customer as "pending refill". Pend E
        //     therefore MUST NOT increase.
        //   - collectedPerType must NOT be decremented — the original
        //     deposit_charged event incremented it (correctly, since the
        //     cylinder ownership transferred). The refund is a SEPARATE
        //     "empties returned to depot" event conceptually — treated as
        //     a collection on the display axis (Emp C = qty).
        //
        // What DOES change: depositQtyPerType and depositGivenPerType
        // drop by qty / amount — Deposits Held summary block reduces
        // correctly.
        //
        // amountDelta on this row is INFORMATIONAL — the cash movement
        // is booked as a negative PaymentTransaction (cash) or CreditNote
        // (credit-note). Both are handled by refundDeposit() and emit
        // their own separate ledger rows that flow into cumulative*.
        const typeId = entry.cylinderTypeId;
        const qty = entry.qtyDelta ?? 0;
        let cylinderTypeName = '';
        let perTypePending = 0;
        let perTypeEmpCost = 0;
        if (typeId && qty > 0) {
          depositGivenPerType.set(
            typeId,
            (depositGivenPerType.get(typeId) ?? 0) - toNum(entry.amountDelta),
          );
          depositQtyPerType.set(
            typeId,
            Math.max(0, (depositQtyPerType.get(typeId) ?? 0) - qty),
          );
          cylinderTypeName = cylinderTypeNameMap?.get(typeId) ?? '';
          // Per-type Pend E snapshot — UNCHANGED by refund (cylinder is
          // at depot after refund, not with customer).
          perTypePending = Math.max(0, pendingEmptiesPerType.get(typeId) ?? 0);
          const emptyPrice = emptyPriceMap.get(typeId) ?? 0;
          perTypeEmpCost = perTypePending * emptyPrice;
        }
        if (!emit) return;
        emitRow(entry.entryDate, {
          orderDate: dateStr,
          amount: 0,
          receivedAmount: 0,
          emptyCylsCollected: qty,        // cylinder(s) came back to depot — a collection event
          cylinderType: cylinderTypeName, // Type column shows the type
          pendingEmptyCyls: perTypePending, // unchanged by refund
          emptyCylsCost: perTypeEmpCost,    // unchanged by refund
          depositGiven: -toNum(entry.amountDelta),
          narration: entry.narration ?? 'Deposit refunded',
          kind: 'deposit_refunded',
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
  // 2026-07-21 — surface the OB row also when the customer has NO ₹
  // opening balance but DOES have seeded empties, so mini-op customers
  // seeded with only empties (or edited to clear the ₹) still show a
  // visible "Opening Balance b/f" row on the ledger. Previously the row
  // only appeared when |openingBalance| > 0.005 which hid empties-only
  // seeds and gave the impression the seed had been lost.
  const showOpeningRow =
    Math.abs(openingBalance) > 0.005 || openingEmptySeedEntries.length > 0;

  if (showOpeningRow) {
    // Carry-forward block — sits at the top of the period before any
    // in-range transaction. Emits up to TWO kinds of rows:
    //   (a) ONE ₹ money row when the customer has a non-zero opening
    //       balance — narration "Opening Balance b/f", all cylinder
    //       columns blank, money columns filled. This is the row a
    //       collections agent looks at to understand the outstanding.
    //   (b) N empties rows — ONE per seeded cylinder type — narration
    //       "Opening empties held", Type column = typeName, Pend E =
    //       qty. Money columns blank on empties rows (the ₹ figure
    //       lives on the money row above; putting the money on the
    //       first empties row conflated two concepts and made the
    //       second-row zeros look like a bug).
    //
    // Date convention: report-start − 1 day so the reader sees it's
    // carried forward from BEFORE the period. If no range was supplied,
    // fall back to (earliest in-range entry − 1 day) or today − 1 day.
    const firstInRange = allEntries.find((e) => {
      const inRange = (!fromDate || e.entryDate >= fromDate) && (!toDate || e.entryDate <= toDate);
      const isOB = e.entryType === 'invoice_entry' && !!(e.invoiceId && invoiceMap.get(e.invoiceId)?.isOpeningBalance);
      return inRange && !isOB;
    });
    const bfAnchor = fromDate ?? firstInRange?.entryDate ?? new Date();
    const bfDate = new Date(bfAnchor);
    bfDate.setDate(bfDate.getDate() - 1);

    const bfDateStr = bfDate.toISOString().split('T')[0];
    const roundedOpeningBalance = Math.round(openingBalance * 100) / 100;
    const hasMoney = Math.abs(roundedOpeningBalance) > 0.005;
    // (a) Emit the money row FIRST when there's a ₹ opening balance.
    if (hasMoney) {
      rows.push({
        orderDate: bfDateStr,
        cylinderType: '',
        fullCylsDelivered: 0,
        amount: 0,
        emptyCylsCollected: 0,
        pendingEmptyCyls: 0,
        emptyCylsCost: 0,
        totalAmount: Math.round(cumulativeInvoiceAmount * 100) / 100,
        receivedAmount: Math.round(cumulativeReceivedAmount * 100) / 100,
        dueAmount: roundedOpeningBalance,
        creditDays,
        overDueAmount: 0,
        // v13 (2026-07-31): shortened from "Opening Balance b/f" (19
        // chars) to "Opening Balance" (15) so the Narration column's
        // 18-char cap doesn't truncate to "Opening Balance b...".
        // Two words, ends cleanly.
        narration: 'Opening Balance',
        kind: 'opening',
      });
    }
    // (b) Then emit one empties row per seeded cylinder type. Money
    // columns are blank on these — they belong to the money row above.
    // Emp Cost column carries the per-type liability (qty × empty
    // cylinder price) so a mini-op reseller sees the value of empties
    // they’re carrying for the customer. If there are seeded empties
    // BUT no ₹, the empties rows still carry the running-balance
    // snapshot (0) so the reader sees the opening cash position was zero.
    openingEmptySeedEntries.forEach(([typeId, { typeName, qty }], idx) => {
      const isFirstEmptyRow = !hasMoney && idx === 0;
      const perTypePrice = emptyPriceMap.get(typeId) ?? 0;
      rows.push({
        orderDate: bfDateStr,
        cylinderType: typeName,
        fullCylsDelivered: 0,
        amount: 0,
        emptyCylsCollected: 0,
        pendingEmptyCyls: qty,
        emptyCylsCost: Math.round(qty * perTypePrice * 100) / 100,
        // When there is no money row, snapshot the running balance (0)
        // on the very first empties row so a reader still sees the
        // Total Amt / Due Amt columns start at 0 rather than blank.
        totalAmount: isFirstEmptyRow ? Math.round(cumulativeInvoiceAmount * 100) / 100 : 0,
        receivedAmount: isFirstEmptyRow ? Math.round(cumulativeReceivedAmount * 100) / 100 : 0,
        dueAmount: isFirstEmptyRow ? roundedOpeningBalance : 0,
        creditDays,
        overDueAmount: 0,
        // v13 (2026-07-31): shortened — "Opening empties held" (20 chars)
        // → "Opening Empties" (15). Same reason as the ₹ b/f row above:
        // 18-char Narration cap was truncating to "Opening empties h...".
        // "Opening Balance b/f" → "Opening Balance" for the fallback
        // first-row case too.
        narration: hasMoney ? 'Opening Empties' : (idx === 0 ? 'Opening Balance' : 'Opening Empties'),
        kind: 'opening',
      });
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

  // 2026-07-29 — sum over the naive per-type totals (matches the
  // Total-row Pend E formula in customerLedgerPdfService). Previously we
  // summed `pendingEmptiesPerType` (the clamped-per-step running state)
  // which could exceed the naive figure when a customer over-returned at
  // some point mid-period (the per-step clamp lost the "credit"). That
  // produced statements with e.g. Pend E=1 next to Emp Cost=₹7,200.
  const allTypeIds = new Set<string>([
    ...openingPerType.keys(),
    ...deliveredPerType.keys(),
    ...collectedPerType.keys(),
  ]);
  let totalEmptyCylsCost = 0;
  for (const typeId of allTypeIds) {
    const opening = openingPerType.get(typeId) ?? 0;
    const delivered = deliveredPerType.get(typeId) ?? 0;
    const collected = collectedPerType.get(typeId) ?? 0;
    const naivePending = Math.max(0, opening + delivered - collected);
    const price = emptyPriceMap.get(typeId) ?? 0;
    totalEmptyCylsCost += naivePending * price;
  }

  // Deposit ledger (2026-07-31): build the per-cylinder-type breakdown
  // from the running deposit accumulators. Skips zero-amount entries so
  // types that had a deposit_charged fully offset by a deposit_refunded
  // don't show in the breakdown UI. Names come from the preloaded
  // cylinderTypeNameMap; falls back to '' for legacy callers that
  // didn't preload (breakdown still renders with qty + amount).
  const depositBreakdown: NonNullable<CustomerLedgerResponse['summary']['depositBreakdown']> = [];
  for (const [typeId, amount] of depositGivenPerType) {
    const qty = depositQtyPerType.get(typeId) ?? 0;
    if (Math.abs(amount) < 0.005 && qty === 0) continue;
    depositBreakdown.push({
      cylinderTypeId: typeId,
      cylinderTypeName: cylinderTypeNameMap?.get(typeId) ?? '',
      qty,
      amount: Math.round(amount * 100) / 100,
    });
  }
  depositBreakdown.sort((a, b) => b.amount - a.amount);

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
    // Deposit ledger (2026-07-31): running deposit ₹ + qty per
    // cylinder type. Empty array when no deposits recorded. Drives the
    // per-type breakdown box at the top of the ledger PDF/web view.
    depositBreakdown,
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

  const [orders, openingInvoices, payments, depositAgg] = await Promise.all([
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
    // Deposit ledger (2026-07-31 refinement): a cylinder deposit is a
    // refundable liability, NOT an invoice payment. PaymentTransaction.amount
    // still tracks physical cash-in (correct for bank recon / Tally), but
    // the credit-gate overdue calc must SUBTRACT the net-held-deposit
    // portion so a customer who paid ₹5000 (all deposit) against a ₹1000
    // invoice still shows as overdue.
    //
    // Storage convention: amountDelta is +ve on BOTH deposit_charged and
    // deposit_refunded rows. Net-held-deposit = Σ charged − Σ refunded.
    // Cash-side accounting:
    //   - Cash-out refund books a negative PaymentTransaction (already
    //     nets out in the cash sum above).
    //   - Credit-note refund books no PaymentTransaction (the refund
    //     goes to the invoice's outstanding directly).
    // Either way, subtracting Σ (charged − refunded) from cash-in-total
    // gives cash-against-invoices correctly for both refund paths.
    prisma.customerLedgerEntry.groupBy({
      by: ['entryType'],
      where: {
        distributorId, customerId,
        entryType: { in: ['deposit_charged', 'deposit_refunded'] },
      },
      _sum: { amountDelta: true },
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

  // Deposit ledger (2026-07-31): the FIFO invoice-payment allocator only
  // wants the invoice-side portion of cash-in, NOT deposit money. Subtract
  // net-held-deposit = Σ deposit_charged − Σ deposit_refunded from the raw
  // PaymentTransaction sum. See the depositAgg query comment above for the
  // storage-sign convention.
  const totalPaymentsCashIn = payments.reduce((s, p) => s + toNum(p.amount), 0);
  const chargedSum = toNum(
    depositAgg.find((r) => r.entryType === 'deposit_charged')?._sum.amountDelta ?? 0,
  );
  const refundedSum = toNum(
    depositAgg.find((r) => r.entryType === 'deposit_refunded')?._sum.amountDelta ?? 0,
  );
  const netDepositHeld = chargedSum - refundedSum;
  const totalReceived = totalPaymentsCashIn - netDepositHeld;

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
