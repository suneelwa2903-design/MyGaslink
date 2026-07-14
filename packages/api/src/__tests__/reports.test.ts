import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken } from './helpers.js';
import type { Express } from 'express';
import { reportToCsv, type ReportResult, type ReportColumn } from '../services/reportsService.js';
import type { UserRole } from '@gaslink/shared';

let app: Express;
let token: string;

beforeAll(async () => {
  app = createApp();
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'sharma@gasdist.com' } });
  token = generateToken({ userId: admin.id, email: admin.email, role: admin.role as UserRole, distributorId: admin.distributorId });
});

const auth = () => ({ Authorization: `Bearer ${token}`, 'X-Distributor-Id': 'dist-002' });

describe('GET /api/reports/:reportType', () => {
  const types = ['sales-summary', 'outstanding-aging', 'gst-summary', 'delivery-performance', 'inventory-movement'];

  for (const t of types) {
    it(`${t} returns the standard envelope with date range`, async () => {
      const res = await request(app)
        .get(`/api/reports/${t}`)
        .query({ dateFrom: '2026-05-01', dateTo: '2026-05-31' })
        .set(auth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.columns)).toBe(true);
      expect(res.body.data.columns.length).toBeGreaterThan(0);
      expect(Array.isArray(res.body.data.rows)).toBe(true);
      // every row has every column key
      for (const r of res.body.data.rows.slice(0, 3)) {
        for (const c of res.body.data.columns) expect(r).toHaveProperty(c.key);
      }
    });
  }

  it('vehicle-ledger returns the movement envelope plus a Corporation secondary table', async () => {
    const res = await request(app)
      .get('/api/reports/vehicle-ledger')
      .query({ dateFrom: '2026-05-01', dateTo: '2026-05-31', groupBy: 'day' })
      .set(auth());
    expect(res.status).toBe(200);
    const keys = res.body.data.columns.map((c: ReportColumn) => c.key);
    expect(keys).toContain('vehicleNumber');
    expect(keys).toContain('fullsDispatched');
    expect(keys).toContain('emptiesReturnedVerified');
    expect(keys).toContain('emptiesGap');
    // secondary Corporation table is always present (may have empty rows).
    expect(res.body.data.secondary).toBeTruthy();
    expect(res.body.data.secondary.title).toMatch(/Corporation/);
    const corporationKeys = res.body.data.secondary.columns.map((c: ReportColumn) => c.key);
    expect(corporationKeys).toContain('documentNumber');
    expect(corporationKeys).toContain('quantity');
  });

  it('vehicle-ledger groupBy=trip is accepted and returns rows', async () => {
    const res = await request(app)
      .get('/api/reports/vehicle-ledger')
      .query({ dateFrom: '2026-05-01', dateTo: '2026-05-31', groupBy: 'trip' })
      .set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.rows)).toBe(true);
    // emptiesGap must equal collected − verified on every row.
    for (const r of res.body.data.rows) {
      expect(r.emptiesGap).toBe((r.emptiesCollected as number) - (r.emptiesReturnedVerified as number));
    }
  });

  it('unknown report type → 404', async () => {
    const res = await request(app).get('/api/reports/nonsense').set(auth());
    expect(res.status).toBe(404);
  });

  it('customer-statement requires customerId → 400 without it', async () => {
    const res = await request(app).get('/api/reports/customer-statement').query({ dateFrom: '2026-05-01', dateTo: '2026-05-31' }).set(auth());
    expect(res.status).toBe(400);
  });

  it('customer-statement returns rows with a running balance for a real customer', async () => {
    const cust = await prisma.customer.findFirstOrThrow({ where: { distributorId: 'dist-002', deletedAt: null } });
    const res = await request(app)
      .get('/api/reports/customer-statement')
      .query({ customerId: cust.id, dateFrom: '2026-01-01', dateTo: '2026-12-31' })
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.columns.map((c: ReportColumn) => c.key)).toContain('balance');
  });

  it('format=csv returns text/csv attachment with a header row', async () => {
    const res = await request(app)
      .get('/api/reports/gst-summary')
      .query({ dateFrom: '2026-05-01', dateTo: '2026-05-31', format: 'csv' })
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('gst-summary.csv');
    expect(res.text.split('\n')[0]).toContain('Invoice No');
  });

  it('date range filter narrows results (empty far-future window → no rows)', async () => {
    const res = await request(app)
      .get('/api/reports/sales-summary')
      .query({ dateFrom: '2099-01-01', dateTo: '2099-01-02' })
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBe(0);
  });

  it('cross-tenant isolation: dist-001 admin cannot read dist-002 via body spoof', async () => {
    const other = await prisma.user.findFirst({ where: { email: 'bhargava@gasagency.com' } });
    if (!other) return;
    const otherTok = generateToken({ userId: other.id, email: other.email, role: other.role as UserRole, distributorId: other.distributorId });
    const res = await request(app)
      .get('/api/reports/gst-summary')
      .query({ dateFrom: '2026-05-01', dateTo: '2026-05-31' })
      .set({ Authorization: `Bearer ${otherTok}` });
    // resolves to dist-001 from JWT — must not include dist-002 invoice numbers (ISHD/RSHD are dist-002 series)
    expect(res.status).toBe(200);
    const nums = res.body.data.rows.map((r: Record<string, unknown>) => r.invoiceNumber as string);
    expect(nums.some((n: string) => /SHD/.test(n))).toBe(false);
  });
});

