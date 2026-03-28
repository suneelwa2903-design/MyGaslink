import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';
import { BILLING_GRACE_PERIOD_DAYS, BILLING_OVERDUE_SUSPEND_DAYS, GST_RATES } from '@gaslink/shared';
import * as pendingActionsService from './pendingActionsService.js';

const billingCycleInclude = {
  distributor: { select: { id: true, businessName: true, billingTier: true } },
  items: true,
} satisfies Prisma.BillingCycleInclude;

/**
 * List billing cycles for a distributor (or all distributors for super_admin).
 */
export async function listBillingCycles(
  distributorId?: string,
  filters: { status?: string; page?: number; pageSize?: number } = {}
) {
  const where: Prisma.BillingCycleWhereInput = {};
  if (distributorId) where.distributorId = distributorId;
  if (filters.status) {
    const statuses = filters.status.includes(',')
      ? filters.status.split(',').map(s => s.trim())
      : [filters.status];
    where.billingStatus = statuses.length === 1
      ? (statuses[0] as any)
      : { in: statuses as any };
  }

  const page = filters.page || 1;
  const pageSize = filters.pageSize || 25;

  const [cycles, total] = await Promise.all([
    prisma.billingCycle.findMany({
      where,
      include: billingCycleInclude,
      orderBy: { periodStartDate: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.billingCycle.count({ where }),
  ]);

  return {
    data: cycles,
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

export async function getBillingCycleById(id: string) {
  return prisma.billingCycle.findUnique({
    where: { id },
    include: billingCycleInclude,
  });
}

/**
 * Generate a billing cycle for a distributor.
 * Counts active users by type and calculates billing based on tier pricing.
 */
export async function generateBillingCycle(
  distributorId: string,
  data: {
    periodType: string;
    periodStartDate: string;
    periodEndDate: string;
  }
) {
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: {
      billingTier: true,
      subscriptionPlan: true,
      gaslinkBillingEnabled: true,
      billingSuspended: true,
    },
  });

  if (!distributor) throw new BillingError('Distributor not found', 404);
  if (!distributor.gaslinkBillingEnabled) throw new BillingError('GasLink billing is not enabled for this distributor', 400);
  if (!distributor.subscriptionPlan && !distributor.billingTier) throw new BillingError('No subscription plan or billing tier assigned', 400);

  // Check for existing cycle in same period
  const existing = await prisma.billingCycle.findFirst({
    where: {
      distributorId,
      periodStartDate: new Date(data.periodStartDate),
      periodEndDate: new Date(data.periodEndDate),
    },
  });
  if (existing) throw new BillingError('Billing cycle already exists for this period', 400);

  // Get pricing from PricingTier if subscription plan exists, else fallback to legacy tier pricing
  let basePriceMonthly: number;
  let driverLoginPrice: number;
  let otherLoginPrice: number;
  let customerPortalPrice = 49;
  let gstApiOveragePrice = 2;
  let gstApiIncluded = 1500;
  let periodDiscount = 0;

  if (distributor.subscriptionPlan) {
    const tier = await prisma.pricingTier.findUnique({
      where: { plan: distributor.subscriptionPlan },
    });
    if (tier) {
      basePriceMonthly = tier.monthlyPrice;
      driverLoginPrice = tier.extraSeatPriceDriver;
      otherLoginPrice = tier.extraSeatPriceAdmin;
      customerPortalPrice = tier.customerPortalPrice;
      gstApiOveragePrice = tier.gstApiOveragePrice;
      gstApiIncluded = tier.gstApiCallsIncluded;
      // Period discount
      const discountMap: Record<string, number> = {
        quarterly: tier.quarterlyDiscount,
        half_yearly: tier.halfYearlyDiscount,
        yearly: tier.yearlyDiscount,
      };
      periodDiscount = discountMap[data.periodType] || 0;
    } else {
      basePriceMonthly = 4999;
      driverLoginPrice = 99;
      otherLoginPrice = 299;
    }
  } else {
    // Legacy tier-based pricing fallback
    const tierPricing: Record<string, { base: number; driverLogin: number; otherLogin: number }> = {
      tier_1: { base: 2000, driverLogin: 200, otherLogin: 300 },
      tier_2: { base: 5000, driverLogin: 150, otherLogin: 250 },
      tier_3: { base: 10000, driverLogin: 100, otherLogin: 200 },
      tier_4: { base: 20000, driverLogin: 75, otherLogin: 150 },
    };
    const legacy = tierPricing[distributor.billingTier!] || tierPricing.tier_1!;
    basePriceMonthly = legacy.base;
    driverLoginPrice = legacy.driverLogin;
    otherLoginPrice = legacy.otherLogin;
  }

  // Count active users by role
  const userCounts = await prisma.user.groupBy({
    by: ['role'],
    where: { distributorId, status: 'active', deletedAt: null },
    _count: true,
  });

  const driverCount = userCounts.find(u => u.role === 'driver')?._count || 0;
  const adminCount = userCounts.find(u => u.role === 'distributor_admin')?._count || 0;
  const financeCount = userCounts.find(u => u.role === 'finance')?._count || 0;
  const inventoryCount = userCounts.find(u => u.role === 'inventory')?._count || 0;

  // Get included seats from pricing tier (only charge for EXTRA seats beyond plan)
  let includedDrivers = 5, includedAdmin = 1, includedFinance = 1, includedInventory = 1;
  if (distributor.subscriptionPlan) {
    const tier = await prisma.pricingTier.findUnique({ where: { plan: distributor.subscriptionPlan } });
    if (tier) {
      includedDrivers = tier.driverSeats;
      includedAdmin = tier.adminSeats;
      includedFinance = tier.financeSeats;
      includedInventory = tier.inventorySeats;
    }
  }

  const extraDrivers = Math.max(0, driverCount - includedDrivers);
  const extraAdmin = Math.max(0, adminCount - includedAdmin);
  const extraFinance = Math.max(0, financeCount - includedFinance);
  const extraInventory = Math.max(0, inventoryCount - includedInventory);
  const extraOtherLogins = extraAdmin + extraFinance + extraInventory;

  // Determine period multiplier
  const periodMultiplier: Record<string, number> = {
    monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12,
  };
  const multiplier = periodMultiplier[data.periodType] || 1;

  const gstRate = 18;
  const items: Prisma.BillingItemCreateWithoutBillingCycleInput[] = [];

  // Base subscription (includes plan seats)
  const baseAmount = basePriceMonthly * multiplier;
  const baseGst = baseAmount * gstRate / 100;
  items.push({
    itemType: 'base_subscription',
    description: `Base subscription - ${distributor.subscriptionPlan || 'legacy'} (${data.periodType}) — incl. ${includedAdmin} admin, ${includedFinance} fin, ${includedInventory} inv, ${includedDrivers} drivers`,
    quantity: multiplier,
    unitPriceExclGst: basePriceMonthly,
    gstRate,
    lineTotalExclGst: baseAmount,
    lineGstAmount: baseGst,
    lineTotalInclGst: baseAmount + baseGst,
  });

  // Extra driver logins (only those exceeding plan)
  if (extraDrivers > 0) {
    const driverAmount = driverLoginPrice * extraDrivers * multiplier;
    const driverGst = driverAmount * gstRate / 100;
    items.push({
      itemType: 'driver_login',
      description: `Extra drivers (${extraDrivers} beyond ${includedDrivers} included × ${multiplier} mo)`,
      quantity: extraDrivers * multiplier,
      unitPriceExclGst: driverLoginPrice,
      gstRate,
      lineTotalExclGst: driverAmount,
      lineGstAmount: driverGst,
      lineTotalInclGst: driverAmount + driverGst,
    });
  }

  // Extra other logins (admin/finance/inventory beyond plan)
  if (extraOtherLogins > 0) {
    const otherAmount = otherLoginPrice * extraOtherLogins * multiplier;
    const otherGst = otherAmount * gstRate / 100;
    items.push({
      itemType: 'other_login',
      description: `Extra seats (${extraOtherLogins} beyond plan — ${extraAdmin > 0 ? `${extraAdmin} admin ` : ''}${extraFinance > 0 ? `${extraFinance} fin ` : ''}${extraInventory > 0 ? `${extraInventory} inv ` : ''}× ${multiplier} mo)`,
      quantity: extraOtherLogins * multiplier,
      unitPriceExclGst: otherLoginPrice,
      gstRate,
      lineTotalExclGst: otherAmount,
      lineGstAmount: otherGst,
      lineTotalInclGst: otherAmount + otherGst,
    });
  }

  // Customer portal users billing
  const customerPortalCount = await prisma.user.count({
    where: { distributorId, role: 'customer' as any, status: 'active', deletedAt: null },
  });
  if (customerPortalCount > 0) {
    const portalAmount = customerPortalPrice * customerPortalCount * multiplier;
    const portalGst = portalAmount * gstRate / 100;
    items.push({
      itemType: 'customer_portal',
      description: `Customer portal (${customerPortalCount} customers x ${multiplier} months)`,
      quantity: customerPortalCount * multiplier,
      unitPriceExclGst: customerPortalPrice,
      gstRate,
      lineTotalExclGst: portalAmount,
      lineGstAmount: portalGst,
      lineTotalInclGst: portalAmount + portalGst,
    });
  }

  // GST API overage charges
  const now = new Date();
  const gstUsage = await prisma.gstApiUsage.findUnique({
    where: {
      distributorId_month_year: {
        distributorId,
        month: now.getMonth() + 1,
        year: now.getFullYear(),
      },
    },
  });
  if (gstUsage && gstUsage.totalCalls > gstApiIncluded) {
    const overageCalls = gstUsage.totalCalls - gstApiIncluded;
    const overageAmount = gstApiOveragePrice * overageCalls;
    const overageGst = overageAmount * gstRate / 100;
    items.push({
      itemType: 'gst_api_overage',
      description: `GST API overage (${overageCalls} calls beyond ${gstApiIncluded} included)`,
      quantity: overageCalls,
      unitPriceExclGst: gstApiOveragePrice,
      gstRate,
      lineTotalExclGst: overageAmount,
      lineGstAmount: overageGst,
      lineTotalInclGst: overageAmount + overageGst,
    });
  }

  // Extra seat charges (approved seat requests)
  const approvedSeats = await prisma.seatRequest.findMany({
    where: { distributorId, status: 'approved_seat', pricePerMonth: { not: null } },
  });
  if (approvedSeats.length > 0) {
    const seatTotal = approvedSeats.reduce((sum, s) => sum + (s.pricePerMonth || 0), 0) * multiplier;
    const seatGst = seatTotal * gstRate / 100;
    items.push({
      itemType: 'extra_seat',
      description: `Extra seats (${approvedSeats.length} approved x ${multiplier} months)`,
      quantity: approvedSeats.length * multiplier,
      unitPriceExclGst: approvedSeats.length > 0 ? seatTotal / (approvedSeats.length * multiplier) : 0,
      gstRate,
      lineTotalExclGst: seatTotal,
      lineGstAmount: seatGst,
      lineTotalInclGst: seatTotal + seatGst,
    });
  }

  // Period discount (quarterly/half-yearly/yearly)
  const subtotalExclGst = items.reduce((sum, i) => sum + i.lineTotalExclGst, 0);
  if (periodDiscount > 0) {
    const discountAmount = subtotalExclGst * periodDiscount / 100;
    const discountGst = discountAmount * gstRate / 100;
    items.push({
      itemType: 'period_discount' as any,
      description: `${data.periodType} discount (${periodDiscount}% off)`,
      quantity: 1,
      unitPriceExclGst: -discountAmount,
      gstRate,
      lineTotalExclGst: -discountAmount,
      lineGstAmount: -discountGst,
      lineTotalInclGst: -(discountAmount + discountGst),
    });
  }

  const totalExclGst = items.reduce((sum, i) => sum + i.lineTotalExclGst, 0);
  const totalGst = items.reduce((sum, i) => sum + i.lineGstAmount, 0);
  const totalInclGst = totalExclGst + totalGst;

  const dueDate = new Date(data.periodEndDate);
  dueDate.setDate(dueDate.getDate() + BILLING_GRACE_PERIOD_DAYS);

  return prisma.billingCycle.create({
    data: {
      distributorId,
      periodType: data.periodType as any,
      periodStartDate: new Date(data.periodStartDate),
      periodEndDate: new Date(data.periodEndDate),
      billingStatus: 'invoice_generated',
      billingTier: distributor.billingTier,
      totalAmountExclGst: Math.round(totalExclGst * 100) / 100,
      totalGstAmount: Math.round(totalGst * 100) / 100,
      totalAmountInclGst: Math.round(totalInclGst * 100) / 100,
      dueDate,
      items: { create: items },
    },
    include: billingCycleInclude,
  });
}

/**
 * Add a custom billing item to an existing cycle.
 */
export async function addBillingItem(
  cycleId: string,
  data: {
    itemType: string;
    description: string;
    quantity: number;
    unitPriceExclGst: number;
    gstRate?: number;
    discountAmount?: number;
  }
) {
  const cycle = await prisma.billingCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new BillingError('Billing cycle not found', 404);
  if (cycle.billingStatus === 'paid_billing') throw new BillingError('Cannot modify a paid billing cycle', 400);

  const gstRate = data.gstRate ?? 18;
  const discount = data.discountAmount ?? 0;
  const lineTotalExclGst = (data.unitPriceExclGst * data.quantity) - discount;
  const lineGst = lineTotalExclGst * gstRate / 100;

  return prisma.$transaction(async (tx) => {
    const item = await tx.billingItem.create({
      data: {
        billingCycleId: cycleId,
        itemType: data.itemType as any,
        description: data.description,
        quantity: data.quantity,
        unitPriceExclGst: data.unitPriceExclGst,
        gstRate,
        discountAmount: discount,
        lineTotalExclGst,
        lineGstAmount: lineGst,
        lineTotalInclGst: lineTotalExclGst + lineGst,
      },
    });

    // Recalculate cycle totals
    const allItems = await tx.billingItem.findMany({ where: { billingCycleId: cycleId } });
    const totalExclGst = allItems.reduce((sum, i) => sum + i.lineTotalExclGst, 0);
    const totalGst = allItems.reduce((sum, i) => sum + i.lineGstAmount, 0);

    await tx.billingCycle.update({
      where: { id: cycleId },
      data: {
        totalAmountExclGst: Math.round(totalExclGst * 100) / 100,
        totalGstAmount: Math.round(totalGst * 100) / 100,
        totalAmountInclGst: Math.round((totalExclGst + totalGst) * 100) / 100,
      },
    });

    return item;
  });
}

/**
 * Mark a billing cycle as paid.
 */
export async function markBillingPaid(cycleId: string) {
  const cycle = await prisma.billingCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new BillingError('Billing cycle not found', 404);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.billingCycle.update({
      where: { id: cycleId },
      data: { billingStatus: 'paid_billing' },
      include: billingCycleInclude,
    });

    // If distributor was suspended, unsuspend
    if (cycle.distributorId) {
      await tx.distributor.update({
        where: { id: cycle.distributorId },
        data: { billingSuspended: false },
      });
    }

    return updated;
  });
}

/**
 * Suspend a distributor for overdue billing.
 */
export async function suspendForOverdueBilling(distributorId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.distributor.update({
      where: { id: distributorId },
      data: { billingSuspended: true },
    });

    await tx.billingCycle.updateMany({
      where: { distributorId, billingStatus: 'overdue_billing' },
      data: { billingStatus: 'suspended_billing' },
    });

    return { suspended: true };
  });
}

