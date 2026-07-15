/**
 * Feature A (2026-07-15): HQ Portal integration tests.
 *
 * Covers three isolation walls (all must hold; each has a dedicated
 * describe block):
 *   1. Role gate — only customer_hq can hit /api/customer-group-portal;
 *      customer_hq CANNOT hit /api/customer-portal (Razorpay money flow).
 *   2. Method guard — router 405s any non-GET method.
 *   3. Tenant + group isolation (anti-pattern #13) — a customer_hq
 *      user's queries return only rows where (distributorId, customerId)
 *      is in their group; cross-tenant / cross-group access → 403/404.
 *
 * Fixture strategy: creates 3 groups spanning 2 distributors —
 *   • dist-001 groupAlpha: 2 members (both dist-001 B2B customers)
 *   • dist-002 groupBeta:  2 members (both dist-002 B2B customers)
 *   • dist-001 groupGamma: 1 member  (same tenant as Alpha, disjoint
 *     customer set — used to prove same-tenant cross-group isolation)
 *
 * Each group has its own customer_hq user. All fixtures are cleaned
 * up in afterAll. Named with an `hq-test-` prefix so a partial cleanup
 * failure is easy to spot and manually clear.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { UserRole } from '@gaslink/shared';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken, loginAsDistAdmin, loginAsFinance, loginAsInventory, loginAsCustomer, loginAsDriver, loginAsSuperAdmin } from './helpers.js';

const app = createApp();

interface HqFixture {
  groupId: string;
  distributorId: string;
  memberIds: string[];
  hqUserId: string;
  hqToken: string;
}

async function createHqFixture(
  distributorId: string,
  namePrefix: string,
  memberCount: number,
  // Skip the first N B2B customers when picking members. Lets two
  // fixtures on the same tenant (alpha + gamma) hold DISJOINT member
  // sets so the same-tenant-different-group isolation test is meaningful.
  skip = 0,
): Promise<HqFixture> {
  // Pick N existing B2B customers on this distributor — they already
  // have orders / invoices / ledger entries from the main seed +
  // running dev-DB data, so the portal endpoints return real shapes.
  const members = await prisma.customer.findMany({
    where: {
      distributorId,
      deletedAt: null,
      customerType: 'B2B',
    },
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
      name: `hq-test-${namePrefix}-${Date.now()}`,
      members: {
        create: members.map((m) => ({ customerId: m.id })),
      },
    },
  });

  const email = `hq-test-${namePrefix}-${Date.now()}@example.com`;
  const passwordHash = await bcrypt.hash('TestHq@123', 4);
  const hqUser = await prisma.user.create({
    data: {
      email,
      passwordHash,
      firstName: 'Test',
      lastName: `HQ ${namePrefix}`,
      role: 'customer_hq',
      status: 'active',
      distributorId,
      groupId: group.id,
      requiresPasswordReset: false,
    },
  });

  const hqToken = generateToken({
    userId: hqUser.id,
    email: hqUser.email,
    role: 'customer_hq' as UserRole,
    distributorId,
    groupId: group.id,
  });

  return {
    groupId: group.id,
    distributorId,
    memberIds: members.map((m) => m.id),
    hqUserId: hqUser.id,
    hqToken,
  };
}

describe('HQ Portal — Feature A', () => {
  let alpha: HqFixture;  // dist-001
  let beta: HqFixture;   // dist-002 — cross-tenant
  let gamma: HqFixture;  // dist-001 — same tenant, different group

  beforeAll(async () => {
    alpha = await createHqFixture('dist-001', 'alpha', 2, 0);
    beta = await createHqFixture('dist-002', 'beta', 2, 0);
    // gamma skips the first 2 dist-001 B2B customers so alpha ∩ gamma
    // members = ∅. Without the skip both fixtures would pick the same
    // top-of-list customers and same-tenant isolation tests would be
    // trivially violated by shared data.
    gamma = await createHqFixture('dist-001', 'gamma', 1, 2);
  }, 30_000);

  afterAll(async () => {
    // Order matters: delete fixture HQ users first (they have FK to
    // group), then group members, then groups themselves.
    const hqUserIds = [alpha, beta, gamma].map((f) => f.hqUserId);
    const groupIds = [alpha, beta, gamma].map((f) => f.groupId);
    await prisma.user.deleteMany({ where: { id: { in: hqUserIds } } });
    await prisma.customerGroupMember.deleteMany({ where: { groupId: { in: groupIds } } });
    await prisma.customerGroup.deleteMany({ where: { id: { in: groupIds } } });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('T1 — Role gates', () => {
    it('customer_hq can GET /customer-group-portal/dashboard', async () => {
      const res = await request(app)
        .get('/api/customer-group-portal/dashboard')
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('properties');
    });

    // NON-NEGOTIABLE per plan: customer_hq must NOT reach the Razorpay-
    // bearing /api/customer-portal router. The customer_hq role isn't
    // in requireRole('customer'), so the gate is authoritative here.
    it('customer_hq CANNOT reach /api/customer-portal/dashboard', async () => {
      const res = await request(app)
        .get('/api/customer-portal/dashboard')
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      expect(res.status).toBe(403);
    });

    it('customer role CANNOT reach /api/customer-group-portal', async () => {
      const { token } = await loginAsCustomer();
      const res = await request(app)
        .get('/api/customer-group-portal/dashboard')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('distributor_admin CANNOT reach /api/customer-group-portal', async () => {
      const { token } = await loginAsDistAdmin();
      const res = await request(app)
        .get('/api/customer-group-portal/dashboard')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('finance CANNOT reach /api/customer-group-portal', async () => {
      const { token } = await loginAsFinance();
      const res = await request(app)
        .get('/api/customer-group-portal/dashboard')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('inventory CANNOT reach /api/customer-group-portal', async () => {
      const { token } = await loginAsInventory();
      const res = await request(app)
        .get('/api/customer-group-portal/dashboard')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('driver CANNOT reach /api/customer-group-portal', async () => {
      const { token } = await loginAsDriver();
      const res = await request(app)
        .get('/api/customer-group-portal/dashboard')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('unauthenticated request → 401', async () => {
      const res = await request(app).get('/api/customer-group-portal/dashboard');
      expect(res.status).toBe(401);
    });

    it('customer_hq whose DB row has no groupId → 403', async () => {
      // `authenticate` re-reads groupId from the DB row (not the JWT
      // claim) — a defence-in-depth pattern that lets a group change
      // take effect immediately. So the guarantee we're testing is
      // "no groupId on the User row → requireGroupAccess blocks",
      // NOT "no groupId in the token". Create a throwaway user with
      // groupId=null for this test only.
      const orphan = await prisma.user.create({
        data: {
          email: `hq-orphan-${Date.now()}@example.com`,
          passwordHash: await bcrypt.hash('x', 4),
          firstName: 'Orphan', lastName: 'HQ',
          role: 'customer_hq',
          status: 'active',
          distributorId: 'dist-001',
          groupId: null,
          requiresPasswordReset: false,
        },
      });
      try {
        const token = generateToken({
          userId: orphan.id,
          email: orphan.email,
          role: 'customer_hq' as UserRole,
          distributorId: 'dist-001',
          groupId: null,
        });
        const res = await request(app)
          .get('/api/customer-group-portal/dashboard')
          .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
      } finally {
        await prisma.user.delete({ where: { id: orphan.id } });
      }
    });

    it('customer_hq CANNOT reach admin /api/orders', async () => {
      const res = await request(app)
        .get('/api/orders')
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      expect(res.status).toBe(403);
    });

    it('customer_hq CANNOT reach admin /api/invoices', async () => {
      const res = await request(app)
        .get('/api/invoices')
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      expect(res.status).toBe(403);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('T2 — Method guard (405 on non-GET)', () => {
    it('POST /customer-group-portal/dashboard → 405', async () => {
      const res = await request(app)
        .post('/api/customer-group-portal/dashboard')
        .set('Authorization', `Bearer ${alpha.hqToken}`)
        .send({});
      expect(res.status).toBe(405);
      expect(res.body.code).toBe('METHOD_NOT_ALLOWED');
    });

    it('PUT /customer-group-portal/orders → 405', async () => {
      const res = await request(app)
        .put('/api/customer-group-portal/orders')
        .set('Authorization', `Bearer ${alpha.hqToken}`)
        .send({});
      expect(res.status).toBe(405);
    });

    it('DELETE /customer-group-portal/invoices → 405', async () => {
      const res = await request(app)
        .delete('/api/customer-group-portal/invoices')
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      expect(res.status).toBe(405);
    });

    it('PATCH /customer-group-portal/profile → 405', async () => {
      const res = await request(app)
        .patch('/api/customer-group-portal/profile')
        .set('Authorization', `Bearer ${alpha.hqToken}`)
        .send({});
      expect(res.status).toBe(405);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('T3 — Tenant isolation (anti-pattern #13)', () => {
    it('dashboard.properties only lists own-tenant customers', async () => {
      const res = await request(app)
        .get('/api/customer-group-portal/dashboard')
        .set('Authorization', `Bearer ${beta.hqToken}`);
      expect(res.status).toBe(200);
      const propertyIds: string[] = res.body.data.properties.map((p: { customerId: string }) => p.customerId);
      // beta is dist-002 — its properties MUST match its member set exactly.
      expect(new Set(propertyIds)).toEqual(new Set(beta.memberIds));
      // AND must NOT include any of alpha's members (dist-001).
      for (const alphaMemberId of alpha.memberIds) {
        expect(propertyIds).not.toContain(alphaMemberId);
      }
    });

    it('cannot fetch an order belonging to a different tenant → 404', async () => {
      // Find any order belonging to a dist-002 customer.
      const otherTenantOrder = await prisma.order.findFirst({
        where: { distributorId: 'dist-002', deletedAt: null },
        select: { id: true },
      });
      if (!otherTenantOrder) return; // dev DB may not have any yet — skip silently
      const res = await request(app)
        .get(`/api/customer-group-portal/orders/${otherTenantOrder.id}`)
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      // alpha is dist-001; the order is dist-002. Must be 404 (no
      // info-leak — same shape as any tenant miss).
      expect(res.status).toBe(404);
    });

    it('cannot fetch an invoice belonging to a different tenant → 404', async () => {
      const otherTenantInvoice = await prisma.invoice.findFirst({
        where: { distributorId: 'dist-002', deletedAt: null },
        select: { id: true },
      });
      if (!otherTenantInvoice) return;
      const res = await request(app)
        .get(`/api/customer-group-portal/invoices/${otherTenantInvoice.id}`)
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('T4 — Group isolation (same tenant, different group)', () => {
    it('groupAlpha HQ cannot see groupGamma members in the dashboard', async () => {
      const res = await request(app)
        .get('/api/customer-group-portal/dashboard')
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      expect(res.status).toBe(200);
      const propertyIds: string[] = res.body.data.properties.map((p: { customerId: string }) => p.customerId);
      for (const gammaMemberId of gamma.memberIds) {
        expect(propertyIds).not.toContain(gammaMemberId);
      }
    });

    it('specifying ?customerId= for a customer outside the group → 403', async () => {
      // Alpha (dist-001, groupAlpha) tries to filter for gamma's
      // customerId (dist-001, groupGamma — same tenant, disjoint group).
      const res = await request(app)
        .get(`/api/customer-group-portal/orders?customerId=${gamma.memberIds[0]}`)
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      expect(res.status).toBe(403);
    });

    it('specifying ?customerId= for a customer that IS in the group → 200', async () => {
      const res = await request(app)
        .get(`/api/customer-group-portal/orders?customerId=${alpha.memberIds[0]}`)
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      expect(res.status).toBe(200);
    });

    it('cross-tenant customerId filter → 403 (never 404)', async () => {
      const res = await request(app)
        .get(`/api/customer-group-portal/invoices?customerId=${beta.memberIds[0]}`)
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      // 403 because the guard fires on visibleCustomerIds BEFORE any
      // DB lookup — no info leak on whether the customer exists.
      expect(res.status).toBe(403);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('T5 — Wire-shape guards (anti-pattern #9)', () => {
    it('dashboard has the documented shape', async () => {
      const res = await request(app)
        .get('/api/customer-group-portal/dashboard')
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d).toHaveProperty('totalOutstanding');
      expect(d).toHaveProperty('totalOverdue');
      expect(d).toHaveProperty('cylindersThisMonth');
      expect(d).toHaveProperty('aging');
      expect(d.aging).toHaveProperty('bucket0_30');
      expect(d.aging).toHaveProperty('bucket31_60');
      expect(d.aging).toHaveProperty('bucket60plus');
      expect(Array.isArray(d.properties)).toBe(true);
    });

    it('orders has {orders[], meta}', async () => {
      const res = await request(app)
        .get('/api/customer-group-portal/orders')
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.orders)).toBe(true);
      expect(res.body.data.meta).toHaveProperty('page');
      expect(res.body.data.meta).toHaveProperty('totalPages');
    });

    it('invoices has {invoices[], meta}', async () => {
      const res = await request(app)
        .get('/api/customer-group-portal/invoices')
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.invoices)).toBe(true);
      expect(res.body.data.meta).toHaveProperty('total');
    });

    it('ledger has {rows[], totals{totalDebited,totalReceived,netOutstanding}}', async () => {
      const res = await request(app)
        .get('/api/customer-group-portal/ledger')
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(Array.isArray(d.rows)).toBe(true);
      expect(d.totals).toHaveProperty('totalDebited');
      expect(d.totals).toHaveProperty('totalReceived');
      expect(d.totals).toHaveProperty('netOutstanding');
    });

    it('payments has {payments[], meta}', async () => {
      const res = await request(app)
        .get('/api/customer-group-portal/payments')
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.payments)).toBe(true);
    });

    it('aging returns {rows[], columns[]}', async () => {
      const res = await request(app)
        .get('/api/customer-group-portal/aging')
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.rows)).toBe(true);
      expect(Array.isArray(res.body.data.columns)).toBe(true);
    });

    it('profile has {group, distributor, members[]}', async () => {
      const res = await request(app)
        .get('/api/customer-group-portal/profile')
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.group).toHaveProperty('id', alpha.groupId);
      expect(d.group).toHaveProperty('name');
      expect(d.distributor).toHaveProperty('businessName');
      expect(Array.isArray(d.members)).toBe(true);
      expect(d.members.length).toBe(alpha.memberIds.length);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('T6 — PDF endpoints', () => {
    it('/ledger/pdf returns application/pdf 200', async () => {
      const res = await request(app)
        .get('/api/customer-group-portal/ledger/pdf')
        .set('Authorization', `Bearer ${alpha.hqToken}`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      // PDF magic number %PDF
      expect((res.body as Buffer).slice(0, 4).toString()).toBe('%PDF');
    });

    it('/invoices/:id/pdf returns 404 for cross-tenant invoice', async () => {
      const otherTenantInvoice = await prisma.invoice.findFirst({
        where: { distributorId: 'dist-002', deletedAt: null },
        select: { id: true },
      });
      if (!otherTenantInvoice) return;
      const res = await request(app)
        .get(`/api/customer-group-portal/invoices/${otherTenantInvoice.id}/pdf`)
        .set('Authorization', `Bearer ${alpha.hqToken}`);
      expect(res.status).toBe(404);
    });

    it('/invoices/:id/pdf returns application/pdf 200 for own invoice', async () => {
      // Find any invoice belonging to alpha's group.
      const own = await prisma.invoice.findFirst({
        where: {
          distributorId: 'dist-001',
          customerId: { in: alpha.memberIds },
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!own) return; // no invoices for alpha members yet
      const res = await request(app)
        .get(`/api/customer-group-portal/invoices/${own.id}/pdf`)
        .set('Authorization', `Bearer ${alpha.hqToken}`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('T7 — CustomerGroup admin CRUD + isolation', () => {
    it('distributor_admin can list own-tenant groups', async () => {
      const { token } = await loginAsDistAdmin();
      const res = await request(app)
        .get('/api/customer-groups')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      const ids: string[] = res.body.data.groups.map((g: { id: string }) => g.id);
      // Must include alpha (dist-001) but NOT beta (dist-002).
      expect(ids).toContain(alpha.groupId);
      expect(ids).not.toContain(beta.groupId);
    });

    it('distributor_admin CANNOT GET a group in another tenant → 404', async () => {
      const { token } = await loginAsDistAdmin();
      const res = await request(app)
        .get(`/api/customer-groups/${beta.groupId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    it('driver role CANNOT list groups', async () => {
      const { token } = await loginAsDriver();
      const res = await request(app)
        .get('/api/customer-groups')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('super_admin can see groups across tenants when x-distributor-id is set', async () => {
      const { token } = await loginAsSuperAdmin();
      const res = await request(app)
        .get('/api/customer-groups')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Distributor-Id', 'dist-002');
      expect(res.status).toBe(200);
      const ids: string[] = res.body.data.groups.map((g: { id: string }) => g.id);
      expect(ids).toContain(beta.groupId);
      // But not alpha — X-Distributor-Id was 'dist-002'.
      expect(ids).not.toContain(alpha.groupId);
    });
  });
});
