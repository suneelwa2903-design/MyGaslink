import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';
import { toNum } from '../utils/decimal.js';
import { getEffectivePrice } from './cylinderTypeService.js';
import { computeCustomerOverdue } from './paymentService.js';

/**
 * Get customer dashboard stats.
 */
export async function getCustomerDashboard(
  distributorId: string,
  customerId: string,
  range?: { from?: string; to?: string },
) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, distributorId, deletedAt: null },
    select: { id: true, customerName: true, stopSupply: true, creditPeriodDays: true },
  });
  if (!customer) throw new PortalError('Customer not found', 404);

  // Cylinder types with the current effective price. Built MANUALLY (not via
  // a mapper) so the shape exactly matches what the mobile New Order modal
  // reads — { id, typeName, capacity, latestPrice }. Returned even when supply
  // is stopped (the order itself is still blocked server-side in createOrder).
  // CylinderType has no soft-delete column; it uses `isActive`.
  const types = await prisma.cylinderType.findMany({
    where: { distributorId, isActive: true },
    select: { id: true, typeName: true, capacity: true },
    orderBy: { capacity: 'asc' },
  });
  const asOf = new Date();
  const cylinderTypes = await Promise.all(types.map(async (t) => ({
    id: t.id,
    typeName: t.typeName,
    capacity: t.capacity,
    latestPrice: await getEffectivePrice(distributorId, t.id, asOf),
  })));

  // WI-121: ACTIVITY metrics (orders, delivered, payments) are scoped to a
  // date range; BALANCE/STATE metrics (outstanding, overdue, empties, pending)
  // always reflect the present and ignore the range. Default range = current
  // month (1st → end of today).
  const now = new Date();
  const from = range?.from ? new Date(range.from) : new Date(now.getFullYear(), now.getMonth(), 1);
  const to = range?.to ? new Date(range.to) : now;
  const toEnd = new Date(to);
  toEnd.setHours(23, 59, 59, 999);
  const periodRange = { from: from.toISOString(), to: toEnd.toISOString() };

  if (customer.stopSupply) {
    return {
      outstandingAmount: 0,
      overdueAmount: 0,
      totalOrders: 0,
      ordersDelivered: 0,
      amountDelivered: 0,
      paymentsReceived: 0,
      pendingOrders: 0,
      emptyCylinders: 0,
      recentOrders: [],
      cylinderTypes,
      range: periodRange,
      supplyStopped: true,
    };
  }

  const deliveredStatuses = ['delivered', 'modified_delivered'];
  const [pendingOrders, totalOrders, deliveredAgg, paymentsAgg, outstandingResult, overdueAmount, balances, recent] = await Promise.all([
    // ── Always-current (state) ──
    prisma.order.count({
      where: {
        customerId, distributorId, deletedAt: null,
        status: { in: ['pending_driver_assignment', 'pending_dispatch', 'pending_delivery'] },
      },
    }),
    // ── Date-filtered (activity) ──
    prisma.order.count({
      where: { customerId, distributorId, deletedAt: null, deliveryDate: { gte: from, lte: toEnd } },
    }),
    prisma.order.aggregate({
      where: {
        customerId, distributorId, deletedAt: null,
        status: { in: deliveredStatuses as any },
        deliveryDate: { gte: from, lte: toEnd },
      },
      _count: true,
      _sum: { totalAmount: true },
    }),
    prisma.paymentTransaction.aggregate({
      where: { customerId, distributorId, deletedAt: null, transactionDate: { gte: from, lte: toEnd } },
      _sum: { amount: true },
    }),
    // ── Always-current (balance) ──
    prisma.invoice.aggregate({
      where: {
        customerId, distributorId, deletedAt: null,
        outstandingAmount: { gt: 0 },
        status: { in: ['issued', 'partially_paid', 'overdue'] },
      },
      _sum: { outstandingAmount: true },
    }),
    // WI-122: canonical overdue (ledger formula), not the status flag.
    computeCustomerOverdue(distributorId, customerId),
    prisma.customerInventoryBalance.findMany({
      where: { customerId, customer: { distributorId, deletedAt: null } },
      select: { withCustomerQty: true },
    }),
    prisma.order.findMany({
      where: { customerId, distributorId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, orderNumber: true, status: true, deliveryDate: true, totalAmount: true },
    }),
  ]);

  return {
    // Always-current
    outstandingAmount: toNum(outstandingResult._sum.outstandingAmount),
    overdueAmount,
    pendingOrders,
    emptyCylinders: balances.reduce((sum, b) => sum + b.withCustomerQty, 0),
    // Date-filtered activity (within range)
    totalOrders,
    ordersDelivered: deliveredAgg._count,
    amountDelivered: toNum(deliveredAgg._sum.totalAmount),
    paymentsReceived: toNum(paymentsAgg._sum.amount),
    range: periodRange,
    // Lists / catalog
    recentOrders: recent.map((o) => ({
      orderId: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      deliveryDate: o.deliveryDate,
      totalAmount: toNum(o.totalAmount),
    })),
    cylinderTypes,
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
  // `status` accepts a single value or a comma-separated list (e.g.
  // "delivered,modified_delivered") so the account "Recent Deliveries" card
  // can fetch both terminal delivery states in one call.
  if (filters.status) {
    const statuses = filters.status.split(',').map((s) => s.trim()).filter(Boolean);
    where.status = statuses.length > 1 ? { in: statuses as any } : (statuses[0] as any);
  }

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

  // WI-119: driver identity (name + phone) is disclosed to the customer ONLY
  // while the order is in flight (pending_dispatch / pending_delivery). Once
  // the order reaches a terminal state (delivered / modified_delivered /
  // cancelled) the driver is removed entirely — name, phone, and the nested
  // relation are all nulled so nothing leaks through mapOrder's re-derivation.
  const flattened = orders.map((o) => {
    const showDriver = !!o.driver
      && ['pending_dispatch', 'pending_delivery'].includes(o.status);
    return {
      ...o,
      driver: showDriver ? o.driver : null,
      driverName: showDriver ? o.driver?.driverName ?? null : null,
      driverPhone: showDriver ? o.driver?.phone ?? null : null,
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

  // WI-119: same disclosure rule as the list — driver only while in flight.
  const showDriver = !!order.driver
    && ['pending_dispatch', 'pending_delivery'].includes(order.status);

  return {
    ...order,
    driver: showDriver ? order.driver : null,
    driverName: showDriver ? order.driver?.driverName ?? null : null,
    driverPhone: showDriver ? order.driver?.phone ?? null : null,
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
    // WI-122: optional commitment fields when re-submitting after the gate.
    promisedDate?: string;
    promisedAmount?: number;
    acknowledged?: boolean;
  }
) {
  const { createOrder } = await import('./orderService.js');
  const hasCommitment = data.promisedDate != null || data.promisedAmount != null || data.acknowledged != null;
  const options = hasCommitment
    ? {
        commitment: {
          promisedDate: data.promisedDate ? new Date(data.promisedDate) : undefined,
          promisedAmount: data.promisedAmount,
          acknowledged: data.acknowledged,
        },
      }
    : undefined;
  return createOrder(distributorId, userId, {
    customerId,
    deliveryDate: data.deliveryDate,
    specialInstructions: data.specialInstructions,
    items: data.items,
  }, options);
}

/**
 * WI-093: customer modifies the QUANTITIES on their own pending order.
 *
 * Allowed only while the order is pending_driver_assignment or
 * pending_dispatch (same window the cancel action uses). Cylinder types
 * cannot be added, removed, or substituted — only quantities change. We
 * keep each item's existing unitPrice/discountPerUnit and recompute
 * totalPrice + order.totalAmount; if an invoice already exists for the
 * order, its totalAmount + outstandingAmount are recalculated too.
 *
 * Tenant + customer scoped: the order must belong to BOTH this distributor
 * and this customer, otherwise it's reported as not found (404).
 */
export async function modifyMyOrder(
  distributorId: string,
  customerId: string,
  orderId: string,
  items: { cylinderTypeId: string; quantity: number }[],
) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, customerId, distributorId, deletedAt: null },
    include: { items: true, invoice: { select: { id: true } } },
  });
  if (!order) throw new PortalError('Order not found', 404);
  if (!['pending_driver_assignment', 'pending_dispatch'].includes(order.status)) {
    throw new PortalError('This order can no longer be modified', 400);
  }
  if (!items || items.length === 0) {
    throw new PortalError('At least one item is required', 400);
  }
  for (const it of items) {
    if (!Number.isInteger(it.quantity) || it.quantity <= 0) {
      throw new PortalError('Quantity must be a positive whole number', 400);
    }
  }
  // Quantity-only: the submitted set of cylinder types must exactly match the
  // order's existing types (no add, remove, or substitution).
  const existingIds = new Set(order.items.map((i) => i.cylinderTypeId));
  const submittedIds = new Set(items.map((i) => i.cylinderTypeId));
  const sameTypes = submittedIds.size === existingIds.size
    && [...submittedIds].every((id) => existingIds.has(id));
  if (!sameTypes) {
    throw new PortalError('Only quantities can be changed', 400);
  }

  return prisma.$transaction(async (tx) => {
    let totalAmount = 0;
    for (const it of items) {
      const existing = order.items.find((oi) => oi.cylinderTypeId === it.cylinderTypeId)!;
      const effectivePrice = Math.max(toNum(existing.unitPrice) - toNum(existing.discountPerUnit), 0);
      const totalPrice = effectivePrice * it.quantity;
      totalAmount += totalPrice;
      await tx.orderItem.update({
        where: { id: existing.id },
        data: { quantity: it.quantity, totalPrice },
      });
    }

    if (order.invoice) {
      const inv = await tx.invoice.findUnique({ where: { id: order.invoice.id } });
      if (inv) {
        const paid = toNum(inv.amountPaid);
        await tx.invoice.update({
          where: { id: inv.id },
          data: { totalAmount, outstandingAmount: Math.max(totalAmount - paid, 0) },
        });
      }
    }

    return tx.order.update({
      where: { id: orderId },
      data: { totalAmount },
      include: {
        items: { include: { cylinderType: { select: { typeName: true } } } },
        customer: true,
      },
    });
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
  const customer = await prisma.customer.findFirst({
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
      // WI-120: per-customer cylinder discounts. mapCustomer flattens each
      // entry to { cylinderTypeName, discountPerUnit } for the account screen.
      cylinderDiscounts: {
        select: {
          id: true,
          cylinderTypeId: true,
          discountPerUnit: true,
          cylinderType: { select: { typeName: true, capacity: true } },
        },
      },
    },
  });
  if (!customer) return null;

  // WI-120: current effective prices for every active cylinder type, net of
  // this customer's discount. Built manually (no mapper) so the mobile account
  // screen reads a stable shape:
  //   { cylinderTypeId, typeName, capacity, basePrice, discountPerUnit, customerPrice }
  const types = await prisma.cylinderType.findMany({
    where: { distributorId, isActive: true },
    select: { id: true, typeName: true, capacity: true },
    orderBy: { capacity: 'asc' },
  });
  const discountMap = new Map(
    customer.cylinderDiscounts.map((d) => [d.cylinderTypeId, toNum(d.discountPerUnit)]),
  );
  const asOf = new Date();
  const currentPrices = await Promise.all(types.map(async (t) => {
    const basePrice = await getEffectivePrice(distributorId, t.id, asOf);
    const discountPerUnit = discountMap.get(t.id) ?? 0;
    return {
      cylinderTypeId: t.id,
      typeName: t.typeName,
      capacity: t.capacity,
      basePrice,
      discountPerUnit,
      customerPrice: Math.max(basePrice - discountPerUnit, 0),
    };
  }));

  return { ...customer, currentPrices };
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

  const totalAmount = invoices.reduce((s, i) => s + toNum(i.totalAmount), 0);
  const totalOutstanding = invoices.reduce((s, i) => s + toNum(i.outstandingAmount), 0);
  const totalGst = invoices.reduce((s, i) => s + toNum(i.cgstValue) + toNum(i.sgstValue) + toNum(i.igstValue), 0);

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
