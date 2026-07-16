/**
 * Mini-Operator (2026-07-16) — invariant + wire-shape tests.
 *
 * Complements mini-operator-scenarios.test.ts:
 *   - scenarios: end-to-end happy paths (S1–S8)
 *   - this file: invariant guards + edge cases that don't warrant a full
 *     scenario walk (see also anti-pattern-guards.test.ts for the
 *     wire-shape guards on cross-tenant + role escalation surfaces).
 *
 * TEST_DATE avoids anti-pattern #7 (time-sensitive fixtures on the shared
 * dev DB).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { UserRole } from '@gaslink/shared';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken, loginAsSuperAdmin, loginAsDistAdmin } from './helpers.js';

const app = createApp();
const RUN_SUFFIX = String(Date.now()).slice(-6);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

interface MiniOpFixture {
  distributorId: string;
  adminToken: string;
  cylinderTypeId: string;
  customerId: string;
}

async function createFixture(codeLetter: string): Promise<MiniOpFixture> {
  const lastDigit = Number(RUN_SUFFIX.slice(-1));
  const letter = String.fromCharCode('A'.charCodeAt(0) + (Number.isFinite(lastDigit) ? lastDigit : 0));
  const docCode = `Q${codeLetter}${letter}`; // Q-prefix to avoid collision with scenarios' M-prefix

  const distributor = await prisma.distributor.create({
    data: {
      businessName: `MiniOp Guard ${codeLetter} ${RUN_SUFFIX}`,
      legalName: `MiniOp Guard ${codeLetter} ${RUN_SUFFIX}`,
      accountType: 'mini_operator',
      gstMode: 'disabled',
      docCode,
      state: 'Telangana',
    },
    select: { id: true },
  });

  const passwordHash = await bcrypt.hash('MiniOp@123', 4);
  const user = await prisma.user.create({
    data: {
      email: `miniop-guard-${codeLetter.toLowerCase()}-${RUN_SUFFIX}@example.com`,
      passwordHash,
      firstName: 'Guard',
      lastName: codeLetter,
      role: 'mini_operator_admin',
      status: 'active',
      distributorId: distributor.id,
      requiresPasswordReset: false,
    },
  });

  const cylinderType = await prisma.cylinderType.create({
    data: {
      distributorId: distributor.id,
      typeName: '19KG Commercial',
      capacity: 19,
      unit: 'KG',
      hsnCode: '27111900',
      isActive: true,
    },
    select: { id: true },
  });

  const customer = await prisma.customer.create({
    data: {
      distributorId: distributor.id,
      customerName: `Guard Customer ${codeLetter} ${RUN_SUFFIX}`,
      customerType: 'B2C',
      phone: '+919999999998',
      status: 'active',
      creditPeriodDays: 30,
      billingState: 'Telangana',
    },
    select: { id: true },
  });

  const adminToken = generateToken({
    userId: user.id,
    email: user.email,
    role: 'mini_operator_admin' as UserRole,
    distributorId: distributor.id,
  });

  return {
    distributorId: distributor.id,
    adminToken,
    cylinderTypeId: cylinderType.id,
    customerId: customer.id,
  };
}

async function cleanupFixture(distributorId: string): Promise<void> {
  try {
    await prisma.inventoryEvent.deleteMany({ where: { distributorId } });
    await prisma.inventorySummary.deleteMany({ where: { distributorId } });
    await prisma.purchaseEntryItem.deleteMany({ where: { purchaseEntry: { distributorId } } });
    await prisma.purchaseEntry.deleteMany({ where: { distributorId } });
    await prisma.sourceDistributor.deleteMany({ where: { distributorId } });
    await prisma.orderItem.deleteMany({ where: { order: { distributorId } } });
    await prisma.orderStatusLog.deleteMany({ where: { order: { distributorId } } });
    await prisma.invoiceItem.deleteMany({ where: { invoice: { distributorId } } });
    await prisma.invoice.deleteMany({ where: { distributorId } });
    await prisma.order.deleteMany({ where: { distributorId } });
    await prisma.customerInventoryBalance.deleteMany({ where: { customer: { distributorId } } });
    await prisma.customerCylinderDiscount.deleteMany({ where: { customer: { distributorId } } });
    await prisma.customerLedgerEntry.deleteMany({ where: { distributorId } });
    await prisma.customerGroupMember.deleteMany({ where: { customer: { distributorId } } });
    await prisma.customer.deleteMany({ where: { distributorId } });
    await prisma.cylinderType.deleteMany({ where: { distributorId } });
    await prisma.invoiceCounter.deleteMany({ where: { distributorId } });
    await prisma.auditLog.deleteMany({ where: { distributorId } });
    await prisma.user.deleteMany({ where: { distributorId, role: 'mini_operator_admin' } });
    await prisma.distributor.delete({ where: { id: distributorId } });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[guard cleanup]', (err as Error).message);
  }
}

describe('Mini-Operator — invariants + wire shapes', () => {
  let fixture: MiniOpFixture;
  let superToken: string;

  beforeAll(async () => {
    superToken = (await loginAsSuperAdmin()).token;
    const stale = await prisma.distributor.findMany({
      where: {
        accountType: 'mini_operator',
        businessName: { startsWith: 'MiniOp Guard ' },
      },
      select: { id: true },
    });
    for (const d of stale) await cleanupFixture(d.id);
    fixture = await createFixture('A');
  });

  afterAll(async () => {
    await cleanupFixture(fixture.distributorId);
  });

  // ─── AccountType invariants ──────────────────────────────────────────────

  describe('AccountType default + updateDistributor guard', () => {
    it('every seeded existing distributor has accountType=distributor (migration backfill)', async () => {
      const rows = await prisma.distributor.findMany({
        where: { businessName: { in: ['Bhargava Gas Agency', 'Sharma Gas Distributors'] } },
        select: { businessName: true, accountType: true },
      });
      for (const r of rows) {
        expect(r.accountType).toBe('distributor');
      }
    });

    it('PUT /api/distributors/:id flipping to mini_operator when gstMode!=disabled → 400', async () => {
      // Create a fresh regular distributor on sandbox gstMode then try to flip.
      const dist = await prisma.distributor.create({
        data: {
          businessName: `Guard PUT ${RUN_SUFFIX}`,
          legalName: `Guard PUT ${RUN_SUFFIX}`,
          gstMode: 'sandbox',
          isTestTenant: true, // sandbox precondition
          state: 'Telangana',
        },
      });
      try {
        const res = await request(app)
          .put(`/api/distributors/${dist.id}`)
          .set(auth(superToken))
          .send({ accountType: 'mini_operator' });
        expect(res.status).toBe(400);
        // sendError writes only the message + status; the DistributorError.code
        // ('MINI_OPERATOR_REQUIRES_GST_DISABLED') is not surfaced by the current
        // envelope. Assert the human-readable message instead — it's the
        // single visible contract for a UI toast.
        expect(res.body.error).toMatch(/mini-operator/i);
        expect(res.body.error).toMatch(/GST/);
      } finally {
        await prisma.distributor.delete({ where: { id: dist.id } });
      }
    });

    it('non-super-admin PUT strips accountType from the body (defense-in-depth)', async () => {
      // distributor_admin on dist-001 tries to sneak accountType into a self-PUT.
      // Route already requires super_admin, so the request should 403 — but the
      // strip guarantees that even if the requireRole ever loosens (e.g. we
      // add distributor_admin to the allowlist for a legitimate reason), the
      // accountType field STILL cannot be set. Assert the current 403 shape.
      const distAdmin = await loginAsDistAdmin();
      const res = await request(app)
        .put('/api/distributors/dist-001')
        .set(auth(distAdmin.token))
        .send({ accountType: 'mini_operator', businessName: 'ATTEMPT' });
      expect(res.status).toBe(403);
      // Also verify the row was NOT changed as a safety net.
      const after = await prisma.distributor.findUnique({
        where: { id: 'dist-001' },
        select: { accountType: true, businessName: true },
      });
      expect(after?.accountType).toBe('distributor');
      expect(after?.businessName).not.toBe('ATTEMPT');
    });
  });

  // ─── GST activation guard ────────────────────────────────────────────────

  describe('GST activation refuses mini-operator', () => {
    it('POST /api/admin/distributors/:id/gst/activate → MINI_OPERATOR_NO_GST', async () => {
      await prisma.distributor.update({
        where: { id: fixture.distributorId },
        data: { gstin: '36AAAAA1234A1Z5' },
      });
      const res = await request(app)
        .post(`/api/admin/distributors/${fixture.distributorId}/gst/activate`)
        .set(auth(superToken))
        .send({
          mode: 'sandbox',
          einvoice: {
            clientId: 'x',
            clientSecret: 'x',
            username: 'x',
            password: 'x',
            gstin: '36AAAAA1234A1Z5',
          },
          ewaybill: 'same_as_einvoice',
          reason: 'new_distributor_activation',
        });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body)).toContain('MINI_OPERATOR_NO_GST');
    });
  });

  // ─── Order short-circuit ─────────────────────────────────────────────────

  describe('createOrder short-circuit for mini-operator', () => {
    it('mini-op order lands in pending_delivery immediately, driverId=null', async () => {
      const res = await request(app)
        .post('/api/orders')
        .set(auth(fixture.adminToken))
        .send({
          customerId: fixture.customerId,
          deliveryDate: '2099-12-31',
          driverNameFreeText: 'GuardDriver',
          items: [{ cylinderTypeId: fixture.cylinderTypeId, quantity: 1 }],
        });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('pending_delivery');
      expect(res.body.data.driverId).toBeNull();
      expect(res.body.data.driverNameFreeText).toBe('GuardDriver');
    });
  });

  // ─── numberingService 'P' allocator ──────────────────────────────────────

  describe('purchase number allocator uses per-tenant + per-year counter', () => {
    it('two purchase entries increment sequentially (000001 → 000002)', async () => {
      // Fresh source distributor for the tenant.
      const src = await request(app)
        .post('/api/source-distributors')
        .set(auth(fixture.adminToken))
        .send({ name: `Guard-Src-${RUN_SUFFIX}` });
      expect(src.status).toBe(201);

      const one = await request(app)
        .post('/api/purchase-entries')
        .set(auth(fixture.adminToken))
        .send({
          sourceDistributorId: src.body.data.id,
          purchaseDate: '2099-12-31',
          items: [{ cylinderTypeId: fixture.cylinderTypeId, fullsReceived: 1, emptiesGivenOut: 0 }],
        });
      expect(one.status).toBe(201);
      const two = await request(app)
        .post('/api/purchase-entries')
        .set(auth(fixture.adminToken))
        .send({
          sourceDistributorId: src.body.data.id,
          purchaseDate: '2099-12-31',
          items: [{ cylinderTypeId: fixture.cylinderTypeId, fullsReceived: 1, emptiesGivenOut: 0 }],
        });
      expect(two.status).toBe(201);

      // Both numbers must share the P + docCode + FY prefix and differ by 1 in
      // the trailing 6-digit sequence.
      const rx = /^P(.{3})(\d{4})(\d{6})$/;
      const m1 = rx.exec(one.body.data.purchaseNumber);
      const m2 = rx.exec(two.body.data.purchaseNumber);
      expect(m1).not.toBeNull();
      expect(m2).not.toBeNull();
      expect(m1![1]).toBe(m2![1]); // same docCode
      expect(m1![2]).toBe(m2![2]); // same financial year
      expect(Number(m2![3]) - Number(m1![3])).toBe(1);
    });
  });

  // ─── Wire-shape guards ───────────────────────────────────────────────────

  describe('wire-shape guards — anti-pattern #9', () => {
    it('GET /api/source-distributors returns an array (not { data: { rows: [] } })', async () => {
      const res = await request(app)
        .get('/api/source-distributors')
        .set(auth(fixture.adminToken));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('GET /api/purchase-entries returns { purchaseEntries, meta }', async () => {
      const res = await request(app)
        .get('/api/purchase-entries')
        .set(auth(fixture.adminToken));
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('purchaseEntries');
      expect(Array.isArray(res.body.data.purchaseEntries)).toBe(true);
      expect(res.body.data).toHaveProperty('meta');
      expect(res.body.data.meta).toHaveProperty('page');
      expect(res.body.data.meta).toHaveProperty('pageSize');
      expect(res.body.data.meta).toHaveProperty('total');
    });

    it('order response includes driverNameFreeText field (null OK, undefined NOT)', async () => {
      const res = await request(app)
        .post('/api/orders')
        .set(auth(fixture.adminToken))
        .send({
          customerId: fixture.customerId,
          deliveryDate: '2099-12-31',
          items: [{ cylinderTypeId: fixture.cylinderTypeId, quantity: 1 }],
        });
      expect(res.status).toBe(201);
      expect(res.body.data).toHaveProperty('driverNameFreeText');
      // Without the input, the field is null (trim+null-fold at the service).
      expect(res.body.data.driverNameFreeText).toBeNull();
    });
  });
});
