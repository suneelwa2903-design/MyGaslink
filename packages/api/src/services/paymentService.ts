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
    page?: number; pageSize?: number;
    sortBy?: 'createdAt' | 'amount' | 'transactionDate';
    sortOrder?: 'asc' | 'desc';
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

  const page = filters.page || 1;
  const pageSize = filters.pageSize || 25;
  const sortBy = filters.sortBy ?? 'createdAt';
  const sortOrder = filters.sortOrder ?? 'desc';

  const [payments, total] = await Promise.all([
    prisma.paymentTransaction.findMany({
      where,
      include: {
        customer: { select: { id: true, customerName: true } },
        allocations: {
          include: { invoice: { select: { id: true, invoiceNumber: true } } },
        },
      },
      orderBy: { [sortBy]: sortOrder } as Prisma.PaymentTransactionOrderByWithRelationInput,
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

export async function createPayment(
  distributorId: string,
  userId: string,
  data: {
    customerId: string;
    amount: number;
    paymentMethod: string;
    referenceNumber?: string;
    transactionDate: string;
    allocations?: { invoiceId: string; amount: number }[];
  }
) {
  // Validate customer belongs to distributor
  const customer = await prisma.customer.findFirst({
    where: { id: data.customerId, distributorId, deletedAt: null },
  });
  if (!customer) throw new PaymentError('Customer not found', 404);

  return prisma.$transaction(async (tx) => {
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
          include: { invoice: { select: { id: true, invoiceNumber: true } } },
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
  });
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
          include: { invoice: { select: { id: true, invoiceNumber: true } } },
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
  const creditDays = customer.creditPeriodDays;

  // Pull ALL ledger entries (not range-filtered yet) so we can compute the
  // carry-forward "Opening Balance b/f" amount from pre-range entries.
  const allEntries = await prisma.customerLedgerEntry.findMany({
    where: { distributorId, customerId },
    orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }],
  });

  // Pre-load referenced invoices (with items + linked order items) so each
  // invoice_entry row can render per-cylinder-type breakdown without N+1.
  const invoiceIds = Array.from(
    new Set(allEntries.map((e) => e.invoiceId).filter((x): x is string => !!x)),
  );
  const invoices = invoiceIds.length === 0
    ? []
    : await prisma.invoice.findMany({
        where: { id: { in: invoiceIds } },
        select: {
          id: true,
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
        },
      });
  const invoiceMap = new Map(invoices.map((i) => [i.id, i]));

  const emptyPrices = await prisma.emptyCylinderPrice.findMany({ where: { distributorId } });
  const emptyPriceMap = new Map<string, number>(
    emptyPrices.map((ep) => [ep.cylinderTypeId, toNum(ep.emptyCylinderPrice)] as const),
  );

  const fromDate = range?.from ? new Date(range.from) : null;
  const toDate = range?.to ? new Date(range.to) : null;

  // Mutating state shared across pre-range accumulation and in-range emission.
  let cumulativeInvoiceAmount = 0;
  let cumulativeReceivedAmount = 0;
  const pendingEmptiesPerType = new Map<string, number>();
  // Only NON-OB invoice debits enter this list — preserves overdueAmount
  // contract with computeCustomerOverdue.
  const unpaidDeliveries: { date: Date; amount: number }[] = [];
  const today = new Date();

  function rebuildOverdueOnState(): number {
    let overdue = 0;
    let remaining = cumulativeReceivedAmount;
    for (const ud of unpaidDeliveries) {
      if (remaining >= ud.amount) { remaining -= ud.amount; continue; }
      const unpaid = ud.amount - remaining;
      remaining = 0;
      const days = Math.floor((today.getTime() - ud.date.getTime()) / (1000 * 60 * 60 * 24));
      if (days > creditDays) overdue += unpaid;
    }
    return overdue;
  }

  const rows: CustomerLedgerRow[] = [];

  function emitRow(partial: Partial<CustomerLedgerRow> & {
    orderDate: string; kind: CustomerLedgerRow['kind']; narration: string;
  }): void {
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
      overDueAmount: Math.round(rebuildOverdueOnState() * 100) / 100,
      narration: partial.narration,
      kind: partial.kind,
    });
  }

  // Process a single CustomerLedgerEntry: mutate cumulative state and
  // optionally emit one or more output rows.
  function processEntry(entry: typeof allEntries[number], emit: boolean): void {
    const delta = toNum(entry.amountDelta);
    const inv = entry.invoiceId ? invoiceMap.get(entry.invoiceId) ?? null : null;
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
        // OB does NOT enter the unpaid-deliveries FIFO — keeps overdueAmount
        // aligned with computeCustomerOverdue (which only sees Orders).
        if (!isOB && delta > 0) {
          unpaidDeliveries.push({ date: entry.entryDate, amount: delta });
        }

        if (!emit) return;

        if (isOB || !inv?.items?.length) {
          emitRow({
            orderDate: dateStr,
            cylinderType: isOB ? 'Opening Balance' : '',
            amount: delta,
            narration: entry.narration ?? (isOB ? 'Opening Balance' : 'Invoice'),
            kind: isOB ? 'opening' : 'invoice',
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
          emitRow({
            orderDate: dateStr,
            cylinderType: agg.name,
            fullCylsDelivered: agg.delivered,
            amount: agg.amount,
            emptyCylsCollected: agg.collected,
            pendingEmptyCyls: pendingForType,
            emptyCylsCost: pendingForType * emptyPrice,
            narration: entry.narration ?? '',
            kind: 'invoice',
          });
        }
        return;
      }
      case 'payment_entry': {
        const credit = Math.abs(delta);
        cumulativeReceivedAmount += credit;
        if (!emit) return;
        emitRow({
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
        emitRow({
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
        emitRow({
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
        emitRow({
          orderDate: dateStr,
          amount: delta >= 0 ? delta : 0,
          receivedAmount: delta < 0 ? -delta : 0,
          narration: entry.narration ?? 'Adjustment',
          kind: 'adjustment',
        });
        return;
      }
    }
  }

  // Pass 1 — accumulate pre-range state, no emit.
  if (fromDate) {
    for (const entry of allEntries) {
      if (entry.entryDate < fromDate) processEntry(entry, false);
    }
  }

  const openingBalance = cumulativeInvoiceAmount - cumulativeReceivedAmount;
  const showOpeningRow = !!fromDate && Math.abs(openingBalance) > 0.005;

  if (showOpeningRow) {
    // Carry-forward row — sits at the top of the period before any
    // in-range transaction. dueAmount equals the opening balance; no
    // debit/credit split, no per-row overdue contribution.
    rows.push({
      orderDate: fromDate!.toISOString().split('T')[0],
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

  // Pass 2 — emit in-range entries.
  for (const entry of allEntries) {
    const inRange =
      (!fromDate || entry.entryDate >= fromDate) &&
      (!toDate || entry.entryDate <= toDate);
    if (inRange) processEntry(entry, true);
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
    overdueAmount: Math.round(rebuildOverdueOnState() * 100) / 100,
    emptyCylsCost: Math.round(totalEmptyCylsCost * 100) / 100,
    openingBalance: showOpeningRow ? Math.round(openingBalance * 100) / 100 : 0,
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

  const [orders, payments] = await Promise.all([
    prisma.order.findMany({
      where: {
        distributorId, customerId,
        status: { in: ['delivered', 'modified_delivered'] },
        deletedAt: null,
      },
      include: { items: true },
      orderBy: { deliveryDate: 'asc' },
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
