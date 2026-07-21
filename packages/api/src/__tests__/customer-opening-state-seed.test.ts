/**
 * 2026-07-21 — Mini-Operator "opening state" customer-onboarding seed.
 *
 * Guards the atomic customer-create-with-seed contract:
 *
 *   T1  Happy path: creates customer + allowlist + empties + OB invoice
 *       + ledger entry + audit marker in ONE transaction. Ledger reader
 *       (getCustomerLedger) emits the "Opening Balance b/f" row at
 *       index 0 with dueAmount = OB amount.
 *   T2  computeCustomerOverdue includes the OB debt when past credit
 *       window (Fix C 2026-06-11).
 *   T3  Non-mini-op tenant sending openingState → 400.
 *   T4  Cross-tenant cylinder-type in allowlist → 400, transaction
 *       fully rolled back (no orphan customer row).
 *   T5  GET /cylinder-types?customerId=... returns only the allowlist
 *       when the customer has ANY allowlist rows; returns all types
 *       for a legacy customer with no rows.
 *   T6  Opening state is ignored on the plain (no-openingState) path —
 *       creates a customer that does NOT have opening_state_seeded_at
 *       set. Backward compat for every existing caller.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { UserRole } from '@gaslink/shared';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken, loginAsDistAdmin } from './helpers.js';
import { getCustomerLedger, computeCustomerOverdue } from '../services/paymentService.js';

const app = createApp();
const RUN_SUFFIX = String(Date.now()).slice(-6);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

// TEST_DATE (2099-12-31) avoids CLAUDE.md anti-pattern #7 on the shared
// dev DB. Everything the OB flow needs (invoice with issue/due date) is
// safely far-future so preflight sweeps never touch it.
const TEST_DATE = '2099-12-31';

interface MiniOpFixture {
  distributorId: string;
  adminToken: string;
  cylinderTypeAId: string;
  cylinderTypeBId: string;
}

async function createMiniOp(codeLetter: string): Promise<MiniOpFixture> {
  const distributor = await prisma.distributor.create({
    data: {
      businessName: `OpeningSeed MiniOp ${codeLetter} ${RUN_SUFFIX}`,
      legalName: `OpeningSeed MiniOp ${codeLetter} ${RUN_SUFFIX}`,
      accountType: 'mini_operator',
      gstMode: 'disabled',
      docCode: `OS${codeLetter}${RUN_SUFFIX.slice(-2)}`,
      state: 'Telangana',
    },
    select: { id: true },
  });
  const passwordHash = await bcrypt.hash('MiniOp@123', 4);
  const user = await prisma.user.create({
    data: {
      email: `openingseed-${codeLetter.toLowerCase()}-${RUN_SUFFIX}@example.com`,
      passwordHash,
      firstName: 'Opening',
      lastName: codeLetter,
      role: 'mini_operator_admin',
      status: 'active',
      distributorId: distributor.id,
      requiresPasswordReset: false,
    },
  });
  const ctA = await prisma.cylinderType.create({
    data: {
      distributorId: distributor.id,
      typeName: '19 KG Commercial',
      capacity: 19,
      unit: 'KG',
      hsnCode: '27111900',
      isActive: true,
    },
    select: { id: true },
  });
  const ctB = await prisma.cylinderType.create({
    data: {
      distributorId: distributor.id,
      typeName: '5 KG Domestic',
      capacity: 5,
      unit: 'KG',
      hsnCode: '27111900',
      isActive: true,
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
    cylinderTypeAId: ctA.id,
    cylinderTypeBId: ctB.id,
  };
}

async function cleanupMiniOp(distributorId: string) {
  try {
    await prisma.customerLedgerEntry.deleteMany({ where: { distributorId } });
    await prisma.invoice.deleteMany({ where: { distributorId } });
    await prisma.customerInventoryBalance.deleteMany({ where: { customer: { distributorId } } });
    await prisma.customerAllowedCylinderType.deleteMany({ where: { customer: { distributorId } } });
    await prisma.customer.deleteMany({ where: { distributorId } });
    await prisma.cylinderType.deleteMany({ where: { distributorId } });
    await prisma.invoiceCounter.deleteMany({ where: { distributorId } });
    await prisma.auditLog.deleteMany({ where: { distributorId } });
    await prisma.user.deleteMany({ where: { distributorId, role: 'mini_operator_admin' } });
    await prisma.distributor.delete({ where: { id: distributorId } });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[opening-seed cleanup]', (err as Error).message);
  }
}

describe('Mini-Operator opening state seed — customer create', () => {
  let miniOp: MiniOpFixture;
  let otherMiniOp: MiniOpFixture;

  beforeAll(async () => {
    miniOp = await createMiniOp('A');
    otherMiniOp = await createMiniOp('B');
  }, 60_000);

  afterAll(async () => {
    await cleanupMiniOp(miniOp.distributorId);
    await cleanupMiniOp(otherMiniOp.distributorId);
  });

  // ─────────────────────────────────────────────────────────────
  describe('T1 — happy path atomic seed', () => {
    it('creates customer + allowlist + empties + OB invoice + ledger row atomically', async () => {
      const res = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T1 Customer ${RUN_SUFFIX}`,
          phone: '+919999900001',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: {
            allowedCylinderTypeIds: [miniOp.cylinderTypeAId, miniOp.cylinderTypeBId],
            empties: [{ cylinderTypeId: miniOp.cylinderTypeAId, qty: 5 }],
            openingBalance: {
              amount: 8500,
              asOfDate: TEST_DATE,
              notes: 'Paper-ledger carry forward',
            },
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.seeded).toMatchObject({
        allowedCylinderTypeCount: 2,
        emptiesRowCount: 1,
      });
      expect(res.body.data.seeded.openingInvoiceId).toBeTruthy();
      const customerId = res.body.data.customerId as string;

      // All 5 side effects landed
      const [allowlist, empties, invoice, ledger, customer] = await Promise.all([
        prisma.customerAllowedCylinderType.findMany({ where: { customerId } }),
        prisma.customerInventoryBalance.findMany({ where: { customerId } }),
        prisma.invoice.findFirst({
          where: { customerId, isOpeningBalance: true },
          select: { id: true, totalAmount: true, outstandingAmount: true, status: true },
        }),
        prisma.customerLedgerEntry.findMany({ where: { customerId } }),
        prisma.customer.findUnique({
          where: { id: customerId },
          select: { openingStateSeededAt: true },
        }),
      ]);
      expect(allowlist).toHaveLength(2);
      expect(empties).toHaveLength(1);
      expect(empties[0].withCustomerQty).toBe(5);
      expect(invoice).not.toBeNull();
      expect(Number(invoice!.totalAmount)).toBe(8500);
      expect(Number(invoice!.outstandingAmount)).toBe(8500);
      expect(ledger).toHaveLength(1);
      expect(Number(ledger[0].amountDelta)).toBe(8500);
      expect(customer?.openingStateSeededAt).not.toBeNull();
    });

    it('ledger reader emits "Opening Balance b/f" as row 0 with correct dueAmount', async () => {
      const customer = await prisma.customer.findFirst({
        where: {
          distributorId: miniOp.distributorId,
          customerName: `T1 Customer ${RUN_SUFFIX}`,
        },
        select: { id: true },
      });
      expect(customer).not.toBeNull();
      const ledger = await getCustomerLedger(miniOp.distributorId, customer!.id);
      expect(ledger.rows.length).toBeGreaterThan(0);
      expect(ledger.rows[0].kind).toBe('opening');
      expect(ledger.rows[0].dueAmount).toBe(8500);
      expect(ledger.summary.openingBalance).toBe(8500);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('T2 — overdue counts OB past credit window', () => {
    it('OB dated far in the past counts as overdue', async () => {
      const oldDate = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
      const res = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T2 Overdue ${RUN_SUFFIX}`,
          phone: '+919999900002',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: {
            openingBalance: {
              amount: 5000,
              asOfDate: oldDate,
            },
          },
        });
      expect(res.status).toBe(201);
      const customerId = res.body.data.customerId as string;
      const overdue = await computeCustomerOverdue(miniOp.distributorId, customerId, new Date());
      expect(overdue).toBe(5000);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('T3 — non-mini-op tenant is rejected', () => {
    it('regular distributor_admin sending openingState → 400', async () => {
      const admin = await loginAsDistAdmin();
      const res = await request(app)
        .post('/api/customers')
        .set(auth(admin.token))
        .send({
          customerName: `T3 Regular ${RUN_SUFFIX}`,
          phone: '+919999900003',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: {
            openingBalance: { amount: 100, asOfDate: TEST_DATE },
          },
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/mini-operator/i);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('T4 — cross-tenant allowlist rejected + full rollback', () => {
    it('rejects otherMiniOp cylinder-type id in miniOp allowlist → 400, no orphan customer', async () => {
      const before = await prisma.customer.count({
        where: { distributorId: miniOp.distributorId, customerName: `T4 Reject ${RUN_SUFFIX}` },
      });
      expect(before).toBe(0);
      const res = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T4 Reject ${RUN_SUFFIX}`,
          phone: '+919999900004',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: {
            allowedCylinderTypeIds: [otherMiniOp.cylinderTypeAId], // cross-tenant
          },
        });
      expect(res.status).toBe(400);
      const after = await prisma.customer.count({
        where: { distributorId: miniOp.distributorId, customerName: `T4 Reject ${RUN_SUFFIX}` },
      });
      expect(after).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('T5 — GET /cylinder-types filters by allowlist', () => {
    it('with-allowlist customer sees only their types; legacy (no rows) sees all', async () => {
      // T1 customer has allowlist rows for BOTH types.
      const t1Customer = await prisma.customer.findFirst({
        where: {
          distributorId: miniOp.distributorId,
          customerName: `T1 Customer ${RUN_SUFFIX}`,
        },
        select: { id: true },
      });
      // Legacy customer (no openingState) — create one:
      const legacyRes = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T5 Legacy ${RUN_SUFFIX}`,
          phone: '+919999900005',
          creditPeriodDays: 30,
          gstRateOverride: 18,
        });
      expect(legacyRes.status).toBe(201);
      const legacyId = legacyRes.body.data.customerId as string;

      // Allowlisted (T1 has BOTH types on allowlist — so should see 2 in
      // this fixture; if we make a customer with only ONE allowlist row
      // we can prove the filter narrows properly).
      const singleTypeRes = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T5 SingleType ${RUN_SUFFIX}`,
          phone: '+919999900006',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: {
            allowedCylinderTypeIds: [miniOp.cylinderTypeAId],
          },
        });
      expect(singleTypeRes.status).toBe(201);
      const singleTypeId = singleTypeRes.body.data.customerId as string;

      // Legacy → all types
      const legacyList = await request(app)
        .get(`/api/cylinder-types?customerId=${legacyId}`)
        .set(auth(miniOp.adminToken));
      expect(legacyList.status).toBe(200);
      expect(legacyList.body.data.cylinderTypes.length).toBe(2);

      // Single-type allowlist → 1 type only
      const singleList = await request(app)
        .get(`/api/cylinder-types?customerId=${singleTypeId}`)
        .set(auth(miniOp.adminToken));
      expect(singleList.status).toBe(200);
      expect(singleList.body.data.cylinderTypes.length).toBe(1);
      expect(singleList.body.data.cylinderTypes[0].cylinderTypeId).toBe(miniOp.cylinderTypeAId);

      // Also assert T1 customer with allowlist=BOTH sees BOTH
      const t1List = await request(app)
        .get(`/api/cylinder-types?customerId=${t1Customer!.id}`)
        .set(auth(miniOp.adminToken));
      expect(t1List.status).toBe(200);
      expect(t1List.body.data.cylinderTypes.length).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('T6 — plain create (no openingState) is unchanged', () => {
    it('creating without openingState leaves opening_state_seeded_at NULL and skips all seeds', async () => {
      const res = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T6 Plain ${RUN_SUFFIX}`,
          phone: '+919999900007',
          creditPeriodDays: 30,
          gstRateOverride: 18,
        });
      expect(res.status).toBe(201);
      expect(res.body.data.seeded).toMatchObject({
        seededAt: null,
        allowedCylinderTypeCount: 0,
        emptiesRowCount: 0,
        openingInvoiceId: null,
      });
      const customerId = res.body.data.customerId as string;
      const [allowlist, empties, invoice, customer] = await Promise.all([
        prisma.customerAllowedCylinderType.count({ where: { customerId } }),
        prisma.customerInventoryBalance.count({ where: { customerId } }),
        prisma.invoice.count({ where: { customerId, isOpeningBalance: true } }),
        prisma.customer.findUnique({
          where: { id: customerId },
          select: { openingStateSeededAt: true },
        }),
      ]);
      expect(allowlist).toBe(0);
      expect(empties).toBe(0);
      expect(invoice).toBe(0);
      expect(customer?.openingStateSeededAt).toBeNull();
    });
  });
});
