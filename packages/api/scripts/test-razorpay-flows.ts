/**
 * Razorpay end-to-end flows runner — Phase E + F, all 11 variants.
 *
 * Runs against live Razorpay TEST sandbox (`rzp_test_*` creds in
 * .env). Does NOT touch the checkout iframe — instead it:
 *   - Lets our API call Razorpay's real orders.create() (server-side
 *     SDK call hits the sandbox).
 *   - Generates a valid handler-callback HMAC LOCALLY using the same
 *     key_secret. This is what Razorpay's server would have computed
 *     after a successful card / UPI payment. Our verify endpoint
 *     trusts the HMAC — that's the security contract.
 *   - Generates webhook signatures the same way using the webhook
 *     secret.
 *
 * Why "fake" payment_ids are OK for our test:
 *   - In production, Razorpay generates a real `pay_XXX` id when the
 *     user completes payment, and signs it with our key_secret. The
 *     signature ties the payment_id to the order_id.
 *   - Here, we generate `pay_phaseE2E_XXX` ourselves and sign it with
 *     the same secret. The signature verifies. The cycle flips paid
 *     in our DB.
 *   - This exercises ALL OUR CODE end to end. It does NOT prove
 *     Razorpay's webhook will arrive (no real payment was made) — but
 *     that's verified separately via the webhook variants here that
 *     simulate the webhook directly.
 *
 * Usage:
 *   pnpm --filter @gaslink/api exec tsx scripts/test-razorpay-flows.ts
 *
 * Requires:
 *   - API running on http://localhost:5000
 *   - .env with RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET + RAZORPAY_WEBHOOK_SECRET
 *   - Seed data (dist-001 Bhargava, dist-002 Sharma, customer users)
 *
 * Exit code:
 *   0 — all variants passed
 *   1 — one or more variants failed (details printed)
 */
import 'dotenv/config';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

const API = 'http://localhost:5000';
const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID!;
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET!;
const RZP_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET!;
const JWT_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-in-production';

if (!RZP_KEY_ID || !RZP_KEY_SECRET || !RZP_WEBHOOK_SECRET) {
  console.error('Missing Razorpay env vars. Set RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET + RAZORPAY_WEBHOOK_SECRET in packages/api/.env');
  process.exit(1);
}
if (RZP_KEY_ID.includes('mock')) {
  console.error(`Mock key detected (${RZP_KEY_ID}). This script verifies the REAL sandbox path. Stop and check .env.`);
  process.exit(1);
}

const prisma = new PrismaClient();

// ─── Helpers ────────────────────────────────────────────────────────────────

interface Result { name: string; pass: boolean; detail?: string }
const results: Result[] = [];

function record(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail });
  const mark = pass ? '✅' : '❌';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

function tokenFor(user: { id: string; email: string; role: string; distributorId: string | null; customerId: string | null }): string {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      distributorId: user.distributorId,
      customerId: user.customerId ?? null,
    },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function handlerSignature(orderId: string, paymentId: string, secret = RZP_KEY_SECRET): string {
  return crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
}

function webhookSignature(body: string, secret = RZP_WEBHOOK_SECRET): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

interface ApiResp<T = unknown> { ok: boolean; status: number; body: { success?: boolean; data?: T; error?: string; code?: string } }

async function api<T = unknown>(path: string, opts: { method: string; token?: string; body?: unknown; rawHeaders?: Record<string, string> }): Promise<ApiResp<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  Object.assign(headers, opts.rawHeaders ?? {});
  const res = await fetch(`${API}${path}`, {
    method: opts.method,
    headers,
    body: opts.body !== undefined ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
  });
  let body: { success?: boolean; data?: T; error?: string; code?: string };
  try { body = await res.json() as { success?: boolean; data?: T; error?: string; code?: string }; } catch { body = {}; }
  return { ok: res.ok, status: res.status, body };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const PHASE_PREFIX = 'phaseE2E';
const createdCycleIds: string[] = [];
const createdInvoiceIds: string[] = [];
const createdPaymentIds: string[] = [];

async function createPendingCycle(distributorId = 'dist-001', amount = 1180): Promise<string> {
  const cycle = await prisma.billingCycle.create({
    data: {
      distributorId,
      periodType: 'monthly',
      periodStartDate: new Date('2099-07-01'),
      periodEndDate: new Date('2099-07-31'),
      billingStatus: 'pending_payment',
      billingTier: 'tier_1',
      totalAmountExclGst: amount / 1.18,
      totalGstAmount: amount - amount / 1.18,
      totalAmountInclGst: amount,
    },
  });
  createdCycleIds.push(cycle.id);
  return cycle.id;
}

