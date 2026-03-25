import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';
import type { CustomerLedgerRow, CustomerLedgerResponse } from '@gaslink/shared';

export async function listPayments(
  distributorId: string,
  filters: {
    customerId?: string; paymentMethod?: string;
    dateFrom?: string; dateTo?: string;
    page?: number; pageSize?: number;
  }
) {
  const where: Prisma.PaymentTransactionWhereInput = { distributorId, deletedAt: null };
  if (filters.customerId) where.customerId = filters.customerId;
  if (filters.paymentMethod) where.paymentMethod = filters.paymentMethod as any;
  if (filters.dateFrom || filters.dateTo) {
    where.transactionDate = {};
    if (filters.dateFrom) where.transactionDate.gte = new Date(filters.dateFrom);
    if (filters.dateTo) where.transactionDate.lte = new Date(filters.dateTo);
  }

  const page = filters.page || 1;
  const pageSize = filters.pageSize || 25;

  const [payments, total] = await Promise.all([
    prisma.paymentTransaction.findMany({
      where,
      include: {
        customer: { select: { id: true, customerName: true } },
        allocations: {
          include: { invoice: { select: { id: true, invoiceNumber: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.paymentTransaction.count({ where }),
  ]);

  // Compute allocated/unallocated amounts
  const enriched = payments.map(p => {
    const allocatedAmount = p.allocations.reduce((sum, a) => sum + a.allocatedAmount, 0);
    return {
      ...p,
      allocatedAmount,
      unallocatedAmount: p.amount - allocatedAmount,
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
        if (alloc.amount > invoice.outstandingAmount) {
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
        const newOutstanding = invoice.outstandingAmount - alloc.amount;
        const newAmountPaid = invoice.amountPaid + alloc.amount;
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

        const allocAmount = Math.min(remaining, invoice.outstandingAmount);
        await tx.paymentAllocation.create({
          data: {
            paymentId: payment.id,
            invoiceId: invoice.id,
            allocatedAmount: allocAmount,
          },
        });

        const newOutstanding = invoice.outstandingAmount - allocAmount;
        const newAmountPaid = invoice.amountPaid + allocAmount;
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

export async function getCustomerLedger(distributorId: string, customerId: string): Promise<CustomerLedgerResponse> {
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
    emptyPriceMap.set(ep.cylinderTypeId, ep.emptyCylinderPrice);
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
      const amount = delivered * (item.unitPrice - item.discountPerUnit);
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
      amount: payment.amount,
    });
  }

  // Sort by date ascending
  timeline.sort((a, b) => a.date.getTime() - b.date.getTime());

  // 6. Build ledger rows with running totals
  const rows: CustomerLedgerRow[] = [];
  let cumulativeInvoiceAmount = 0;
  let cumulativeReceivedAmount = 0;

  // Track pending empties per cylinder type
  const pendingEmptiesPerType = new Map<string, number>();

  // Track unpaid delivery amounts with their dates for overdue calculation
  const unpaidDeliveries: { date: Date; amount: number }[] = [];

  const today = new Date();

  for (const entry of timeline) {
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

export class PaymentError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'PaymentError';
  }
}
