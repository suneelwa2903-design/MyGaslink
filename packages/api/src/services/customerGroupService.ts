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

export interface PortalUserShape {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  sourceContactId: string | null;
  sourceContactName: string | null;
  sourceCustomerId: string | null;
  sourceCustomerName: string | null;
}

export interface CustomerGroupSummaryRow {
  id: string;
  distributorId: string;
  name: string;
  memberCount: number;
  hasPortalAccess: boolean;
  // Feature A follow-up (2026-07-15): compact preview of up to 3 HQ
  // login emails for the Groups tab list card; `portalUserCount` is
  // the authoritative total.
  portalEmails: string[];
  portalUserCount: number;
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
  // Feature A follow-up (2026-07-15): a group can now hold multiple
  // active HQ logins. Previously singular `portalUser | null`.
  portalUsers: PortalUserShape[];
}

export interface GroupCandidateContactRow {
  contactId: string;
  name: string;
  email: string | null;
  phone: string;
  isPrimary: boolean;
  customerId: string;
  customerName: string;
  hasLogin: boolean;
}

/**
 * List all non-deleted groups for a distributor, with member count and
 * portal-access status per row. Used by the web Groups tab index.
 */
export async function listGroups(distributorId: string): Promise<CustomerGroupSummaryRow[]> {
  const rows = await prisma.customerGroup.findMany({
    where: { distributorId, deletedAt: null },
    include: {
      _count: {
        select: {
          members: true,
          // Feature A follow-up: authoritative HQ-login count. Filter
          // is applied at the `users` include below AND indirectly
          // here via the where — but Prisma _count.users doesn't take
          // a where clause on this relation kind, so we count in-code
          // from the same fetched array.
          users: true,
        },
      },
      users: {
        where: { deletedAt: null, status: 'active' },
        select: { id: true, email: true },
        // Cap at 3 for the compact preview; the total count is on
        // `portalUserCount` (derived below from users.length here,
        // since `take` truncates and _count.users is unfiltered).
        take: 3,
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { name: 'asc' },
  });
  // Second pass to get an accurate active-user count per group. Two
  // small queries are cheaper than joining count-with-filter, and this
  // preserves the anti-pattern #13 distributorId scoping — every group
  // in the list is already tenant-verified, so counting users by
  // groupId + status filter is safe.
  const groupIds = rows.map((r) => r.id);
  const activeCounts = groupIds.length === 0
    ? []
    : await prisma.user.groupBy({
        by: ['groupId'],
        where: { groupId: { in: groupIds }, deletedAt: null, status: 'active' },
        _count: { _all: true },
      });
  const countByGroup = new Map(activeCounts.map((c) => [c.groupId ?? '', c._count._all]));
  return rows.map((r) => ({
    id: r.id,
    distributorId: r.distributorId,
    name: r.name,
    memberCount: r._count.members,
    hasPortalAccess: (countByGroup.get(r.id) ?? 0) > 0,
    portalEmails: r.users.map((u) => u.email),
    portalUserCount: countByGroup.get(r.id) ?? 0,
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
        select: {
          id: true, email: true, firstName: true, lastName: true,
          sourceContactId: true,
          // Feature A follow-up: pull the source-contact + owning-
          // customer names so the admin sees "hq-x@… — Rajesh Kumar
          // (Kinara Property A)" directly on the Portal Access tab.
          // Narrow select — never `include: true`.
          sourceContact: {
            select: {
              name: true,
              customer: { select: { id: true, customerName: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
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
    portalUsers: group.users.map((u) => ({
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      sourceContactId: u.sourceContactId,
      sourceContactName: u.sourceContact?.name ?? null,
      sourceCustomerId: u.sourceContact?.customer?.id ?? null,
      sourceCustomerName: u.sourceContact?.customer?.customerName ?? null,
    })),
  };
}

/**
 * Feature A follow-up (2026-07-15): return every CustomerContact
 * across every member customer of a group, tagged with whether the
 * contact has already been promoted to an HQ login. Powers the
 * "Promote a contact" picker in the Portal Access tab.
 *
 * All contacts stay tenant-scoped via the CustomerGroup → members →
 * customer chain — the outer group is fetched with the distributorId
 * filter first (anti-pattern #13). We do NOT read contacts by
 * `distributorId` because CustomerContact doesn't carry that column;
 * the tenant scope is inherited from the group.
 */
export async function listGroupContacts(
  distributorId: string,
  groupId: string,
): Promise<GroupCandidateContactRow[]> {
  const group = await prisma.customerGroup.findFirst({
    where: { id: groupId, distributorId, deletedAt: null },
    include: {
      members: {
        include: {
          customer: {
            select: {
              id: true, customerName: true, deletedAt: true,
              contacts: {
                select: {
                  id: true, name: true, email: true, phone: true, isPrimary: true,
                  // For each candidate contact: does it already have
                  // an ACTIVE HQ login? Filter on the hqLogins reverse
                  // relation (`take: 1` = existence check).
                  hqLogins: {
                    where: { deletedAt: null, status: 'active' },
                    select: { id: true },
                    take: 1,
                  },
                },
                orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
              },
            },
          },
        },
      },
    },
  });
  if (!group) throw new CustomerGroupError('Group not found', 404);
  const rows: GroupCandidateContactRow[] = [];
  for (const m of group.members) {
    if (m.customer.deletedAt) continue;
    for (const c of m.customer.contacts) {
      rows.push({
        contactId: c.id,
        name: c.name,
        email: c.email,
        phone: c.phone,
        isPrimary: c.isPrimary,
        customerId: m.customer.id,
        customerName: m.customer.customerName,
        hasLogin: c.hqLogins.length > 0,
      });
    }
  }
  return rows;
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
  data: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    sourceContactId?: string;
  },
): Promise<Pick<User, 'id' | 'email' | 'firstName' | 'lastName' | 'role'>> {
  const group = await prisma.customerGroup.findFirst({
    where: { id: groupId, distributorId, deletedAt: null },
    include: {
      members: { select: { customerId: true } },
    },
  });
  if (!group) throw new CustomerGroupError('Group not found', 404);

  // Feature A follow-up (2026-07-15): the "one active HQ per group"
  // guard has been REMOVED. Multiple HQ logins per group are now a
  // legitimate configuration (e.g. Kinara GM + Finance Manager both
  // need visibility). The email-uniqueness guard below is still the
  // safety net against accidentally creating a duplicate login.

  // If the caller passed a sourceContactId, verify it belongs to a
  // contact of one of THIS group's member customers. Rejects out-of-
  // group ids (403) — this is the tenant/group isolation for the
  // contact-picker path.
  if (data.sourceContactId) {
    const memberCustomerIds = group.members.map((m) => m.customerId);
    const contact = await prisma.customerContact.findFirst({
      where: {
        id: data.sourceContactId,
        customerId: { in: memberCustomerIds },
      },
      select: { id: true },
    });
    if (!contact) {
      throw new CustomerGroupError(
        'Source contact is not a contact of any group member',
        403,
      );
    }
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
      sourceContactId: data.sourceContactId ?? null,
      requiresPasswordReset: true,
    },
    select: { id: true, email: true, firstName: true, lastName: true, role: true },
  });
}

/**
 * Feature A follow-up (2026-07-15): revoke ONE specific HQ user by
 * id. Used by the per-row "Revoke" button in the Portal Access tab
 * when a group has multiple HQ logins. Verifies the user belongs to
 * the target group (tenant + group isolation) — passing a userId
 * that isn't part of this group returns 404 (no info leak).
 */
export async function revokePortalUser(
  distributorId: string,
  groupId: string,
  userId: string,
): Promise<{ revokedCount: number }> {
  const group = await prisma.customerGroup.findFirst({
    where: { id: groupId, distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!group) throw new CustomerGroupError('Group not found', 404);

  const user = await prisma.user.findFirst({
    where: {
      id: userId,
      groupId,
      distributorId,
      role: 'customer_hq',
      deletedAt: null,
      status: 'active',
    },
    select: { id: true },
  });
  if (!user) throw new CustomerGroupError('HQ user not found', 404);

  await prisma.user.update({
    where: { id: userId },
    data: { deletedAt: new Date(), status: 'inactive' },
  });
  return { revokedCount: 1 };
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
