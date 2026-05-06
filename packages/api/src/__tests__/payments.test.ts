import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, loginAsFinance, getSeedData, today } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let financeToken: string;
let seedData: Awaited<ReturnType<typeof getSeedData>>;

// We create our own dedicated invoice for these tests so we don't perturb
// the seed (which has invoices the workflow tests rely on).
let testInvoiceId: string;
let testInvoiceCustomerId: string;
let testInvoiceTotal: number;

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;
  financeToken = (await loginAsFinance()).token;
  seedData = await getSeedData();

  // Create a fresh invoice for payment tests.
  const customer = seedData.customers[0];
  const cyl = seedData.cylinderTypes[0];
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `TEST-INV-${Date.now()}`,
      distributorId: 'dist-001',
      customerId: customer.id,
      issueDate: new Date(today()),
      dueDate: new Date(today()),
      totalAmount: 1000,
      amountPaid: 0,
      outstandingAmount: 1000,
      status: 'issued',
      items: {
        create: [{
          cylinderTypeId: cyl.id,
          description: `${cyl.typeName} LPG Cylinder`,
          hsnCode: '27111900',
          quantity: 2,
          unitPrice: 500,
          totalPrice: 1000,
          gstRate: 0,
        }],
      },
    },
  });
  testInvoiceId = invoice.id;
  testInvoiceCustomerId = customer.id;
  testInvoiceTotal = Number(invoice.totalAmount);
});

afterAll(async () => {
  // Clean up payments + the test invoice we made
  await prisma.paymentAllocation.deleteMany({ where: { invoiceId: testInvoiceId } });
  await prisma.paymentTransaction.deleteMany({
    where: { distributorId: 'dist-001', referenceNumber: { startsWith: 'TEST-PAY-' } },
  });
  await prisma.invoiceItem.deleteMany({ where: { invoiceId: testInvoiceId } });
  await prisma.invoice.delete({ where: { id: testInvoiceId } });
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('Payments — Auth', () => {
  it('rejects unauthenticated GET with 401', async () => {
    const res = await request(app).get('/api/payments');
    expect(res.status).toBe(401);
  });

  it('rejects unauthenticated POST with 401', async () => {
    const res = await request(app).post('/api/payments').send({});
    expect(res.status).toBe(401);
  });
});

describe('Payments — Validation', () => {
  it('rejects payment with missing customerId (400)', async () => {
    const res = await request(app)
      .post('/api/payments')
      .set(auth(financeToken))
      .send({ amount: 100, paymentMethod: 'cash', transactionDate: today() });
    expect(res.status).toBe(400);
  });

  it('rejects payment with non-positive amount (400)', async () => {
    const res = await request(app)
      .post('/api/payments')
      .set(auth(financeToken))
      .send({
        customerId: testInvoiceCustomerId,
        amount: -50,
        paymentMethod: 'cash',
        transactionDate: today(),
      });
    expect(res.status).toBe(400);
  });
});

describe('Payments — Partial payment', () => {
  it('records a partial payment and leaves invoice in partially_paid', async () => {
    const partial = testInvoiceTotal / 2;
    const res = await request(app)
      .post('/api/payments')
      .set(auth(financeToken))
      .send({
        customerId: testInvoiceCustomerId,
        amount: partial,
        paymentMethod: 'cash',
        referenceNumber: 'TEST-PAY-PARTIAL',
        transactionDate: today(),
        allocations: [{ invoiceId: testInvoiceId, amount: partial }],
      });
    if (res.status !== 201) console.log('partial payment error:', res.body);
    expect(res.status).toBe(201);
    expect(res.body.data.amount).toBe(partial);

    // Invoice should now be partially_paid
    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: testInvoiceId } });
    expect(updated.status).toBe('partially_paid');
    expect(Number(updated.outstandingAmount)).toBe(testInvoiceTotal - partial);
  });
});

describe('Payments — Full payment marks invoice paid', () => {
  it('records the remaining balance and flips invoice to paid', async () => {
    const remainingInvoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: testInvoiceId },
    });
    const remaining = Number(remainingInvoice.outstandingAmount);

    const res = await request(app)
      .post('/api/payments')
      .set(auth(financeToken))
      .send({
        customerId: testInvoiceCustomerId,
        amount: remaining,
        paymentMethod: 'upi',
        referenceNumber: 'TEST-PAY-FULL',
        transactionDate: today(),
        allocations: [{ invoiceId: testInvoiceId, amount: remaining }],
      });
    if (res.status !== 201) console.log('full payment error:', res.body);
    expect(res.status).toBe(201);

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: testInvoiceId } });
    expect(updated.status).toBe('paid');
    expect(Number(updated.outstandingAmount)).toBe(0);
  });
});

describe('Payments — List + ledger', () => {
  it('lists payments scoped to caller distributor', async () => {
    const res = await request(app).get('/api/payments').set(auth(financeToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.payments)).toBe(true);
    for (const p of res.body.data.payments) {
      expect(p.distributorId).toBe('dist-001');
    }
  });

  it('returns customer ledger', async () => {
    const res = await request(app)
      .get(`/api/payments/ledger/${testInvoiceCustomerId}`)
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });
});

describe('Payments — Tenant Isolation', () => {
  it('cannot fetch ledger for another distributor\'s customer (404 / empty)', async () => {
    const dist2Customer = await prisma.customer.findFirst({
      where: { distributorId: 'dist-002', deletedAt: null },
    });
    if (!dist2Customer) throw new Error('Seed expected a dist-002 customer');

    const res = await request(app)
      .get(`/api/payments/ledger/${dist2Customer.id}`)
      .set(auth(financeToken)); // dist-001 finance

    // Either 404 or success-with-empty — must not return another tenant's data
    if (res.status === 200) {
      const entries = res.body.data?.entries ?? res.body.data?.ledger ?? [];
      expect(Array.isArray(entries) ? entries.length : 0).toBe(0);
    } else {
      expect([403, 404]).toContain(res.status);
    }
  });
});
