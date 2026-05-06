import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';

/**
 * Get customer dashboard stats.
 */
export async function getCustomerDashboard(distributorId: string, customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, distributorId, deletedAt: null },
    select: { id: true, customerName: true, stopSupply: true, creditPeriodDays: true },
  });
  if (!customer) throw new PortalError('Customer not found', 404);

  if (customer.stopSupply) {
    return {
      ordersPending: 0,
      invoicesOutstanding: 0,
      amountOutstanding: 0,
      supplyStopped: true,
    };
  }

  const [ordersPending, outstandingResult, overdueResult, emptiesByType, paymentTotal] = await Promise.all([
    prisma.order.count({
      where: {
        customerId, distributorId, deletedAt: null,
        status: { in: ['pending_driver_assignment', 'pending_dispatch', 'pending_delivery'] },
      },
    }),
    prisma.invoice.aggregate({
      where: {
        customerId, distributorId, deletedAt: null,
        outstandingAmount: { gt: 0 },
        status: { in: ['issued', 'partially_paid', 'overdue'] },
      },
      _sum: { outstandingAmount: true },
      _count: true,
    }),
    prisma.invoice.aggregate({
      where: {
        customerId, distributorId, deletedAt: null,
        status: 'overdue',
      },
      _sum: { outstandingAmount: true },
    }),
    prisma.customerInventoryBalance.findMany({
      where: { customerId, customer: { distributorId, deletedAt: null } },
      include: { cylinderType: { select: { typeName: true, capacity: true } } },
    }),
    prisma.paymentTransaction.aggregate({
      where: { customerId, distributorId, deletedAt: null },
      _sum: { amount: true },
    }),
  ]);

  return {
    ordersPending,
    invoicesOutstanding: outstandingResult._count,
    amountOutstanding: outstandingResult._sum.outstandingAmount || 0,
    overdueAmount: overdueResult._sum.outstandingAmount || 0,
    paymentTotal: paymentTotal._sum.amount || 0,
    emptiesByType: emptiesByType.map(b => ({
      cylinderTypeName: b.cylinderType.typeName,
      capacity: b.cylinderType.capacity,
      withCustomerQty: b.withCustomerQty,
    })),
    supplyStopped: false,
  };
}

/**
 * Get customer's orders.
 */
export async function getMyOrders(
  distributorId: string,
  customerId: string,
  filters: { status?: string; page?: number; pageSize?: number }
) {
  const where: Prisma.OrderWhereInput = { customerId, distributorId, deletedAt: null };
  if (filters.status) where.status = filters.status as any;

  const page = filters.page || 1;
  const pageSize = filters.pageSize || 25;

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        items: { include: { cylinderType: { select: { typeName: true } } } },
        driver: { select: { driverName: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);

  // Flatten driver fields onto the order — see getMyOrderById for the
  // driver-phone disclosure rule (only shown while the order is in flight).
  const flattened = orders.map((o) => {
    const showDriverContact = !!o.driver
      && ['pending_dispatch', 'pending_delivery'].includes(o.status);
    return {
      ...o,
      driverName: o.driver?.driverName ?? null,
      driverPhone: showDriverContact ? o.driver?.phone ?? null : null,
    };
  });

  return {
    data: flattened,
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

/**
 * Get a specific order for the customer.
 *
 * Flattens driver name + phone onto the order so the portal UI can render a
 * "Your delivery driver" section without traversing the nested driver relation.
 * Phone is exposed only to the customer who actually owns this order
 * (filter by customerId + distributorId above guarantees tenant isolation).
 * Driver phone is hidden once the order reaches a terminal state — the customer
 * has no reason to call the driver about a delivered or cancelled order.
 */
export async function getMyOrderById(distributorId: string, customerId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, customerId, distributorId, deletedAt: null },
    include: {
      items: { include: { cylinderType: { select: { typeName: true } } } },
      driver: { select: { driverName: true, phone: true } },
      statusLogs: { orderBy: { changedAt: 'desc' } },
    },
  });
  if (!order) return null;

  const showDriverContact = !!order.driver
    && ['pending_dispatch', 'pending_delivery'].includes(order.status);

  return {
    ...order,
    driverName: order.driver?.driverName ?? null,
    driverPhone: showDriverContact ? order.driver?.phone ?? null : null,
  };
}

