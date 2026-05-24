import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';
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
  if (filters.paymentMethod) where.paymentMethod = filters.paymentMethod as any;
  if (filters.allocationStatus) {
    const list = Array.isArray(filters.allocationStatus) ? filters.allocationStatus : [filters.allocationStatus];
    where.allocationStatus = { in: list as any };
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
        paymentMethod: data.paymentMethod as any,
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
      data: { allocationStatus: allocationStatus as any },
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
      data: { allocationStatus: allocationStatus as any },
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

export async function getCustomerLedger(
  distributorId: string,
  customerId: string,
  range?: { from?: string; to?: string },
): Promise<CustomerLedgerResponse> {
  // 1. Get customer with credit period
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, distributorId, deletedAt: null },
    select: { id: true, creditPeriodDays: true },
  });
  if (!customer) throw new PaymentError('Customer not found', 404);

  const creditDays = customer.creditPeriodDays;

  // 2. Get all delivered orders with items and cylinder type names
  const orders = await prisma.order.findMany({
    where: {
      distributorId,
      customerId,
      status: { in: ['delivered', 'modified_delivered'] },
      deletedAt: null,
    },
    include: {
      items: {
        include: {
          cylinderType: { select: { id: true, typeName: true } },
        },
      },
    },
    orderBy: { deliveryDate: 'asc' },
  });

  // 3. Get all payments for this customer
  const payments = await prisma.paymentTransaction.findMany({
    where: { distributorId, customerId, deletedAt: null },
    orderBy: { transactionDate: 'asc' },
  });

  // 4. Get empty cylinder prices for this distributor
  const emptyPrices = await prisma.emptyCylinderPrice.findMany({
    where: { distributorId },
  });
  const emptyPriceMap = new Map<string, number>();
  for (const ep of emptyPrices) {
    emptyPriceMap.set(ep.cylinderTypeId, toNum(ep.emptyCylinderPrice));
  }

  // 5. Build unified timeline entries (deliveries + payments) sorted by date
  type TimelineEntry = {
    date: Date;
    type: 'delivery';
    cylinderTypeId: string;
    cylinderTypeName: string;
    fullCylsDelivered: number;
    amount: number;
    emptyCylsCollected: number;
  } | {
    date: Date;
    type: 'payment';
    amount: number;
  };

  const timeline: TimelineEntry[] = [];

  for (const order of orders) {
    const orderDate = order.deliveryDate ?? order.orderDate;
    for (const item of order.items) {
      const delivered = item.deliveredQuantity ?? item.quantity;
      const collected = item.emptiesCollected ?? 0;
      const amount = delivered * (toNum(item.unitPrice) - toNum(item.discountPerUnit));
      timeline.push({
        date: orderDate,
        type: 'delivery',
        cylinderTypeId: item.cylinderType.id,
        cylinderTypeName: item.cylinderType.typeName,
        fullCylsDelivered: delivered,
        amount,
        emptyCylsCollected: collected,
      });
    }
  }

  for (const payment of payments) {
    timeline.push({
      date: payment.transactionDate,
      type: 'payment',
      amount: toNum(payment.amount),
    });
  }

  // Sort by date ascending
  timeline.sort((a, b) => a.date.getTime() - b.date.getTime());

  // WI-092: optional date-range scoping for the customer statement PDF.
  // When no range is supplied (the default ledger view) the timeline is
  // used as-is, so existing callers are unaffected.
  const fromDate = range?.from ? new Date(range.from) : null;
  const toDate = range?.to ? new Date(range.to) : null;
  const scopedTimeline = (fromDate || toDate)
    ? timeline.filter((e) => {
        if (fromDate && e.date < fromDate) return false;
        if (toDate && e.date > toDate) return false;
        return true;
      })
    : timeline;

  // 6. Build ledger rows with running totals
  const rows: CustomerLedgerRow[] = [];
  let cumulativeInvoiceAmount = 0;
  let cumulativeReceivedAmount = 0;

  // Track pending empties per cylinder type
  const pendingEmptiesPerType = new Map<string, number>();

  // Track unpaid delivery amounts with their dates for overdue calculation
  const unpaidDeliveries: { date: Date; amount: number }[] = [];

  const today = new Date();

  for (const entry of scopedTimeline) {
    if (entry.type === 'delivery') {
      const { cylinderTypeId, cylinderTypeName, fullCylsDelivered, amount, emptyCylsCollected } = entry;

      cumulativeInvoiceAmount += amount;

      // Update pending empties for this cylinder type
      const currentPending = pendingEmptiesPerType.get(cylinderTypeId) || 0;
      const newPending = currentPending + fullCylsDelivered - emptyCylsCollected;
      pendingEmptiesPerType.set(cylinderTypeId, Math.max(0, newPending));

      const emptyPrice = emptyPriceMap.get(cylinderTypeId) || 0;
      const pendingEmptyCyls = pendingEmptiesPerType.get(cylinderTypeId) || 0;
      const emptyCylsCost = pendingEmptyCyls * emptyPrice;

      // Track this delivery for overdue calculation
      unpaidDeliveries.push({ date: entry.date, amount });

      // Calculate overdue: sum of unpaid deliveries where (today - deliveryDate) > creditDays
      const dueAmount = cumulativeInvoiceAmount - cumulativeReceivedAmount;
      let overDueAmount = 0;
      let remainingPayments = cumulativeReceivedAmount;
      for (const ud of unpaidDeliveries) {
        if (remainingPayments >= ud.amount) {
          remainingPayments -= ud.amount;
          continue;
        }
        const unpaidPortion = ud.amount - remainingPayments;
        remainingPayments = 0;
        const daysSinceDelivery = Math.floor((today.getTime() - ud.date.getTime()) / (1000 * 60 * 60 * 24));
        if (daysSinceDelivery > creditDays) {
          overDueAmount += unpaidPortion;
        }
      }

      rows.push({
        orderDate: entry.date.toISOString().split('T')[0],
        cylinderType: cylinderTypeName,
        fullCylsDelivered,
        amount: Math.round(amount * 100) / 100,
        emptyCylsCollected,
        pendingEmptyCyls,
        emptyCylsCost: Math.round(emptyCylsCost * 100) / 100,
        totalAmount: Math.round(cumulativeInvoiceAmount * 100) / 100,
        receivedAmount: Math.round(cumulativeReceivedAmount * 100) / 100,
        dueAmount: Math.round(dueAmount * 100) / 100,
        creditDays,
        overDueAmount: Math.round(overDueAmount * 100) / 100,
      });
    } else {
      // Payment entry
      cumulativeReceivedAmount += entry.amount;
      const dueAmount = cumulativeInvoiceAmount - cumulativeReceivedAmount;

      // Recalculate overdue after payment
      let overDueAmount = 0;
      let remainingPayments = cumulativeReceivedAmount;
      for (const ud of unpaidDeliveries) {
        if (remainingPayments >= ud.amount) {
          remainingPayments -= ud.amount;
          continue;
        }
        const unpaidPortion = ud.amount - remainingPayments;
        remainingPayments = 0;
        const daysSinceDelivery = Math.floor((today.getTime() - ud.date.getTime()) / (1000 * 60 * 60 * 24));
        if (daysSinceDelivery > creditDays) {
          overDueAmount += unpaidPortion;
        }
      }

      rows.push({
        orderDate: entry.date.toISOString().split('T')[0],
        cylinderType: '',
        fullCylsDelivered: 0,
        amount: 0,
        emptyCylsCollected: 0,
        pendingEmptyCyls: 0,
        emptyCylsCost: 0,
        totalAmount: Math.round(cumulativeInvoiceAmount * 100) / 100,
        receivedAmount: Math.round(entry.amount * 100) / 100,
        dueAmount: Math.round(dueAmount * 100) / 100,
        creditDays,
        overDueAmount: Math.round(overDueAmount * 100) / 100,
      });
    }
  }

  // 7. Calculate total empty cylinder cost across all types
  let totalEmptyCylsCost = 0;
  for (const [typeId, pending] of pendingEmptiesPerType) {
    const price = emptyPriceMap.get(typeId) || 0;
    totalEmptyCylsCost += pending * price;
  }

  // 8. Calculate final overdue amount
  let finalOverdueAmount = 0;
  let remainingPayments = cumulativeReceivedAmount;
  for (const ud of unpaidDeliveries) {
    if (remainingPayments >= ud.amount) {
      remainingPayments -= ud.amount;
      continue;
    }
    const unpaidPortion = ud.amount - remainingPayments;
    remainingPayments = 0;
    const daysSinceDelivery = Math.floor((today.getTime() - ud.date.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSinceDelivery > creditDays) {
      finalOverdueAmount += unpaidPortion;
    }
  }

  const summary = {
    totalAmount: Math.round(cumulativeInvoiceAmount * 100) / 100,
    receivedAmount: Math.round(cumulativeReceivedAmount * 100) / 100,
    dueAmount: Math.round((cumulativeInvoiceAmount - cumulativeReceivedAmount) * 100) / 100,
    overdueAmount: Math.round(finalOverdueAmount * 100) / 100,
    emptyCylsCost: Math.round(totalEmptyCylsCost * 100) / 100,
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
