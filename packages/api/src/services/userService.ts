import { prisma } from '../lib/prisma.js';
import { hashPassword } from './authService.js';
import type { Prisma, $Enums } from '@prisma/client';

const userSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  role: true,
  status: true,
  provisioningStatus: true,
  distributorId: true,
  customerId: true,
  requiresPasswordReset: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export async function listUsers(distributorId: string | null, role: string) {
  const where: Prisma.UserWhereInput = { deletedAt: null };
  if (role !== 'super_admin' && distributorId) {
    where.distributorId = distributorId;
  }
  return prisma.user.findMany({ where, select: userSelect, orderBy: { createdAt: 'desc' } });
}

export async function getUserById(id: string, distributorId?: string) {
  const where: Prisma.UserWhereInput = { id, deletedAt: null };
  if (distributorId) where.distributorId = distributorId;
  return prisma.user.findFirst({
    where,
    select: userSelect,
  });
}

export async function getUserProfile(userId: string) {
  return prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      ...userSelect,
      distributor: {
        select: { id: true, businessName: true, status: true },
      },
    },
  });
}

export async function createUser(data: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role: string;
  distributorId?: string;
  customerId?: string;
}) {
  // Seat limit enforcement
  if (data.distributorId && data.role !== 'super_admin') {
    const seatCheck = await checkSeatAvailability(data.distributorId, data.role);
    if (!seatCheck.available) {
      throw new SeatLimitError(
        `Seat limit reached for ${data.role}. ${seatCheck.used}/${seatCheck.allowed} seats used. Request additional seats or upgrade your plan.`,
        data.role,
        seatCheck.allowed,
        seatCheck.used
      );
    }
  }

  const passwordHash = await hashPassword(data.password);
  return prisma.user.create({
    data: {
      email: data.email.toLowerCase(),
      passwordHash,
      firstName: data.firstName,
      lastName: data.lastName,
      phone: data.phone || null,
      role: data.role as $Enums.UserRole,
      distributorId: data.distributorId || null,
      customerId: data.customerId || null,
      requiresPasswordReset: true,
    },
    select: userSelect,
  });
}

export async function updateUser(id: string, data: {
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  role?: string;
  distributorId?: string;
  customerId?: string;
}, callerDistributorId?: string) {
  if (callerDistributorId) {
    const existing = await prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: { distributorId: true },
    });
    if (!existing) throw new Error('User not found');
    if (existing.distributorId !== callerDistributorId) throw new Error('Forbidden');
  }
  const updateData: Prisma.UserUpdateInput = {};
  if (data.email !== undefined) updateData.email = data.email.toLowerCase();
  if (data.firstName !== undefined) updateData.firstName = data.firstName;
  if (data.lastName !== undefined) updateData.lastName = data.lastName;
  if (data.phone !== undefined) updateData.phone = data.phone;
  if (data.role !== undefined) updateData.role = data.role as $Enums.UserRole;
  if (data.distributorId !== undefined) {
    updateData.distributor = data.distributorId
      ? { connect: { id: data.distributorId } }
      : { disconnect: true };
  }
  if (data.customerId !== undefined) {
    updateData.customer = data.customerId
      ? { connect: { id: data.customerId } }
      : { disconnect: true };
  }

  return prisma.user.update({
    where: { id },
    data: updateData,
    select: userSelect,
  });
}

export async function softDeleteUser(id: string, callerDistributorId?: string) {
  if (callerDistributorId) {
    const existing = await prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: { distributorId: true },
    });
    if (!existing) throw new Error('User not found');
    if (existing.distributorId !== callerDistributorId) throw new Error('Forbidden');
  }
  return prisma.user.update({
    where: { id },
    data: { deletedAt: new Date(), status: 'inactive', refreshToken: null },
    select: { id: true },
  });
}

// ─── Seat Limit Enforcement ──────────────────────────────────────────────────

async function checkSeatAvailability(distributorId: string, role: string) {
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { subscriptionPlan: true },
  });

  if (!distributor?.subscriptionPlan) {
    return { available: true, allowed: 999, used: 0 }; // No plan = no limits
  }

  const tier = await prisma.pricingTier.findUnique({
    where: { plan: distributor.subscriptionPlan },
  });

  if (!tier) return { available: true, allowed: 999, used: 0 };

  // Map role to seat category
  const seatMap: Record<string, number> = {
    distributor_admin: tier.adminSeats,
    finance: tier.financeSeats,
    inventory: tier.inventorySeats,
    driver: tier.driverSeats,
  };

  const allowed = seatMap[role];
  if (allowed === undefined) return { available: true, allowed: 999, used: 0 }; // Unknown role, no limit

  const used = await prisma.user.count({
    where: { distributorId, role: role as $Enums.UserRole, status: 'active', deletedAt: null },
  });

  return { available: used < allowed, allowed, used };
}

export class SeatLimitError extends Error {
  constructor(
    message: string,
    public role: string,
    public allowed: number,
    public used: number,
    public statusCode: number = 403
  ) {
    super(message);
    this.name = 'SeatLimitError';
  }
}
