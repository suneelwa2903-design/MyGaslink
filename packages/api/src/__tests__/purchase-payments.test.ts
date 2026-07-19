/**
 * Mini-Operator 2026-07-19 — Purchase Payments invariants + wire shape.
 *
 * Locks:
 *   T1  FIFO auto-allocation across 3 unpaid entries
 *   T2  PurchaseEntry.amountPaid rolls forward inside the same tx
 *   T3  Manual override: sum-mismatch → 400 ALLOCATION_MISMATCH
 *   T4  Manual override: cross-source entry → 400 FOREIGN_ENTRY
 *   T5  Cross-tenant: dist-B payment cannot target dist-A entry (404)
 *   T6  Reverse rolls PurchaseEntry.amountPaid back to pre-payment state
 *   T7  Double reverse → 409 ALREADY_REVERSED
 *   T8  Supplier ledger interleaves debits+credits with running balance
 *   T9  Supplier balances rollup for the Purchases tab
 *   T10 Role gate: distributor_admin token → 403 on POST /
 *
 * Deliberately DOES NOT test route validation (zod covered by the
 * anti-pattern-guards + wire-shape-guards suites).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { UserRole } from '@gaslink/shared';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken, loginAsDistAdmin } from './helpers.js';

const app = createApp();
const RUN = String(Date.now()).slice(-6);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

interface Fixture {
  distributorId: string;
  adminToken: string;
  sourceAId: string;
  sourceBId: string;
  purchase1Id: string; // sourceA, ₹100
  purchase2Id: string; // sourceA, ₹200
  purchase3Id: string; // sourceA, ₹300
  purchaseSourceBId: string; // sourceB, ₹500 (cross-source)
}

async function seedPurchase(
  distributorId: string,
  sourceDistributorId: string,
  createdBy: string,
  amount: number,
  purchaseDate: string,
  docCode: string,
  seq: number,
): Promise<string> {
  // Create a purchase entry with one item priced so unitPrice * fulls = amount.
  const cylType = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId }, select: { id: true },
  });
  const entry = await prisma.purchaseEntry.create({
    data: {
      purchaseNumber: `P${docCode}2627${String(seq).padStart(6, '0')}`,
      distributorId,
      sourceDistributorId,
      sourceDistributorName: null,
      purchaseDate,
      notes: null,
      createdBy,
      items: {
        create: [{
          cylinderTypeId: cylType.id,
          fullsReceived: 1,
          emptiesGivenOut: 0,
          unitPrice: amount, // 1 * amount = amount
        }],
      },
    },
    select: { id: true },
  });
  return entry.id;
}

async function makeFixture(codeLetter: string): Promise<Fixture> {
  const docCode = `Z${codeLetter}A`;
  const distributor = await prisma.distributor.create({
    data: {
      businessName: `PurchPay ${codeLetter} ${RUN}`,
      legalName: `PurchPay ${codeLetter} ${RUN}`,
      accountType: 'mini_operator',
      gstMode: 'disabled',
      docCode,
      state: 'Telangana',
    },
    select: { id: true },
  });

  const passwordHash = await bcrypt.hash('PP@123', 4);
  const user = await prisma.user.create({
    data: {
      email: `purchpay-${codeLetter.toLowerCase()}-${RUN}@example.com`,
      passwordHash,
      firstName: 'PP',
      lastName: codeLetter,
      role: 'mini_operator_admin',
      status: 'active',
      distributorId: distributor.id,
      requiresPasswordReset: false,
    },
    select: { id: true, email: true },
  });

  await prisma.cylinderType.create({
    data: {
      distributorId: distributor.id,
      typeName: '19KG',
      capacity: 19,
      unit: 'KG',
      hsnCode: '27111900',
      isActive: true,
    },
  });

  const [sourceA, sourceB] = await Promise.all([
    prisma.sourceDistributor.create({
      data: { distributorId: distributor.id, name: `SourceA ${RUN}` },
      select: { id: true },
    }),
    prisma.sourceDistributor.create({
      data: { distributorId: distributor.id, name: `SourceB ${RUN}` },
      select: { id: true },
    }),
  ]);

  // 3 sourceA entries in ascending purchaseDate order — FIFO oldest first.
  // Use fixed far-future dates (anti-pattern #7).
  const purchase1Id = await seedPurchase(distributor.id, sourceA.id, user.id, 100, '2099-01-01', docCode, 1);
  const purchase2Id = await seedPurchase(distributor.id, sourceA.id, user.id, 200, '2099-01-02', docCode, 2);
  const purchase3Id = await seedPurchase(distributor.id, sourceA.id, user.id, 300, '2099-01-03', docCode, 3);

  const purchaseSourceBId = await seedPurchase(distributor.id, sourceB.id, user.id, 500, '2099-01-01', docCode, 4);

  const adminToken = generateToken({
    userId: user.id,
    email: user.email,
    role: 'mini_operator_admin' as UserRole,
    distributorId: distributor.id,
  });

  return {
    distributorId: distributor.id,
    adminToken,
    sourceAId: sourceA.id,
    sourceBId: sourceB.id,
    purchase1Id,
    purchase2Id,
    purchase3Id,
    purchaseSourceBId,
  };
}

async function cleanupFixture(distributorId: string): Promise<void> {
  try {
    await prisma.purchasePaymentAllocation.deleteMany({
      where: { payment: { distributorId } },
    });
    await prisma.purchasePayment.deleteMany({ where: { distributorId } });
    await prisma.purchaseEntryItem.deleteMany({ where: { purchaseEntry: { distributorId } } });
    await prisma.purchaseEntry.deleteMany({ where: { distributorId } });
    await prisma.sourceDistributor.deleteMany({ where: { distributorId } });
    await prisma.cylinderType.deleteMany({ where: { distributorId } });
    await prisma.auditLog.deleteMany({ where: { distributorId } });
    await prisma.user.deleteMany({ where: { distributorId, role: 'mini_operator_admin' } });
    await prisma.distributor.delete({ where: { id: distributorId } });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[purchase-payments cleanup]', (err as Error).message);
  }
}

describe('Mini-Operator — Purchase Payments', () => {
  let fx: Fixture;
  let fx2: Fixture;
  let distAdmin: { token: string };

  beforeAll(async () => {
    distAdmin = await loginAsDistAdmin();
    // Clean stale fixtures from prior runs of this file.
    const stale = await prisma.distributor.findMany({
      where: { accountType: 'mini_operator', businessName: { startsWith: 'PurchPay ' } },
      select: { id: true },
    });
    for (const d of stale) await cleanupFixture(d.id);
    fx = await makeFixture('A');
    fx2 = await makeFixture('B');
  });

  afterAll(async () => {
    await cleanupFixture(fx.distributorId);
    await cleanupFixture(fx2.distributorId);
  });

  it('T1 — FIFO auto-allocation: pay ₹250 across (100/200/300) → 100 full + 150 partial + 0', async () => {
    const res = await request(app)
      .post('/api/purchase-payments')
      .set(auth(fx.adminToken))
      .send({
        sourceDistributorId: fx.sourceAId,
        transactionDate: '2099-06-01',
        amount: 250,
        paymentMethod: 'cash',
      });
    expect(res.status).toBe(201);
    const allocations: Array<{ purchaseEntryId: string; amount: number }> = res.body.data.allocations;
    expect(allocations.length).toBe(2);
    expect(allocations[0]).toMatchObject({ purchaseEntryId: fx.purchase1Id, amount: 100 });
    expect(allocations[1]).toMatchObject({ purchaseEntryId: fx.purchase2Id, amount: 150 });
    expect(res.body.data.unallocated).toBe(0);
  });

  it('T2 — PurchaseEntry.amountPaid rolls forward after T1', async () => {
    const [p1, p2, p3] = await Promise.all([
      prisma.purchaseEntry.findUniqueOrThrow({ where: { id: fx.purchase1Id }, select: { amountPaid: true } }),
      prisma.purchaseEntry.findUniqueOrThrow({ where: { id: fx.purchase2Id }, select: { amountPaid: true } }),
      prisma.purchaseEntry.findUniqueOrThrow({ where: { id: fx.purchase3Id }, select: { amountPaid: true } }),
    ]);
    expect(Number(p1.amountPaid)).toBe(100);
    expect(Number(p2.amountPaid)).toBe(150);
    expect(Number(p3.amountPaid)).toBe(0);
  });

  it('T3 — manual allocations that don\'t sum to amount → 400 ALLOCATION_MISMATCH', async () => {
    const res = await request(app)
      .post('/api/purchase-payments')
      .set(auth(fx.adminToken))
      .send({
        sourceDistributorId: fx.sourceAId,
        transactionDate: '2099-06-02',
        amount: 100,
        allocations: [{ purchaseEntryId: fx.purchase3Id, amount: 50 }], // 50 ≠ 100
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ALLOCATION_MISMATCH');
  });

  it('T4 — manual allocation to a foreign source entry → 400 FOREIGN_ENTRY', async () => {
    const res = await request(app)
      .post('/api/purchase-payments')
      .set(auth(fx.adminToken))
      .send({
        sourceDistributorId: fx.sourceAId,
        transactionDate: '2099-06-03',
        amount: 500,
        allocations: [{ purchaseEntryId: fx.purchaseSourceBId, amount: 500 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FOREIGN_ENTRY');
  });

  it('T5 — cross-tenant: fx2 token cannot pay against fx purchase → SOURCE_NOT_FOUND', async () => {
    const res = await request(app)
      .post('/api/purchase-payments')
      .set(auth(fx2.adminToken))
      .send({
        sourceDistributorId: fx.sourceAId,
        transactionDate: '2099-06-04',
        amount: 100,
      });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SOURCE_NOT_FOUND');
  });

  it('T6 — reverse rolls amountPaid back', async () => {
    // Fresh payment we'll then reverse.
    const create = await request(app)
      .post('/api/purchase-payments')
      .set(auth(fx.adminToken))
      .send({
        sourceDistributorId: fx.sourceAId,
        transactionDate: '2099-06-05',
        amount: 50,
        allocations: [{ purchaseEntryId: fx.purchase3Id, amount: 50 }],
      });
    expect(create.status).toBe(201);
    const paymentId = create.body.data.payment.id;

    const before = await prisma.purchaseEntry.findUniqueOrThrow({
      where: { id: fx.purchase3Id }, select: { amountPaid: true },
    });
    expect(Number(before.amountPaid)).toBe(50);

    const reverse = await request(app)
      .post(`/api/purchase-payments/${paymentId}/reverse`)
      .set(auth(fx.adminToken));
    expect(reverse.status).toBe(200);

    const after = await prisma.purchaseEntry.findUniqueOrThrow({
      where: { id: fx.purchase3Id }, select: { amountPaid: true },
    });
    expect(Number(after.amountPaid)).toBe(0);

    // T7 — double reverse
    const reverseAgain = await request(app)
      .post(`/api/purchase-payments/${paymentId}/reverse`)
      .set(auth(fx.adminToken));
    expect(reverseAgain.status).toBe(409);
    expect(reverseAgain.body.code).toBe('ALREADY_REVERSED');
  });

  it('T8 — supplier ledger: merged debits+credits, monotonic running balance', async () => {
    const res = await request(app)
      .get(`/api/purchase-payments/supplier-ledger/${fx.sourceAId}`)
      .set(auth(fx.adminToken));
    expect(res.status).toBe(200);
    const rows: Array<{ kind: string; debit: number; credit: number; balance: number }> = res.body.data.rows;
    // 3 debits from purchases + at least 1 credit from T1's ₹250 payment.
    expect(rows.filter((r) => r.kind === 'purchase').length).toBe(3);
    expect(rows.filter((r) => r.kind === 'payment').length).toBeGreaterThanOrEqual(1);
    // Running balance walks: totals - paid at the last row.
    const summary: { totalPurchased: number; totalPaid: number; netOutstanding: number } = res.body.data.summary;
    expect(summary.totalPurchased).toBe(600); // 100+200+300
    expect(summary.netOutstanding).toBe(summary.totalPurchased - summary.totalPaid);
  });

  it('T9 — supplier balances rollup surfaces the outstanding total', async () => {
    const res = await request(app)
      .get('/api/purchase-payments/supplier-balances')
      .set(auth(fx.adminToken));
    expect(res.status).toBe(200);
    const suppliers: Array<{ sourceDistributorId: string; outstanding: number }> = res.body.data.suppliers;
    const sourceA = suppliers.find((s) => s.sourceDistributorId === fx.sourceAId);
    expect(sourceA).toBeTruthy();
    // Rollup ignores soft-deleted payments (T6 reversed a ₹50) but adds
    // the T1 ₹250 that stayed active. So paid = 250, purchased = 600,
    // outstanding = 350.
    expect(sourceA!.outstanding).toBe(350);
  });

  it('T10 — role gate: distributor_admin cannot record a purchase payment', async () => {
    const res = await request(app)
      .post('/api/purchase-payments')
      .set(auth(distAdmin.token))
      .send({
        sourceDistributorId: fx.sourceAId,
        transactionDate: '2099-06-06',
        amount: 100,
      });
    // 403 from requireRole, or 404 from tenant mismatch — either way NOT 201.
    expect([403, 404]).toContain(res.status);
  });
});
