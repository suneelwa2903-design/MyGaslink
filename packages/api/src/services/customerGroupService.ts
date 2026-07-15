/**
 * Feature A (2026-07-15): distributor-facing CustomerGroup management.
 *
 * Full CRUD for CustomerGroup + membership + portal-access
 * provisioning. All functions take `distributorId` as the first arg
 * and enforce it on every query (anti-pattern #13). Never trust
 * distributorId from the request body — routes source it from
 * req.user.distributorId only.
 *
 * The customer_hq portal READ surface lives in a separate service
 * (customerGroupPortalService.ts) — do NOT mix concerns here.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from './authService.js';
import type { CustomerGroup, User } from '@prisma/client';

export class CustomerGroupError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'CustomerGroupError';
  }
}

export interface CustomerGroupSummaryRow {
  id: string;
  distributorId: string;
  name: string;
  memberCount: number;
  hasPortalAccess: boolean;
  portalEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerGroupDetail {
  id: string;
  distributorId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  members: Array<{
    id: string;
    groupId: string;
    customerId: string;
    customerName: string;
    businessName: string | null;
    gstin: string | null;
    customerType: string;
    addedAt: Date;
  }>;
  portalUser: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  } | null;
}

/**
 * List all non-deleted groups for a distributor, with member count and
 * portal-access status per row. Used by the web Groups tab index.
 */
