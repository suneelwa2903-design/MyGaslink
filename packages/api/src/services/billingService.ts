import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';
import { BILLING_GRACE_PERIOD_DAYS, BILLING_OVERDUE_SUSPEND_DAYS, GST_RATES } from '@gaslink/shared';

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
    select: { billingTier: true, gaslinkBillingEnabled: true, billingSuspended: true },
  });

  if (!distributor) throw new BillingError('Distributor not found', 404);
  if (!distributor.gaslinkBillingEnabled) throw new BillingError('GasLink billing is not enabled for this distributor', 400);
  if (!distributor.billingTier) throw new BillingError('No billing tier assigned', 400);

  // Check for existing cycle in same period
  const existing = await prisma.billingCycle.findFirst({
    where: {
      distributorId,
      periodStartDate: new Date(data.periodStartDate),
      periodEndDate: new Date(data.periodEndDate),
    },
  });
  if (existing) throw new BillingError('Billing cycle already exists for this period', 400);

  // Count active users by role
  const userCounts = await prisma.user.groupBy({
    by: ['role'],
    where: { distributorId, status: 'active', deletedAt: null },
    _count: true,
  });

  const driverCount = userCounts.find(u => u.role === 'driver')?._count || 0;
  const otherLoginCount = userCounts
    .filter(u => u.role !== 'driver' && u.role !== 'super_admin')
    .reduce((sum, u) => sum + u._count, 0);

  // Tier-based pricing (per month)
  const tierPricing: Record<string, { base: number; driverLogin: number; otherLogin: number }> = {
    tier_1: { base: 2000, driverLogin: 200, otherLogin: 300 },
    tier_2: { base: 5000, driverLogin: 150, otherLogin: 250 },
    tier_3: { base: 10000, driverLogin: 100, otherLogin: 200 },
    tier_4: { base: 20000, driverLogin: 75, otherLogin: 150 },
  };
  const pricing = tierPricing[distributor.billingTier] || tierPricing.tier_1!;

  // Determine period multiplier
  const periodMultiplier: Record<string, number> = {
    monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12,
  };
  const multiplier = periodMultiplier[data.periodType] || 1;

  const gstRate = 18;
  const items: Prisma.BillingItemCreateWithoutBillingCycleInput[] = [];

  // Base subscription
  const baseAmount = pricing.base * multiplier;
  const baseGst = baseAmount * gstRate / 100;
  items.push({
    itemType: 'base_subscription',
    description: `Base subscription (${data.periodType})`,
    quantity: multiplier,
    unitPriceExclGst: pricing.base,
    gstRate,
    lineTotalExclGst: baseAmount,
    lineGstAmount: baseGst,
    lineTotalInclGst: baseAmount + baseGst,
  });

  // Driver logins
  if (driverCount > 0) {
    const driverAmount = pricing.driverLogin * driverCount * multiplier;
    const driverGst = driverAmount * gstRate / 100;
    items.push({
      itemType: 'driver_login',
      description: `Driver logins (${driverCount} drivers x ${multiplier} months)`,
      quantity: driverCount * multiplier,
      unitPriceExclGst: pricing.driverLogin,
      gstRate,
      lineTotalExclGst: driverAmount,
      lineGstAmount: driverGst,
      lineTotalInclGst: driverAmount + driverGst,
    });
  }

  // Other logins
  if (otherLoginCount > 0) {
    const otherAmount = pricing.otherLogin * otherLoginCount * multiplier;
    const otherGst = otherAmount * gstRate / 100;
    items.push({
      itemType: 'other_login',
      description: `Other logins (${otherLoginCount} users x ${multiplier} months)`,
      quantity: otherLoginCount * multiplier,
      unitPriceExclGst: pricing.otherLogin,
      gstRate,
      lineTotalExclGst: otherAmount,
      lineGstAmount: otherGst,
      lineTotalInclGst: otherAmount + otherGst,
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

export class BillingError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'BillingError';
  }
}