describe('reportToCsv', () => {
  it('escapes commas/quotes and appends totals row', () => {
    const r: ReportResult = {
      columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
      rows: [{ a: 'x,y', b: 'he"llo' }],
      totals: { a: 'TOTAL', b: 5 },
    };
    const csv = reportToCsv(r);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('A,B');
    expect(lines[1]).toBe('"x,y","he""llo"');
    expect(lines[2]).toBe('TOTAL,5');
  });
});

// 2026-07-14 regression guard (Suneel): payment-collections was
// double-counting Sale Amount + Pending Amount when an invoice had
// multiple allocations in the range. Verified against prod: 6
// Vanasthali invoices produced ₹67,011 inflated Sale total. This
// test seeds ONE invoice + TWO allocations and asserts Total Sale =
// invoice.totalAmount (not 2× it), Total Pending = invoice.outstanding
// (not 2× it), Total Amount Paid = SUM of allocations (per-row math).
describe('GET /api/reports/payment-collections', () => {
  const CUSTOMER_NAME = 'PC_TEST_CUSTOMER_DOUBLECOUNT';
  const ORDER_NUMBER = 'PC-TEST-DOUBLECOUNT-1';
  const INVOICE_NUMBER = 'PC-TEST-INV-DOUBLECOUNT-1';
  const TEST_DATE = new Date('2099-12-24');
  const DIST_ID = 'dist-002';
  const INVOICE_TOTAL = 12764;
  const ALLOC_A = 12760;
  const ALLOC_B = 4;
  const OUTSTANDING = INVOICE_TOTAL - ALLOC_A - ALLOC_B; // 0
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];
  const customerIds: string[] = [];
  const paymentIds: string[] = [];

  beforeAll(async () => {
    const cyl = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: DIST_ID } });
    const customer = await prisma.customer.create({
      data: {
        distributorId: DIST_ID,
        customerName: CUSTOMER_NAME,
        businessName: CUSTOMER_NAME,
        phone: '9911511511',
        customerType: 'B2C',
      },
    });
    customerIds.push(customer.id);

    const order = await prisma.order.create({
      data: {
        orderNumber: ORDER_NUMBER,
        distributorId: DIST_ID,
        customerId: customer.id,
        orderDate: TEST_DATE,
        deliveryDate: TEST_DATE,
        status: 'delivered',
        totalAmount: INVOICE_TOTAL,
        items: {
          create: [{ cylinderTypeId: cyl.id, quantity: 4, deliveredQuantity: 4, emptiesCollected: 4, unitPrice: 3191, totalPrice: INVOICE_TOTAL }],
        },
      },
    });
    orderIds.push(order.id);

    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: INVOICE_NUMBER,
        distributorId: DIST_ID,
        customerId: customer.id,
        orderId: order.id,
        issueDate: TEST_DATE,
        dueDate: new Date(TEST_DATE.getTime() + 30 * 24 * 3600_000),
        totalAmount: INVOICE_TOTAL,
        outstandingAmount: OUTSTANDING,
        amountPaid: INVOICE_TOTAL - OUTSTANDING,
        status: 'paid',
        items: { create: [{ cylinderTypeId: cyl.id, description: '19 KG (test)', quantity: 4, unitPrice: 3191, totalPrice: INVOICE_TOTAL }] },
      },
    });
    invoiceIds.push(invoice.id);

    // Two payments — mirrors the prod pattern (big payment + rounding)
    for (const amount of [ALLOC_A, ALLOC_B]) {
      const pt = await prisma.paymentTransaction.create({
        data: {
          distributorId: DIST_ID,
          customerId: customer.id,
          amount,
          paymentMethod: 'cash',
          transactionDate: TEST_DATE,
          allocationStatus: 'fully_allocated',
          allocations: { create: [{ invoiceId: invoice.id, allocatedAmount: amount }] },
        },
      });
      paymentIds.push(pt.id);
    }
  });

  afterAll(async () => {
    await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: paymentIds } } });
    await prisma.paymentTransaction.deleteMany({ where: { id: { in: paymentIds } } });
    await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  });

  it('one row per invoice; Sale = Paid Earlier + Paid Today + Pending balances', async () => {
    // dist-002 token
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'sharma@gasdist.com' } });
    const tk = generateToken({ userId: admin.id, email: admin.email, role: admin.role as UserRole, distributorId: admin.distributorId });
    const res = await request(app)
      .get('/api/reports/payment-collections')
      .query({ dateFrom: '2099-12-01', dateTo: '2099-12-31' })
      .set({ Authorization: `Bearer ${tk}`, 'X-Distributor-Id': DIST_ID });
    expect(res.status).toBe(200);

    const columns = res.body.data.columns as ReportColumn[];
    expect(columns.map((c) => c.key)).toEqual([
      'invoiceDate', 'customerName', 'invoiceNumber',
      'fullsDelivered', 'emptiesCollected',
      'saleAmount', 'paidEarlier', 'paidToday', 'pendingAmount',
      'driverName',
    ]);

    const rows = res.body.data.rows as Array<{
      invoiceNumber: string;
      saleAmount: number;
      paidEarlier: number;
      paidToday: number;
      pendingAmount: number;
      fullsDelivered: number;
      emptiesCollected: number;
    }>;
    const myRows = rows.filter((r) => r.invoiceNumber === INVOICE_NUMBER);
    // NEW SHAPE: 1 row per unique invoice regardless of allocation count.
    expect(myRows).toHaveLength(1);

    const [row] = myRows;
    expect(row.saleAmount).toBe(INVOICE_TOTAL);
    expect(row.pendingAmount).toBe(OUTSTANDING);
    expect(row.fullsDelivered).toBe(4);
    expect(row.emptiesCollected).toBe(4);

    // Both allocations landed inside the date range → paidToday captures
    // the whole invoice-paid amount, paidEarlier = 0.
    expect(row.paidToday).toBe(ALLOC_A + ALLOC_B);
    expect(row.paidEarlier).toBe(0);

    // The math identity every row must satisfy.
    expect(row.saleAmount).toBe(row.paidEarlier + row.paidToday + row.pendingAmount);

    // Totals row also honours the identity.
    const totals = res.body.data.totals as {
      saleAmount: number;
      paidEarlier: number;
      paidToday: number;
      pendingAmount: number;
    };
    expect(Number.isFinite(totals.saleAmount)).toBe(true);
    expect(Number.isFinite(totals.paidEarlier)).toBe(true);
    expect(Number.isFinite(totals.paidToday)).toBe(true);
    expect(Number.isFinite(totals.pendingAmount)).toBe(true);
    // For all-inside-range fixture, this test's contribution to totals is
    // exactly the invoice we seeded — so distributor totals must include
    // it at least once (may aggregate other seed data too).
    expect(totals.saleAmount).toBeGreaterThanOrEqual(INVOICE_TOTAL);
    expect(totals.paidToday).toBeGreaterThanOrEqual(ALLOC_A + ALLOC_B);
  });
});
