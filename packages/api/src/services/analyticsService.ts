import { prisma } from '../lib/prisma.js';

/**
 * Dashboard statistics for the distributor.
 */
export async function getDashboardStats(distributorId: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const [
    ordersToday, deliveredToday, revenueTodayResult,
    pendingOrders, overdueInvoices, outstandingResult,
    inventoryAlerts, pendingActions,
  ] = await Promise.all([
    prisma.order.count({
      where: { distributorId, deletedAt: null, orderDate: { gte: today, lt: tomorrow } },
    }),
    prisma.order.count({
      where: {
        distributorId, deletedAt: null,
        status: { in: ['delivered', 'modified_delivered'] },
        deliveredAt: { gte: today, lt: tomorrow },
      },
    }),
    prisma.order.aggregate({
      where: {
        distributorId, deletedAt: null,
        status: { in: ['delivered', 'modified_delivered'] },
        deliveredAt: { gte: today, lt: tomorrow },
      },
      _sum: { totalAmount: true },
    }),
    prisma.order.count({
      where: {
        distributorId, deletedAt: null,
        status: { in: ['pending_driver_assignment', 'pending_dispatch', 'pending_delivery'] },
      },
    }),
    prisma.invoice.count({
      where: { distributorId, status: 'overdue', deletedAt: null },
    }),
    prisma.invoice.aggregate({
      where: { distributorId, outstandingAmount: { gt: 0 }, deletedAt: null },
      _sum: { outstandingAmount: true },
    }),
    prisma.cylinderThreshold.count({
      where: { distributorId, alertEnabled: true },
    }),
    prisma.pendingAction.count({
      where: { distributorId, status: { in: ['open', 'in_progress'] } },
    }),
  ]);

  return {
    ordersToday,
    deliveredToday,
    revenueToday: revenueTodayResult._sum.totalAmount || 0,
    pendingOrders,
    overdueInvoices,
    totalOutstanding: outstandingResult._sum.outstandingAmount || 0,
    inventoryAlerts,
    pendingActions,
  };
}

/**
 * Header metrics for the dashboard.
 */
export async function getHeaderMetrics(distributorId: string) {
  const [
    totalOutstanding, overdueResult, paidResult,
    customerBalances, emptyPrices,
  ] = await Promise.all([
    prisma.invoice.aggregate({
      where: { distributorId, outstandingAmount: { gt: 0 }, deletedAt: null },
      _sum: { outstandingAmount: true, totalAmount: true, amountPaid: true },
    }),
    prisma.invoice.aggregate({
      where: { distributorId, status: 'overdue', deletedAt: null },
      _sum: { outstandingAmount: true },
    }),
    prisma.paymentTransaction.aggregate({
      where: { distributorId, deletedAt: null },
      _sum: { amount: true },
    }),
    prisma.customerInventoryBalance.findMany({
      where: { customer: { distributorId, deletedAt: null } },
      select: { withCustomerQty: true, missingQty: true, cylinderTypeId: true },
    }),
    prisma.emptyCylinderPrice.findMany({
      where: { distributorId },
    }),
  ]);

  const totalCapital = totalOutstanding._sum.totalAmount || 0;
  const collectedAmount = paidResult._sum.amount || 0;
  const dueAmount = totalOutstanding._sum.outstandingAmount || 0;
  const overdueAmount = overdueResult._sum.outstandingAmount || 0;

  // Calculate amount in market (cylinder value with customers)
  const emptyPriceMap = new Map(emptyPrices.map(p => [p.cylinderTypeId, p.emptyCylinderPrice]));
  let amountInMarket = 0;
  let unrecoveredAmount = 0;
  for (const bal of customerBalances) {
    const price = emptyPriceMap.get(bal.cylinderTypeId) || 0;
    amountInMarket += bal.withCustomerQty * price;
    unrecoveredAmount += bal.missingQty * price;
  }

  return {
    amountInMarket,
    collectedAmount,
    dueAmount,
    overdueAmount,
    totalCapital,
    unrecoveredAmount,
  };
}

/**
 * Empty cylinders report per customer.
 */
export async function getEmptyCylindersReport(distributorId: string) {
  return prisma.customerInventoryBalance.findMany({
    where: {
      customer: { distributorId, deletedAt: null },
      withCustomerQty: { gt: 0 },
    },
    include: {
      customer: { select: { id: true, customerName: true, phone: true } },
      cylinderType: { select: { typeName: true } },
    },
    orderBy: { withCustomerQty: 'desc' },
  });
}

/**
 * Due amounts per customer.
 */
