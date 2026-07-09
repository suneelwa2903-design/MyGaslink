/**
 * driver-payment-settlement.test.ts
 *
 * Item 10 (docs/INVESTIGATION-JUL09-B.md) — driver's my-submissions list
 * carries `settledInvoices: {invoiceId, invoiceNumber, allocatedAmount}[]`
 * so the driver sees which invoices their approved payment settled.
 *
 * Pins:
 *   - Pending/rejected submissions → settledInvoices === []
 *   - Verified with N allocations → settledInvoices has N entries with
 *     matching invoiceNumber + allocatedAmount
 *   - Multi-invoice allocation: entries returned in the order the office
 *     allocated (sorted implicitly by the DB, we don't overpromise ordering)
 *   - Wire-shape guard: GET /drivers/me/payment-submissions returns the
 *     field (per anti-pattern #9 — every typed response gets a guard test)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { listByDriver } from '../services/paymentSubmissionService.js';
import { getSeedData } from './helpers.js';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import type { Express } from 'express';

const D1 = 'dist-001';

let app: Express;
let seedData: Awaited<ReturnType<typeof getSeedData>>;
let driverRowId: string;
let driverToken: string;

// Track for cleanup.
const trackedSubmissionIds: string[] = [];
const trackedPaymentIds: string[] = [];
const trackedInvoiceIds: string[] = [];
const trackedOrderIds: string[] = [];
const trackedCustomerIds: string[] = [];

async function makeCustomer(name: string) {
  const c = await prisma.customer.create({
    data: {
      distributorId: D1,
      customerName: `${name}-${Date.now().toString(36)}`,
      customerType: 'B2C',
      phone: '+919999999999',
      billingAddressLine1: 'x',
      billingState: 'Karnataka',
      billingPincode: '560001',
      billingCity: 'Bengaluru',
      status: 'active',
      creditPeriodDays: 30,
    },
  });
  trackedCustomerIds.push(c.id);
  return c;
}

async function makeInvoiceOutstanding(customerId: string, totalAmount: number): Promise<string> {
  const order = await prisma.order.create({
    data: {
      orderNumber: `T10-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      distributorId: D1,
      customerId,
      orderDate: new Date(),
      deliveryDate: new Date(),
      status: 'delivered',
      totalAmount,
      items: {
        create: [{
          cylinderTypeId: seedData.cylinderTypes[0].id,
          quantity: 1,
          unitPrice: totalAmount,
          discountPerUnit: 0,
          totalPrice: totalAmount,
          deliveredQuantity: 1,
        }],
      },
    },
  });
  trackedOrderIds.push(order.id);

  const inv = await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-T10-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 4)}`,
      distributorId: D1,
      customerId,
      orderId: order.id,
      issueDate: new Date(),
      dueDate: new Date(),
      totalAmount,
      amountPaid: 0,
      outstandingAmount: totalAmount,
      status: 'issued',
    },
  });
  trackedInvoiceIds.push(inv.id);
  return inv.id;
}

/**
 * Create a verified PaymentSubmission with N allocations. Mirrors what
 * paymentSubmissionService.verifySubmission does end-to-end — bypass here
 * for test brevity.
 */
async function makeVerifiedSubmission(opts: {
  customerId: string;
  amount: number;
  allocations: { invoiceId: string; allocatedAmount: number }[];
}): Promise<{ submissionId: string; paymentId: string }> {
  // 1) Real PaymentTransaction (the office-verify step's shadow row).
  const payment = await prisma.paymentTransaction.create({
    data: {
      distributorId: D1,
      customerId: opts.customerId,
      amount: opts.amount,
      paymentMethod: 'cash',
      transactionDate: new Date(),
      allocations: {
        create: opts.allocations.map((a) => ({
          invoiceId: a.invoiceId,
          allocatedAmount: a.allocatedAmount,
        })),
      },
    },
  });
  trackedPaymentIds.push(payment.id);

  // 2) PaymentSubmission verified → resulting_payment_id points at (1).
  const submission = await prisma.paymentSubmission.create({
    data: {
      distributorId: D1,
      customerId: opts.customerId,
      submittedByDriverId: driverRowId,
      submittedBy: 'driver',
      amount: opts.amount,
      paymentMethod: 'cash',
      transactionDate: new Date(),
      status: 'verified',
      verifiedAt: new Date(),
      resultingPaymentId: payment.id,
    },
  });
  trackedSubmissionIds.push(submission.id);
  return { submissionId: submission.id, paymentId: payment.id };
}

async function makePendingSubmission(customerId: string, amount: number): Promise<string> {
  const s = await prisma.paymentSubmission.create({
    data: {
      distributorId: D1,
      customerId,
      submittedByDriverId: driverRowId,
      submittedBy: 'driver',
      amount,
      paymentMethod: 'cash',
      transactionDate: new Date(),
      status: 'pending_verification',
    },
  });
  trackedSubmissionIds.push(s.id);
  return s.id;
}

