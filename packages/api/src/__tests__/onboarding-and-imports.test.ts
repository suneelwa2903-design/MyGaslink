import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, loginAsSuperAdmin } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let saToken: string;
let dist1Id: string;
let dist2Id: string | null = null;

const TRACK_NAMES = [
  'Import Test Alpha', 'Import Test Beta', 'Import Test Gamma',
  'Cross Tenant Customer', 'OB Test Customer', 'Bal Cust One', 'Bal Cust Two',
];

async function ensureSecondDistributor(): Promise<string> {
  let dist = await prisma.distributor.findFirst({ where: { id: 'dist-002' } });
  if (!dist) {
    dist = await prisma.distributor.create({
      data: {
        id: 'dist-002',
        businessName: 'Test Tenant 2',
        ownerName: 'T2 Owner',
        phone: '0000000002',
        email: 't2@test.local',
        gstMode: 'disabled',
        status: 'active',
      },
    });
  }
  return dist.id;
}

beforeAll(async () => {
  app = createApp();
  const admin = await loginAsDistAdmin();
  adminToken = admin.token;
  dist1Id = admin.distributorId;
  saToken = (await loginAsSuperAdmin()).token;
  dist2Id = await ensureSecondDistributor();
});

beforeEach(async () => {
  // Wipe anything our tests create so each scenario starts clean. Order
  // matters: ledger / payments → customers.
  await prisma.customerLedgerEntry.deleteMany({
    where: {
      OR: [
        { distributorId: dist1Id, narration: { contains: 'Opening balance import' } },
        { distributorId: dist2Id ?? '__none__', narration: { contains: 'Opening balance import' } },
      ],
    },
  });
  await prisma.paymentTransaction.deleteMany({
    where: {
      OR: [
        { distributorId: dist1Id, referenceNumber: 'opening_balance_import' },
        { distributorId: dist2Id ?? '__none__', referenceNumber: 'opening_balance_import' },
      ],
    },
  });
  await prisma.customer.deleteMany({
    where: { customerName: { in: TRACK_NAMES } },
  });
});

afterAll(async () => {
  await prisma.customerLedgerEntry.deleteMany({
    where: { narration: { contains: 'Opening balance import' } },
  });
  await prisma.paymentTransaction.deleteMany({
    where: { referenceNumber: 'opening_balance_import' },
  });
  await prisma.customer.deleteMany({ where: { customerName: { in: TRACK_NAMES } } });
});

function auth(token: string, distId?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (distId) headers['X-Distributor-Id'] = distId;
  return headers;
}

// ─── /api/customers/import-csv ───────────────────────────────────────────────