/**
 * Unsuspend a distributor.
 */
export async function unsuspendDistributor(distributorId: string) {
  return prisma.distributor.update({
    where: { id: distributorId },
    data: { billingSuspended: false },
  });
}

/**
 * Mark overdue billing cycles (for cron).
 */
export async function markOverdueBillingCycles() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result = await prisma.billingCycle.updateMany({
    where: {
      billingStatus: { in: ['invoice_generated', 'pending_payment'] },
      dueDate: { lt: today },
    },
    data: { billingStatus: 'overdue_billing' },
  });

  return { markedOverdue: result.count };
}

/**
 * Check billing cycles expiring within 5 days and create pending actions for renewal.
 */
export async function checkBillingExpiryAndCreatePendingActions() {
  const now = new Date();
  const fiveDaysFromNow = new Date(now);
  fiveDaysFromNow.setDate(fiveDaysFromNow.getDate() + 5);

  // Find cycles expiring within 5 days that are not paid or cancelled
  const expiringCycles = await prisma.billingCycle.findMany({
    where: {
      periodEndDate: { gte: now, lte: fiveDaysFromNow },
      billingStatus: { notIn: ['paid_billing', 'suspended_billing'] },
    },
    include: {
      distributor: { select: { id: true, businessName: true } },
    },
  });

  let createdCount = 0;

  for (const cycle of expiringCycles) {
    // Check if a pending action for billing_renewal already exists for this distributor
    const existingAction = await prisma.pendingAction.findFirst({
      where: {
        distributorId: cycle.distributorId,
        actionType: 'billing_renewal',
        status: 'open' as any,
      },
    });

    if (!existingAction) {
      const endDate = cycle.periodEndDate.toISOString().split('T')[0];
      await pendingActionsService.createPendingAction(cycle.distributorId, {
        module: 'billing' as any,
        entityType: 'billing_cycle',
        entityId: cycle.id,
        actionType: 'billing_renewal',
        description: `Billing cycle for ${cycle.distributor.businessName} expires on ${endDate}. Generate invoice for next period.`,
        severity: 'high',
        requiresApproval: false,
      });
      createdCount++;
    }
  }

  return { pendingActionsCreated: createdCount };
}

export class BillingError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'BillingError';
  }
}
