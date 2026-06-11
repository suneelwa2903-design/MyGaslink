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

// Group B Part 4 — staff Users list filters + search + sort.
// Defaults to STAFF roles only (excludes customer + driver portal logins),
// since the Settings → Users page is for the distributor's internal team.
// Customer-role users are administered from the Customers section; driver-
// role users from Fleet → Drivers. Callers that need the full list (e.g.
// the upcoming portal-status view) opt in via `includePortal: true`.
type ListUsersFilters = {
  /** Filter by single role. Overrides default-hide of customer/driver. */
  roleFilter?: string;
  /** Filter by status (active/inactive). */
  statusFilter?: string;
  /** Free-text search across firstName, lastName, email, phone. */
  search?: string;
  /** Sort column — one of name/email/createdAt/lastLoginAt. */
  sortBy?: 'name' | 'email' | 'createdAt' | 'lastLoginAt';
  /** Sort direction. Defaults to desc. */
  sortDir?: 'asc' | 'desc';
  /** When true, include customer + driver roles in the default response. */
  includePortal?: boolean;
  /**
   * Group L1 (2026-06-11): explicit tenant scope. Super-admin can pass a
   * distributorId here to filter the Users list to a single tenant
   * WITHOUT touching the global X-Distributor-Id selector. Ignored for
   * non-super_admin callers (their list is always scoped to their own
   * distributor via the caller's JWT).
   */
  distributorIdFilter?: string;
};

export async function listUsers(
  distributorId: string | null,
  role: string,
  filters: ListUsersFilters = {},
) {
  const where: Prisma.UserWhereInput = { deletedAt: null };
  if (role !== 'super_admin' && distributorId) {
    where.distributorId = distributorId;
  } else if (role === 'super_admin' && filters.distributorIdFilter) {
    // Group L1 (2026-06-11): super-admin opt-in scope, independent of
    // the global tenant selector.
    where.distributorId = filters.distributorIdFilter;
  }

  // Role: explicit filter wins; otherwise default-hide ONLY customer-role
  // users (their natural home is the Customers section). Driver-role users
  // ARE staff and should appear in the default Users list alongside
  // finance/inventory/distributor_admin (Group B Part 7 Bug 3 — Suneel
  // pushed back on hiding drivers; they're delivery staff, not portal
  // logins). `includePortal=true` opt-in restores customer rows too.
  if (filters.roleFilter) {
    where.role = filters.roleFilter as $Enums.UserRole;
  } else if (!filters.includePortal) {
    where.role = { not: 'customer' as $Enums.UserRole };
  }

  if (filters.statusFilter) {
    where.status = filters.statusFilter as $Enums.UserStatus;
  }

  // Search: case-insensitive contains on firstName / lastName / email / phone.
  // Phone is matched without case-insensitive (it has no letters), so it
  // gets its own clause to avoid the "Mode" arg landing where it doesn't apply.
  if (filters.search) {
    const q = filters.search.trim();
    if (q.length > 0) {
      where.OR = [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
      ];
    }
  }

  // Sort: "name" is mapped to firstName since Prisma can't sort by a
  // concatenation; firstName is the dominant display surface in the table.
  const sortDir: Prisma.SortOrder = filters.sortDir ?? 'desc';
  let orderBy: Prisma.UserOrderByWithRelationInput;
  switch (filters.sortBy) {
    case 'name':
      orderBy = { firstName: sortDir };
      break;
    case 'email':
      orderBy = { email: sortDir };
      break;
    case 'lastLoginAt':
      orderBy = { lastLoginAt: sortDir };
      break;
    case 'createdAt':
    default:
      orderBy = { createdAt: sortDir };
      break;
  }

  // Group L1 (2026-06-11): include the distributor's businessName so the
  // super-admin Users table can render a per-row "Distributor" column
  // even when the list is unscoped (cross-tenant). One extra column on
  // the join, no extra round-trip.
  return prisma.user.findMany({
    where,
    select: { ...userSelect, distributor: { select: { id: true, businessName: true } } },
    orderBy,
  });
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

// Group L3 (2026-06-11): suspend/reactivate user.
//
// Suspend = reversible block. Sets status='suspended' and clears the
// refresh token so the existing session can't survive past the next
// access-token expiry (default 15min). On the next login attempt, the
// auth service surfaces a specialised message:
//   "Your account has been suspended. Contact your administrator."
//
// Reactivate is the inverse — flips status back to active. Login
// resumes normally; an admin must hand the user a password if they
// forgot it (no implicit password reset).
//
// Tenant isolation: distributor_admin can ONLY act on users in their
// own tenant. Super-admin can act on any tenant. Two extra guards:
//   1. You can't suspend yourself (lockout footgun).
//   2. You can't suspend a super_admin (lockout-of-platform footgun;
//      escalation if a tenant admin could nuke the SaaS owner).
//   3. distributor_admin can't suspend ANOTHER distributor_admin in
//      the same tenant — co-admin lockout protection. Only super-admin
//      can suspend a distributor_admin.

export class UserError extends Error {
  constructor(message: string, public statusCode: number, public code?: string) {
    super(message);
    this.name = 'UserError';
  }
}

async function assertCanModifyUser(
  targetId: string,
  actorId: string,
  actorRole: string,
  callerDistributorId: string | null,
): Promise<{ id: string; role: $Enums.UserRole; distributorId: string | null; status: $Enums.UserStatus }> {
  const target = await prisma.user.findFirst({
    where: { id: targetId, deletedAt: null },
    select: { id: true, role: true, distributorId: true, status: true },
  });
  if (!target) throw new UserError('User not found', 404);
  if (target.id === actorId) {
    throw new UserError('You cannot suspend your own account', 400, 'CANNOT_SUSPEND_SELF');
  }
  if (target.role === 'super_admin') {
    throw new UserError('Super-admin accounts cannot be suspended', 403, 'CANNOT_SUSPEND_SUPER_ADMIN');
  }
  if (actorRole !== 'super_admin') {
    // distributor_admin actor
    if (target.distributorId !== callerDistributorId) {
      throw new UserError('User not found', 404);
    }
    if (target.role === 'distributor_admin') {
      throw new UserError(
        'A distributor admin can only suspend a fellow admin via super-admin',
        403,
        'CANNOT_SUSPEND_PEER_ADMIN',
      );
    }
  }
  return target;
}

export async function suspendUser(
  targetId: string,
  actorId: string,
  actorRole: string,
  callerDistributorId: string | null,
) {
  await assertCanModifyUser(targetId, actorId, actorRole, callerDistributorId);
  return prisma.user.update({
    where: { id: targetId },
    data: {
      status: 'suspended',
      // Wipe the refresh token so the existing session can't be renewed.
      // The access token still works until it expires (15min default) —
      // acceptable for a soft suspend; the next refresh attempt fails.
      refreshToken: null,
    },
    select: userSelect,
  });
}

export async function reactivateUser(
  targetId: string,
  actorId: string,
  actorRole: string,
  callerDistributorId: string | null,
) {
  await assertCanModifyUser(targetId, actorId, actorRole, callerDistributorId);
  return prisma.user.update({
    where: { id: targetId },
    data: { status: 'active' },
    select: userSelect,
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