/**
 * Create an order from the customer portal.
 */
export async function createMyOrder(
  distributorId: string,
  customerId: string,
  userId: string,
  data: {
    deliveryDate: string;
    specialInstructions?: string;
    items: { cylinderTypeId: string; quantity: number }[];
  }
) {
  const { createOrder } = await import('./orderService.js');
  return createOrder(distributorId, userId, {
    customerId,
    deliveryDate: data.deliveryDate,
    specialInstructions: data.specialInstructions,
    items: data.items,
  });
}

/**
 * Get customer's invoices.
 */
export async function getMyInvoices(
  distributorId: string,
  customerId: string,
  filters: { status?: string; page?: number; pageSize?: number }
) {
  const where: Prisma.InvoiceWhereInput = { customerId, distributorId, deletedAt: null, isGaslinkBilling: false };
  if (filters.status) where.status = filters.status as any;

  const page = filters.page || 1;
  const pageSize = filters.pageSize || 25;

  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: {
        items: { include: { cylinderType: { select: { typeName: true } } } },
        order: { select: { orderNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.invoice.count({ where }),
  ]);

  return {
    data: invoices,
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

/**
 * Get a specific invoice for the customer.
 */
export async function getMyInvoiceById(distributorId: string, customerId: string, invoiceId: string) {
  return prisma.invoice.findFirst({
    where: { id: invoiceId, customerId, distributorId, deletedAt: null },
    include: {
      items: { include: { cylinderType: { select: { typeName: true } } } },
      order: { select: { orderNumber: true } },
      paymentAllocations: {
        include: { payment: { select: { paymentMethod: true, referenceNumber: true, transactionDate: true } } },
      },
      creditNotes: true,
      debitNotes: true,
    },
  });
}

/**
 * Get customer's payments.
 */
export async function getMyPayments(
  distributorId: string,
  customerId: string,
  filters: { page?: number; pageSize?: number }
) {
  const page = filters.page || 1;
  const pageSize = filters.pageSize || 25;

  const [payments, total] = await Promise.all([
    prisma.paymentTransaction.findMany({
      where: { customerId, distributorId, deletedAt: null },
      include: {
        allocations: {
          include: { invoice: { select: { invoiceNumber: true } } },
        },
      },
      orderBy: { transactionDate: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.paymentTransaction.count({
      where: { customerId, distributorId, deletedAt: null },
    }),
  ]);

  return {
    data: payments,
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

/**
 * Get customer's payment by ID.
 */
export async function getMyPaymentById(distributorId: string, customerId: string, paymentId: string) {
  return prisma.paymentTransaction.findFirst({
    where: { id: paymentId, customerId, distributorId, deletedAt: null },
    include: {
      allocations: {
        include: { invoice: { select: { invoiceNumber: true, totalAmount: true, status: true } } },
      },
    },
  });
}

/**
 * Get customer's cylinder balance (empties, pending returns).
 */
export async function getMyBalance(distributorId: string, customerId: string) {
  return prisma.customerInventoryBalance.findMany({
    where: { customerId, customer: { distributorId, deletedAt: null } },
    include: { cylinderType: { select: { typeName: true, capacity: true } } },
  });
}

/**
 * Get customer's account info.
 */
export async function getMyAccount(distributorId: string, customerId: string) {
  return prisma.customer.findFirst({
    where: { id: customerId, distributorId, deletedAt: null },
    select: {
      id: true,
      customerName: true,
      businessName: true,
      phone: true,
      email: true,
      gstin: true,
      billingAddressLine1: true,
      billingAddressLine2: true,
      billingCity: true,
      billingState: true,
      billingPincode: true,
      shippingAddressLine1: true,
      shippingAddressLine2: true,
      shippingCity: true,
      shippingState: true,
      shippingPincode: true,
      creditPeriodDays: true,
      contacts: true,
    },
  });
}

/**
 * Update customer's profile (limited fields).
 */
export async function updateMyProfile(
  distributorId: string,
  customerId: string,
  data: {
    phone?: string;
    email?: string;
    shippingAddressLine1?: string;
    shippingAddressLine2?: string;
    shippingCity?: string;
    shippingState?: string;
    shippingPincode?: string;
  }
) {
  const existing = await prisma.customer.findFirst({
    where: { id: customerId, distributorId, deletedAt: null },
  });
  if (!existing) throw new PortalError('Customer not found', 404);

  return prisma.customer.update({
    where: { id: customerId },
    data,
    select: {
      id: true, customerName: true, phone: true, email: true,
      shippingAddressLine1: true, shippingAddressLine2: true,
      shippingCity: true, shippingState: true, shippingPincode: true,
    },
  });
}

/**
 * Get distributor info for the customer.
 */
export async function getMyDistributorInfo(distributorId: string) {
  return prisma.distributor.findUnique({
    where: { id: distributorId },
    select: {
      businessName: true,
      phone: true,
      email: true,
      address: true,
      city: true,
      state: true,
      pincode: true,
    },
  });
}

/**
 * Get all invoices for a customer (for customer app) with GST document details.
 */
export async function getCustomerInvoices(
  distributorId: string,
  customerId: string,
  filters?: { dateFrom?: string; dateTo?: string; status?: string }
) {
  const where: any = { distributorId, customerId, deletedAt: null, isGaslinkBilling: false };
  if (filters?.status) where.status = filters.status;
  if (filters?.dateFrom || filters?.dateTo) {
    where.issueDate = {};
    if (filters?.dateFrom) where.issueDate.gte = new Date(filters.dateFrom);
    if (filters?.dateTo) where.issueDate.lte = new Date(filters.dateTo);
  }

  return prisma.invoice.findMany({
    where,
    include: {
      items: { include: { cylinderType: { select: { typeName: true } } } },
      gstDocuments: {
        where: { isLatest: true },
        select: { irn: true, ackNo: true, ewbNo: true, signedQr: true, irnStatus: true, ewbStatus: true },
      },
    },
    orderBy: { issueDate: 'desc' },
  });
}

/**
 * Get invoice summary for bulk download metadata.
 */
export async function getInvoiceSummaryForDownload(
  distributorId: string,
  customerId: string,
  dateFrom: string,
  dateTo: string
) {
  const invoices = await prisma.invoice.findMany({
    where: {
      distributorId,
      customerId,
      deletedAt: null,
      isGaslinkBilling: false,
      issueDate: {
        gte: new Date(dateFrom),
        lte: new Date(dateTo),
      },
    },
    select: {
      id: true,
      invoiceNumber: true,
      issueDate: true,
      totalAmount: true,
      outstandingAmount: true,
      status: true,
      cgstValue: true,
      sgstValue: true,
      igstValue: true,
    },
    orderBy: { issueDate: 'desc' },
  });

  const totalAmount = invoices.reduce((s, i) => s + i.totalAmount, 0);
  const totalOutstanding = invoices.reduce((s, i) => s + i.outstandingAmount, 0);
  const totalGst = invoices.reduce((s, i) => s + i.cgstValue + i.sgstValue + i.igstValue, 0);

  return {
    dateRange: { from: dateFrom, to: dateTo },
    count: invoices.length,
    totalAmount: Math.round(totalAmount * 100) / 100,
    totalOutstanding: Math.round(totalOutstanding * 100) / 100,
    totalGst: Math.round(totalGst * 100) / 100,
    invoices,
  };
}

export class PortalError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'PortalError';
  }
}
