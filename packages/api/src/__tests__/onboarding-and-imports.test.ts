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
        legalName: 'Test Tenant 2 Pvt Ltd',
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
  // matters: ledger → invoices → customers.
  //
  // Group 1 (2026-06-11): the importer now stamps narration with
  // 'Opening Balance b/f' (was 'Opening balance import — …'). Match BOTH
  // prefixes so older test runs and the new path both clean. Match by
  // `invoice.isOpeningBalance` is the most robust signal, but
  // CustomerLedgerEntry has no FK-traversable filter on the linked invoice
  // when invoiceId is null, so a narration substring stays the simplest
  // catch-all.
  await prisma.customerLedgerEntry.deleteMany({
    where: {
      distributorId: { in: [dist1Id, dist2Id ?? '__none__'] },
      OR: [
        { narration: { contains: 'Opening balance import' } },
        { narration: { contains: 'Opening Balance b/f' } },
      ],
    },
  });
  await prisma.invoice.deleteMany({
    where: {
      OR: [
        { distributorId: dist1Id, isOpeningBalance: true },
        { distributorId: dist2Id ?? '__none__', isOpeningBalance: true },
      ],
    },
  });
  await prisma.customer.deleteMany({
    where: { customerName: { in: TRACK_NAMES } },
  });
});