async function createOutstandingInvoice(distributorId: string, customerId: string, total = 1000): Promise<string> {
  const invoice = await prisma.invoice.create({
    data: {
      distributorId,
      customerId,
      invoiceNumber: `${PHASE_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      issueDate: new Date('2099-08-01'),
      dueDate: new Date('2099-08-31'),
      totalAmount: total,
      amountPaid: 0,
      outstandingAmount: total,
      status: 'issued',
    },
  });
  createdInvoiceIds.push(invoice.id);
  return invoice.id;
}

async function cleanup() {
  // Payments + allocations created during the test.
  const ourPayments = await prisma.paymentTransaction.findMany({
    where: { OR: [
      { razorpayPaymentId: { startsWith: 'pay_phaseE2E' } },
      { id: { in: createdPaymentIds } },
    ] },
    select: { id: true },
  });
  await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: ourPayments.map(p => p.id) } } });
  await prisma.paymentTransaction.deleteMany({ where: { id: { in: ourPayments.map(p => p.id) } } });
  await prisma.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
  await prisma.billingCycle.deleteMany({ where: { id: { in: createdCycleIds } } });
  // Restore dist-001 + dist-002 razorpay state.
  await prisma.distributor.updateMany({
    where: { id: { in: ['dist-001', 'dist-002'] } },
    data: {
      razorpayEnabled: false,
      razorpayKeyId: null,
      razorpayKeySecret: null,
      razorpayWebhookSecret: null,
      billingSuspended: false,
    },
  });
}

// ─── Variants ───────────────────────────────────────────────────────────────

async function run() {
  // Setup — load test actors.
  const distAdmin = await prisma.user.findFirstOrThrow({ where: { email: 'bhargava@gasagency.com' } });
  const distAdminToken = tokenFor(distAdmin);
  const sharmaAdmin = await prisma.user.findFirstOrThrow({ where: { email: 'sharma@gasdist.com' } });
  const sharmaAdminToken = tokenFor(sharmaAdmin);
  const cust1 = await prisma.user.findFirstOrThrow({ where: { distributorId: 'dist-001', role: 'customer', customerId: { not: null } } });
  const cust1Token = tokenFor(cust1);
  const cust2 = await prisma.user.findFirstOrThrow({ where: { distributorId: 'dist-002', role: 'customer', customerId: { not: null } } });
  const cust2Token = tokenFor(cust2);

  console.log(`\n===== Razorpay live-sandbox flow tests =====`);
  console.log(`key_id    : ${RZP_KEY_ID}`);
  console.log(`mock      : ${RZP_KEY_ID.includes('mock') ? 'YES (BUG)' : 'NO'}`);
  console.log(`dist-001  : ${distAdmin.email}`);
  console.log(`dist-002  : ${sharmaAdmin.email}`);
  console.log(`cust dist-001 : ${cust1.email}`);
  console.log(`cust dist-002 : ${cust2.email}\n`);

  // ─── Variant 1 — Phase E subscription SUCCESS ────────────────────────────
  try {
    const cycleId = await createPendingCycle();
    const orderResp = await api<{ razorpayOrderId: string; amount: number; mock: boolean }>(`/api/billing/cycles/${cycleId}/create-payment-order`, { method: 'POST', token: distAdminToken });
    if (!orderResp.ok) throw new Error(`create-order failed ${orderResp.status} ${JSON.stringify(orderResp.body)}`);
    const orderId = orderResp.body.data!.razorpayOrderId;
    if (orderResp.body.data!.mock !== false) throw new Error(`expected mock:false, got mock:${orderResp.body.data!.mock}`);
    if (!orderId.startsWith('order_')) throw new Error(`expected real order_ id, got ${orderId}`);
    const paymentId = `pay_${PHASE_PREFIX}_v1_${Date.now()}`;
    const sig = handlerSignature(orderId, paymentId);
    const vRes = await api(`/api/billing/cycles/${cycleId}/verify-payment`, {
      method: 'POST', token: distAdminToken,
      body: { razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: sig },
    });
    if (!vRes.ok) throw new Error(`verify failed ${vRes.status} ${JSON.stringify(vRes.body)}`);
    const after = await prisma.billingCycle.findUniqueOrThrow({ where: { id: cycleId } });
    if (after.billingStatus !== 'paid_billing') throw new Error(`status=${after.billingStatus}, expected paid_billing`);
    if (!after.paidAt) throw new Error('paidAt not set');
    if (after.razorpayPaymentId !== paymentId) throw new Error(`razorpayPaymentId=${after.razorpayPaymentId}`);
    if (after.razorpaySignature !== sig) throw new Error(`signature not stored`);
    const dist = await prisma.distributor.findUniqueOrThrow({ where: { id: 'dist-001' } });
    if (dist.billingSuspended) throw new Error(`billingSuspended=true after payment`);
    record('Variant 1 — Phase E subscription SUCCESS', true, `order=${orderId.slice(0, 20)} paidAt=${after.paidAt.toISOString().slice(0, 19)}`);
  } catch (e) {
    record('Variant 1 — Phase E subscription SUCCESS', false, (e as Error).message);
  }

  // ─── Variant 2 — Phase E subscription FAILURE (tampered sig) ─────────────
  try {
    const cycleId = await createPendingCycle();
    const orderResp = await api<{ razorpayOrderId: string }>(`/api/billing/cycles/${cycleId}/create-payment-order`, { method: 'POST', token: distAdminToken });
    const orderId = orderResp.body.data!.razorpayOrderId;
    const paymentId = `pay_${PHASE_PREFIX}_v2_${Date.now()}`;
    const correctSig = handlerSignature(orderId, paymentId);
    const tamperedSig = correctSig.slice(0, -2) + (correctSig.endsWith('0') ? '11' : '00');
    const vRes = await api(`/api/billing/cycles/${cycleId}/verify-payment`, {
      method: 'POST', token: distAdminToken,
      body: { razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: tamperedSig },
    });
    if (vRes.status !== 400) throw new Error(`expected 400, got ${vRes.status}`);
    if (vRes.body.code !== 'INVALID_SIGNATURE') throw new Error(`expected INVALID_SIGNATURE, got ${vRes.body.code}`);
    const after = await prisma.billingCycle.findUniqueOrThrow({ where: { id: cycleId } });
    if (after.billingStatus !== 'pending_payment') throw new Error(`status=${after.billingStatus}, expected pending_payment`);
    if (after.paidAt !== null) throw new Error(`paidAt should be null`);
    if (after.razorpayPaymentId !== null) throw new Error(`razorpayPaymentId should be null`);
    record('Variant 2 — Phase E subscription FAILURE (invalid sig)', true, 'cycle unchanged, no DB write');
  } catch (e) {
    record('Variant 2 — Phase E subscription FAILURE (invalid sig)', false, (e as Error).message);
  }

  // ─── Variant 3 — Phase E idempotency ──────────────────────────────────────
  try {
    const cycleId = await createPendingCycle();
    const o = await api<{ razorpayOrderId: string }>(`/api/billing/cycles/${cycleId}/create-payment-order`, { method: 'POST', token: distAdminToken });
    const orderId = o.body.data!.razorpayOrderId;
    const paymentId = `pay_${PHASE_PREFIX}_v3_${Date.now()}`;
    const sig = handlerSignature(orderId, paymentId);
    // First post — flips to paid.
    const v1 = await api(`/api/billing/cycles/${cycleId}/verify-payment`, {
      method: 'POST', token: distAdminToken,
      body: { razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: sig },
    });
    if (!v1.ok) throw new Error(`first verify failed ${v1.status}`);
    const first = await prisma.billingCycle.findUniqueOrThrow({ where: { id: cycleId } });
    const firstPaidAt = first.paidAt;
    // Second post — should be idempotent.
    await new Promise(r => setTimeout(r, 50));
    const v2 = await api<{ alreadyPaid?: boolean }>(`/api/billing/cycles/${cycleId}/verify-payment`, {
      method: 'POST', token: distAdminToken,
      body: { razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: sig },
    });
    if (v2.status !== 200) throw new Error(`second verify expected 200, got ${v2.status}`);
    if (v2.body.data?.alreadyPaid !== true) throw new Error(`expected alreadyPaid:true, got ${JSON.stringify(v2.body.data)}`);
    const second = await prisma.billingCycle.findUniqueOrThrow({ where: { id: cycleId } });
    if (second.paidAt?.getTime() !== firstPaidAt?.getTime()) throw new Error(`paidAt changed (${firstPaidAt?.toISOString()} → ${second.paidAt?.toISOString()})`);
    record('Variant 3 — Phase E idempotency', true, `alreadyPaid:true, paidAt unchanged`);
  } catch (e) {
    record('Variant 3 — Phase E idempotency', false, (e as Error).message);
  }

  // ─── Variant 4 — Phase F customer FULL payment ───────────────────────────
  try {
    // Enable Razorpay on dist-002 (Sharma) so dist-002 customer can pay.
    await prisma.distributor.update({
      where: { id: 'dist-002' },
      data: {
        razorpayEnabled: true,
        razorpayKeyId: RZP_KEY_ID,
        razorpayKeySecret: RZP_KEY_SECRET,
        razorpayWebhookSecret: RZP_WEBHOOK_SECRET,
      },
    });
    const invoiceId = await createOutstandingInvoice('dist-002', cust2.customerId!, 1000);
    const o = await api<{ razorpayOrderId: string; amount: number; mock: boolean }>(
      `/api/customer-portal/invoices/${invoiceId}/create-payment-order`,
      { method: 'POST', token: cust2Token, body: { amount: 1000 } },
    );
    if (!o.ok) throw new Error(`create-order failed ${o.status} ${JSON.stringify(o.body)}`);
    if (o.body.data!.mock !== false) throw new Error(`expected mock:false`);
    const orderId = o.body.data!.razorpayOrderId;
    const paymentId = `pay_${PHASE_PREFIX}_v4_${Date.now()}`;
    const sig = handlerSignature(orderId, paymentId);
    const v = await api(`/api/customer-portal/invoices/${invoiceId}/verify-payment`, {
      method: 'POST', token: cust2Token,
      body: { razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: sig, amount: 1000 },
    });
    if (!v.ok) throw new Error(`verify failed ${v.status} ${JSON.stringify(v.body)}`);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (Number(inv.outstandingAmount) !== 0) throw new Error(`outstanding=${inv.outstandingAmount}, expected 0`);
    if (inv.status !== 'paid') throw new Error(`status=${inv.status}, expected paid`);
    const payment = await prisma.paymentTransaction.findFirstOrThrow({
      where: { razorpayPaymentId: paymentId },
      include: { allocations: true },
    });
    createdPaymentIds.push(payment.id);
    if (payment.allocations.length !== 1) throw new Error(`expected 1 allocation, got ${payment.allocations.length}`);
    if (payment.allocations[0]!.invoiceId !== invoiceId) throw new Error(`allocation invoice mismatch`);
    if (payment.razorpaySignature !== sig) throw new Error(`signature not stored`);
    record('Variant 4 — Phase F customer FULL payment', true, `invoice paid, allocation created`);
  } catch (e) {
    record('Variant 4 — Phase F customer FULL payment', false, (e as Error).message);
  }

  // ─── Variant 5 — Phase F customer PARTIAL payment ────────────────────────
  try {
    const invoiceId = await createOutstandingInvoice('dist-002', cust2.customerId!, 2000);
    const o = await api<{ razorpayOrderId: string }>(`/api/customer-portal/invoices/${invoiceId}/create-payment-order`, {
      method: 'POST', token: cust2Token, body: { amount: 800 },
    });
    if (!o.ok) throw new Error(`create-order failed ${o.status}`);
    const orderId = o.body.data!.razorpayOrderId;
    const paymentId = `pay_${PHASE_PREFIX}_v5_${Date.now()}`;
    const sig = handlerSignature(orderId, paymentId);
    const v = await api(`/api/customer-portal/invoices/${invoiceId}/verify-payment`, {
      method: 'POST', token: cust2Token,
      body: { razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: sig, amount: 800 },
    });
    if (!v.ok) throw new Error(`verify failed ${v.status} ${JSON.stringify(v.body)}`);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (Number(inv.outstandingAmount) !== 1200) throw new Error(`outstanding=${inv.outstandingAmount}, expected 1200`);
    if (inv.status !== 'partially_paid') throw new Error(`status=${inv.status}, expected partially_paid`);
    const payment = await prisma.paymentTransaction.findFirstOrThrow({ where: { razorpayPaymentId: paymentId } });
    createdPaymentIds.push(payment.id);
    if (Number(payment.amount) !== 800) throw new Error(`payment.amount=${payment.amount}, expected 800`);
    record('Variant 5 — Phase F customer PARTIAL payment', true, `outstanding 2000→1200, status=partially_paid`);
  } catch (e) {
    record('Variant 5 — Phase F customer PARTIAL payment', false, (e as Error).message);
  }

  // ─── Variant 6 — Phase F customer FAILURE (invalid sig) ──────────────────
  try {
    const invoiceId = await createOutstandingInvoice('dist-002', cust2.customerId!, 500);
    const o = await api<{ razorpayOrderId: string }>(`/api/customer-portal/invoices/${invoiceId}/create-payment-order`, {
      method: 'POST', token: cust2Token, body: { amount: 500 },
    });
    const orderId = o.body.data!.razorpayOrderId;
    const paymentId = `pay_${PHASE_PREFIX}_v6_${Date.now()}`;
    const v = await api(`/api/customer-portal/invoices/${invoiceId}/verify-payment`, {
      method: 'POST', token: cust2Token,
      body: { razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: 'definitely_not_a_real_hmac', amount: 500 },
    });
    if (v.status !== 400) throw new Error(`expected 400, got ${v.status}`);
    if (v.body.code !== 'INVALID_SIGNATURE') throw new Error(`expected INVALID_SIGNATURE, got ${v.body.code}`);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (Number(inv.outstandingAmount) !== 500) throw new Error(`outstanding changed: ${inv.outstandingAmount}`);
    const payment = await prisma.paymentTransaction.findFirst({ where: { razorpayPaymentId: paymentId } });
    if (payment) throw new Error(`payment was recorded despite invalid sig`);
    record('Variant 6 — Phase F customer FAILURE (invalid sig)', true, 'invoice unchanged, no payment row');
  } catch (e) {
    record('Variant 6 — Phase F customer FAILURE (invalid sig)', false, (e as Error).message);
  }

  // ─── Variant 7 — Phase F cross-tenant isolation ──────────────────────────
  try {
    // dist-001 customer (cust1) tries to pay dist-002 invoice.
    const invoiceId = await createOutstandingInvoice('dist-002', cust2.customerId!, 100);
    const o = await api(`/api/customer-portal/invoices/${invoiceId}/create-payment-order`, {
      method: 'POST', token: cust1Token, body: { amount: 100 },
    });
    if (o.status !== 404) throw new Error(`expected 404 (hide existence), got ${o.status}`);
    record('Variant 7 — Phase F cross-tenant isolation', true, '404 hides existence');
  } catch (e) {
    record('Variant 7 — Phase F cross-tenant isolation', false, (e as Error).message);
  }

  // ─── Variant 8 — Phase F razorpayEnabled=false ───────────────────────────
  try {
    // dist-001 hasn't had Razorpay enabled in this run — make sure of it.
    await prisma.distributor.update({
      where: { id: 'dist-001' },
      data: { razorpayEnabled: false, razorpayKeyId: null, razorpayKeySecret: null },
    });
    const invoiceId = await createOutstandingInvoice('dist-001', cust1.customerId!, 100);
    const o = await api(`/api/customer-portal/invoices/${invoiceId}/create-payment-order`, {
      method: 'POST', token: cust1Token, body: { amount: 100 },
    });
    if (o.status !== 400) throw new Error(`expected 400, got ${o.status}`);
    if (o.body.code !== 'RAZORPAY_NOT_ENABLED') throw new Error(`expected RAZORPAY_NOT_ENABLED, got ${o.body.code}`);
    record('Variant 8 — Phase F razorpayEnabled=false', true, '400 RAZORPAY_NOT_ENABLED');
  } catch (e) {
    record('Variant 8 — Phase F razorpayEnabled=false', false, (e as Error).message);
  }

  // ─── Variant 9 — Phase E webhook capture ──────────────────────────────────
  try {
    const cycleId = await createPendingCycle();
    const o = await api<{ razorpayOrderId: string }>(`/api/billing/cycles/${cycleId}/create-payment-order`, { method: 'POST', token: distAdminToken });
    const orderId = o.body.data!.razorpayOrderId;
    const paymentId = `pay_${PHASE_PREFIX}_v9_${Date.now()}`;
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { order_id: orderId, id: paymentId, method: 'upi' } } },
    });
    const sig = webhookSignature(body);
    const wRes = await api('/api/billing/webhooks/razorpay', {
      method: 'POST', body,
      rawHeaders: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig },
    });
    if (!wRes.ok) throw new Error(`webhook failed ${wRes.status} ${JSON.stringify(wRes.body)}`);
    const after = await prisma.billingCycle.findUniqueOrThrow({ where: { id: cycleId } });
    if (after.billingStatus !== 'paid_billing') throw new Error(`status=${after.billingStatus}`);
    if (after.razorpayPaymentId !== paymentId) throw new Error(`razorpayPaymentId mismatch`);
    if (after.paymentMethod !== 'upi') throw new Error(`paymentMethod=${after.paymentMethod}`);
    record('Variant 9 — Phase E webhook capture', true, 'cycle flipped via webhook');
  } catch (e) {
    record('Variant 9 — Phase E webhook capture', false, (e as Error).message);
  }

  // ─── Variant 10 — Phase F webhook customer payment ───────────────────────
  try {
    // Re-enable Razorpay on dist-002 (Variant 4 cleanup left it enabled,
    // but Variant 8 may have flipped dist-001 only — re-set explicitly).
    await prisma.distributor.update({
      where: { id: 'dist-002' },
      data: {
        razorpayEnabled: true,
        razorpayKeyId: RZP_KEY_ID,
        razorpayKeySecret: RZP_KEY_SECRET,
        razorpayWebhookSecret: RZP_WEBHOOK_SECRET,
      },
    });
    const invoiceId = await createOutstandingInvoice('dist-002', cust2.customerId!, 1500);
    const o = await api<{ razorpayOrderId: string }>(`/api/customer-portal/invoices/${invoiceId}/create-payment-order`, {
      method: 'POST', token: cust2Token, body: { amount: 1500 },
    });
    const orderId = o.body.data!.razorpayOrderId;
    const paymentId = `pay_${PHASE_PREFIX}_v10_${Date.now()}`;
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: {
        order_id: orderId, id: paymentId, method: 'card', amount: 150000,
        notes: { invoiceId, customerId: cust2.customerId!, distributorId: 'dist-002' },
      } } },
    });
    const sig = webhookSignature(body);
    const wRes = await api(`/api/customer-portal/webhooks/razorpay/dist-002`, {
      method: 'POST', body,
      rawHeaders: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig },
    });
    if (!wRes.ok) throw new Error(`webhook failed ${wRes.status} ${JSON.stringify(wRes.body)}`);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (Number(inv.outstandingAmount) !== 0) throw new Error(`outstanding=${inv.outstandingAmount}, expected 0`);
    const payment = await prisma.paymentTransaction.findFirstOrThrow({ where: { razorpayPaymentId: paymentId } });
    createdPaymentIds.push(payment.id);
    if (payment.paymentMethod !== 'online') throw new Error(`method=${payment.paymentMethod}, expected online (mapped from card)`);
    record('Variant 10 — Phase F webhook customer payment', true, 'webhook recorded payment + allocated');
  } catch (e) {
    record('Variant 10 — Phase F webhook customer payment', false, (e as Error).message);
  }

  // ─── Variant 11 — Webhook invalid signature (security) ───────────────────
  try {
    const cycleId = await createPendingCycle();
    const o = await api<{ razorpayOrderId: string }>(`/api/billing/cycles/${cycleId}/create-payment-order`, { method: 'POST', token: distAdminToken });
    const orderId = o.body.data!.razorpayOrderId;
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { order_id: orderId, id: 'pay_evil', method: 'card' } } },
    });
    const wRes = await api('/api/billing/webhooks/razorpay', {
      method: 'POST', body,
      rawHeaders: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'definitely_not_correct' },
    });
    if (wRes.status !== 400) throw new Error(`expected 400, got ${wRes.status}`);
    if (wRes.body.code !== 'INVALID_WEBHOOK_SIGNATURE') throw new Error(`expected INVALID_WEBHOOK_SIGNATURE, got ${wRes.body.code}`);
    const after = await prisma.billingCycle.findUniqueOrThrow({ where: { id: cycleId } });
    if (after.billingStatus !== 'pending_payment') throw new Error(`status=${after.billingStatus}, expected pending_payment`);
    if (after.razorpayPaymentId !== null) throw new Error(`razorpayPaymentId should be null`);
    record('Variant 11 — Webhook invalid signature', true, '400 + no DB write');
  } catch (e) {
    record('Variant 11 — Webhook invalid signature', false, (e as Error).message);
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n===== Summary =====');
  const passCount = results.filter(r => r.pass).length;
  console.log(`${passCount} / ${results.length} variants passed`);
  if (passCount < results.length) {
    console.log('\nFailures:');
    for (const r of results.filter(r => !r.pass)) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
  }
  return passCount === results.length;
}

try {
  const ok = await run();
  await cleanup();
  await prisma.$disconnect();
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error('Runner crashed:', e);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
}
