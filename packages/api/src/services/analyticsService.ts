import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';
import { toNum } from '../utils/decimal.js';
import { computeCustomerOverdue } from './paymentService.js';
import { checkThresholds } from './inventoryService.js';

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
    pendingDispatch, inFlight, overdueInvoices, outstandingResult,
    inventoryAlerts, pendingActions, totalCustomers,
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
    // Awaiting dispatch: placed/assigned but not yet dispatched.
    prisma.order.count({
      where: {
        distributorId, deletedAt: null,
        status: { in: ['pending_driver_assignment', 'pending_dispatch'] },
      },
    }),
    // In-flight: dispatched, awaiting delivery. Godown-pickup orders are
    // also in pending_delivery but never went on a truck — they're
    // sitting in the depot waiting for the customer. The "trucks
    // in-flight" KPI must exclude them or the number is wrong.
    prisma.order.count({
      where: {
        distributorId, deletedAt: null,
        status: 'pending_delivery',
        isGodownPickup: false,
      },
    }),
    prisma.invoice.count({
      where: { distributorId, status: 'overdue', deletedAt: null },
    }),
    prisma.invoice.aggregate({
      where: { distributorId, outstandingAmount: { gt: 0 }, deletedAt: null },
      _sum: { outstandingAmount: true },
    }),
    // Live count of cylinder types CURRENTLY below their warning level.
    // The previous query counted *configured* alert-enabled threshold rows
    // — a constant per tenant, not a stock-state metric. It made the
    // dashboard say "Inventory Alerts: 4" forever even after stock was
    // replenished above the warning threshold. Delegate to checkThresholds
    // (already the source of truth for the Threshold Alerts list shown
    // lower on the dashboard) and just count the resulting array.
    checkThresholds(distributorId).then((alerts) => alerts.length),
    prisma.pendingAction.count({
      where: { distributorId, status: { in: ['open', 'in_progress'] } },
    }),
    // Total active customers — surfaced on the mobile admin Customers KPI card.
    prisma.customer.count({
      where: { distributorId, deletedAt: null },
    }),
  ]);

  return {
    ordersToday,
    deliveredToday,
    revenueToday: toNum(revenueTodayResult._sum.totalAmount),
    pendingDispatch,
    inFlight,
    overdueInvoices,
    totalOutstanding: toNum(outstandingResult._sum.outstandingAmount),
    inventoryAlerts,
    pendingActions,
    totalCustomers,
  };
}

/**
 * Header metrics for the dashboard.
 */