export async function listGroups(distributorId: string): Promise<CustomerGroupSummaryRow[]> {
  const rows = await prisma.customerGroup.findMany({
    where: { distributorId, deletedAt: null },
    include: {
      _count: { select: { members: true } },
      users: {
        where: { deletedAt: null, status: 'active' },
        select: { id: true, email: true },
        take: 1,
      },
    },
    orderBy: { name: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    distributorId: r.distributorId,
    name: r.name,
    memberCount: r._count.members,
    hasPortalAccess: r.users.length > 0,
    portalEmail: r.users[0]?.email ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/**
 * Fetch one group with its member list + portal user for the manage
 * modal. Filters out soft-deleted customers from the member list — a
 * customer that's been deleted since being added shouldn't show up.
 */
export async function getGroup(
  distributorId: string,
  groupId: string,
): Promise<CustomerGroupDetail> {
  const group = await prisma.customerGroup.findFirst({
    where: { id: groupId, distributorId, deletedAt: null },
    include: {
      members: {
        include: {
          customer: {
            select: {
              id: true,
              customerName: true,
              businessName: true,
              gstin: true,
              customerType: true,
              deletedAt: true,
            },
          },
        },
      },
      users: {
        where: { deletedAt: null, status: 'active' },
        select: { id: true, email: true, firstName: true, lastName: true },
        take: 1,
      },
    },
  });
  if (!group) throw new CustomerGroupError('Group not found', 404);
  return {
    id: group.id,
    distributorId: group.distributorId,
    name: group.name,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    members: group.members
      .filter((m) => !m.customer.deletedAt)
      .map((m) => ({
        id: m.id,
        groupId: m.groupId,
        customerId: m.customerId,
        customerName: m.customer.customerName,
        businessName: m.customer.businessName,
        gstin: m.customer.gstin,
        customerType: m.customer.customerType,
        addedAt: m.addedAt,
      })),
    portalUser: group.users[0] ?? null,
  };
}

export async function createGroup(
  distributorId: string,
  data: { name: string },
): Promise<CustomerGroup> {
  return prisma.customerGroup.create({
    data: {
      id: randomUUID(),
      distributorId,
      name: data.name.trim(),
    },
  });
}

/**
 * Rename a group. Verifies tenant ownership before update.
 */
export async function updateGroup(
  distributorId: string,
  groupId: string,
  data: { name: string },
): Promise<CustomerGroup> {
  const existing = await prisma.customerGroup.findFirst({
    where: { id: groupId, distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!existing) throw new CustomerGroupError('Group not found', 404);
  return prisma.customerGroup.update({
    where: { id: groupId },
    data: { name: data.name.trim() },
  });
}

/**
 * Soft-delete a group. Refuses if the group still has an active portal
 * user — the caller must revoke access first. Members are left in
 * place (they still exist as customers, just no longer in this group).
 */
export async function deleteGroup(distributorId: string, groupId: string): Promise<void> {
  const existing = await prisma.customerGroup.findFirst({
    where: { id: groupId, distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!existing) throw new CustomerGroupError('Group not found', 404);
  const activeUser = await prisma.user.count({
    where: { groupId, deletedAt: null, status: 'active' },
  });
  if (activeUser > 0) {
    throw new CustomerGroupError(
      'Revoke portal access before deleting the group',
      400,
    );
  }
  await prisma.customerGroup.update({
    where: { id: groupId },
    data: { deletedAt: new Date() },
  });
}

/**
 * Add a customer to a group. Verifies BOTH the group AND the customer
 * belong to the caller's distributor (anti-pattern #13 — never trust
 * inputs to identify the tenant). Refuses duplicate memberships.
 */
export async function addMember(
  distributorId: string,
  groupId: string,
  customerId: string,
): Promise<void> {
  const [group, customer] = await Promise.all([
    prisma.customerGroup.findFirst({
      where: { id: groupId, distributorId, deletedAt: null },
      select: { id: true },
    }),
    prisma.customer.findFirst({
      where: { id: customerId, distributorId, deletedAt: null },
      select: { id: true },
    }),
  ]);
  if (!group) throw new CustomerGroupError('Group not found', 404);
  if (!customer) throw new CustomerGroupError('Customer not found', 404);
  const existing = await prisma.customerGroupMember.findFirst({
    where: { groupId, customerId },
    select: { id: true },
  });
  if (existing) {
    throw new CustomerGroupError('Customer is already a member of this group', 400);
  }
  await prisma.customerGroupMember.create({
    data: { id: randomUUID(), groupId, customerId },
  });
}

/**
 * Remove a customer from a group. Verifies group belongs to the
 * caller's distributor. Idempotent — a no-op if the row is already
 * gone (Prisma delete would 404 otherwise; we handle that gracefully).
 */
export async function removeMember(
  distributorId: string,
  groupId: string,
  customerId: string,
): Promise<void> {
  const group = await prisma.customerGroup.findFirst({
    where: { id: groupId, distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!group) throw new CustomerGroupError('Group not found', 404);
  await prisma.customerGroupMember.deleteMany({
    where: { groupId, customerId },
  });
}

/**
 * Provision a customer_hq portal user for a group. Verifies group
 * belongs to distributor. Refuses if the group already has an active
 * portal user (only one allowed per group in v1) or the email is
 * already taken anywhere in the system.
 *
 * Returns a narrow shape — never the passwordHash.
 */
export async function provisionPortalAccess(
  distributorId: string,
  groupId: string,
  data: { email: string; password: string; firstName: string; lastName: string },
): Promise<Pick<User, 'id' | 'email' | 'firstName' | 'lastName' | 'role'>> {
  const group = await prisma.customerGroup.findFirst({
    where: { id: groupId, distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!group) throw new CustomerGroupError('Group not found', 404);

  const activeExisting = await prisma.user.findFirst({
    where: { groupId, deletedAt: null, status: 'active' },
    select: { id: true, email: true },
  });
  if (activeExisting) {
    throw new CustomerGroupError(
      'Group already has portal access. Revoke first before provisioning a new login.',
      400,
    );
  }

  const emailNormalized = data.email.trim().toLowerCase();
  const emailTaken = await prisma.user.findUnique({
    where: { email: emailNormalized },
    select: { id: true },
  });
  if (emailTaken) {
    throw new CustomerGroupError('This email is already in use', 400);
  }

  const passwordHash = await hashPassword(data.password);
  return prisma.user.create({
    data: {
      id: randomUUID(),
      email: emailNormalized,
      passwordHash,
      firstName: data.firstName.trim(),
      lastName: data.lastName.trim(),
      role: 'customer_hq',
      distributorId,
      groupId,
      requiresPasswordReset: true,
    },
    select: { id: true, email: true, firstName: true, lastName: true, role: true },
  });
}

/**
 * Revoke portal access for a group by soft-deleting every active
 * customer_hq user linked to it. Idempotent — a no-op if there is no
 * active portal user (returns 0 affected rows silently).
 */
export async function revokePortalAccess(
  distributorId: string,
  groupId: string,
): Promise<{ revokedCount: number }> {
  const group = await prisma.customerGroup.findFirst({
    where: { id: groupId, distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!group) throw new CustomerGroupError('Group not found', 404);
  const result = await prisma.user.updateMany({
    where: { groupId, deletedAt: null, status: 'active' },
    data: { deletedAt: new Date(), status: 'inactive' },
  });
  return { revokedCount: result.count };
}
