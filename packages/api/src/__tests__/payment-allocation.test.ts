/**
 * WI-092 — Manual payment allocation (paymentService.allocatePayment).
 *
 * Covers the happy path (invoice + payment state updated, NO duplicate ledger
 * entry) and the four validation rejections. Service-level tests: they call
 * allocatePayment directly and assert DB state + PaymentError status codes.
 *
 * Fixtures use dedicated customers/invoices/payments created here and torn
 * down in afterAll — never the seeded fleet (anti-pattern #7/#8).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { allocatePayment } from '../services/paymentService.js';

const DIST = 'dist-002';
const OTHER_DIST = 'dist-001';

const createdCustomerIds: string[] = [];
const createdInvoiceIds: string[] = [];
const createdPaymentIds: string[] = [];

let userId: string;
let customerA: { id: string };
let customerB: { id: string };

async function makeCustomer(name: string, distributorId = DIST) {
  const c = await prisma.customer.create({
    data: {
      distributorId,
      customerName: name,
      phone: '9' + Math.random().toString().slice(2, 11),
      customerType: 'B2C',
    },
  });
  createdCustomerIds.push(c.id);
  return c;
}

async function makeInvoice(customerId: string | null, outstanding: number, distributorId = DIST) {
  const inv = await prisma.invoice.create({
    data: {
      invoiceNumber: `ALLOC-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      distributorId,
      customerId,
      issueDate: new Date(),
      dueDate: new Date(),
      totalAmount: outstanding,
      amountPaid: 0,
      outstandingAmount: outstanding,
      status: 'issued',
    },
  });
  createdInvoiceIds.push(inv.id);
  return inv;
}

async function makePayment(customerId: string, amount: number, distributorId = DIST) {
  const p = await prisma.paymentTransaction.create({
    data: {
      distributorId,
      customerId,
      amount,
      paymentMethod: 'cash',
      transactionDate: new Date(),
      allocationStatus: 'unallocated',
    },
  });
  createdPaymentIds.push(p.id);
  return p;
}

beforeAll(async () => {
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'sharma@gasdist.com' } });
  userId = admin.id;
  customerA = await makeCustomer('WI-092 Alloc Cust A');
  customerB = await makeCustomer('WI-092 Alloc Cust B');
});

afterAll(async () => {
  await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: createdPaymentIds } } });
  await prisma.paymentTransaction.deleteMany({ where: { id: { in: createdPaymentIds } } });
  await prisma.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
  await prisma.customerLedgerEntry.deleteMany({ where: { customerId: { in: createdCustomerIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
});

describe('WI-092 — allocatePayment success', () => {
  it('creates an allocation, updates invoice + payment, and creates NO ledger entry', async () => {
    const payment = await makePayment(customerA.id, 1000);
    const invoice = await makeInvoice(customerA.id, 600);

    const ledgerBefore = await prisma.customerLedgerEntry.count({ where: { customerId: customerA.id } });

    const result = await allocatePayment(DIST, userId, payment.id, { invoiceId: invoice.id, amount: 600 });

    // PaymentAllocation row created with the correct amount.
    const allocs = await prisma.paymentAllocation.findMany({ where: { paymentId: payment.id } });
    expect(allocs).toHaveLength(1);
    expect(Number(allocs[0].allocatedAmount)).toBe(600);

    // Invoice outstanding reduced to 0 → status 'paid'.
    const updatedInv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(Number(updatedInv.outstandingAmount)).toBe(0);
    expect(Number(updatedInv.amountPaid)).toBe(600);
    expect(updatedInv.status).toBe('paid');

    // Payment: 600 of 1000 allocated → partially_allocated.
    const updatedPay = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: payment.id } });
    expect(updatedPay.allocationStatus).toBe('partially_allocated');
    expect(result.payment.unallocatedAmount).toBe(400);

    // No new ledger entry — the payment was already recorded in the ledger
    // when it was first created; allocation must not double-count.
    const ledgerAfter = await prisma.customerLedgerEntry.count({ where: { customerId: customerA.id } });
    expect(ledgerAfter).toBe(ledgerBefore);
  });
});

describe('WI-092 — allocatePayment validations', () => {
  it('rejects 404 when the payment belongs to a different distributor', async () => {
    const payment = await makePayment(customerA.id, 500);
    const invoice = await makeInvoice(customerA.id, 300);
    await expect(
      allocatePayment(OTHER_DIST, userId, payment.id, { invoiceId: invoice.id, amount: 100 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects 400 when the invoice belongs to a different customer than the payment', async () => {
    const payment = await makePayment(customerA.id, 500);
    const invoiceForB = await makeInvoice(customerB.id, 300);
    await expect(
      allocatePayment(DIST, userId, payment.id, { invoiceId: invoiceForB.id, amount: 100 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects 400 when the amount exceeds the unallocated payment amount', async () => {
    const payment = await makePayment(customerA.id, 500);
    const invoice = await makeInvoice(customerA.id, 1000);
    await expect(
      allocatePayment(DIST, userId, payment.id, { invoiceId: invoice.id, amount: 600 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects 400 when the amount exceeds the invoice outstanding amount', async () => {
    const payment = await makePayment(customerA.id, 1000);
    const invoice = await makeInvoice(customerA.id, 400);
    await expect(
      allocatePayment(DIST, userId, payment.id, { invoiceId: invoice.id, amount: 600 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
