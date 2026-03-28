import { prisma } from '../lib/prisma.js';

// Get all active pricing tiers
export async function listPricingTiers() {
  return prisma.pricingTier.findMany({
    where: { isActive: true },
    orderBy: { monthlyPrice: 'asc' },
  });
}

// Get pricing for a specific plan
export async function getPricingByPlan(plan: string) {
  return prisma.pricingTier.findUnique({
    where: { plan: plan as any },
  });
}

// Calculate price for a period type
export function calculatePeriodPrice(
  monthlyPrice: number,
  periodType: string,
  discounts: { quarterly: number; halfYearly: number; yearly: number },
) {
  const multipliers: Record<string, number> = {
    monthly: 1,
    quarterly: 3,
    half_yearly: 6,
    yearly: 12,
  };
  const discountMap: Record<string, number> = {
    monthly: 0,
    quarterly: discounts.quarterly,
    half_yearly: discounts.halfYearly,
    yearly: discounts.yearly,
  };

  const months = multipliers[periodType] || 1;
  const discountPct = discountMap[periodType] || 0;
  const subtotal = monthlyPrice * months;
  const discount = (subtotal * discountPct) / 100;
  return { subtotal, discount, total: subtotal - discount, months };
}

// Get seat limits for a distributor based on their subscription plan
export async function getSeatLimits(distributorId: string) {
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { subscriptionPlan: true },
  });
  if (!distributor?.subscriptionPlan) return null;

  const tier = await prisma.pricingTier.findUnique({
    where: { plan: distributor.subscriptionPlan },
  });
  if (!tier) return null;

  // Count current users by role category
  const users = await prisma.user.groupBy({
    by: ['role'],
    where: { distributorId, status: 'active', deletedAt: null },
    _count: true,
  });

  const adminRoles = ['distributor_admin'];
  const financeRoles = ['finance'];
  const inventoryRoles = ['inventory'];
  const driverRole = ['driver'];

  const currentAdmin = users
    .filter((u) => adminRoles.includes(u.role))
    .reduce((s, u) => s + u._count, 0);
  const currentFinance = users
    .filter((u) => financeRoles.includes(u.role))
    .reduce((s, u) => s + u._count, 0);
  const currentInventory = users
    .filter((u) => inventoryRoles.includes(u.role))
    .reduce((s, u) => s + u._count, 0);
  const currentDrivers = users
    .filter((u) => driverRole.includes(u.role))
    .reduce((s, u) => s + u._count, 0);

  return {
    plan: tier.plan,
    limits: {
      admin: {
        allowed: tier.adminSeats,
        used: currentAdmin,
        extraPrice: tier.extraSeatPriceAdmin,
      },
      finance: {
        allowed: tier.financeSeats,
        used: currentFinance,
        extraPrice: tier.extraSeatPriceAdmin,
      },
      inventory: {
        allowed: tier.inventorySeats,
        used: currentInventory,
        extraPrice: tier.extraSeatPriceAdmin,
      },
      driver: {
        allowed: tier.driverSeats,
        used: currentDrivers,
        extraPrice: tier.extraSeatPriceDriver,
      },
    },
    gstApi: {
      included: tier.gstApiCallsIncluded,
      overagePrice: tier.gstApiOveragePrice,
    },
    customerPortalPrice: tier.customerPortalPrice,
  };
}