beforeAll(async () => {
  app = createApp();
  seedData = await getSeedData();

  // Find the driver's associated user row so we can mint a driver JWT.
  const driver = seedData.drivers[0];
  driverRowId = driver.id;
  const user = await prisma.user.findFirst({
    where: { distributorId: D1, role: 'driver', phone: driver.phone },
    select: { id: true, email: true, role: true, distributorId: true },
  });
  if (!user) throw new Error('No driver user found — check seed');
  driverToken = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      distributorId: user.distributorId,
      customerId: null,
    },
    config.jwt.accessSecret,
    { expiresIn: '1h' },
  );
});

afterAll(async () => {
  if (trackedSubmissionIds.length) {
    await prisma.paymentSubmission.deleteMany({ where: { id: { in: trackedSubmissionIds } } });
  }
  if (trackedPaymentIds.length) {
    await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: trackedPaymentIds } } });
    await prisma.paymentTransaction.deleteMany({ where: { id: { in: trackedPaymentIds } } });
  }
  if (trackedInvoiceIds.length) {
    await prisma.invoice.deleteMany({ where: { id: { in: trackedInvoiceIds } } });
  }
  if (trackedOrderIds.length) {
    await prisma.orderItem.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: trackedOrderIds } } });
  }
  if (trackedCustomerIds.length) {
    await prisma.customerLedgerEntry.deleteMany({ where: { customerId: { in: trackedCustomerIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: trackedCustomerIds } } });
  }
});

describe('Item 10 — driver settled invoices in listByDriver', () => {
  it('T1 — verified submission with 1 allocation → settledInvoices has 1 entry', async () => {
    const c = await makeCustomer('T1-c');
    const invId = await makeInvoiceOutstanding(c.id, 500);
    await makeVerifiedSubmission({
      customerId: c.id,
      amount: 500,
      allocations: [{ invoiceId: invId, allocatedAmount: 500 }],
    });

    const result = await listByDriver(D1, driverRowId);
    const mine = result.submissions.filter((s) => trackedSubmissionIds.includes(s.id));
    const row = mine.find((s) => s.customerId === c.id);
    expect(row).toBeDefined();
    expect(row!.settledInvoices).toHaveLength(1);
    expect(row!.settledInvoices[0].invoiceId).toBe(invId);
    expect(row!.settledInvoices[0].allocatedAmount).toBe(500);
  });

  it('T2 — verified submission with 2 allocations → settledInvoices has 2 entries', async () => {
    const c = await makeCustomer('T2-c');
    const inv1 = await makeInvoiceOutstanding(c.id, 400);
    const inv2 = await makeInvoiceOutstanding(c.id, 300);
    await makeVerifiedSubmission({
      customerId: c.id,
      amount: 700,
      allocations: [
        { invoiceId: inv1, allocatedAmount: 400 },
        { invoiceId: inv2, allocatedAmount: 300 },
      ],
    });

    const result = await listByDriver(D1, driverRowId);
    const row = result.submissions.find((s) => s.customerId === c.id);
    expect(row).toBeDefined();
    expect(row!.settledInvoices).toHaveLength(2);
    const total = row!.settledInvoices.reduce((s, si) => s + si.allocatedAmount, 0);
    expect(total).toBe(700);
    const ids = row!.settledInvoices.map((si) => si.invoiceId).sort();
    expect(ids).toEqual([inv1, inv2].sort());
  });

  it('T3 — pending submission → settledInvoices is []', async () => {
    const c = await makeCustomer('T3-c');
    await makePendingSubmission(c.id, 200);
    const result = await listByDriver(D1, driverRowId);
    const row = result.submissions.find((s) => s.customerId === c.id);
    expect(row).toBeDefined();
    expect(row!.settledInvoices).toEqual([]);
  });

  it('T4 — Wire-shape guard: GET /drivers/me/payment-submissions returns settledInvoices field', async () => {
    // Use a fresh customer with a verified submission so this test's row
    // is easy to identify in the response.
    const c = await makeCustomer('T4-c');
    const invId = await makeInvoiceOutstanding(c.id, 150);
    await makeVerifiedSubmission({
      customerId: c.id,
      amount: 150,
      allocations: [{ invoiceId: invId, allocatedAmount: 150 }],
    });

    const res = await request(app)
      .get('/api/drivers/me/payment-submissions')
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(200);
    const payload = res.body.data ?? res.body;
    const submissions = Array.isArray(payload) ? payload : payload.submissions;
    const row = submissions.find((s: { customerId: string }) => s.customerId === c.id);
    expect(row).toBeDefined();
    expect(row.settledInvoices).toBeDefined();
    expect(Array.isArray(row.settledInvoices)).toBe(true);
    expect(row.settledInvoices).toHaveLength(1);
    expect(row.settledInvoices[0].invoiceId).toBe(invId);
    expect(row.settledInvoices[0].allocatedAmount).toBe(150);
  });
});
