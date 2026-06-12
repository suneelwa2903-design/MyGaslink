/**
 * Phase F — Razorpay customer-portal payments (customer → distributor).
 *
 * Two key differences from Phase E:
 *   - Credentials are per-distributor (DB-stored), not GasLink-wide
 *     (env-stored). Each tenant's payments go to THEIR Razorpay
 *     account; GasLink never touches the money.
 *   - The recording path goes through paymentService.createPayment
 *     (the shared service every payment route uses) so allocation
 *     and ledger logic stays in lockstep with manual payments.
 *
 * What's tested:
 *   - Super-admin setting razorpayEnabled + keyId + secrets + webhook
 *     secret via PUT /distributors/:id; secrets NEVER appear in any
 *     GET response.
 *   - Non-super-admin role gates on the credential write path.
 *   - POST /customer-portal/invoices/:id/create-payment-order:
 *     enabled gate, cross-customer guard, amount bounds, mock-mode
 *     order returned.
 *   - POST /customer-portal/invoices/:id/verify-payment: signature
 *     verify, payment recording via paymentService (allocation +
 *     ledger), idempotency, cross-customer gate.
 *   - Webhook signature verification (per-distributor secret), event
 *     handling, idempotency, missing-field race-safety.
 *   - Manual payment recording unaffected (regression check).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../app.js';
import {
  loginAsDistAdmin,
  loginAsSuperAdmin,
  generateToken,
} from './helpers.js';
import { prisma } from '../lib/prisma.js';
import type { Express } from 'express';
import { UserRole } from '@gaslink/shared';

let app: Express;
let superAdminToken: string;
let distAdminToken: string;
let customerToken: string;        // customer for dist-001
// crossCustomerToken intentionally created in beforeAll for completeness
// even though the cross-customer tests assert via the dist-001 token
// hitting a dist-002 invoice. Underscored to satisfy no-unused-vars.
let _crossCustomerToken: string;

let invoiceId: string;       // customer's own invoice on dist-001
let crossInvoiceId: string;  // dist-002 invoice (cross-tenant)
let customerId: string;
let crossCustomerId: string;

const RZP_KEY_ID = 'rzp_test_phaseF_mock';
const RZP_KEY_SECRET = 'phaseF_secret_xyz';
const RZP_WEBHOOK_SECRET = 'wh_phaseF_secret';

// Real-mode HMAC (uses the live key_secret for signature gen so
// verifyHandlerSignature actually runs).
const REAL_KEY_ID = 'rzp_test_phaseF_real';
const REAL_KEY_SECRET = 'phaseF_real_secret_abc';

beforeAll(async () => {
  app = createApp();
  superAdminToken = (await loginAsSuperAdmin()).token;
  distAdminToken = (await loginAsDistAdmin()).token;

  // Find a customer user on dist-001 + dist-002 for the portal calls.
  const cust1 = await prisma.user.findFirstOrThrow({
    where: { distributorId: 'dist-001', role: 'customer', customerId: { not: null } },
  });
  const cust2 = await prisma.user.findFirstOrThrow({
    where: { distributorId: 'dist-002', role: 'customer', customerId: { not: null } },
  });
  customerId = cust1.customerId!;
  crossCustomerId = cust2.customerId!;
  customerToken = generateToken({
    userId: cust1.id, email: cust1.email,
    role: UserRole.CUSTOMER, distributorId: cust1.distributorId,
    customerId: cust1.customerId,
  });
  _crossCustomerToken = generateToken({
    userId: cust2.id, email: cust2.email,
    role: UserRole.CUSTOMER, distributorId: cust2.distributorId,
    customerId: cust2.customerId,
  });

  // Seed fixture invoices with outstanding balance. Far-future date
  // so they never collide with real test data. We can't rely on the
  // seed's invoices because they may be fully paid or absent.
  const fixtureInv = await prisma.invoice.create({
    data: {
      distributorId: 'dist-001',
      customerId,
      invoiceNumber: `PHASEF-${Date.now()}-1`,
      issueDate: new Date('2099-10-01'),
      dueDate: new Date('2099-10-31'),
      totalAmount: 500,
      amountPaid: 0,
      outstandingAmount: 500,
      status: 'issued',
    },
  });
  invoiceId = fixtureInv.id;
  const crossFixtureInv = await prisma.invoice.create({
    data: {
      distributorId: 'dist-002',
      customerId: crossCustomerId,
      invoiceNumber: `PHASEF-${Date.now()}-2`,
      issueDate: new Date('2099-10-01'),
      dueDate: new Date('2099-10-31'),
      totalAmount: 500,
      amountPaid: 0,
      outstandingAmount: 500,
      status: 'issued',
    },
  });
  crossInvoiceId = crossFixtureInv.id;
});

afterAll(async () => {
  // Restore dist-001 + dist-002 to razorpayEnabled=false to keep the
  // DB clean for the next session.
  await prisma.distributor.update({
    where: { id: 'dist-001' },
    data: {
      razorpayEnabled: false,
      razorpayKeyId: null,
      razorpayKeySecret: null,
      razorpayWebhookSecret: null,
    },
  });
  // Clean up fixture invoices + any payments we created against them.
  await prisma.paymentAllocation.deleteMany({
    where: { invoiceId: { in: [invoiceId, crossInvoiceId] } },
  });
  await prisma.paymentTransaction.deleteMany({
    where: {
      OR: [
        { razorpayPaymentId: { startsWith: 'pay_phaseF_' } },
      ],
    },
  });
  await prisma.invoice.deleteMany({
    where: { id: { in: [invoiceId, crossInvoiceId] } },
  });
});

// ─── 1. Super-admin credential write + secret-hiding ────────────────────────

describe('PUT /api/distributors/:id — Razorpay credential writes', () => {
  it('super-admin can enable Razorpay and set keyId + secrets', async () => {
    const res = await request(app)
      .put('/api/distributors/dist-001')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        razorpayEnabled: true,
        razorpayKeyId: RZP_KEY_ID,
        razorpayKeySecret: RZP_KEY_SECRET,
        razorpayWebhookSecret: RZP_WEBHOOK_SECRET,
      });
    expect(res.status).toBe(200);
    expect(res.body.data.razorpayEnabled).toBe(true);
    expect(res.body.data.razorpayKeyId).toBe(RZP_KEY_ID);
    // Critical guarantee: secrets NEVER returned, even on the write
    // response. distributorSelect-as-chokepoint enforces it.
    expect(res.body.data.razorpayKeySecret).toBeUndefined();
    expect(res.body.data.razorpayWebhookSecret).toBeUndefined();

    // But they ARE persisted internally (verify via raw Prisma).
    const dist = await prisma.distributor.findUnique({
      where: { id: 'dist-001' },
      select: { razorpayKeySecret: true, razorpayWebhookSecret: true },
    });
    expect(dist?.razorpayKeySecret).toBe(RZP_KEY_SECRET);
    expect(dist?.razorpayWebhookSecret).toBe(RZP_WEBHOOK_SECRET);
  });

  it('GET /api/distributors does NOT leak secrets in the list response', async () => {
    const res = await request(app)
      .get('/api/distributors')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
    for (const dist of res.body.data.distributors) {
      expect(dist.razorpayKeySecret).toBeUndefined();
      expect(dist.razorpayWebhookSecret).toBeUndefined();
    }
  });

  it('distributor_admin → 403 on PUT /distributors/:id (route is super-admin only)', async () => {
    const res = await request(app)
      .put('/api/distributors/dist-001')
      .set('Authorization', `Bearer ${distAdminToken}`)
      .send({ razorpayEnabled: false });
    expect(res.status).toBe(403);
  });
});

// ─── 2. POST /customer-portal/invoices/:id/create-payment-order ────────────

describe('POST /customer-portal/invoices/:id/create-payment-order', () => {
  beforeEach(async () => {
    await prisma.distributor.update({
      where: { id: 'dist-001' },
      data: {
        razorpayEnabled: true,
        razorpayKeyId: RZP_KEY_ID,
        razorpayKeySecret: RZP_KEY_SECRET,
        razorpayWebhookSecret: RZP_WEBHOOK_SECRET,
      },
    });
  });

  it('customer can create a payment order for their own outstanding invoice', async () => {
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const outstanding = Number(inv.outstandingAmount);

    const res = await request(app)
      .post(`/api/customer-portal/invoices/${invoiceId}/create-payment-order`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ amount: outstanding });

    expect(res.status).toBe(201);
    expect(res.body.data.razorpayOrderId).toBe(`mock_rzp_${invoiceId}`);
    expect(res.body.data.amount).toBe(Math.round(outstanding * 100));
    expect(res.body.data.keyId).toBe(RZP_KEY_ID);
    expect(res.body.data.mock).toBe(true);
    expect(res.body.data.invoiceNumber).toBe(inv.invoiceNumber);
  });

  it('returns 400 RAZORPAY_NOT_ENABLED when distributor has not enabled it', async () => {
    await prisma.distributor.update({
      where: { id: 'dist-001' },
      data: { razorpayEnabled: false },
    });
    const res = await request(app)
      .post(`/api/customer-portal/invoices/${invoiceId}/create-payment-order`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ amount: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RAZORPAY_NOT_ENABLED');
  });

  it('cross-customer invoice (different tenant) → 404 (not even 403; we hide existence)', async () => {
    const res = await request(app)
      .post(`/api/customer-portal/invoices/${crossInvoiceId}/create-payment-order`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ amount: 1 });
    // Tenant scoping in the findFirst means the invoice is not found
    // at all → 404. That's the safer leak posture.
    expect(res.status).toBe(404);
  });

  it('amount > outstanding → 400 AMOUNT_OUT_OF_BOUNDS', async () => {
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const outstanding = Number(inv.outstandingAmount);
    const res = await request(app)
      .post(`/api/customer-portal/invoices/${invoiceId}/create-payment-order`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ amount: outstanding + 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AMOUNT_OUT_OF_BOUNDS');
  });

  it('amount <= 0 fails Zod validation', async () => {
    const res = await request(app)
      .post(`/api/customer-portal/invoices/${invoiceId}/create-payment-order`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ amount: 0 });
    expect(res.status).toBe(400);
  });
});

// ─── 3. POST /customer-portal/invoices/:id/verify-payment ──────────────────

describe('POST /customer-portal/invoices/:id/verify-payment', () => {
  beforeEach(async () => {
    await prisma.distributor.update({
      where: { id: 'dist-001' },
      data: {
        razorpayEnabled: true,
        razorpayKeyId: RZP_KEY_ID,
        razorpayKeySecret: RZP_KEY_SECRET,
        razorpayWebhookSecret: RZP_WEBHOOK_SECRET,
      },
    });
    // Wipe any payment rows from a prior test run. Order matters:
    // delete allocations first (FK), then payments. Reset the invoice
    // back to its initial outstanding so each test starts clean.
    const ourPayments = await prisma.paymentTransaction.findMany({
      where: {
        distributorId: 'dist-001',
        razorpayPaymentId: { startsWith: 'pay_phaseF_' },
      },
      select: { id: true },
    });
    await prisma.paymentAllocation.deleteMany({
      where: { paymentId: { in: ourPayments.map((p) => p.id) } },
    });
    await prisma.paymentTransaction.deleteMany({
      where: { id: { in: ourPayments.map((p) => p.id) } },
    });
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { outstandingAmount: 500, amountPaid: 0, status: 'issued', closedAt: null },
    });
  });

  it('valid signature (mock mode) records payment + allocates against the invoice', async () => {
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const initialOutstanding = Number(inv.outstandingAmount);

    const res = await request(app)
      .post(`/api/customer-portal/invoices/${invoiceId}/verify-payment`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        razorpayOrderId: `mock_rzp_${invoiceId}`,
        razorpayPaymentId: 'pay_phaseF_xyz',
        razorpaySignature: 'mock_sig_anything',
        amount: initialOutstanding,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.payment.razorpayPaymentId).toBe('pay_phaseF_xyz');
    // Critical: razorpaySignature MUST be stripped by the mapper.
    expect(res.body.data.payment.razorpaySignature).toBeUndefined();

    // Side effects: PaymentTransaction row, allocation, invoice updated.
    const payment = await prisma.paymentTransaction.findFirst({
      where: { razorpayPaymentId: 'pay_phaseF_xyz' },
      include: { allocations: true },
    });
    expect(payment).not.toBeNull();
    expect(payment?.allocations.length).toBe(1);
    expect(payment?.allocations[0]?.invoiceId).toBe(invoiceId);
    expect(payment?.razorpaySignature).toBe('mock_sig_anything');

    const updatedInv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(Number(updatedInv.outstandingAmount)).toBe(0);
    expect(updatedInv.status).toBe('paid');
  });

  it('REAL-mode signature verification: tampered signature → 400 INVALID_SIGNATURE, NO payment recorded', async () => {
    // Use a non-mock key id so verifyHandlerSignature actually
    // exercises the HMAC path.
    await prisma.distributor.update({
      where: { id: 'dist-001' },
      data: { razorpayKeyId: REAL_KEY_ID, razorpayKeySecret: REAL_KEY_SECRET },
    });
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });

    const res = await request(app)
      .post(`/api/customer-portal/invoices/${invoiceId}/verify-payment`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        razorpayOrderId: `mock_rzp_${invoiceId}`,
        razorpayPaymentId: 'pay_phaseF_bad',
        razorpaySignature: 'definitely_not_a_valid_hmac',
        amount: Number(inv.outstandingAmount),
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SIGNATURE');

    const payment = await prisma.paymentTransaction.findFirst({
      where: { razorpayPaymentId: 'pay_phaseF_bad' },
    });
    expect(payment).toBeNull();
  });

  it('REAL-mode signature verification: correctly-signed message succeeds', async () => {
    await prisma.distributor.update({
      where: { id: 'dist-001' },
      data: { razorpayKeyId: REAL_KEY_ID, razorpayKeySecret: REAL_KEY_SECRET },
    });
    const amount = 100; // Pay ₹100 of the outstanding
    const orderId = 'order_phaseF_real';
    const paymentId = 'pay_phaseF_good';
    const sig = crypto.createHmac('sha256', REAL_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

    const res = await request(app)
      .post(`/api/customer-portal/invoices/${invoiceId}/verify-payment`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: sig,
        amount,
      });

    expect(res.status).toBe(200);
    const payment = await prisma.paymentTransaction.findFirst({
      where: { razorpayPaymentId: paymentId },
    });
    expect(payment).not.toBeNull();
  });

  it('idempotent: re-posting the same razorpayPaymentId returns alreadyPaid without re-recording', async () => {
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const initial = Number(inv.outstandingAmount);
    if (initial <= 0) return; // Nothing to pay — skip

    // First post — succeeds and records.
    await request(app)
      .post(`/api/customer-portal/invoices/${invoiceId}/verify-payment`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        razorpayOrderId: `mock_rzp_${invoiceId}`,
        razorpayPaymentId: 'pay_phaseF_dup',
        razorpaySignature: 'mock_sig',
        amount: Math.min(50, initial),
      });
    const countAfterFirst = await prisma.paymentTransaction.count({
      where: { razorpayPaymentId: 'pay_phaseF_dup' },
    });
    expect(countAfterFirst).toBe(1);

    // Second post with same payment id — returns alreadyPaid, no new
    // row created.
    const res2 = await request(app)
      .post(`/api/customer-portal/invoices/${invoiceId}/verify-payment`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        razorpayOrderId: `mock_rzp_${invoiceId}`,
        razorpayPaymentId: 'pay_phaseF_dup',
        razorpaySignature: 'mock_sig',
        amount: Math.min(50, initial),
      });
    expect(res2.status).toBe(200);
    expect(res2.body.data.alreadyPaid).toBe(true);

    const countAfterSecond = await prisma.paymentTransaction.count({
      where: { razorpayPaymentId: 'pay_phaseF_dup' },
    });
    expect(countAfterSecond).toBe(1);
  });

  it('cross-customer verify (another tenant) → 404', async () => {
    const res = await request(app)
      .post(`/api/customer-portal/invoices/${crossInvoiceId}/verify-payment`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        razorpayOrderId: 'whatever',
        razorpayPaymentId: 'pay_phaseF_xtenant',
        razorpaySignature: 'whatever',
        amount: 100,
      });
    expect(res.status).toBe(404);
  });
});

// ─── 4. Webhook: /api/customer-portal/webhooks/razorpay/:distributorId ─────

describe('POST /api/customer-portal/webhooks/razorpay/:distributorId', () => {
  beforeEach(async () => {
    await prisma.distributor.update({
      where: { id: 'dist-001' },
      data: {
        razorpayEnabled: true,
        razorpayKeyId: RZP_KEY_ID,
        razorpayKeySecret: RZP_KEY_SECRET,
        razorpayWebhookSecret: RZP_WEBHOOK_SECRET,
      },
    });
    const ourPayments = await prisma.paymentTransaction.findMany({
      where: {
        distributorId: 'dist-001',
        razorpayPaymentId: { startsWith: 'pay_phaseF_webhook' },
      },
      select: { id: true },
    });
    await prisma.paymentAllocation.deleteMany({
      where: { paymentId: { in: ourPayments.map((p) => p.id) } },
    });
    await prisma.paymentTransaction.deleteMany({
      where: { id: { in: ourPayments.map((p) => p.id) } },
    });
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { outstandingAmount: 500, amountPaid: 0, status: 'issued', closedAt: null },
    });
  });

  it('REAL signature → records payment via paymentService.createPayment', async () => {
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            order_id: 'order_phaseF_wh',
            id: 'pay_phaseF_webhook_good',
            method: 'card',
            amount: 5000, // ₹50
            notes: { invoiceId, customerId },
          },
        },
      },
    });
    const sig = crypto.createHmac('sha256', RZP_WEBHOOK_SECRET).update(body).digest('hex');

    const res = await request(app)
      .post('/api/customer-portal/webhooks/razorpay/dist-001')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', sig)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.data.received).toBe(true);

    const payment = await prisma.paymentTransaction.findFirst({
      where: { razorpayPaymentId: 'pay_phaseF_webhook_good' },
    });
    expect(payment).not.toBeNull();
    // Razorpay's `card` collapses to our enum's `online` (only `upi`
    // maps 1:1; everything else lands in `online`). The original
    // Razorpay method is preserved in razorpayPaymentId reference.
    expect(payment?.paymentMethod).toBe('online');
    expect(Number(payment?.amount)).toBe(50);
  });

  it('invalid signature → 400 INVALID_WEBHOOK_SIGNATURE, no DB write', async () => {
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            order_id: 'order_phaseF_wh2',
            id: 'pay_phaseF_webhook_bad',
            amount: 100,
            notes: { invoiceId, customerId },
          },
        },
      },
    });
    const res = await request(app)
      .post('/api/customer-portal/webhooks/razorpay/dist-001')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', 'not_a_real_hmac')
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_WEBHOOK_SIGNATURE');

    const payment = await prisma.paymentTransaction.findFirst({
      where: { razorpayPaymentId: 'pay_phaseF_webhook_bad' },
    });
    expect(payment).toBeNull();
  });

  it('distributor without Razorpay enabled → 400, signature check skipped', async () => {
    await prisma.distributor.update({
      where: { id: 'dist-001' },
      data: { razorpayEnabled: false },
    });
    const res = await request(app)
      .post('/api/customer-portal/webhooks/razorpay/dist-001')
      .send({ event: 'payment.captured', payload: {} });
    expect(res.status).toBe(400);
  });

  it('webhook for unknown distributor → 404', async () => {
    const res = await request(app)
      .post('/api/customer-portal/webhooks/razorpay/00000000-0000-0000-0000-000000000000')
      .send({ event: 'payment.captured', payload: {} });
    expect(res.status).toBe(404);
  });

  it('webhook with missing required notes (invoiceId/customerId) → 200 no-op, no DB write', async () => {
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: { entity: { order_id: 'order_phaseF_missing', id: 'pay_phaseF_webhook_missing', amount: 100 } },
      },
    });
    const sig = crypto.createHmac('sha256', RZP_WEBHOOK_SECRET).update(body).digest('hex');

    const res = await request(app)
      .post('/api/customer-portal/webhooks/razorpay/dist-001')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', sig)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.data.processed).toBe(false);

    const payment = await prisma.paymentTransaction.findFirst({
      where: { razorpayPaymentId: 'pay_phaseF_webhook_missing' },
    });
    expect(payment).toBeNull();
  });

  it('webhook idempotency: second webhook for same razorpayPaymentId is no-op', async () => {
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            order_id: 'order_phaseF_wh_idem',
            id: 'pay_phaseF_webhook_idem',
            method: 'upi',
            amount: 100,
            notes: { invoiceId, customerId },
          },
        },
      },
    });
    const sig = crypto.createHmac('sha256', RZP_WEBHOOK_SECRET).update(body).digest('hex');

    // First webhook records.
    await request(app)
      .post('/api/customer-portal/webhooks/razorpay/dist-001')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', sig)
      .send(body);
    const countAfterFirst = await prisma.paymentTransaction.count({
      where: { razorpayPaymentId: 'pay_phaseF_webhook_idem' },
    });
    expect(countAfterFirst).toBe(1);

    // Second identical webhook — no new row.
    const res = await request(app)
      .post('/api/customer-portal/webhooks/razorpay/dist-001')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', sig)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.data.alreadyRecorded).toBe(true);

    const countAfterSecond = await prisma.paymentTransaction.count({
      where: { razorpayPaymentId: 'pay_phaseF_webhook_idem' },
    });
    expect(countAfterSecond).toBe(1);
  });
});

// ─── 5. Regression: manual payment recording unaffected ─────────────────────

describe('Phase F regression: manual /api/payments unaffected', () => {
  it('admin POST /api/payments still works without razorpay fields', async () => {
    const cust = await prisma.customer.findFirstOrThrow({
      where: { distributorId: 'dist-001', deletedAt: null },
    });
    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${distAdminToken}`)
      .send({
        customerId: cust.id,
        amount: 1,
        paymentMethod: 'cash',
        transactionDate: '2099-12-31',
      });
    expect(res.status).toBe(201);
    // razorpayPaymentId + razorpayOrderId stay null for manual payments.
    expect(res.body.data.razorpayPaymentId).toBeNull();
    expect(res.body.data.razorpayOrderId).toBeNull();
    expect(res.body.data.razorpaySignature).toBeUndefined();

    // Cleanup so test data doesn't accumulate.
    await prisma.paymentAllocation.deleteMany({ where: { paymentId: res.body.data.paymentId } });
    await prisma.paymentTransaction.delete({ where: { id: res.body.data.paymentId } });
  });
});
