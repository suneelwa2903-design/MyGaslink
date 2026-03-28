import { prisma } from '../lib/prisma.js';

/**
 * Increment GST API call count for a distributor.
 * Called after each IRN generation or EWB generation API call.
 */
export async function trackGstApiCall(distributorId: string, callType: 'irn' | 'ewb') {
  const now = new Date();
  const month = now.getMonth() + 1; // 1-12
  const year = now.getFullYear();

  // Get allocated calls from pricing tier
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { subscriptionPlan: true },
  });

  let allocatedCalls = 1500; // default starter
  if (distributor?.subscriptionPlan) {
    const tier = await prisma.pricingTier.findUnique({
      where: { plan: distributor.subscriptionPlan },
      select: { gstApiCallsIncluded: true },
    });
    if (tier) allocatedCalls = tier.gstApiCallsIncluded;
  }

  const incrementData = callType === 'irn'
    ? { irnCallCount: { increment: 1 }, totalCalls: { increment: 1 } }
    : { ewbCallCount: { increment: 1 }, totalCalls: { increment: 1 } };

  return prisma.gstApiUsage.upsert({
    where: { distributorId_month_year: { distributorId, month, year } },
    create: {
      distributorId,
      month,
      year,
      irnCallCount: callType === 'irn' ? 1 : 0,
      ewbCallCount: callType === 'ewb' ? 1 : 0,
      totalCalls: 1,
      allocatedCalls,
    },
    update: incrementData,
  });
}

/**
 * Get current month's GST API usage for a distributor
 */
export async function getGstApiUsage(distributorId: string, month?: number, year?: number) {
  const now = new Date();
  const m = month || now.getMonth() + 1;
  const y = year || now.getFullYear();

  const usage = await prisma.gstApiUsage.findUnique({
    where: { distributorId_month_year: { distributorId, month: m, year: y } },
  });

  if (!usage) {
    // Get allocated from pricing tier
    const distributor = await prisma.distributor.findUnique({
      where: { id: distributorId },
      select: { subscriptionPlan: true },
    });
    let allocated = 1500;
    if (distributor?.subscriptionPlan) {
      const tier = await prisma.pricingTier.findUnique({
        where: { plan: distributor.subscriptionPlan },
        select: { gstApiCallsIncluded: true },
      });
      if (tier) allocated = tier.gstApiCallsIncluded;
    }
    return { month: m, year: y, irnCallCount: 0, ewbCallCount: 0, totalCalls: 0, allocatedCalls: allocated, overageCount: 0 };
  }

  return {
    ...usage,
    overageCount: Math.max(0, usage.totalCalls - usage.allocatedCalls),
  };
}

/**
 * Get GST API usage history for a distributor (last N months)
 */
export async function getGstApiUsageHistory(distributorId: string, months = 6) {
  return prisma.gstApiUsage.findMany({
    where: { distributorId },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
    take: months,
  });
}

/**
 * Get all distributors' GST API usage for the current month (super admin view)
 */
export async function getAllGstApiUsage(month?: number, year?: number) {
  const now = new Date();
  const m = month || now.getMonth() + 1;
  const y = year || now.getFullYear();

  return prisma.gstApiUsage.findMany({
    where: { month: m, year: y },
    include: {
      distributor: { select: { id: true, businessName: true, subscriptionPlan: true } },
    },
    orderBy: { totalCalls: 'desc' },
  });
}