describe('POST /api/customers/import-csv', () => {
  it('imports valid rows and creates customer records', async () => {
    const res = await request(app)
      .post('/api/customers/import-csv')
      .set(auth(adminToken))
      .send({
        rows: [
          { name: 'Import Test Alpha', phone: '9000000001' },
          { name: 'Import Test Beta', phone: '9000000002', address: 'Bangalore' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.imported).toBe(2);
    expect(res.body.data.failures).toEqual([]);

    const created = await prisma.customer.findMany({
      where: { distributorId: dist1Id, customerName: { in: ['Import Test Alpha', 'Import Test Beta'] } },
    });
    expect(created.length).toBe(2);
  });

  it('returns a per-row failure for duplicate phone, does not 500', async () => {
    // First import seeds the customer
    await request(app)
      .post('/api/customers/import-csv')
      .set(auth(adminToken))
      .send({ rows: [{ name: 'Import Test Alpha', phone: '9000000001' }] });

    const res = await request(app)
      .post('/api/customers/import-csv')
      .set(auth(adminToken))
      .send({ rows: [{ name: 'Import Test Gamma', phone: '9000000001' }] });

    expect(res.status).toBe(200);
    expect(res.body.data.imported).toBe(0);
    expect(res.body.data.failures.length).toBe(1);
    expect(res.body.data.failures[0].reason).toMatch(/duplicate phone/i);
  });

  it('tenant isolation — dist-001 admin cannot create customers under dist-002', async () => {
    const res = await request(app)
      .post('/api/customers/import-csv')
      .set(auth(adminToken))
      .send({ rows: [{ name: 'Cross Tenant Customer', phone: '9000099999' }] });

    expect(res.status).toBe(200);
    const dist2Cust = await prisma.customer.findFirst({
      where: { distributorId: dist2Id!, customerName: 'Cross Tenant Customer' },
    });
    expect(dist2Cust).toBeNull();

    const dist1Cust = await prisma.customer.findFirst({
      where: { distributorId: dist1Id, customerName: 'Cross Tenant Customer' },
    });
    expect(dist1Cust).not.toBeNull();
  });
});

// ─── /api/customers/import-opening-balances ─────────────────────────────────

describe('POST /api/customers/import-opening-balances', () => {
  it('imports balances for a known customer', async () => {
    // Seed a customer first
    await prisma.customer.create({
      data: { distributorId: dist1Id, customerName: 'OB Test Customer', phone: '9000000010' },
    });

    const res = await request(app)
      .post('/api/customers/import-opening-balances')
      .set(auth(adminToken))
      .send({
        rows: [{ customerName: 'OB Test Customer', openingBalance: 12500, notes: 'Carried forward' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.imported).toBe(1);
    expect(res.body.data.failures).toEqual([]);

    const payments = await prisma.paymentTransaction.findMany({
      where: { distributorId: dist1Id, referenceNumber: 'opening_balance_import' },
    });
    expect(payments.length).toBe(1);
    expect(payments[0].amount).toBe(12500);
    expect(payments[0].paymentMethod).toBe('credit');

    const ledger = await prisma.customerLedgerEntry.findMany({
      where: { distributorId: dist1Id, customerId: payments[0].customerId },
    });
    expect(ledger.length).toBeGreaterThanOrEqual(1);
  });

  it('returns a row failure (not 500) for an unknown customer name', async () => {
    const res = await request(app)
      .post('/api/customers/import-opening-balances')
      .set(auth(adminToken))
      .send({
        rows: [{ customerName: 'Definitely Not A Customer ZZZZ', openingBalance: 100 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.imported).toBe(0);
    expect(res.body.data.failures.length).toBe(1);
    expect(res.body.data.failures[0].reason).toMatch(/customer not found/i);
  });

  it('tenant isolation — dist-001 admin cannot import balance against a dist-002 customer', async () => {
    // Seed a customer in dist-002 only
    await prisma.customer.create({
      data: { distributorId: dist2Id!, customerName: 'Bal Cust One', phone: '9000000020' },
    });

    const res = await request(app)
      .post('/api/customers/import-opening-balances')
      .set(auth(adminToken)) // dist-001 admin
      .send({ rows: [{ customerName: 'Bal Cust One', openingBalance: 5000 }] });

    expect(res.status).toBe(200);
    expect(res.body.data.imported).toBe(0);
    expect(res.body.data.failures.length).toBe(1);

    // No payment was created against the dist-002 customer
    const payments = await prisma.paymentTransaction.findMany({
      where: { distributorId: dist2Id!, referenceNumber: 'opening_balance_import' },
    });
    expect(payments.length).toBe(0);
  });
});

// ─── /api/analytics/overdue-call-list ────────────────────────────────────────

describe('GET /api/analytics/overdue-call-list', () => {
  let testCustomerId: string;
  const issued = new Date();
  const past = new Date(Date.now() - 15 * 86400_000);
  const future = new Date(Date.now() + 5 * 86400_000);

  beforeAll(async () => {
    // Seed: one customer with an overdue invoice + one with a future-due invoice
    const c1 = await prisma.customer.create({
      data: { distributorId: dist1Id, customerName: 'Overdue Caller', phone: '9000000100' },
    });
    testCustomerId = c1.id;
    await prisma.invoice.create({
      data: {
        invoiceNumber: `OBT-${Date.now()}-1`,
        distributorId: dist1Id,
        customerId: c1.id,
        issueDate: issued,
        dueDate: past,
        totalAmount: 1000,
        outstandingAmount: 1000,
        status: 'overdue',
      },
    });

    const c2 = await prisma.customer.create({
      data: { distributorId: dist1Id, customerName: 'Within Period', phone: '9000000101' },
    });
    await prisma.invoice.create({
      data: {
        invoiceNumber: `OBT-${Date.now()}-2`,
        distributorId: dist1Id,
        customerId: c2.id,
        issueDate: issued,
        dueDate: future,
        totalAmount: 500,
        outstandingAmount: 500,
        status: 'issued',
      },
    });

    // dist-002 customer that should NOT appear when dist-001 admin queries
    const c3 = await prisma.customer.create({
      data: { distributorId: dist2Id!, customerName: 'Other Tenant Caller', phone: '9000000102' },
    });
    await prisma.invoice.create({
      data: {
        invoiceNumber: `OBT-${Date.now()}-3`,
        distributorId: dist2Id!,
        customerId: c3.id,
        issueDate: issued,
        dueDate: past,
        totalAmount: 999,
        outstandingAmount: 999,
        status: 'overdue',
      },
    });
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({
      where: { invoiceNumber: { startsWith: 'OBT-' } },
    });
    await prisma.customer.deleteMany({
      where: { customerName: { in: ['Overdue Caller', 'Within Period', 'Other Tenant Caller'] } },
    });
  });

  it('returns customers past credit period sorted by daysOverdue desc', async () => {
    const res = await request(app)
      .get('/api/analytics/overdue-call-list')
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    const list = res.body.data as Array<{ customerName: string; daysOverdue: number; totalOutstanding: number }>;
    expect(list.find((c) => c.customerName === 'Overdue Caller')).toBeDefined();
    // Sort: each successive entry's daysOverdue must be ≤ the previous
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].daysOverdue).toBeGreaterThanOrEqual(list[i].daysOverdue);
    }
  });

  it('does NOT return customers within their credit period', async () => {
    const res = await request(app)
      .get('/api/analytics/overdue-call-list')
      .set(auth(adminToken));
    const list = res.body.data as Array<{ customerName: string }>;
    expect(list.find((c) => c.customerName === 'Within Period')).toBeUndefined();
  });

  it('tenant isolation — dist-001 query never returns dist-002 customers', async () => {
    const res = await request(app)
      .get('/api/analytics/overdue-call-list')
      .set(auth(adminToken));
    const list = res.body.data as Array<{ customerName: string }>;
    expect(list.find((c) => c.customerName === 'Other Tenant Caller')).toBeUndefined();

    // And super-admin scoped to dist-002 SEES it
    const res2 = await request(app)
      .get('/api/analytics/overdue-call-list')
      .set(auth(saToken, dist2Id!));
    expect(res2.status).toBe(200);
    const list2 = res2.body.data as Array<{ customerName: string }>;
    expect(list2.find((c) => c.customerName === 'Other Tenant Caller')).toBeDefined();
  });
});

// ─── confirm-delivery idempotency (Task 3) ──────────────────────────────────

describe('POST /api/orders/:id/confirm-delivery — idempotency', () => {
  it('confirming the same delivery twice with same quantities returns 200 (no 500)', async () => {
    // Use seed data: pick first cylinder type + a customer + driver
    const ct = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: dist1Id, isActive: true } });
    const customer = await prisma.customer.findFirstOrThrow({ where: { distributorId: dist1Id, deletedAt: null } });
    const driver = await prisma.driver.findFirstOrThrow({ where: { distributorId: dist1Id, deletedAt: null } });

    const order = await prisma.order.create({
      data: {
        orderNumber: `IDEM-${Date.now()}-A`,
        distributorId: dist1Id,
        customerId: customer.id,
        driverId: driver.id,
        orderDate: new Date(),
        deliveryDate: new Date(),
        status: 'pending_delivery',
        totalAmount: 100,
        items: { create: [{ cylinderTypeId: ct.id, quantity: 1, unitPrice: 100, discountPerUnit: 0, totalPrice: 100 }] },
      },
    });

    const body = { items: [{ cylinderTypeId: ct.id, deliveredQuantity: 1, emptiesCollected: 0 }] };

    const res1 = await request(app).post(`/api/orders/${order.id}/confirm-delivery`).set(auth(adminToken)).send(body);
    expect(res1.status).toBe(200);

    const res2 = await request(app).post(`/api/orders/${order.id}/confirm-delivery`).set(auth(adminToken)).send(body);
    expect(res2.status).toBe(200);

    // cleanup
    await prisma.orderStatusLog.deleteMany({ where: { orderId: order.id } });
    await prisma.inventoryEvent.deleteMany({ where: { referenceId: order.id } });
    await prisma.invoice.deleteMany({ where: { orderId: order.id } });
    await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
    await prisma.order.delete({ where: { id: order.id } });
  });

  it('confirming an already-delivered order with DIFFERENT quantities returns 409', async () => {
    const ct = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: dist1Id, isActive: true } });
    const customer = await prisma.customer.findFirstOrThrow({ where: { distributorId: dist1Id, deletedAt: null } });
    const driver = await prisma.driver.findFirstOrThrow({ where: { distributorId: dist1Id, deletedAt: null } });

    const order = await prisma.order.create({
      data: {
        orderNumber: `IDEM-${Date.now()}-B`,
        distributorId: dist1Id,
        customerId: customer.id,
        driverId: driver.id,
        orderDate: new Date(),
        deliveryDate: new Date(),
        status: 'pending_delivery',
        totalAmount: 200,
        items: { create: [{ cylinderTypeId: ct.id, quantity: 2, unitPrice: 100, discountPerUnit: 0, totalPrice: 200 }] },
      },
    });

    const first = { items: [{ cylinderTypeId: ct.id, deliveredQuantity: 2, emptiesCollected: 0 }] };
    const res1 = await request(app).post(`/api/orders/${order.id}/confirm-delivery`).set(auth(adminToken)).send(first);
    expect(res1.status).toBe(200);

    const second = { items: [{ cylinderTypeId: ct.id, deliveredQuantity: 1, emptiesCollected: 1 }] };
    const res2 = await request(app).post(`/api/orders/${order.id}/confirm-delivery`).set(auth(adminToken)).send(second);
    expect(res2.status).toBe(409);

    // cleanup
    await prisma.orderStatusLog.deleteMany({ where: { orderId: order.id } });
    await prisma.inventoryEvent.deleteMany({ where: { referenceId: order.id } });
    await prisma.invoice.deleteMany({ where: { orderId: order.id } });
    await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
    await prisma.order.delete({ where: { id: order.id } });
  });
});
