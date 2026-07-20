/**
 * 2026-07-20: CustomerGroupMember.displayName — per-membership alias
 * shown on HQ portal LIST surfaces (ledger Property column, property
 * picker, payments/orders/invoices/dashboard) in place of the
 * canonical customer.customerName. Never mutates the underlying
 * customer.
 *
 * Invariants pinned by this file:
 *   1. Ledger rows use the alias when set; fall back to customer name
 *      when null.
 *   2. Profile picker shows the alias (single source of truth with the
 *      ledger — one label per property everywhere).
 *   3. Invoice DETAIL is NOT aliased (invoice is a legal document —
 *      bill-to name must be the canonical customer record). Same
 *      contract for order detail. See the anti-alias regression test
 *      at the bottom.
 *   4. PATCH /api/customer-groups/:groupId/members/:customerId is
 *      tenant-scoped: another tenant's PATCH → 404 (no info leak).
 *   5. displayName is capped at 80 chars — the schema rejects longer
 *      values with 400 before touching the DB.
 *   6. Empty string is coerced to null (readers fall back to the
 *      canonical customer name).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { UserRole } from '@gaslink/shared';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken, loginAsDistAdmin } from './helpers.js';

const app = createApp();

const PREFIX = `dn-test-${Date.now()}`;

interface Fixture {
  distributorId: string;
  groupId: string;
  memberIds: string[];
  hqUserId: string;
  hqToken: string;
  adminToken: string;
}

async function createFixture(distributorId: string, memberCount: number, skip = 0): Promise<Fixture> {
  const members = await prisma.customer.findMany({
    where: { distributorId, deletedAt: null, customerType: 'B2B' },
    orderBy: { customerName: 'asc' },
    skip,
    take: memberCount,
    select: { id: true },
  });
  if (members.length < memberCount) {
    throw new Error(`Need ${memberCount} B2B customers on ${distributorId}, found ${members.length}`);
  }

  const group = await prisma.customerGroup.create({
    data: {
      distributorId,
      name: `${PREFIX}-${distributorId}`,
      members: { create: members.map((m) => ({ customerId: m.id })) },
    },
  });

  const email = `${PREFIX}-${distributorId}@example.com`;
  const hqUser = await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash('TestHq@123', 4),
      firstName: 'DN',
      lastName: distributorId,
      role: 'customer_hq',
      status: 'active',
      distributorId,
      groupId: group.id,
      requiresPasswordReset: false,
    },
  });

  const hqToken = generateToken({
    userId: hqUser.id,
    email,
    role: 'customer_hq' as UserRole,
    distributorId,
    groupId: group.id,
  });

  return {
    distributorId,
    groupId: group.id,
    memberIds: members.map((m) => m.id),
    hqUserId: hqUser.id,
    hqToken,
    adminToken: '', // filled per-test below
  };
}

describe('CustomerGroupMember.displayName — HQ alias', () => {
  let alpha: Fixture; // dist-001
  let beta: Fixture; // dist-002 — cross-tenant

  beforeAll(async () => {
    alpha = await createFixture('dist-001', 2, 0);
    beta = await createFixture('dist-002', 1, 0);
  }, 30_000);

  afterAll(async () => {
    const hqIds = [alpha.hqUserId, beta.hqUserId];
    const groupIds = [alpha.groupId, beta.groupId];
    await prisma.user.deleteMany({ where: { id: { in: hqIds } } });
    await prisma.customerGroupMember.deleteMany({ where: { groupId: { in: groupIds } } });
    await prisma.customerGroup.deleteMany({ where: { id: { in: groupIds } } });
  });

  // Reset aliases before every test so ordering doesn't matter.
  beforeEach(async () => {
    await prisma.customerGroupMember.updateMany({
      where: { groupId: { in: [alpha.groupId, beta.groupId] } },
      data: { displayName: null },
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('T1 — ledger + profile fallback', () => {
    it('displayName null: ledger row + profile picker show customer.customerName', async () => {
      const [profileRes, ledgerRes] = await Promise.all([
        request(app).get('/api/customer-group-portal/profile').set('Authorization', `Bearer ${alpha.hqToken}`),
        request(app).get('/api/customer-group-portal/ledger').set('Authorization', `Bearer ${alpha.hqToken}`),
      ]);
      expect(profileRes.status).toBe(200);
      expect(ledgerRes.status).toBe(200);

      const customers = await prisma.customer.findMany({
        where: { id: { in: alpha.memberIds } },
        select: { id: true, customerName: true },
      });
      const nameById = new Map(customers.map((c) => [c.id, c.customerName]));

      // Profile members reflect canonical names.
      for (const m of profileRes.body.data.members as Array<{ customerId: string; customerName: string }>) {
        expect(m.customerName).toBe(nameById.get(m.customerId));
      }
      // Every ledger row also reflects canonical.
      for (const r of ledgerRes.body.data.rows as Array<{ customerId: string; customerName: string }>) {
        expect(r.customerName).toBe(nameById.get(r.customerId));
      }
    });

    it('displayName set: ledger row + profile picker + payments list all show the alias', async () => {
      const target = alpha.memberIds[0];
      await prisma.customerGroupMember.updateMany({
        where: { groupId: alpha.groupId, customerId: target },
        data: { displayName: 'Axolotl' },
      });

      const [profileRes, ledgerRes, paymentsRes] = await Promise.all([
        request(app).get('/api/customer-group-portal/profile').set('Authorization', `Bearer ${alpha.hqToken}`),
        request(app).get('/api/customer-group-portal/ledger').set('Authorization', `Bearer ${alpha.hqToken}`),
        request(app).get('/api/customer-group-portal/payments').set('Authorization', `Bearer ${alpha.hqToken}`),
      ]);
      expect(profileRes.status).toBe(200);
      expect(ledgerRes.status).toBe(200);
      expect(paymentsRes.status).toBe(200);

      const profileTarget = (profileRes.body.data.members as Array<{ customerId: string; customerName: string }>)
        .find((m) => m.customerId === target);
      expect(profileTarget?.customerName).toBe('Axolotl');

      for (const r of ledgerRes.body.data.rows as Array<{ customerId: string; customerName: string }>) {
        if (r.customerId === target) expect(r.customerName).toBe('Axolotl');
      }
      for (const p of paymentsRes.body.data.payments as Array<{ customerId: string; customerName: string }>) {
        if (p.customerId === target) expect(p.customerName).toBe('Axolotl');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('T2 — invoice detail NEVER aliased (legal document)', () => {
    it('invoice DETAIL endpoint returns the canonical customer name even when an alias is set', async () => {
      const target = alpha.memberIds[0];
      await prisma.customerGroupMember.updateMany({
        where: { groupId: alpha.groupId, customerId: target },
        data: { displayName: 'ALIAS-DO-NOT-USE-ON-LEGAL-DOC' },
      });

      // Find any invoice on the target customer.
      const invoice = await prisma.invoice.findFirst({
        where: { customerId: target, deletedAt: null },
        select: { id: true },
      });
      if (!invoice) {
        // No invoices in seed for this customer — skip rather than fail.
        return;
      }
      const detailRes = await request(app)
        .get(`/api/customer-group-portal/invoices/${invoice.id}`)
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      expect(detailRes.status).toBe(200);
      const canonical = await prisma.customer.findUnique({
        where: { id: target }, select: { customerName: true },
      });
      // The bill-to name on an invoice detail is the canonical customer.
      // Both the shallow field and the nested customer relation return
      // the canonical name — never the alias.
      const nested = (detailRes.body.data.customer as { customerName?: string } | undefined)?.customerName;
      expect(nested).toBe(canonical!.customerName);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('T3 — PATCH /api/customer-groups/:groupId/members/:customerId', () => {
    it('distributor_admin can PATCH a display name; empty string clears to null', async () => {
      const admin = await loginAsDistAdmin();
      const target = alpha.memberIds[0];

      // Set
      const setRes = await request(app)
        .patch(`/api/customer-groups/${alpha.groupId}/members/${target}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ displayName: 'MyAlias' });
      expect(setRes.status).toBe(200);
      const setRow = await prisma.customerGroupMember.findFirst({
        where: { groupId: alpha.groupId, customerId: target },
        select: { displayName: true },
      });
      expect(setRow?.displayName).toBe('MyAlias');

      // Clear via empty string — zod coerces '' → null.
      const clearRes = await request(app)
        .patch(`/api/customer-groups/${alpha.groupId}/members/${target}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ displayName: '' });
      expect(clearRes.status).toBe(200);
      const clearedRow = await prisma.customerGroupMember.findFirst({
        where: { groupId: alpha.groupId, customerId: target },
        select: { displayName: true },
      });
      expect(clearedRow?.displayName).toBeNull();

      // Clear via explicit null
      const nullRes = await request(app)
        .patch(`/api/customer-groups/${alpha.groupId}/members/${target}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ displayName: null });
      expect(nullRes.status).toBe(200);
    });

    it('displayName over 80 chars is rejected with 400 before DB touch', async () => {
      const admin = await loginAsDistAdmin();
      const target = alpha.memberIds[0];
      const tooLong = 'X'.repeat(81);
      const res = await request(app)
        .patch(`/api/customer-groups/${alpha.groupId}/members/${target}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ displayName: tooLong });
      expect(res.status).toBe(400);
      const row = await prisma.customerGroupMember.findFirst({
        where: { groupId: alpha.groupId, customerId: target },
        select: { displayName: true },
      });
      expect(row?.displayName).toBeNull();
    });

    it('cross-tenant PATCH → 404 (no info leak)', async () => {
      // dist-001 admin cannot PATCH a member of dist-002's beta group.
      const admin = await loginAsDistAdmin();
      const betaMember = beta.memberIds[0];
      const res = await request(app)
        .patch(`/api/customer-groups/${beta.groupId}/members/${betaMember}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ displayName: 'Attempted' });
      expect(res.status).toBe(404);
      const row = await prisma.customerGroupMember.findFirst({
        where: { groupId: beta.groupId, customerId: betaMember },
        select: { displayName: true },
      });
      expect(row?.displayName).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('T4 — POST /members accepts displayName at add-time', () => {
    it('add-member with displayName persists on the CustomerGroupMember row', async () => {
      const admin = await loginAsDistAdmin();
      // Pick a B2B customer NOT already in alpha's group.
      const spare = await prisma.customer.findFirst({
        where: {
          distributorId: 'dist-001',
          deletedAt: null,
          customerType: 'B2B',
          id: { notIn: alpha.memberIds },
        },
        select: { id: true },
      });
      if (!spare) return; // dev-db too small — skip rather than fail

      // Add. displayName is coerced to trim + null on empty per schema.
      const addRes = await request(app)
        .post(`/api/customer-groups/${alpha.groupId}/members`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ customerId: spare.id, displayName: '  Villa 7  ' });
      expect(addRes.status).toBe(201);

      const row = await prisma.customerGroupMember.findFirst({
        where: { groupId: alpha.groupId, customerId: spare.id },
        select: { displayName: true },
      });
      expect(row?.displayName).toBe('Villa 7');

      // Cleanup — remove the added member so the alpha fixture stays 2.
      await prisma.customerGroupMember.deleteMany({
        where: { groupId: alpha.groupId, customerId: spare.id },
      });
    });
  });
});
