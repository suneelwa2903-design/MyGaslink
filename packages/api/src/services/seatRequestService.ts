import { prisma } from '../lib/prisma.js';
import type { Prisma, $Enums } from '@prisma/client';
import { toNum } from '../utils/decimal.js';

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
      pricePerMonth = request.requestedRole === 'driver' ? toNum(tier.extraSeatPriceDriver) : toNum(tier.extraSeatPriceAdmin);
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
