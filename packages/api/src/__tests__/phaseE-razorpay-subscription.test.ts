/**
 * Phase E — Razorpay subscription payments (distributor → GasLink).
 *
 * Layers tested:
 *   1. razorpayService — pure crypto + mock-mode helpers, no HTTP.
 *   2. routes/billing.ts — create-payment-order + verify-payment
 *      endpoints with auth + tenant isolation + idempotency.
 *   3. routes/razorpayWebhook.ts — public webhook with signature
 *      verification + payment.captured + order.paid handling.
 *
 * Tests use TWO modes:
 *   - REAL crypto + mock SDK: RAZORPAY_KEY_ID set to a non-mock
 *     value during signature tests so the HMAC actually runs. The
 *     SDK is never reached because createRazorpayOrder falls back to
 *     mock when there's no live secret, OR we exercise the crypto
 *     helper directly (no SDK call).
 *   - Full mock mode: RAZORPAY_KEY_ID contains "mock" — exercises
 *     the full route flow without hitting the real sandbox, used for
 *     the create-payment-order + cycle-state-machine tests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../app.js';
import { loginAsDistAdmin, loginAsFinance, loginAsInventory, loginAsSuperAdmin } from './helpers.js';
import { prisma } from '../lib/prisma.js';
import {
  createRazorpayOrder,
  verifyHandlerSignature,
  verifyWebhookSignature,
  isMockKey,
} from '../services/razorpayService.js';
import type { Express } from 'express';

let app: Express;
let distAdminToken: string;
let financeToken: string;
let inventoryToken: string;
let superAdminToken: string;

// Two known-state cycles seeded fresh per test run:
//   payableCycle  — billingStatus=pending_payment, belongs to dist-001
//   paidCycle     — billingStatus=paid_billing,     belongs to dist-001
//   crossCycle    — pending_payment,                belongs to dist-002
// Cleaned up in afterAll.
let payableCycleId: string;
let paidCycleId: string;
let crossCycleId: string;

// Save the real env so afterAll can restore it. We unconditionally
// FORCE mock mode for the route-level tests in this file (the pure
// crypto helpers above exercise real-mode HMAC explicitly). Without
// this, a local .env with a real RAZORPAY_KEY_ID would override the
// `??=` fallback and route tests would hit the actual Razorpay
// sandbox + fail on fake signatures — those are mock-fixture
// assertions, not integration coverage. CI has no env set so the
// `??=` would already work; this is the local-dev safety net.
const _envBackup = {
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
};

beforeAll(async () => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_mock_phaseE';
  process.env.RAZORPAY_KEY_SECRET = 'mock_secret_phaseE';

  app = createApp();
  distAdminToken = (await loginAsDistAdmin()).token;
  financeToken = (await loginAsFinance()).token;
  inventoryToken = (await loginAsInventory()).token;
  superAdminToken = (await loginAsSuperAdmin()).token;

  // Seed fixture cycles. periodStartDate way in the future so they
  // never collide with real seed data.
  const payable = await prisma.billingCycle.create({
    data: {
      distributorId: 'dist-001',
      periodType: 'monthly',
      periodStartDate: new Date('2099-01-01'),
      periodEndDate: new Date('2099-01-31'),
      billingStatus: 'pending_payment',
      billingTier: 'tier_1',
      totalAmountExclGst: 1000,
      totalGstAmount: 180,
      totalAmountInclGst: 1180,
    },
  });
  payableCycleId = payable.id;

  const paid = await prisma.billingCycle.create({
    data: {
      distributorId: 'dist-001',
      periodType: 'monthly',
      periodStartDate: new Date('2099-02-01'),
      periodEndDate: new Date('2099-02-28'),
      billingStatus: 'paid_billing',
      billingTier: 'tier_1',
      totalAmountExclGst: 1000,
      totalGstAmount: 180,
      totalAmountInclGst: 1180,
    },
  });
  paidCycleId = paid.id;

  const cross = await prisma.billingCycle.create({
    data: {
      distributorId: 'dist-002',
      periodType: 'monthly',
      periodStartDate: new Date('2099-03-01'),
      periodEndDate: new Date('2099-03-31'),
      billingStatus: 'pending_payment',
      billingTier: 'tier_1',
      totalAmountExclGst: 1000,
      totalGstAmount: 180,
      totalAmountInclGst: 1180,
    },
  });
  crossCycleId = cross.id;
});

afterAll(async () => {
  await prisma.billingCycle.deleteMany({
    where: { id: { in: [payableCycleId, paidCycleId, crossCycleId] } },
  });
  // Restore real env so subsequent files (or the next live-flow probe
  // by the dev) see the actual RAZORPAY_KEY_ID from .env.
  if (_envBackup.RAZORPAY_KEY_ID !== undefined) {
    process.env.RAZORPAY_KEY_ID = _envBackup.RAZORPAY_KEY_ID;
  } else {
    delete process.env.RAZORPAY_KEY_ID;
  }
  if (_envBackup.RAZORPAY_KEY_SECRET !== undefined) {
    process.env.RAZORPAY_KEY_SECRET = _envBackup.RAZORPAY_KEY_SECRET;
  } else {
    delete process.env.RAZORPAY_KEY_SECRET;
  }
});

beforeEach(async () => {
  // Reset the payableCycle's razorpay fields so each create-payment-
  // order test starts clean.
  await prisma.billingCycle.update({
    where: { id: payableCycleId },
    data: {
      razorpayOrderId: null,
      razorpayPaymentId: null,
      razorpaySignature: null,
      paidAt: null,
      paymentMethod: null,
      billingStatus: 'pending_payment',
    },
  });
});

// ─── 1. razorpayService pure helpers ────────────────────────────────────────

describe('razorpayService', () => {
  describe('createRazorpayOrder', () => {
    it('mock mode returns a mock_rzp_<receipt> order with correct paise amount', async () => {
      const order = await createRazorpayOrder(
        { keyId: 'rzp_test_mock_unit', keySecret: 'irrelevant' },
        { amountInPaise: 118000, receipt: 'cycle-abc', notes: { cycleId: 'cycle-abc' } },
      );
      expect(order.id).toBe('mock_rzp_cycle-abc');
      expect(order.amount).toBe(118000);
      expect(order.currency).toBe('INR');
      expect((order as { mock?: boolean }).mock).toBe(true);
    });

    it('mock mode floors amount at 100 paise (Razorpay minimum)', async () => {
      const order = await createRazorpayOrder(
        { keyId: 'mock', keySecret: 'irrelevant' },
        { amountInPaise: 50, receipt: 'cycle-tiny', notes: {} },
      );
      expect(order.amount).toBe(100);
    });
  });

  describe('verifyHandlerSignature', () => {
    const creds = { keyId: 'rzp_test_real', keySecret: 'test_secret_xyz' };
    const orderId = 'order_ABC123';
    const paymentId = 'pay_XYZ789';
    const goodSignature = crypto
      .createHmac('sha256', creds.keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    it('returns true for a correctly-signed message', () => {
      expect(verifyHandlerSignature(creds, orderId, paymentId, goodSignature)).toBe(true);
    });

    it('returns false for a tampered signature (one byte changed)', () => {
      const bad = goodSignature.slice(0, -2) + (goodSignature.endsWith('0') ? '11' : '00');
      expect(verifyHandlerSignature(creds, orderId, paymentId, bad)).toBe(false);
    });

    it('returns false for a tampered orderId (HMAC input changes)', () => {
      expect(verifyHandlerSignature(creds, 'order_TAMPERED', paymentId, goodSignature)).toBe(false);
    });

    it('returns false when any field is empty (defensive)', () => {
      expect(verifyHandlerSignature(creds, '', paymentId, goodSignature)).toBe(false);
      expect(verifyHandlerSignature(creds, orderId, '', goodSignature)).toBe(false);
      expect(verifyHandlerSignature(creds, orderId, paymentId, '')).toBe(false);
    });

    it('mock-key short-circuits to true (test fixture posture)', () => {
      expect(verifyHandlerSignature(
        { keyId: 'rzp_test_mock', keySecret: 'irrelevant' },
        orderId, paymentId, 'whatever',
      )).toBe(true);
    });
  });

  describe('verifyWebhookSignature', () => {
    const secret = 'wh_test_secret_xyz';
    const body = JSON.stringify({ event: 'payment.captured', payload: { foo: 'bar' } });
    const good = crypto.createHmac('sha256', secret).update(body).digest('hex');

    it('returns true for a correctly-signed body', () => {
      expect(verifyWebhookSignature(secret, body, good)).toBe(true);
    });

    it('returns false for a tampered signature', () => {
      const bad = good.slice(0, -1) + (good.endsWith('0') ? '1' : '0');
      expect(verifyWebhookSignature(secret, body, bad)).toBe(false);
    });

    it('returns false when the body bytes differ (whitespace, key order)', () => {
      const tamperedBody = JSON.stringify({ event: 'payment.captured', payload: { foo: 'BAZ' } });
      expect(verifyWebhookSignature(secret, tamperedBody, good)).toBe(false);
    });

    it('returns false when signature header missing', () => {
      expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    });

    it('returns true when webhookSecret is undefined / contains mock (dev mode)', () => {
      expect(verifyWebhookSignature(undefined, body, undefined)).toBe(true);
      expect(verifyWebhookSignature('wh_mock_secret', body, undefined)).toBe(true);
    });
  });

  describe('isMockKey', () => {
    it('detects mock keys', () => {
      expect(isMockKey('rzp_test_mock')).toBe(true);
      expect(isMockKey('rzp_test_mock_phaseE')).toBe(true);
      expect(isMockKey(undefined)).toBe(true);
    });
    it('does not flag real test keys', () => {
      expect(isMockKey('rzp_test_SufHkXq3Ybt8jv')).toBe(false);
      expect(isMockKey('rzp_live_AbcDef')).toBe(false);
    });
  });
});

// ─── 2. POST /api/billing/cycles/:id/create-payment-order ──────────────────

describe('POST /api/billing/cycles/:id/create-payment-order', () => {
  it('distributor_admin can create an order for their own pending cycle (mock mode)', async () => {
    const res = await request(app)
      .post(`/api/billing/cycles/${payableCycleId}/create-payment-order`)
      .set('Authorization', `Bearer ${distAdminToken}`);
    expect(res.status).toBe(201);
    expect(res.body.data.razorpayOrderId).toBe(`mock_rzp_${payableCycleId}`);
    expect(res.body.data.amount).toBe(118000); // 1180 * 100
    expect(res.body.data.currency).toBe('INR');
    expect(res.body.data.keyId).toBeDefined();
    expect(res.body.data.mock).toBe(true);

    // Side effect: razorpayOrderId persisted on the cycle.
    const updated = await prisma.billingCycle.findUnique({ where: { id: payableCycleId } });
    expect(updated?.razorpayOrderId).toBe(`mock_rzp_${payableCycleId}`);
  });

  it('finance role returns 403', async () => {
    const res = await request(app)
      .post(`/api/billing/cycles/${payableCycleId}/create-payment-order`)
      .set('Authorization', `Bearer ${financeToken}`);
    expect(res.status).toBe(403);
  });

  it('inventory role returns 403', async () => {
    const res = await request(app)
      .post(`/api/billing/cycles/${payableCycleId}/create-payment-order`)
      .set('Authorization', `Bearer ${inventoryToken}`);
    expect(res.status).toBe(403);
  });

  it('cross-tenant cycle returns 403 CROSS_TENANT_ACCESS', async () => {
    // dist-001 admin trying to pay dist-002's cycle
    const res = await request(app)
      .post(`/api/billing/cycles/${crossCycleId}/create-payment-order`)
      .set('Authorization', `Bearer ${distAdminToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CROSS_TENANT_ACCESS');
  });

  it('super_admin can create an order for any tenant', async () => {
    const res = await request(app)
      .post(`/api/billing/cycles/${crossCycleId}/create-payment-order`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .set('X-Distributor-Id', 'dist-002');
    expect(res.status).toBe(201);
    expect(res.body.data.razorpayOrderId).toBe(`mock_rzp_${crossCycleId}`);
  });

  it('already-paid cycle returns 400 CYCLE_NOT_PAYABLE', async () => {
    const res = await request(app)
      .post(`/api/billing/cycles/${paidCycleId}/create-payment-order`)
      .set('Authorization', `Bearer ${distAdminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CYCLE_NOT_PAYABLE');
  });

  it('nonexistent cycle returns 404', async () => {
    const res = await request(app)
      .post(`/api/billing/cycles/00000000-0000-0000-0000-000000000000/create-payment-order`)
      .set('Authorization', `Bearer ${distAdminToken}`);
    expect(res.status).toBe(404);
  });
});

// ─── 3. POST /api/billing/cycles/:id/verify-payment ────────────────────────

describe('POST /api/billing/cycles/:id/verify-payment', () => {
  beforeEach(async () => {
    // Set up an order on the payable cycle so verify has something to
    // match against.
    await prisma.billingCycle.update({
      where: { id: payableCycleId },
      data: { razorpayOrderId: `mock_rzp_${payableCycleId}` },
    });
  });

  it('valid signature (mock mode) flips status to paid_billing and stores forensic fields', async () => {
    const res = await request(app)
      .post(`/api/billing/cycles/${payableCycleId}/verify-payment`)
      .set('Authorization', `Bearer ${distAdminToken}`)
      .send({
        razorpayOrderId: `mock_rzp_${payableCycleId}`,
        razorpayPaymentId: 'pay_mock_xyz',
        razorpaySignature: 'mock_signature_anything',
      });

    expect(res.status).toBe(200);
    // mapBillingCycle is a renameId pass-through — billingStatus
    // arrives as the raw Prisma enum value ('paid_billing'), not the
    // shared TS 'paid' alias. Wire shape is the authoritative spec.
    expect(res.body.data.billingCycle.billingStatus).toBe('paid_billing');

    const cycle = await prisma.billingCycle.findUnique({ where: { id: payableCycleId } });
    expect(cycle?.billingStatus).toBe('paid_billing');
    expect(cycle?.razorpayPaymentId).toBe('pay_mock_xyz');
    expect(cycle?.razorpaySignature).toBe('mock_signature_anything');
    expect(cycle?.paidAt).toBeInstanceOf(Date);
  });

  it('order ID mismatch → 400 ORDER_ID_MISMATCH, cycle NOT updated', async () => {
    const res = await request(app)
      .post(`/api/billing/cycles/${payableCycleId}/verify-payment`)
      .set('Authorization', `Bearer ${distAdminToken}`)
      .send({
        razorpayOrderId: 'order_WRONG',
        razorpayPaymentId: 'pay_xxx',
        razorpaySignature: 'sig_xxx',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ORDER_ID_MISMATCH');
    const cycle = await prisma.billingCycle.findUnique({ where: { id: payableCycleId } });
    expect(cycle?.billingStatus).toBe('pending_payment');
  });

  it('idempotent: already-paid cycle returns success without re-processing', async () => {
    await prisma.billingCycle.update({
      where: { id: payableCycleId },
      data: { billingStatus: 'paid_billing' },
    });
    const res = await request(app)
      .post(`/api/billing/cycles/${payableCycleId}/verify-payment`)
      .set('Authorization', `Bearer ${distAdminToken}`)
      .send({
        razorpayOrderId: 'whatever',
        razorpayPaymentId: 'whatever',
        razorpaySignature: 'whatever',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.alreadyPaid).toBe(true);
  });

  it('cross-tenant verify → 403 CROSS_TENANT_ACCESS', async () => {
    await prisma.billingCycle.update({
      where: { id: crossCycleId },
      data: { razorpayOrderId: `mock_rzp_${crossCycleId}` },
    });
    const res = await request(app)
      .post(`/api/billing/cycles/${crossCycleId}/verify-payment`)
      .set('Authorization', `Bearer ${distAdminToken}`)
      .send({
        razorpayOrderId: `mock_rzp_${crossCycleId}`,
        razorpayPaymentId: 'pay_xxx',
        razorpaySignature: 'sig_xxx',
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CROSS_TENANT_ACCESS');
  });

  it('finance role returns 403', async () => {
    const res = await request(app)
      .post(`/api/billing/cycles/${payableCycleId}/verify-payment`)
      .set('Authorization', `Bearer ${financeToken}`)
      .send({
        razorpayOrderId: `mock_rzp_${payableCycleId}`,
        razorpayPaymentId: 'pay_xxx',
        razorpaySignature: 'sig_xxx',
      });
    expect(res.status).toBe(403);
  });

  it('zod validation: missing razorpayPaymentId → 400', async () => {
    const res = await request(app)
      .post(`/api/billing/cycles/${payableCycleId}/verify-payment`)
      .set('Authorization', `Bearer ${distAdminToken}`)
      .send({ razorpayOrderId: 'o', razorpaySignature: 's' });
    expect(res.status).toBe(400);
  });
});

// ─── 4. POST /api/billing/webhooks/razorpay ────────────────────────────────

describe('POST /api/billing/webhooks/razorpay', () => {
  // For these tests we exercise mock-mode signature verification
  // (RAZORPAY_WEBHOOK_SECRET unset / contains "mock"). The pure-
  // helper tests above cover real-mode crypto.
  const originalWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  beforeAll(() => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
  });

  afterAll(() => {
    if (originalWebhookSecret) process.env.RAZORPAY_WEBHOOK_SECRET = originalWebhookSecret;
  });

  beforeEach(async () => {
    await prisma.billingCycle.update({
      where: { id: payableCycleId },
      data: {
        razorpayOrderId: `mock_rzp_${payableCycleId}`,
        billingStatus: 'pending_payment',
      },
    });
  });

  it('payment.captured event with valid signature → cycle flipped paid', async () => {
    const res = await request(app)
      .post('/api/billing/webhooks/razorpay')
      .send({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              order_id: `mock_rzp_${payableCycleId}`,
              id: 'pay_webhook_xyz',
              method: 'upi',
            },
          },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.data.received).toBe(true);

    const cycle = await prisma.billingCycle.findUnique({ where: { id: payableCycleId } });
    expect(cycle?.billingStatus).toBe('paid_billing');
    expect(cycle?.razorpayPaymentId).toBe('pay_webhook_xyz');
    expect(cycle?.paymentMethod).toBe('upi');
  });

  it('order.paid event also marks the cycle paid (Anah-compatible event handling)', async () => {
    const res = await request(app)
      .post('/api/billing/webhooks/razorpay')
      .send({
        event: 'order.paid',
        payload: {
          payment: { entity: { order_id: `mock_rzp_${payableCycleId}`, id: 'pay_op_xyz' } },
        },
      });
    expect(res.status).toBe(200);

    const cycle = await prisma.billingCycle.findUnique({ where: { id: payableCycleId } });
    expect(cycle?.billingStatus).toBe('paid_billing');
    expect(cycle?.razorpayPaymentId).toBe('pay_op_xyz');
  });

  it('invalid signature when secret IS set → 400 INVALID_WEBHOOK_SIGNATURE, no DB write', async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = 'wh_real_secret_xyz';
    try {
      const res = await request(app)
        .post('/api/billing/webhooks/razorpay')
        .set('x-razorpay-signature', 'definitely_not_correct')
        .send({
          event: 'payment.captured',
          payload: {
            payment: { entity: { order_id: `mock_rzp_${payableCycleId}`, id: 'pay_bad' } },
          },
        });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_WEBHOOK_SIGNATURE');

      const cycle = await prisma.billingCycle.findUnique({ where: { id: payableCycleId } });
      expect(cycle?.billingStatus).toBe('pending_payment');
      expect(cycle?.razorpayPaymentId).toBeNull();
    } finally {
      delete process.env.RAZORPAY_WEBHOOK_SECRET;
    }
  });

  it('unknown event (e.g. refund.created) → 200 no-op (we ignore events we do not handle)', async () => {
    const res = await request(app)
      .post('/api/billing/webhooks/razorpay')
      .send({
        event: 'refund.created',
        payload: { payment: { entity: { order_id: 'whatever', id: 'whatever' } } },
      });
    expect(res.status).toBe(200);

    const cycle = await prisma.billingCycle.findUnique({ where: { id: payableCycleId } });
    expect(cycle?.billingStatus).toBe('pending_payment');
  });

  it('webhook for an order_id that does not match any cycle → 200, no error (race-safe)', async () => {
    const res = await request(app)
      .post('/api/billing/webhooks/razorpay')
      .send({
        event: 'payment.captured',
        payload: {
          payment: { entity: { order_id: 'mock_rzp_ghost_cycle_id', id: 'pay_ghost' } },
        },
      });
    expect(res.status).toBe(200);
  });

  it('webhook + verify-payment race: webhook fires first, cycle already paid, second webhook is a no-op', async () => {
    // First webhook flips the cycle to paid.
    await request(app)
      .post('/api/billing/webhooks/razorpay')
      .send({
        event: 'payment.captured',
        payload: { payment: { entity: { order_id: `mock_rzp_${payableCycleId}`, id: 'pay_first', method: 'card' } } },
      });
    const first = await prisma.billingCycle.findUnique({ where: { id: payableCycleId } });
    expect(first?.razorpayPaymentId).toBe('pay_first');

    // Second webhook with a DIFFERENT payment id — should NOT overwrite.
    await request(app)
      .post('/api/billing/webhooks/razorpay')
      .send({
        event: 'payment.captured',
        payload: { payment: { entity: { order_id: `mock_rzp_${payableCycleId}`, id: 'pay_DUP', method: 'upi' } } },
      });
    const second = await prisma.billingCycle.findUnique({ where: { id: payableCycleId } });
    expect(second?.razorpayPaymentId).toBe('pay_first');
    expect(second?.paymentMethod).toBe('card');
  });
});

// ─── 5. Distributor unsuspend on payment ───────────────────────────────────

describe('Phase E — billing-suspended distributor unsuspends on payment', () => {
  let suspendedCycleId: string;

  beforeAll(async () => {
    // Suspend dist-001 + give it an overdue cycle. Pay the cycle ->
    // suspended flag should clear.
    await prisma.distributor.update({
      where: { id: 'dist-001' },
      data: { billingSuspended: true },
    });
    const overdue = await prisma.billingCycle.create({
      data: {
        distributorId: 'dist-001',
        periodType: 'monthly',
        periodStartDate: new Date('2099-04-01'),
        periodEndDate: new Date('2099-04-30'),
        billingStatus: 'overdue_billing',
        billingTier: 'tier_1',
        totalAmountExclGst: 1000,
        totalGstAmount: 180,
        totalAmountInclGst: 1180,
        razorpayOrderId: 'mock_rzp_overdue_phaseE',
      },
    });
    suspendedCycleId = overdue.id;
  });

  afterAll(async () => {
    await prisma.billingCycle.deleteMany({ where: { id: suspendedCycleId } });
    await prisma.distributor.update({
      where: { id: 'dist-001' },
      data: { billingSuspended: false },
    });
  });

  it('verify-payment success on an overdue cycle clears distributor.billingSuspended', async () => {
    const res = await request(app)
      .post(`/api/billing/cycles/${suspendedCycleId}/verify-payment`)
      .set('Authorization', `Bearer ${distAdminToken}`)
      .send({
        razorpayOrderId: 'mock_rzp_overdue_phaseE',
        razorpayPaymentId: 'pay_unsuspend',
        razorpaySignature: 'mock_sig',
      });
    expect(res.status).toBe(200);
    const dist = await prisma.distributor.findUnique({ where: { id: 'dist-001' } });
    expect(dist?.billingSuspended).toBe(false);
  });
});