export async function getHeaderMetrics(distributorId: string) {
  const [
    totalOutstanding, overdueCustomers, paidResult,
    customerBalances, emptyPrices,
  ] = await Promise.all([
    prisma.invoice.aggregate({
      where: { distributorId, outstandingAmount: { gt: 0 }, deletedAt: null },
      _sum: { outstandingAmount: true, totalAmount: true, amountPaid: true },
    }),
    // WI-122: overdue is the ledger formula summed across customers, not the
    // status flag. Only customers with an outstanding balance can be overdue,
    // so we scope the fan-out to them.
    prisma.customer.findMany({
      where: { distributorId, deletedAt: null, invoices: { some: { outstandingAmount: { gt: 0 }, deletedAt: null } } },
      select: { id: true },
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

  const overduePerCustomer = await Promise.all(
    overdueCustomers.map((c) => computeCustomerOverdue(distributorId, c.id)),
  );
  const overdueAmount = overduePerCustomer.reduce((s, a) => s + a, 0);

  const totalCapital = toNum(totalOutstanding._sum.totalAmount);
  const collectedAmount = toNum(paidResult._sum.amount);
  const dueAmount = toNum(totalOutstanding._sum.outstandingAmount);

  // Calculate amount in market (cylinder value with customers)
  const emptyPriceMap = new Map(emptyPrices.map(p => [p.cylinderTypeId, toNum(p.emptyCylinderPrice)]));
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

  const rows = await Promise.all(
    customers
      .filter(c => c.invoices.length > 0)
      .map(async c => {
        const totalDue = c.invoices.reduce((sum, inv) => sum + toNum(inv.outstandingAmount), 0);
        // WI-122: overdue amount via the ledger formula (single source of truth).
        const overdueDue = await computeCustomerOverdue(distributorId, c.id);
        // Days overdue = age of the oldest invoice already past its due date.
        const now = Date.now();
        const overdueDays = c.invoices.reduce((oldest, inv) => {
          const days = Math.floor((now - new Date(inv.dueDate).getTime()) / 86400000);
          return days > 0 ? Math.max(oldest, days) : oldest;
        }, 0);

        return {
          customerId: c.id,
          customerName: c.customerName,
          phone: c.phone,
          totalDue,
          overdueDue,
          overdueDays,
          invoiceCount: c.invoices.length,
          creditPeriodDays: c.creditPeriodDays,
        };
      }),
  );
  return rows.sort((a, b) => b.totalDue - a.totalDue);
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
    existing.totalAmount += toNum(order.totalAmount);
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
// WI-094 (Issue 9): resolve the driver row for a portal/mobile user (drivers
// are linked to users by phone, same as resolveDriverFromUser in the driver
// routes). Returns null when the user has no matching driver.
export async function resolveDriverIdForUser(distributorId: string, userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
  if (!user?.phone) return null;
  const driver = await prisma.driver.findFirst({
    where: { distributorId, phone: user.phone, deletedAt: null },
    select: { id: true },
  });
  return driver?.id ?? null;
}

// WI-094 (Issue 9): `driverId` scopes the report to a single driver. The
// route passes it for the `driver` role so a driver only ever sees their own
// performance; admins/finance/inventory call without it (unscoped, all drivers).
export async function getDriverDeliveryPerformance(distributorId: string, dateFrom?: string, dateTo?: string, driverId?: string) {
  const where: Prisma.OrderWhereInput = { distributorId, deletedAt: null };
  if (dateFrom || dateTo) {
    const deliveryDate: Prisma.DateTimeFilter = {};
    if (dateFrom) deliveryDate.gte = new Date(dateFrom);
    if (dateTo) deliveryDate.lte = new Date(dateTo);
    where.deliveryDate = deliveryDate;
  }

  const drivers = await prisma.driver.findMany({
    where: { distributorId, deletedAt: null, ...(driverId ? { id: driverId } : {}) },
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
    monthlyRevenue.set(key, (monthlyRevenue.get(key) || 0) + toNum(inv.totalAmount));
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
    const totalRevenue = c.invoices.reduce((sum, inv) => sum + toNum(inv.totalAmount), 0);
    const totalPayments = c.payments.reduce((sum, p) => sum + toNum(p.amount), 0);
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
  const priceMap = new Map(emptyPrices.map(p => [p.cylinderTypeId, toNum(p.emptyCylinderPrice)]));

  const rows = await Promise.all(customers.map(async c => {
    const totalDue = c.invoices.reduce((sum, inv) => sum + toNum(inv.outstandingAmount), 0);
    // WI-122: overdue via the ledger formula (single source of truth).
    const overdueDue = await computeCustomerOverdue(distributorId, c.id);
    // Days overdue = age of the oldest invoice past its due date.
    const now = Date.now();
    const overdueDays = c.invoices.reduce((max, inv) => {
      const days = Math.floor((now - new Date(inv.dueDate).getTime()) / 86400000);
      return days > 0 ? Math.max(max, days) : max;
    }, 0);

    const missingCylinders = c.inventoryBalances.reduce((sum, b) => sum + b.missingQty, 0);
    const missingCylinderValue = c.inventoryBalances.reduce((sum, b) => {
      return sum + b.missingQty * (priceMap.get(b.cylinderTypeId) || 0);
    }, 0);
    const excessEmptyCylinders = c.inventoryBalances.reduce((sum, b) => sum + b.withCustomerQty, 0);

    const lastPayment = c.payments[0];

    // WI-122: most recent open commitment for the collections view.
    const commitment = await prisma.paymentCommitment.findFirst({
      where: { distributorId, customerId: c.id, status: 'open' },
      orderBy: { createdAt: 'desc' },
      select: {
        promisedDate: true, overdueAmountSnapshot: true,
        status: true, escalationLevel: true, createdAt: true,
      },
    });

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
      lastPaymentAmount: lastPayment?.amount != null ? toNum(lastPayment.amount) : null,
      creditPeriodDays: c.creditPeriodDays,
      latestCommitment: commitment ? {
        promisedDate: commitment.promisedDate?.toISOString() || null,
        overdueAmountSnapshot: toNum(commitment.overdueAmountSnapshot),
        status: commitment.status,
        escalationLevel: commitment.escalationLevel,
        createdAt: commitment.createdAt.toISOString(),
      } : null,
    };
  }));
  return rows.sort((a, b) => b.totalDue - a.totalDue);
}

/**
 * Overdue call list — customers whose oldest unpaid invoice has passed its due date.
 * One row per customer, sorted by days overdue desc. Used by the morning dashboard
 * (Section C — "Call these customers today") and by the Collections page tab.
 */
export async function getOverdueCallList(distributorId: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const customers = await prisma.customer.findMany({
    where: {
      distributorId,
      deletedAt: null,
      invoices: {
        some: {
          deletedAt: null,
          outstandingAmount: { gt: 0 },
          dueDate: { lt: today },
        },
      },
    },
    select: {
      id: true,
      customerName: true,
      phone: true,
      contacts: { where: { isPrimary: true }, select: { phone: true }, take: 1 },
      invoices: {
        where: {
          deletedAt: null,
          outstandingAmount: { gt: 0 },
          dueDate: { lt: today },
        },
        select: { outstandingAmount: true, dueDate: true },
      },
    },
  });

  return customers
    .map((c) => {
      const totalOutstanding = c.invoices.reduce((s, i) => s + toNum(i.outstandingAmount), 0);
      const oldestDue = c.invoices.reduce((oldest, i) => {
        const d = new Date(i.dueDate).getTime();
        return d < oldest ? d : oldest;
      }, Number.POSITIVE_INFINITY);
      const daysOverdue = Math.floor((today.getTime() - oldestDue) / 86400000);
      return {
        customerId: c.id,
        customerName: c.customerName,
        phone: c.contacts[0]?.phone || c.phone,
        totalOutstanding: Math.round(totalOutstanding * 100) / 100,
        overdueInvoiceCount: c.invoices.length,
        daysOverdue,
      };
    })
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
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

/**
 * Actionable insights for the Analytics overview (TASK 2 Part B).
 * Computed from live data — never hardcoded. Returns at most 5, most urgent
 * first (critical > warning > info). Each is one line + an emoji icon.
 */
export interface Insight { icon: string; text: string; severity: 'critical' | 'warning' | 'info'; link?: string; }

export async function getInsights(distributorId: string): Promise<Insight[]> {
  const insights: Insight[] = [];
  const rank = { critical: 0, warning: 1, info: 2 };

  // 1. Customers overdue > 30 days
  try {
    const callList = await getOverdueCallList(distributorId);
    const over30 = callList.filter((c) => c.daysOverdue > 30);
    if (over30.length > 0) {
      insights.push({
        icon: '⚠️',
        text: `${over30.length} customer${over30.length === 1 ? ' has' : 's have'} invoices overdue by more than 30 days`,
        severity: 'critical',
        link: '/app/collections',
      });
    }
  } catch { /* non-fatal */ }

  // 2. Low / critical stock
  try {
    const alerts = await checkThresholds(distributorId);
    for (const a of alerts) {
      insights.push({
        icon: '⚡',
        text: `${a.cylinderTypeName} stock is ${a.level === 'critical' ? 'critically low' : 'low'} (${a.currentStock} units, threshold ${a.threshold}) — consider restocking`,
        severity: a.level === 'critical' ? 'critical' : 'warning',
        link: '/app/inventory',
      });
    }
  } catch { /* non-fatal */ }

  // 3. Top empty-cylinder holder (cylinders out with a customer)
  try {
    const empties = await getEmptyCylindersReport(distributorId);
    const top = empties[0];
    if (top && top.withCustomerQty >= 5) {
      insights.push({
        icon: '📦',
        text: `${top.customer?.customerName ?? 'A customer'} is holding ${top.withCustomerQty} empty ${top.cylinderType?.typeName ?? ''} cylinder(s) — follow up on return`,
        severity: 'warning',
        link: '/app/customers',
      });
    }
  } catch { /* non-fatal */ }

  // 4. Best driver this month (delivery rate, min 5 orders)
  try {
    const perf = await getDriverDeliveryPerformance(distributorId);
    const best = perf
      .filter((d) => d.totalOrders >= 5)
      .sort((a, b) => b.deliveryRate - a.deliveryRate)[0];
    if (best && best.deliveryRate >= 90) {
      insights.push({
        icon: '🚚',
        text: `Driver ${best.driverName}: ${best.deliveryRate}% delivery rate (above the 90% benchmark)`,
        severity: 'info',
        link: '/app/fleet',
      });
    }
  } catch { /* non-fatal */ }

  return insights.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 5);
}
