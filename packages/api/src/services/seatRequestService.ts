import { prisma } from '../lib/prisma.js';
import type { Prisma, $Enums } from '@prisma/client';
import { toNum } from '../utils/decimal.js';

// Phase 4b (2026-06-12): per-role overage price picker. The PricingTier
// columns (per Phase 4a) carry distinct values for each role; this maps
// the seat request's requested role to the matching column.
//
// Roles that fall outside the per-role table (e.g. super_admin) get the
// admin overage price as the historical fallback — though in practice
// super_admin seats are never billed because that role is platform-side,
// not tenant-side.
type SeatPricingRow = {
  extraSeatPriceAdmin: Prisma.Decimal;
  extraSeatPriceDriver: Prisma.Decimal;
  extraSeatPriceFinance: Prisma.Decimal;
  extraSeatPriceInventory: Prisma.Decimal;
  extraSeatPriceCustomer: Prisma.Decimal;
};

function pickPerRoleSeatPrice(role: string, tier: SeatPricingRow): number {
  switch (role) {
    case 'driver':            return toNum(tier.extraSeatPriceDriver);
    case 'finance':           return toNum(tier.extraSeatPriceFinance);
    case 'inventory':         return toNum(tier.extraSeatPriceInventory);
    case 'customer':          return toNum(tier.extraSeatPriceCustomer);
    case 'distributor_admin':
    default:                  return toNum(tier.extraSeatPriceAdmin);
  }
}

export async function createSeatRequest(data: {
  distributorId: string;
  requestedRole: string;
  requestedBy: string;
  reason?: string;
}) {
  return prisma.seatRequest.create({
    data: {
      distributorId: data.distributorId,
      requestedRole: data.requestedRole,
      requestedBy: data.requestedBy,
      reason: data.reason || null,
    },
  });
}

export async function listSeatRequests(distributorId?: string, status?: string) {
  const where: Prisma.SeatRequestWhereInput = {};
  if (distributorId) where.distributorId = distributorId;
  if (status) where.status = status as $Enums.SeatRequestStatus;

  return prisma.seatRequest.findMany({
    where,
    include: {
      distributor: { select: { id: true, businessName: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function approveSeatRequest(requestId: string, approvedBy: string, distributorId?: string) {
  const request = await prisma.seatRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new Error('Seat request not found');
  if (distributorId && request.distributorId !== distributorId) throw new Error('Forbidden');
  if (request.status !== 'pending_seat') throw new Error('Request is not pending');

  // Get pricing for the extra seat
  const distributor = await prisma.distributor.findUnique({
    where: { id: request.distributorId },
    select: { subscriptionPlan: true },
  });

  let pricePerMonth = 299; // default
  if (distributor?.subscriptionPlan) {
    const tier = await prisma.pricingTier.findUnique({
      where: { plan: distributor.subscriptionPlan },
    });
    if (tier) {
      // Phase 4b (2026-06-12): pick the correct per-role overage column.
      // Pre-Phase-4a there were only Admin + Driver overage prices, so
      // finance + inventory + customer all silently fell through to
      // extraSeatPriceAdmin (₹999) — overcharging finance / inventory
      // (real price ₹499) and undercharging in some edge cases.
      // Phase 4a added the missing columns; this routes each role to its
      // own price.
      pricePerMonth = pickPerRoleSeatPrice(request.requestedRole, tier);
    }
  }

  return prisma.seatRequest.update({
    where: { id: requestId },
    data: {
      status: 'approved_seat',
      approvedBy,
      approvedAt: new Date(),
      pricePerMonth,
    },
  });
}

export async function rejectSeatRequest(requestId: string, approvedBy: string, distributorId?: string) {
  const request = await prisma.seatRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new Error('Seat request not found');
  if (distributorId && request.distributorId !== distributorId) throw new Error('Forbidden');
  return prisma.seatRequest.update({
    where: { id: requestId },
    data: {
      status: 'rejected_seat',
      approvedBy,
      approvedAt: new Date(),
    },
  });
}