afterAll(async () => {
  await prisma.customerLedgerEntry.deleteMany({
    where: {
      OR: [
        { narration: { contains: 'Opening balance import' } },
        { narration: { contains: 'Opening Balance b/f' } },
      ],
    },
  });
  await prisma.invoice.deleteMany({
    where: { isOpeningBalance: true, customer: { customerName: { in: TRACK_NAMES } } },
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

  it('Group 3: re-import on the same phone UPDATES the matched customer (upsert behavior)', async () => {
    // Group 3 (2026-06-11): importCustomers now upserts. A re-run with the
    // same phone but a different name UPDATES the existing customer record
    // (it does not fail with "duplicate phone" as the old contract did).
    // This is the foundation of the "split/partial uploads" workflow.
    const first = await request(app)
      .post('/api/customers/import-csv')
      .set(auth(adminToken))
      .send({ rows: [{ name: 'Import Test Alpha', phone: '9000000001' }] });
    expect(first.body.data.created).toBe(1);
    expect(first.body.data.updated).toBe(0);

    const res = await request(app)
      .post('/api/customers/import-csv')
      .set(auth(adminToken))
      .send({ rows: [{ name: 'Import Test Gamma', phone: '9000000001' }] });

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(0);
    expect(res.body.data.updated).toBe(1);
    expect(res.body.data.imported).toBe(1); // back-compat alias = created + updated
    expect(res.body.data.failures.length).toBe(0);
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
  it('creates an overdue Invoice (not a Payment) for a known customer', async () => {
    // Seed a customer first
    const cust = await prisma.customer.create({
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

    // Stored as an overdue, opening-balance Invoice — not a Payment
    const invoices = await prisma.invoice.findMany({
      where: { distributorId: dist1Id, customerId: cust.id, isOpeningBalance: true },
    });
    expect(invoices.length).toBe(1);
    expect(Number(invoices[0].outstandingAmount)).toBe(12500);
    expect(Number(invoices[0].totalAmount)).toBe(12500);
    expect(Number(invoices[0].amountPaid)).toBe(0);
    expect(invoices[0].status).toBe('overdue');
    expect(invoices[0].invoiceNumber.startsWith('OB-')).toBe(true);

    // Old-style payment row should NOT exist for opening balances
    const payments = await prisma.paymentTransaction.findMany({
      where: { distributorId: dist1Id, customerId: cust.id, referenceNumber: 'opening_balance_import' },
    });
    expect(payments.length).toBe(0);

    const ledger = await prisma.customerLedgerEntry.findMany({
      where: { distributorId: dist1Id, customerId: cust.id, invoiceId: invoices[0].id },
    });
    expect(ledger.length).toBeGreaterThanOrEqual(1);
    expect(ledger[0].entryType).toBe('invoice_entry');
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

    // No opening-balance invoice was created against the dist-002 customer
    const invoices = await prisma.invoice.findMany({
      where: { distributorId: dist2Id!, isOpeningBalance: true },
    });
    expect(invoices.length).toBe(0);
  });
});

// ─── /api/analytics/overdue-call-list ────────────────────────────────────────

describe('GET /api/analytics/overdue-call-list', () => {
  const issued = new Date();
  const past = new Date(Date.now() - 15 * 86400_000);
  const future = new Date(Date.now() + 5 * 86400_000);
  // 2026-06-18: track ids at create time so afterAll deletes ONLY what we
  // created, not every customer that happens to share these names. Previously
  // ~94 leftover rows accumulated on the dev DB because the cleanup ran by
  // name and either skipped customers with FK refs or wasn't scoped.
  const seededCustomerIds: string[] = [];

  beforeAll(async () => {
    // FK-safe sweep of leftover rows from prior failed runs (same names +
    // same fixed phones we seed below). Drop every FK first or P2003 throws.
    const oldCustomers = await prisma.customer.findMany({
      where: {
        OR: [
          { distributorId: dist1Id, phone: { in: ['9000000100', '9000000101'] } },
          { distributorId: dist2Id!, phone: '9000000102' },
        ],
      },
      select: { id: true },
    });
    if (oldCustomers.length > 0) {
      const ids = oldCustomers.map((c) => c.id);
      await prisma.customerInventoryBalance.deleteMany({ where: { customerId: { in: ids } } });
      await prisma.customerLedgerEntry.deleteMany({ where: { customerId: { in: ids } } });
      const oldInvoices = await prisma.invoice.findMany({
        where: { customerId: { in: ids } },
        select: { id: true },
      });
      const invIds = oldInvoices.map((i) => i.id);
      if (invIds.length > 0) {
        await prisma.creditNote.deleteMany({ where: { invoiceId: { in: invIds } } });
        await prisma.debitNote.deleteMany({ where: { invoiceId: { in: invIds } } });
        await prisma.gstDocument.deleteMany({ where: { invoiceId: { in: invIds } } });
        await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: invIds } } });
        await prisma.invoice.deleteMany({ where: { id: { in: invIds } } });
      }
      const oldOrders = await prisma.order.findMany({
        where: { customerId: { in: ids } },
        select: { id: true },
      });
      const orderIds = oldOrders.map((o) => o.id);
      if (orderIds.length > 0) {
        await prisma.driverAssignment.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.cancelledStockEvent.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      }
      await prisma.paymentTransaction.deleteMany({ where: { customerId: { in: ids } } });
      await prisma.user.deleteMany({ where: { customerId: { in: ids } } });
      await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    }
    // Also clear any orphan OBT-* invoices from prior runs (their customer
    // may have been deleted by an earlier afterAll branch).
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: 'OBT-' } } });

    // Seed: one customer with an overdue invoice + one with a future-due invoice
    const c1 = await prisma.customer.create({
      data: { distributorId: dist1Id, customerName: 'Overdue Caller', phone: '9000000100' },
    });
    seededCustomerIds.push(c1.id);
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
    seededCustomerIds.push(c2.id);
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
    seededCustomerIds.push(c3.id);
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
    // 2026-06-18: delete by SEEDED IDS captured in beforeAll, not by name.
    // Name-based delete swept the same names across every prior run, hit
    // FK violations the moment any leftover customer had a balance/ledger
    // row, and accumulated ~94 stale rows on the dev DB.
    if (seededCustomerIds.length > 0) {
      // FK chain: balance + ledger + invoices/items/gst-docs + orders/items/
      // status-log/driver-assignment/CSE + payments before customer delete.
      await prisma.customerInventoryBalance.deleteMany({
        where: { customerId: { in: seededCustomerIds } },
      });
      await prisma.customerLedgerEntry.deleteMany({
        where: { customerId: { in: seededCustomerIds } },
      });
      const inv = await prisma.invoice.findMany({
        where: { customerId: { in: seededCustomerIds } },
        select: { id: true },
      });
      const invIds = inv.map((i) => i.id);
      if (invIds.length > 0) {
        await prisma.creditNote.deleteMany({ where: { invoiceId: { in: invIds } } });
        await prisma.debitNote.deleteMany({ where: { invoiceId: { in: invIds } } });
        await prisma.gstDocument.deleteMany({ where: { invoiceId: { in: invIds } } });
        await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: invIds } } });
        await prisma.invoice.deleteMany({ where: { id: { in: invIds } } });
      }
      await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: 'OBT-' } } });
      const ord = await prisma.order.findMany({
        where: { customerId: { in: seededCustomerIds } },
        select: { id: true },
      });
      const orderIds = ord.map((o) => o.id);
      if (orderIds.length > 0) {
        await prisma.driverAssignment.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.cancelledStockEvent.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      }
      await prisma.paymentTransaction.deleteMany({ where: { customerId: { in: seededCustomerIds } } });
      await prisma.user.deleteMany({ where: { customerId: { in: seededCustomerIds } } });
      await prisma.customer.deleteMany({ where: { id: { in: seededCustomerIds } } });
    } else {
      // Fallback for the unusual path where beforeAll failed mid-seed —
      // still try to clear any OBT-* invoices that may have been written.
      await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: 'OBT-' } } });
    }
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
