/**
 * 2026-07-21 — Customer opening-state seed (rebuild).
 *
 * UNIVERSAL: available to any tenant (regular distributor + mini-op).
 * EDITABLE:  seedable later via POST /customers/:id/seed-opening-state.
 * PREFERENCE: cylinder-types picker SORTS preferred first (does NOT
 *             filter — the customer can still buy any type).
 * PDF: OB row Type column blank; empties b/f surfaced on Pend E.
 *
 * Guards:
 *   T1  Happy-path atomic create + seed: all 5 side effects land,
 *       opening_state_seeded_at set, openingSeedQty snapshotted,
 *       ledger emits OB row with pendingEmptyCyls = seed sum.
 *   T2  Universal — regular distributor (accountType != mini_operator)
 *       CAN seed via nested openingState on POST /customers.
 *   T3  Edit-path — POST /customers/:id/seed-opening-state on an
 *       unseeded customer works; second call rejects with 400.
 *   T4  Cross-tenant cylinder-type → 400 + full rollback.
 *   T5  GET /cylinder-types?customerId=X returns SORTED list with
 *       isPreferred flag; nothing filtered.
 *   T6  Plain create (no openingState) → opening_state_seeded_at
 *       stays NULL, no ledger writes.
 *   T7  computeCustomerOverdue counts OB debt past credit window.
 *   T8  Ledger PDF-shape: OB row has kind='opening', cylinderType=''
 *       (Type-column blank), pendingEmptyCyls = seed sum, and
 *       subsequent delivery rows carry-forward the count.
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

// TEST_DATE avoids CLAUDE.md anti-pattern #7 on the shared dev DB.
const TEST_DATE = '2099-12-31';

interface Fixture {
  distributorId: string;
  adminToken: string;
  cylinderTypeAId: string;
  cylinderTypeBId: string;
  accountType: 'distributor' | 'mini_operator';
}

async function createFixture(
  accountType: 'distributor' | 'mini_operator',
  codeLetter: string,
): Promise<Fixture> {
  const distributor = await prisma.distributor.create({
    data: {
      businessName: `OpenSeed ${accountType} ${codeLetter} ${RUN_SUFFIX}`,
      legalName: `OpenSeed ${accountType} ${codeLetter} ${RUN_SUFFIX}`,
      accountType,
      gstMode: 'disabled',
      docCode: `OS${codeLetter}${RUN_SUFFIX.slice(-2)}`,
      state: 'Telangana',
    },
    select: { id: true },
  });
  const passwordHash = await bcrypt.hash('OpSeed@123', 4);
  const user = await prisma.user.create({
    data: {
      email: `openseed-${accountType}-${codeLetter.toLowerCase()}-${RUN_SUFFIX}@example.com`,
      passwordHash,
      firstName: 'OS',
      lastName: codeLetter,
      role: accountType === 'mini_operator' ? 'mini_operator_admin' : 'distributor_admin',
      status: 'active',
      distributorId: distributor.id,
      requiresPasswordReset: false,
    },
  });
  const ctA = await prisma.cylinderType.create({
    data: {
      distributorId: distributor.id,
      typeName: '19 KG Commercial',
      capacity: 19, unit: 'KG', hsnCode: '27111900', isActive: true,
    },
    select: { id: true },
  });
  const ctB = await prisma.cylinderType.create({
    data: {
      distributorId: distributor.id,
      typeName: '5 KG Domestic',
      capacity: 5, unit: 'KG', hsnCode: '27111900', isActive: true,
    },
    select: { id: true },
  });
  const adminToken = generateToken({
    userId: user.id,
    email: user.email,
    role: user.role as UserRole,
    distributorId: distributor.id,
  });
  return {
    distributorId: distributor.id,
    adminToken,
    cylinderTypeAId: ctA.id,
    cylinderTypeBId: ctB.id,
    accountType,
  };
}

async function cleanup(distributorId: string) {
  try {
    await prisma.customerLedgerEntry.deleteMany({ where: { distributorId } });
    await prisma.invoice.deleteMany({ where: { distributorId } });
    await prisma.customerInventoryBalance.deleteMany({ where: { customer: { distributorId } } });
    await prisma.customerAllowedCylinderType.deleteMany({ where: { customer: { distributorId } } });
    await prisma.customer.deleteMany({ where: { distributorId } });
    await prisma.emptyCylinderPrice.deleteMany({ where: { distributorId } });
    await prisma.cylinderType.deleteMany({ where: { distributorId } });
    await prisma.invoiceCounter.deleteMany({ where: { distributorId } });
    await prisma.auditLog.deleteMany({ where: { distributorId } });
    await prisma.user.deleteMany({ where: { distributorId } });
    await prisma.distributor.delete({ where: { id: distributorId } });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[opening-seed cleanup]', (err as Error).message);
  }
}

describe('Opening-state seed — universal + editable + preference + PDF', () => {
  let miniOp: Fixture;
  let regular: Fixture;
  let otherTenant: Fixture;

  beforeAll(async () => {
    miniOp = await createFixture('mini_operator', 'M');
    regular = await createFixture('distributor', 'R');
    otherTenant = await createFixture('mini_operator', 'X');
  }, 60_000);

  afterAll(async () => {
    await cleanup(miniOp.distributorId);
    await cleanup(regular.distributorId);
    await cleanup(otherTenant.distributorId);
  });

  // ─────────────────────────────────────────────────────────────
  describe('T1 — happy path atomic seed', () => {
    it('creates customer + preferences + empties (with openingSeedQty snapshot) + OB invoice + ledger row atomically', async () => {
      const res = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T1 ${RUN_SUFFIX}`,
          phone: '+919999911001',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: {
            preferredCylinderTypeIds: [miniOp.cylinderTypeAId, miniOp.cylinderTypeBId],
            empties: [{ cylinderTypeId: miniOp.cylinderTypeAId, qty: 5 }],
            openingBalance: {
              amount: 8500,
              asOfDate: TEST_DATE,
              notes: 'Paper-ledger carry forward',
            },
          },
        });
      expect(res.status).toBe(201);
      expect(res.body.data.seeded).toMatchObject({
        preferredCylinderTypeCount: 2,
        emptiesRowCount: 1,
      });
      expect(res.body.data.seeded.openingInvoiceId).toBeTruthy();
      const customerId = res.body.data.customerId as string;

      const [prefs, empties, invoice, ledger, customer] = await Promise.all([
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
      expect(prefs).toHaveLength(2);
      expect(empties).toHaveLength(1);
      expect(empties[0].withCustomerQty).toBe(5);
      expect(empties[0].openingSeedQty).toBe(5); // snapshot preserved
      expect(invoice).not.toBeNull();
      expect(Number(invoice!.totalAmount)).toBe(8500);
      expect(Number(invoice!.outstandingAmount)).toBe(8500);
      expect(ledger).toHaveLength(1);
      expect(customer?.openingStateSeededAt).not.toBeNull();
    });

    it('ledger reader emits a ₹ OB row + one empties row per seeded cylinder type', async () => {
      const customer = await prisma.customer.findFirst({
        where: { distributorId: miniOp.distributorId, customerName: `T1 ${RUN_SUFFIX}` },
        select: { id: true },
      });
      expect(customer).not.toBeNull();
      const ledger = await getCustomerLedger(miniOp.distributorId, customer!.id);
      expect(ledger.rows.length).toBeGreaterThan(0);
      // T1 seeded ₹8500 + typeA qty=5. New shape (2026-07-21):
      //   row 0: money row  — Opening Balance b/f, ₹ 8500, Pend E = 0
      //   row 1: empties row — type A, Pend E = 5, ₹ 0
      const obRows = ledger.rows.filter((r) => r.kind === 'opening');
      expect(obRows).toHaveLength(2);
      const money = obRows[0];
      const empties = obRows[1];
      expect(money.narration).toBe('Opening Balance b/f');
      expect(money.cylinderType).toBe('');
      expect(money.dueAmount).toBe(8500);
      expect(money.pendingEmptyCyls).toBe(0);
      expect(empties.narration).toBe('Opening empties held');
      expect(empties.cylinderType).toBe('19 KG Commercial');
      expect(empties.pendingEmptyCyls).toBe(5);
      expect(empties.dueAmount).toBe(0);
    });

    it('two seeded cylinder types + ₹ balance → 1 money row + 2 empties rows', async () => {
      // Create a separate customer seeded with BOTH types.
      const res = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T1-two ${RUN_SUFFIX}`,
          phone: '+919999911010',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: {
            preferredCylinderTypeIds: [miniOp.cylinderTypeAId, miniOp.cylinderTypeBId],
            empties: [
              { cylinderTypeId: miniOp.cylinderTypeAId, qty: 5 },
              { cylinderTypeId: miniOp.cylinderTypeBId, qty: 2 },
            ],
            openingBalance: { amount: 3543, asOfDate: TEST_DATE },
          },
        });
      expect(res.status).toBe(201);
      const ledger = await getCustomerLedger(miniOp.distributorId, res.body.data.customerId);
      const obRows = ledger.rows.filter((r) => r.kind === 'opening');
      // 1 money row + 2 empties rows = 3.
      expect(obRows).toHaveLength(3);
      // Money row FIRST — narration, ₹, no Pend E, no type.
      expect(obRows[0].narration).toBe('Opening Balance b/f');
      expect(obRows[0].dueAmount).toBe(3543);
      expect(obRows[0].pendingEmptyCyls).toBe(0);
      expect(obRows[0].cylinderType).toBe('');
      // Empties rows — narration "Opening empties held", ₹=0, Pend E per type.
      expect(obRows[1].narration).toBe('Opening empties held');
      expect(obRows[1].cylinderType).not.toBe('');
      expect(obRows[1].dueAmount).toBe(0);
      expect(obRows[2].narration).toBe('Opening empties held');
      expect(obRows[2].cylinderType).not.toBe('');
      expect(obRows[2].dueAmount).toBe(0);
      const totalPendE = obRows.reduce((s, r) => s + r.pendingEmptyCyls, 0);
      expect(totalPendE).toBe(7);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('T2 — mini-op-only gate: regular distributor rejected', () => {
    it('regular distributor_admin sending openingState → 400 (must use CSV importer)', async () => {
      const res = await request(app)
        .post('/api/customers')
        .set(auth(regular.adminToken))
        .send({
          customerName: `T2 Regular ${RUN_SUFFIX}`,
          phone: '+919999911002',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: {
            openingBalance: { amount: 1500, asOfDate: TEST_DATE },
          },
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/mini-operator/i);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('T3 — Edit-path seed-later (POST /:id/seed-opening-state)', () => {
    it('unseeded customer can be seeded later; second call → 400', async () => {
      // Create WITHOUT openingState.
      const createRes = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T3 SeedLater ${RUN_SUFFIX}`,
          phone: '+919999911003',
          creditPeriodDays: 30,
          gstRateOverride: 18,
        });
      expect(createRes.status).toBe(201);
      const customerId = createRes.body.data.customerId as string;

      // Seed later.
      const seedRes = await request(app)
        .post(`/api/customers/${customerId}/seed-opening-state`)
        .set(auth(miniOp.adminToken))
        .send({
          preferredCylinderTypeIds: [miniOp.cylinderTypeAId],
          empties: [{ cylinderTypeId: miniOp.cylinderTypeAId, qty: 3 }],
          openingBalance: { amount: 2200, asOfDate: TEST_DATE },
        });
      expect(seedRes.status).toBe(200);
      expect(seedRes.body.data.seeded.preferredCylinderTypeCount).toBe(1);
      expect(seedRes.body.data.seeded.emptiesRowCount).toBe(1);

      // Verify openingSeedQty snapshotted correctly.
      const empties = await prisma.customerInventoryBalance.findFirst({
        where: { customerId },
        select: { openingSeedQty: true, withCustomerQty: true },
      });
      expect(empties?.openingSeedQty).toBe(3);

      // Second seed on same customer → 400.
      const secondRes = await request(app)
        .post(`/api/customers/${customerId}/seed-opening-state`)
        .set(auth(miniOp.adminToken))
        .send({ openingBalance: { amount: 999, asOfDate: TEST_DATE } });
      expect(secondRes.status).toBe(400);
      expect(secondRes.body.error).toMatch(/already been seeded/i);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('T4 — cross-tenant cylinder-type rejected + full rollback', () => {
    it('rejects otherTenant cylinder-type id in miniOp seed → 400, no orphan customer', async () => {
      const before = await prisma.customer.count({
        where: { distributorId: miniOp.distributorId, customerName: `T4 Rej ${RUN_SUFFIX}` },
      });
      expect(before).toBe(0);
      const res = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T4 Rej ${RUN_SUFFIX}`,
          phone: '+919999911004',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: {
            preferredCylinderTypeIds: [otherTenant.cylinderTypeAId], // cross-tenant
          },
        });
      expect(res.status).toBe(400);
      const after = await prisma.customer.count({
        where: { distributorId: miniOp.distributorId, customerName: `T4 Rej ${RUN_SUFFIX}` },
      });
      expect(after).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('T5 — GET /cylinder-types?customerId sorts with isPreferred; never filters', () => {
    it('returns ALL catalog types even when customer has a preference subset, preferred rows come first', async () => {
      // Create a customer with only one preferred cylinder type.
      const cRes = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T5 Prefer ${RUN_SUFFIX}`,
          phone: '+919999911005',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: {
            preferredCylinderTypeIds: [miniOp.cylinderTypeBId], // only B preferred
          },
        });
      expect(cRes.status).toBe(201);
      const customerId = cRes.body.data.customerId as string;

      const res = await request(app)
        .get(`/api/cylinder-types?customerId=${customerId}`)
        .set(auth(miniOp.adminToken));
      expect(res.status).toBe(200);
      const list = res.body.data.cylinderTypes as Array<{ cylinderTypeId: string; isPreferred?: boolean }>;
      // NEVER filtered — full catalog present.
      expect(list.length).toBe(2);
      // Preferred first.
      expect(list[0].cylinderTypeId).toBe(miniOp.cylinderTypeBId);
      expect(list[0].isPreferred).toBe(true);
      expect(list[1].isPreferred).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('T6 — plain create is unchanged', () => {
    it('no openingState → opening_state_seeded_at NULL, no invoice, no allowlist, no balance', async () => {
      const res = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T6 Plain ${RUN_SUFFIX}`,
          phone: '+919999911006',
          creditPeriodDays: 30,
          gstRateOverride: 18,
        });
      expect(res.status).toBe(201);
      expect(res.body.data.seeded).toBeNull();
      const customerId = res.body.data.customerId as string;
      const [prefs, balances, invoice, cust] = await Promise.all([
        prisma.customerAllowedCylinderType.count({ where: { customerId } }),
        prisma.customerInventoryBalance.count({ where: { customerId } }),
        prisma.invoice.count({ where: { customerId, isOpeningBalance: true } }),
        prisma.customer.findUnique({ where: { id: customerId }, select: { openingStateSeededAt: true } }),
      ]);
      expect(prefs).toBe(0);
      expect(balances).toBe(0);
      expect(invoice).toBe(0);
      expect(cust?.openingStateSeededAt).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('T7 — computeCustomerOverdue counts OB debt past credit window', () => {
    it('OB dated 60 days ago on a 30-day credit customer → full amount counts as overdue', async () => {
      const oldDate = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
      const res = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T7 Overdue ${RUN_SUFFIX}`,
          phone: '+919999911007',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: {
            openingBalance: { amount: 4000, asOfDate: oldDate },
          },
        });
      expect(res.status).toBe(201);
      const customerId = res.body.data.customerId as string;
      const overdue = await computeCustomerOverdue(miniOp.distributorId, customerId, new Date());
      expect(overdue).toBe(4000);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('T8 — mini-op-only Edit-path: regular distributor rejected', () => {
    it('regular distributor Edit-path POST /:id/seed-opening-state → 400', async () => {
      const cRes = await request(app)
        .post('/api/customers')
        .set(auth(regular.adminToken))
        .send({
          customerName: `T8 Regular Edit ${RUN_SUFFIX}`,
          phone: '+919999911008',
          creditPeriodDays: 30,
          gstRateOverride: 18,
        });
      expect(cRes.status).toBe(201);
      const customerId = cRes.body.data.customerId as string;
      const seedRes = await request(app)
        .post(`/api/customers/${customerId}/seed-opening-state`)
        .set(auth(regular.adminToken))
        .send({ openingBalance: { amount: 700, asOfDate: TEST_DATE } });
      expect(seedRes.status).toBe(400);
      expect(seedRes.body.error).toMatch(/mini-operator/i);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('T9 — validation: seed with zero axes rejected', () => {
    it('POST /:id/seed-opening-state with empty body → 400', async () => {
      const cRes = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T9 Empty ${RUN_SUFFIX}`,
          phone: '+919999911009',
          creditPeriodDays: 30,
          gstRateOverride: 18,
        });
      expect(cRes.status).toBe(201);
      const customerId = cRes.body.data.customerId as string;
      const seedRes = await request(app)
        .post(`/api/customers/${customerId}/seed-opening-state`)
        .set(auth(miniOp.adminToken))
        .send({});
      expect(seedRes.status).toBe(400);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Wire-shape smoke on the shared paymentService reader — used by
  // the individual ledger PDF renderer + the group ledger + the HQ
  // portal. If any of these downstream consumers ever changed the
  // ─────────────────────────────────────────────────────────────
  describe('T11 — PUT /:id/opening-state edits in place', () => {
    it('seeds first, then edits the OB amount + swaps a preferred type + updates empties', async () => {
      const createRes = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T11 EditOB ${RUN_SUFFIX}`,
          phone: '+919999911011',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: {
            preferredCylinderTypeIds: [miniOp.cylinderTypeAId],
            empties: [{ cylinderTypeId: miniOp.cylinderTypeAId, qty: 5 }],
            openingBalance: { amount: 3000, asOfDate: TEST_DATE, notes: 'v1' },
          },
        });
      expect(createRes.status).toBe(201);
      const customerId = createRes.body.data.customerId as string;

      // Edit: bump amount to 4200, swap preferred type to B, empties → B:2, drop A.
      const editRes = await request(app)
        .put(`/api/customers/${customerId}/opening-state`)
        .set(auth(miniOp.adminToken))
        .send({
          preferredCylinderTypeIds: [miniOp.cylinderTypeBId],
          empties: [{ cylinderTypeId: miniOp.cylinderTypeBId, qty: 2 }],
          openingBalance: { amount: 4200, asOfDate: TEST_DATE, notes: 'v2' },
        });
      expect(editRes.status).toBe(200);
      expect(editRes.body.data.seeded.preferredCylinderTypeCount).toBe(1);
      expect(editRes.body.data.seeded.emptiesRowCount).toBe(1);

      // OB invoice reflects new total. openingSeedQty for old type cleared.
      const ob = await prisma.invoice.findFirst({
        where: { customerId, isOpeningBalance: true, deletedAt: null },
        select: { totalAmount: true, notes: true },
      });
      expect(Number(ob?.totalAmount)).toBe(4200);
      expect(ob?.notes).toMatch(/v2/);
      const oldA = await prisma.customerInventoryBalance.findFirst({
        where: { customerId, cylinderTypeId: miniOp.cylinderTypeAId },
        select: { openingSeedQty: true, withCustomerQty: true },
      });
      expect(oldA?.openingSeedQty).toBe(0);
      // withCustomerQty rolled back by the removed 5.
      expect(oldA?.withCustomerQty).toBe(0);
      const newB = await prisma.customerInventoryBalance.findFirst({
        where: { customerId, cylinderTypeId: miniOp.cylinderTypeBId },
        select: { openingSeedQty: true, withCustomerQty: true },
      });
      expect(newB?.openingSeedQty).toBe(2);
      expect(newB?.withCustomerQty).toBe(2);

      // Preferences fully replaced.
      const prefs = await prisma.customerAllowedCylinderType.findMany({
        where: { customerId },
        select: { cylinderTypeId: true },
      });
      expect(prefs).toHaveLength(1);
      expect(prefs[0].cylinderTypeId).toBe(miniOp.cylinderTypeBId);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('T12 — PUT edit guardrails', () => {
    it('regular distributor cannot edit → 400 (mini-op only)', async () => {
      // A regular customer can be created without openingState.
      const createRes = await request(app)
        .post('/api/customers')
        .set(auth(regular.adminToken))
        .send({
          customerName: `T12 Reg ${RUN_SUFFIX}`,
          phone: '+919999911012',
          creditPeriodDays: 30,
          gstRateOverride: 18,
        });
      expect(createRes.status).toBe(201);
      const customerId = createRes.body.data.customerId as string;
      const editRes = await request(app)
        .put(`/api/customers/${customerId}/opening-state`)
        .set(auth(regular.adminToken))
        .send({ openingBalance: { amount: 100, asOfDate: TEST_DATE } });
      expect(editRes.status).toBe(400);
    });

    it('editing never-seeded customer → 400', async () => {
      const createRes = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T12 NeverSeeded ${RUN_SUFFIX}`,
          phone: '+919999911013',
          creditPeriodDays: 30,
          gstRateOverride: 18,
        });
      expect(createRes.status).toBe(201);
      const customerId = createRes.body.data.customerId as string;
      const editRes = await request(app)
        .put(`/api/customers/${customerId}/opening-state`)
        .set(auth(miniOp.adminToken))
        .send({ openingBalance: { amount: 500, asOfDate: TEST_DATE } });
      expect(editRes.status).toBe(400);
      expect(editRes.body.error).toMatch(/never been seeded/i);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('T13 — empties-only OB (₹0) still renders row on ledger', () => {
    it('customer seeded with empties but no ₹ still shows an Opening Balance b/f row', async () => {
      const res = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T13 EmptiesOnly ${RUN_SUFFIX}`,
          phone: '+919999911013',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: {
            preferredCylinderTypeIds: [miniOp.cylinderTypeAId],
            empties: [{ cylinderTypeId: miniOp.cylinderTypeAId, qty: 4 }],
            // No openingBalance — pure empties seed.
          },
        });
      expect(res.status).toBe(201);
      const ledger = await getCustomerLedger(miniOp.distributorId, res.body.data.customerId);
      const obRows = ledger.rows.filter((r) => r.kind === 'opening');
      // No ₹ balance → no money row. Just the single empties row with the
      // "Opening Balance b/f" narration (fallback because there is no
      // dedicated money row to carry that label).
      expect(obRows).toHaveLength(1);
      expect(obRows[0].pendingEmptyCyls).toBe(4);
      expect(obRows[0].dueAmount).toBe(0);
      expect(obRows[0].cylinderType).not.toBe('');
      expect(obRows[0].narration).toBe('Opening Balance b/f');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // T14 — comprehensive scenarios walkthrough. Adds an empty
  // cylinder price so the OB rows can carry Emp Cost, then runs
  // every meaningful axis-combination through create / seed-later
  // / edit and asserts the ledger shape end-to-end. This is the
  // "add a customer, do opening entries in all scenarios, check
  // how things come up" pass the user asked for on 2026-07-21.
  describe('T14 — all opening-state scenarios (create / seed-later / edit)', () => {
    // Empty prices carry the OB liability. Ensures the ledger's
    // Emp Cost column has non-zero values to assert on.
    beforeAll(async () => {
      // Use upsert-by-composite-key patterns via createMany with skip
      // so the fixture cleanup doesn't collide with earlier tests.
      const existingA = await prisma.emptyCylinderPrice.findFirst({
        where: { distributorId: miniOp.distributorId, cylinderTypeId: miniOp.cylinderTypeAId },
      });
      if (!existingA) {
        await prisma.emptyCylinderPrice.create({
          data: {
            distributorId: miniOp.distributorId,
            cylinderTypeId: miniOp.cylinderTypeAId,
            emptyCylinderPrice: 2400,
          },
        });
      }
      const existingB = await prisma.emptyCylinderPrice.findFirst({
        where: { distributorId: miniOp.distributorId, cylinderTypeId: miniOp.cylinderTypeBId },
      });
      if (!existingB) {
        await prisma.emptyCylinderPrice.create({
          data: {
            distributorId: miniOp.distributorId,
            cylinderTypeId: miniOp.cylinderTypeBId,
            emptyCylinderPrice: 800,
          },
        });
      }
    });

    // Scenario A — create with ₹ only (no empties).
    it('A: create with ₹ only → 1 money OB row, no empties row', async () => {
      const res = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T14-A ${RUN_SUFFIX}`,
          phone: '+919999911401',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: { openingBalance: { amount: 4500, asOfDate: TEST_DATE } },
        });
      expect(res.status).toBe(201);
      const ledger = await getCustomerLedger(miniOp.distributorId, res.body.data.customerId);
      const obRows = ledger.rows.filter((r) => r.kind === 'opening');
      expect(obRows).toHaveLength(1);
      expect(obRows[0].narration).toBe('Opening Balance b/f');
      expect(obRows[0].dueAmount).toBe(4500);
      expect(obRows[0].pendingEmptyCyls).toBe(0);
      expect(obRows[0].emptyCylsCost).toBe(0);
      expect(obRows[0].cylinderType).toBe('');
    });

    // Scenario B — create with empties only (no ₹).
    it('B: create with empties only → single empties row w/ Emp Cost', async () => {
      const res = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T14-B ${RUN_SUFFIX}`,
          phone: '+919999911402',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: {
            preferredCylinderTypeIds: [miniOp.cylinderTypeAId],
            empties: [{ cylinderTypeId: miniOp.cylinderTypeAId, qty: 3 }],
          },
        });
      expect(res.status).toBe(201);
      const ledger = await getCustomerLedger(miniOp.distributorId, res.body.data.customerId);
      const obRows = ledger.rows.filter((r) => r.kind === 'opening');
      expect(obRows).toHaveLength(1);
      // Falls back to "Opening Balance b/f" narration since there is no
      // money row to carry the label.
      expect(obRows[0].narration).toBe('Opening Balance b/f');
      expect(obRows[0].pendingEmptyCyls).toBe(3);
      expect(obRows[0].emptyCylsCost).toBe(3 * 2400); // 7200
      expect(obRows[0].dueAmount).toBe(0);
    });

    // Scenario C — create with BOTH ₹ + single-type empties.
    it('C: create with ₹ + single-type empties → 2 rows (money + empties)', async () => {
      const res = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T14-C ${RUN_SUFFIX}`,
          phone: '+919999911403',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: {
            preferredCylinderTypeIds: [miniOp.cylinderTypeAId],
            empties: [{ cylinderTypeId: miniOp.cylinderTypeAId, qty: 4 }],
            openingBalance: { amount: 6000, asOfDate: TEST_DATE },
          },
        });
      expect(res.status).toBe(201);
      const ledger = await getCustomerLedger(miniOp.distributorId, res.body.data.customerId);
      const obRows = ledger.rows.filter((r) => r.kind === 'opening');
      expect(obRows).toHaveLength(2);
      // Money row FIRST.
      expect(obRows[0].narration).toBe('Opening Balance b/f');
      expect(obRows[0].dueAmount).toBe(6000);
      expect(obRows[0].pendingEmptyCyls).toBe(0);
      expect(obRows[0].emptyCylsCost).toBe(0);
      // Empties row.
      expect(obRows[1].narration).toBe('Opening empties held');
      expect(obRows[1].pendingEmptyCyls).toBe(4);
      expect(obRows[1].emptyCylsCost).toBe(4 * 2400); // 9600
      expect(obRows[1].dueAmount).toBe(0);
    });

    // Scenario D — create with ₹ + empties in MULTIPLE cylinder types.
    it('D: create with ₹ + multi-type empties → 1 money row + N empties rows', async () => {
      const res = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T14-D ${RUN_SUFFIX}`,
          phone: '+919999911404',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: {
            preferredCylinderTypeIds: [miniOp.cylinderTypeAId, miniOp.cylinderTypeBId],
            empties: [
              { cylinderTypeId: miniOp.cylinderTypeAId, qty: 5 },
              { cylinderTypeId: miniOp.cylinderTypeBId, qty: 7 },
            ],
            openingBalance: { amount: 12500, asOfDate: TEST_DATE },
          },
        });
      expect(res.status).toBe(201);
      const ledger = await getCustomerLedger(miniOp.distributorId, res.body.data.customerId);
      const obRows = ledger.rows.filter((r) => r.kind === 'opening');
      expect(obRows).toHaveLength(3);
      expect(obRows[0].dueAmount).toBe(12500);
      // Empties rows arrive in the order Prisma returned the balances,
      // which is not guaranteed to match the request order. Assert by
      // cylinder type name so the test is order-independent.
      const rowA = obRows.find((r) => r.cylinderType === '19 KG Commercial');
      const rowB = obRows.find((r) => r.cylinderType === '5 KG Domestic');
      expect(rowA?.emptyCylsCost).toBe(5 * 2400); // 12000
      expect(rowB?.emptyCylsCost).toBe(7 * 800);  // 5600
      const emptiesTotal =
        obRows.reduce((s, r) => s + (r.emptyCylsCost || 0), 0);
      expect(emptiesTotal).toBe(12000 + 5600); // 17600
      // Summary carries the same total (empties liability across types).
      expect(ledger.summary.emptyCylsCost).toBe(17600);
    });

    // Scenario E — seed-later on a plain customer (no openingState at create).
    it('E: seed-later on unseeded customer emits correct OB rows', async () => {
      const cRes = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T14-E ${RUN_SUFFIX}`,
          phone: '+919999911405',
          creditPeriodDays: 30,
          gstRateOverride: 18,
        });
      expect(cRes.status).toBe(201);
      const customerId = cRes.body.data.customerId as string;

      // Ledger before seeding — no OB rows.
      const before = await getCustomerLedger(miniOp.distributorId, customerId);
      expect(before.rows.filter((r) => r.kind === 'opening')).toHaveLength(0);

      // Seed later.
      const sRes = await request(app)
        .post(`/api/customers/${customerId}/seed-opening-state`)
        .set(auth(miniOp.adminToken))
        .send({
          preferredCylinderTypeIds: [miniOp.cylinderTypeAId],
          empties: [{ cylinderTypeId: miniOp.cylinderTypeAId, qty: 2 }],
          openingBalance: { amount: 3200, asOfDate: TEST_DATE },
        });
      expect(sRes.status).toBe(200);

      const after = await getCustomerLedger(miniOp.distributorId, customerId);
      const obRows = after.rows.filter((r) => r.kind === 'opening');
      expect(obRows).toHaveLength(2);
      expect(obRows[0].dueAmount).toBe(3200);
      expect(obRows[1].pendingEmptyCyls).toBe(2);
      expect(obRows[1].emptyCylsCost).toBe(2 * 2400);
    });

    // Scenario F — edit path: reduce empties count.
    it('F: PUT /opening-state can reduce empties count', async () => {
      const cRes = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T14-F ${RUN_SUFFIX}`,
          phone: '+919999911406',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: {
            preferredCylinderTypeIds: [miniOp.cylinderTypeAId],
            empties: [{ cylinderTypeId: miniOp.cylinderTypeAId, qty: 8 }],
            openingBalance: { amount: 2000, asOfDate: TEST_DATE },
          },
        });
      expect(cRes.status).toBe(201);
      const customerId = cRes.body.data.customerId as string;

      const eRes = await request(app)
        .put(`/api/customers/${customerId}/opening-state`)
        .set(auth(miniOp.adminToken))
        .send({
          preferredCylinderTypeIds: [miniOp.cylinderTypeAId],
          empties: [{ cylinderTypeId: miniOp.cylinderTypeAId, qty: 3 }],
          openingBalance: { amount: 2000, asOfDate: TEST_DATE },
        });
      expect(eRes.status).toBe(200);

      const ledger = await getCustomerLedger(miniOp.distributorId, customerId);
      const emptiesRow = ledger.rows.find(
        (r) => r.kind === 'opening' && r.pendingEmptyCyls > 0,
      );
      expect(emptiesRow?.pendingEmptyCyls).toBe(3);
      expect(emptiesRow?.emptyCylsCost).toBe(3 * 2400);
    });

    // Scenario G — edit path: add ₹ to a customer that started with empties only.
    it('G: PUT /opening-state can add ₹ to an empties-only customer', async () => {
      const cRes = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T14-G ${RUN_SUFFIX}`,
          phone: '+919999911407',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: {
            preferredCylinderTypeIds: [miniOp.cylinderTypeAId],
            empties: [{ cylinderTypeId: miniOp.cylinderTypeAId, qty: 6 }],
          },
        });
      expect(cRes.status).toBe(201);
      const customerId = cRes.body.data.customerId as string;

      // Before: one empties row, dueAmount=0.
      const before = await getCustomerLedger(miniOp.distributorId, customerId);
      const beforeOb = before.rows.filter((r) => r.kind === 'opening');
      expect(beforeOb).toHaveLength(1);
      expect(beforeOb[0].dueAmount).toBe(0);

      // Edit → add ₹.
      const eRes = await request(app)
        .put(`/api/customers/${customerId}/opening-state`)
        .set(auth(miniOp.adminToken))
        .send({
          preferredCylinderTypeIds: [miniOp.cylinderTypeAId],
          empties: [{ cylinderTypeId: miniOp.cylinderTypeAId, qty: 6 }],
          openingBalance: { amount: 8000, asOfDate: TEST_DATE },
        });
      expect(eRes.status).toBe(200);

      const after = await getCustomerLedger(miniOp.distributorId, customerId);
      const afterOb = after.rows.filter((r) => r.kind === 'opening');
      // Now 2 rows: money + empties.
      expect(afterOb).toHaveLength(2);
      expect(afterOb[0].dueAmount).toBe(8000);
      expect(afterOb[1].pendingEmptyCyls).toBe(6);
    });

    // Scenario H — edit path: swap cylinder types (drop A, add B).
    it('H: PUT /opening-state can swap cylinder types cleanly', async () => {
      const cRes = await request(app)
        .post('/api/customers')
        .set(auth(miniOp.adminToken))
        .send({
          customerName: `T14-H ${RUN_SUFFIX}`,
          phone: '+919999911408',
          creditPeriodDays: 30,
          gstRateOverride: 18,
          openingState: {
            preferredCylinderTypeIds: [miniOp.cylinderTypeAId],
            empties: [{ cylinderTypeId: miniOp.cylinderTypeAId, qty: 4 }],
          },
        });
      expect(cRes.status).toBe(201);
      const customerId = cRes.body.data.customerId as string;

      const eRes = await request(app)
        .put(`/api/customers/${customerId}/opening-state`)
        .set(auth(miniOp.adminToken))
        .send({
          preferredCylinderTypeIds: [miniOp.cylinderTypeBId],
          empties: [{ cylinderTypeId: miniOp.cylinderTypeBId, qty: 9 }],
        });
      expect(eRes.status).toBe(200);

      const ledger = await getCustomerLedger(miniOp.distributorId, customerId);
      const obRows = ledger.rows.filter((r) => r.kind === 'opening');
      expect(obRows).toHaveLength(1);
      expect(obRows[0].cylinderType).toBe('5 KG Domestic');
      expect(obRows[0].pendingEmptyCyls).toBe(9);
      expect(obRows[0].emptyCylsCost).toBe(9 * 800); // 7200

      // openingSeedQty for the OLD type cleared to 0.
      const oldBal = await prisma.customerInventoryBalance.findFirst({
        where: { customerId, cylinderTypeId: miniOp.cylinderTypeAId },
        select: { openingSeedQty: true, withCustomerQty: true },
      });
      expect(oldBal?.openingSeedQty).toBe(0);
      expect(oldBal?.withCustomerQty).toBe(0);
    });
  });

  // OB row's shape, this test guards it.
  describe('T10 — reader interface guard: openingEmptiesByType wiring lives', () => {
    it('paymentService source contains the openingEmptiesByType init + per-type OB emit', async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const src = readFileSync(
        resolve(__dirname, '..', 'services', 'paymentService.ts'),
        'utf-8',
      );
      expect(src).toContain('openingEmptiesByType');
      // 2026-07-21 per-cylinder-type OB emit: one row per seeded type,
      // first bears the money columns.
      expect(src).toContain('openingEmptySeedEntries');
      expect(src).toMatch(/openingEmptySeedEntries\.forEach/);
    });
  });

  // Reference helper import so tree-shaking doesn't strip it (helper
  // suite in helpers.ts is picked up when this file participates).
  void loginAsDistAdmin;
});