export async function getDueAmountsReport(distributorId: string) {
  const customers = await prisma.customer.findMany({
    where: { distributorId, deletedAt: null },
    select: {
      id: true,
      customerName: true,
      phone: true,
      creditPeriodDays: true,
      invoices: {
        where: { outstandingAmount: { gt: 0 }, deletedAt: null },
        select: { outstandingAmount: true, dueDate: true, status: true },
      },
    },
  });

  return customers
    .filter(c => c.invoices.length > 0)
    .map(c => {
      const totalDue = c.invoices.reduce((sum, inv) => sum + inv.outstandingAmount, 0);
      const overdueInvoices = c.invoices.filter(inv => inv.status === 'overdue');
      const overdueDue = overdueInvoices.reduce((sum, inv) => sum + inv.outstandingAmount, 0);
      const oldestOverdue = overdueInvoices.reduce((oldest, inv) => {
        const days = Math.floor((Date.now() - new Date(inv.dueDate).getTime()) / 86400000);
        return Math.max(oldest, days);
      }, 0);

      return {
        customerId: c.id,
        customerName: c.customerName,
        phone: c.phone,
        totalDue,
        overdueDue,
        overdueDays: oldestOverdue,
        invoiceCount: c.invoices.length,
        creditPeriodDays: c.creditPeriodDays,
      };
    })
    .sort((a, b) => b.totalDue - a.totalDue);
}

/**
 * Top sales by date range.
 */
export async function getTopSales(distributorId: string, dateFrom: string, dateTo: string) {
  const orders = await prisma.order.findMany({
    where: {
      distributorId,
      deletedAt: null,
      status: { in: ['delivered', 'modified_delivered'] },
      deliveryDate: {
        gte: new Date(dateFrom),
        lte: new Date(dateTo),
      },
    },
    include: {
      customer: { select: { id: true, customerName: true } },
    },
  });

  // Group by customer
  const salesByCustomer = new Map<string, { customerName: string; totalAmount: number; orderCount: number }>();
  for (const order of orders) {
    const key = order.customerId;
    const existing = salesByCustomer.get(key) || {
      customerName: order.customer.customerName,
      totalAmount: 0,
      orderCount: 0,
    };
    existing.totalAmount += order.totalAmount;
    existing.orderCount += 1;
    salesByCustomer.set(key, existing);
  }

  return Array.from(salesByCustomer.entries())
    .map(([customerId, data]) => ({ customerId, ...data }))
    .sort((a, b) => b.totalAmount - a.totalAmount)
    .slice(0, 20);
}

/**
 * Driver delivery performance.
 */
export async function getDriverDeliveryPerformance(distributorId: string, dateFrom?: string, dateTo?: string) {
  const where: any = { distributorId, deletedAt: null };
  if (dateFrom || dateTo) {
    where.deliveryDate = {};
    if (dateFrom) where.deliveryDate.gte = new Date(dateFrom);
    if (dateTo) where.deliveryDate.lte = new Date(dateTo);
  }

  const drivers = await prisma.driver.findMany({
    where: { distributorId, deletedAt: null },
    select: { id: true, driverName: true },
  });

  const results = [];
  for (const driver of drivers) {
    const [total, delivered, cancelled] = await Promise.all([
      prisma.order.count({ where: { ...where, driverId: driver.id } }),
      prisma.order.count({ where: { ...where, driverId: driver.id, status: { in: ['delivered', 'modified_delivered'] } } }),
      prisma.order.count({ where: { ...where, driverId: driver.id, status: 'cancelled' } }),
    ]);

    if (total > 0) {
      results.push({
        driverId: driver.id,
        driverName: driver.driverName,
        totalOrders: total,
        deliveredOrders: delivered,
        cancelledOrders: cancelled,
        deliveryRate: Math.round((delivered / total) * 100),
      });
    }
  }

  return results.sort((a, b) => b.deliveredOrders - a.deliveredOrders);
}

/**
 * Revenue trends (monthly).
 */
