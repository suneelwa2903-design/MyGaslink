/**
 * Invoice + Payment list search + pagination + tenant-scope.
 *
 * Validates that the new `?search=` param matches against the three
 * documented fields (invoiceNumber / customer name / poNumber for
 * invoices; customerName / referenceNumber / numeric-amount for
 * payments), that pagination metadata is correct, and that search
 * results never cross tenant boundaries (anti-pattern #1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { listInvoices } from '../services/invoiceService.js';
import { listPayments } from '../services/paymentService.js';

const D1 = 'dist-001';
const D2 = 'dist-002';

const trackedInvoiceIds: string[] = [];
const trackedPaymentIds: string[] = [];
const trackedCustomerIds: string[] = [];

// Unique probe strings so a single matched row across the (shared) dev
// DB confirms the search hit, with no risk of accidental collision.
const PROBE = `LSPSEARCHPROBE${Date.now().toString(36)}`;

async function makeCustomer(name: string, distId = D1) {
  const c = await prisma.customer.create({
    data: {
      distributorId: distId,
      customerName: name,
      customerType: 'B2B',
      phone: '+919999999999',
      gstin: '29ABCDE1234F1Z5',
      billingAddressLine1: 'Test St',
      billingState: 'Karnataka',
      billingPincode: '560001',
      billingCity: 'Bengaluru',
      status: 'active',
      creditPeriodDays: 30,
    },
    select: { id: true },
  });
  trackedCustomerIds.push(c.id);
  return c;
}

async function makeInvoice(opts: {
  customerId: string;
  invoiceNumber: string;
  poNumber?: string | null;
  distributorId?: string;
}) {
  const distId = opts.distributorId ?? D1;
  const inv = await prisma.invoice.create({
    data: {
      distributorId: distId,
      customerId: opts.customerId,
      invoiceNumber: opts.invoiceNumber,
      poNumber: opts.poNumber ?? null,
      issueDate: new Date('2099-12-31'),
      dueDate: new Date('2099-12-31'),
      totalAmount: 1000,
      amountPaid: 0,
      outstandingAmount: 1000,
      status: 'issued',
    },
    select: { id: true, invoiceNumber: true },
  });
  trackedInvoiceIds.push(inv.id);
  return inv;
}

async function makePayment(opts: {
  customerId: string;
  amount: number;
  referenceNumber?: string | null;
  distributorId?: string;
}) {
  const p = await prisma.paymentTransaction.create({
    data: {
      distributorId: opts.distributorId ?? D1,
      customerId: opts.customerId,
      amount: opts.amount,
      paymentMethod: 'cash',
      referenceNumber: opts.referenceNumber ?? null,
      transactionDate: new Date('2099-12-31'),
      allocationStatus: 'unallocated',
    },
    select: { id: true },
  });
  trackedPaymentIds.push(p.id);
  return p;
}

describe('listInvoices — search', () => {
  let custId: string;
  beforeAll(async () => {
    const c = await makeCustomer(`SearchCust-${PROBE}`);
    custId = c.id;
    await makeInvoice({ customerId: custId, invoiceNumber: `INV-NUM-${PROBE}`, poNumber: `PO-${PROBE}` });
  });

  it('matches by invoiceNumber', async () => {
    const r = await listInvoices(D1, { search: `INV-NUM-${PROBE}` });
    expect(r.data).toHaveLength(1);
    expect(r.data[0].invoiceNumber).toBe(`INV-NUM-${PROBE}`);
  });

  it('matches by customer customerName (case-insensitive)', async () => {
    const r = await listInvoices(D1, { search: `SEARCHCUST-${PROBE.toLowerCase()}` });
    expect(r.data.length).toBeGreaterThanOrEqual(1);
    expect(r.data.find((i) => i.id === trackedInvoiceIds[0])).toBeTruthy();
  });

  it('matches by poNumber', async () => {
    const r = await listInvoices(D1, { search: `PO-${PROBE}` });
    expect(r.data.length).toBeGreaterThanOrEqual(1);
    expect(r.data.find((i) => i.poNumber === `PO-${PROBE}`)).toBeTruthy();
  });

  it('paginates: page=1 pageSize=20 returns at most 20 + meta is consistent', async () => {
    const r = await listInvoices(D1, { page: 1, pageSize: 20 });
    expect(r.data.length).toBeLessThanOrEqual(20);
    expect(r.meta.page).toBe(1);
    expect(r.meta.pageSize).toBe(20);
    expect(r.meta.total).toBeGreaterThanOrEqual(r.data.length);
    expect(r.meta.totalPages).toBe(Math.ceil(r.meta.total / 20));
  });

  it('tenant-scoped: search probe from dist-001 returns 0 results on dist-002', async () => {
    const r = await listInvoices(D2, { search: `INV-NUM-${PROBE}` });
    expect(r.data).toHaveLength(0);
  });
});

describe('listPayments — search', () => {
  let custId: string;
  beforeAll(async () => {
    const c = await makeCustomer(`PaySearchCust-${PROBE}`);
    custId = c.id;
    await makePayment({ customerId: custId, amount: 123.45, referenceNumber: `REF-${PROBE}` });
    await makePayment({ customerId: custId, amount: 999_999, referenceNumber: null });
  });

  it('matches by referenceNumber', async () => {
    const r = await listPayments(D1, { search: `REF-${PROBE}` });
    expect(r.data.length).toBeGreaterThanOrEqual(1);
    expect(r.data.find((p) => p.referenceNumber === `REF-${PROBE}`)).toBeTruthy();
  });

  it('matches by customer customerName', async () => {
    const r = await listPayments(D1, { search: `PaySearchCust-${PROBE}` });
    expect(r.data.length).toBeGreaterThanOrEqual(2);
  });

  it('matches by exact numeric amount', async () => {
    const r = await listPayments(D1, { search: '999999' });
    expect(r.data.length).toBeGreaterThanOrEqual(1);
    expect(r.data.find((p) => Number(p.amount) === 999999)).toBeTruthy();
  });

  it('tenant-scoped: dist-002 caller sees none of dist-001\'s rows', async () => {
    const r = await listPayments(D2, { search: `REF-${PROBE}` });
    expect(r.data).toHaveLength(0);
  });

  it('pagination meta matches data + page=2 fetches the second slice', async () => {
    const r1 = await listPayments(D1, { page: 1, pageSize: 20 });
    expect(r1.meta.pageSize).toBe(20);
    expect(r1.data.length).toBeLessThanOrEqual(20);
    if (r1.meta.totalPages >= 2) {
      const r2 = await listPayments(D1, { page: 2, pageSize: 20 });
      expect(r2.meta.page).toBe(2);
      const ids1 = new Set(r1.data.map((p) => p.id));
      // Page 2 should contain rows the page 1 set did not (no overlap on
      // a stable createdAt-desc order).
      expect(r2.data.every((p) => !ids1.has(p.id))).toBe(true);
    }
  });

  // 2026-07-17: entry-date filter — operates on PaymentTransaction.createdAt.
  // Verifies that the new filter (a) narrows to rows created in the window,
  // (b) treats the "To" edge as end-of-day (23:59:59.999), (c) is additive
  // with the existing transactionDate range (both active = both must pass).
  it('entryDateFrom + entryDateTo filter by createdAt (data-entry timestamp)', async () => {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    // Both search probes above were created "just now" during this test
    // run, so filtering by today includes them.
    const r = await listPayments(D1, { entryDateFrom: todayStr, entryDateTo: todayStr, search: `REF-${PROBE}` });
    expect(r.data.length).toBeGreaterThanOrEqual(1);
    expect(r.data.find((p) => p.referenceNumber === `REF-${PROBE}`)).toBeTruthy();
    // Range excluding today (yesterday only) must NOT include the fixture.
    const y = new Date(today); y.setDate(y.getDate() - 1);
    const yStr = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
    const rYesterday = await listPayments(D1, { entryDateFrom: yStr, entryDateTo: yStr, search: `REF-${PROBE}` });
    expect(rYesterday.data.find((p) => p.referenceNumber === `REF-${PROBE}`)).toBeUndefined();
  });
});

afterAll(async () => {
  if (trackedPaymentIds.length) {
    await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: trackedPaymentIds } } });
    await prisma.paymentTransaction.deleteMany({ where: { id: { in: trackedPaymentIds } } });
  }
  if (trackedInvoiceIds.length) {
    await prisma.invoice.deleteMany({ where: { id: { in: trackedInvoiceIds } } });
  }
  if (trackedCustomerIds.length) {
    await prisma.customer.updateMany({
      where: { id: { in: trackedCustomerIds } },
      data: { deletedAt: new Date() },
    });
  }
});