export async function getRevenueTrends(distributorId: string, months: number = 12) {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);
  startDate.setDate(1);

  const invoices = await prisma.invoice.findMany({
    where: {
      distributorId,
      deletedAt: null,
      isGaslinkBilling: false,
      issueDate: { gte: startDate },
    },
    select: { totalAmount: true, issueDate: true },
  });

  const monthlyRevenue = new Map<string, number>();
  for (const inv of invoices) {
    const key = `${inv.issueDate.getFullYear()}-${String(inv.issueDate.getMonth() + 1).padStart(2, '0')}`;
    monthlyRevenue.set(key, (monthlyRevenue.get(key) || 0) + inv.totalAmount);
  }

  return Array.from(monthlyRevenue.entries())
    .map(([month, revenue]) => ({ month, revenue: Math.round(revenue * 100) / 100 }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Customer lifetime value.
 */
export async function getCustomerLifetimeValue(distributorId: string) {
  const customers = await prisma.customer.findMany({
    where: { distributorId, deletedAt: null },
    select: {
      id: true,
      customerName: true,
      createdAt: true,
      invoices: {
        where: { deletedAt: null, isGaslinkBilling: false },
        select: { totalAmount: true },
      },
      payments: {
        where: { deletedAt: null },
        select: { amount: true },
      },
    },
  });

  return customers.map(c => {
    const totalRevenue = c.invoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
    const totalPayments = c.payments.reduce((sum, p) => sum + p.amount, 0);
    const monthsActive = Math.max(
      1,
      Math.ceil((Date.now() - c.createdAt.getTime()) / (30 * 86400000))
    );

    return {
      customerId: c.id,
      customerName: c.customerName,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalPayments: Math.round(totalPayments * 100) / 100,
      monthsActive,
      avgMonthlyRevenue: Math.round((totalRevenue / monthsActive) * 100) / 100,
    };
  }).sort((a, b) => b.totalRevenue - a.totalRevenue);
}

/**
 * Collections dashboard per customer.
 */
export async function getCollectionsDashboard(distributorId: string) {
  const customers = await prisma.customer.findMany({
    where: { distributorId, deletedAt: null },
    select: {
      id: true,
      customerName: true,
      creditPeriodDays: true,
      invoices: {
        where: { outstandingAmount: { gt: 0 }, deletedAt: null },
        select: { outstandingAmount: true, dueDate: true, status: true },
      },
      payments: {
        where: { deletedAt: null },
        select: { amount: true, transactionDate: true },
        orderBy: { transactionDate: 'desc' },
        take: 1,
      },
      inventoryBalances: {
        select: { withCustomerQty: true, missingQty: true, cylinderTypeId: true },
      },
    },
  });

  const emptyPrices = await prisma.emptyCylinderPrice.findMany({
    where: { distributorId },
  });
  const priceMap = new Map(emptyPrices.map(p => [p.cylinderTypeId, p.emptyCylinderPrice]));

  return customers.map(c => {
    const totalDue = c.invoices.reduce((sum, inv) => sum + inv.outstandingAmount, 0);
    const overdueInvoices = c.invoices.filter(inv => inv.status === 'overdue');
    const overdueDue = overdueInvoices.reduce((sum, inv) => sum + inv.outstandingAmount, 0);
    const overdueDays = overdueInvoices.reduce((max, inv) => {
      return Math.max(max, Math.floor((Date.now() - new Date(inv.dueDate).getTime()) / 86400000));
    }, 0);

    const missingCylinders = c.inventoryBalances.reduce((sum, b) => sum + b.missingQty, 0);
    const missingCylinderValue = c.inventoryBalances.reduce((sum, b) => {
      return sum + b.missingQty * (priceMap.get(b.cylinderTypeId) || 0);
    }, 0);
    const excessEmptyCylinders = c.inventoryBalances.reduce((sum, b) => sum + b.withCustomerQty, 0);

    const lastPayment = c.payments[0];

    return {
      customerId: c.id,
      customerName: c.customerName,
      totalDue: Math.round(totalDue * 100) / 100,
      overdueDue: Math.round(overdueDue * 100) / 100,
      overdueDays,
      missingCylinders,
      missingCylinderValue: Math.round(missingCylinderValue * 100) / 100,
      excessEmptyCylinders,
      lastPaymentDate: lastPayment?.transactionDate?.toISOString() || null,
      lastPaymentAmount: lastPayment?.amount || null,
      creditPeriodDays: c.creditPeriodDays,
    };
  }).sort((a, b) => b.totalDue - a.totalDue);
}

/**
 * Cylinder utilization and shrinkage metrics.
 */
export async function getAdvancedMetrics(distributorId: string) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Delivery events in last 30 days
  const deliveryEvents = await prisma.inventoryEvent.findMany({
    where: {
      distributorId,
      eventType: 'delivery',
      eventDate: { gte: thirtyDaysAgo },
    },
    select: { fullsChange: true },
  });
  const totalDelivered = deliveryEvents.reduce((sum, e) => sum + Math.abs(e.fullsChange), 0);

  // Collection events
  const collectionEvents = await prisma.inventoryEvent.findMany({
    where: {
      distributorId,
      eventType: 'collection',
      eventDate: { gte: thirtyDaysAgo },
    },
    select: { emptiesChange: true },
  });
  const totalCollected = collectionEvents.reduce((sum, e) => sum + e.emptiesChange, 0);

  const cylinderUtilizationRate = totalDelivered > 0
    ? Math.round((totalCollected / totalDelivered) * 100)
    : 0;

  // Average turnaround (delivery to collection ratio as proxy)
  const avgTurnaroundDays = totalCollected > 0
    ? Math.round(30 * (totalDelivered / totalCollected))
    : 0;

  // Inventory shrinkage (missing cylinders)
  const missingAgg = await prisma.customerInventoryBalance.aggregate({
    where: { customer: { distributorId, deletedAt: null } },
    _sum: { missingQty: true },
  });
  const inventoryShrinkage = missingAgg._sum.missingQty || 0;

  // Delivery efficiency
  const [totalOrders, deliveredOrders] = await Promise.all([
    prisma.order.count({
      where: { distributorId, deletedAt: null, orderDate: { gte: thirtyDaysAgo } },
    }),
    prisma.order.count({
      where: {
        distributorId, deletedAt: null,
        status: { in: ['delivered', 'modified_delivered'] },
        orderDate: { gte: thirtyDaysAgo },
      },
    }),
  ]);
  const deliveryEfficiency = totalOrders > 0
    ? Math.round((deliveredOrders / totalOrders) * 100)
    : 0;

  return {
    cylinderUtilizationRate,
    averageTurnaroundDays: avgTurnaroundDays,
    inventoryShrinkage,
    deliveryEfficiency,
  };
}
