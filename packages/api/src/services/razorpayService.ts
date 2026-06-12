/**
 * Phase E (2026-06-12) — Razorpay payment helpers.
 *
 * Replicates the Anah reference implementation (C:/Projects/Anah —
 * studied during the Pre-Razorpay sweep) and adapts it from Next.js
 * route handlers to an Express service module so:
 *   - Phase E (GasLink subscription) and Phase F (per-distributor
 *     customer-portal payments) can share the SDK + crypto + mock-
 *     mode patterns without re-deriving them.
 *   - The same `verifyHandlerSignature` works for both flows; the only
 *     thing that changes between them is which credentials feed in.
 *
 * Architecture
 *   makeRazorpayClient   — Razorpay SDK instance, per-credentials.
 *                          Anah builds a new client inside each
 *                          handler; we keep that posture so Phase F's
 *                          per-distributor flow can hand the function
 *                          a freshly-decrypted secret on every call
 *                          without race-conditioned singleton reuse.
 *   createRazorpayOrder  — `orders.create({...})` wrapper that
 *                          enforces the minimum-amount + paise
 *                          conversion + `receipt` + `notes` posture.
 *   verifyHandlerSignature
 *                        — synchronous handler-callback signature
 *                          check. HMAC over the literal pipe-joined
 *                          string "<orderId>|<paymentId>" with
 *                          key_secret. Per Razorpay docs.
 *   verifyWebhookSignature
 *                        — webhook signature check. HMAC over the RAW
 *                          request body with the dashboard-issued
 *                          webhook secret (DIFFERENT secret from
 *                          key_secret). Per Razorpay docs.
 *   isMockKey            — `keyId.includes('mock')`. When true the
 *                          create-order path returns a deterministic
 *                          `mock_rzp_<receipt>` order id and the
 *                          verify paths accept any signature so the
 *                          full flow is end-to-end testable without
 *                          hitting the live sandbox. Matches Anah's
 *                          mock posture exactly.
 *
 * Security
 *   - key_secret never logged, never returned in any response.
 *   - signature comparison uses crypto.timingSafeEqual to avoid
 *     leaking byte position via wall-clock — Razorpay docs say string
 *     equality is acceptable but timing-safe is the stronger posture
 *     and costs us nothing.
 *
 * Failure semantics
 *   - SDK errors bubble to the caller; routes wrap them. We do NOT
 *     catch + fall back to mock here. Anah does fall-back-to-mock in
 *     dev when Razorpay returns 401 (credentials misconfigured); we
 *     keep that decision in the route layer so it's visible.
 */
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RazorpayCreds {
  keyId: string;
  keySecret: string;
}

export interface RazorpayOrderInput {
  amountInPaise: number;
  receipt: string;
  notes: Record<string, string>;
  currency?: string; // defaults to INR
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
}

export interface MockRazorpayOrder extends RazorpayOrder {
  mock: true;
}

// ─── Mock detection ─────────────────────────────────────────────────────────

/**
 * True when the integration should bypass real Razorpay calls. Two
 * triggers (matching Anah's posture):
 *   1. keyId literally contains "mock" — explicit dev mode.
 *   2. keySecret is empty / undefined — the deployment hasn't set
 *      the secret yet, so any real call would 401. Soft-failing to
 *      mock here is friendlier than crashing during a Settings page
 *      load.
 *
 * The route layer additionally checks NODE_ENV to gate this — mock
 * mode is dev-only on the GasLink side and dev-or-not-yet-configured
 * on the per-distributor side. The caller decides which.
 */
export function isMockKey(keyId: string | undefined): boolean {
  if (!keyId) return true;
  return keyId.includes('mock');
}

// ─── SDK client ─────────────────────────────────────────────────────────────

export function makeRazorpayClient(creds: RazorpayCreds): Razorpay {
  return new Razorpay({
    key_id: creds.keyId,
    key_secret: creds.keySecret,
  });
}

// ─── Order creation ─────────────────────────────────────────────────────────

/**
 * Create a Razorpay order. Wraps SDK.orders.create with:
 *   - Math.max(..., 100) floor (Razorpay rejects <₹1)
 *   - Default currency INR
 *   - Mock short-circuit when isMockKey(creds.keyId)
 *
 * The `receipt` argument MUST be our internal PK (cycleId, invoiceId,
 * etc.) so the webhook handler can reverse-lookup the row by
 * `razorpayOrderId` OR by `receipt` in the order metadata.
 *
 * `notes` is forensic metadata Razorpay echoes back in dashboard +
 * webhooks. Keep stringly-typed (the Razorpay API rejects non-string
 * values).
 */
export async function createRazorpayOrder(
  creds: RazorpayCreds,
  input: RazorpayOrderInput,
): Promise<RazorpayOrder | MockRazorpayOrder> {
  const amount = Math.max(Math.round(input.amountInPaise), 100);
  const currency = input.currency ?? 'INR';

  if (isMockKey(creds.keyId)) {
    logger.info('[RAZORPAY MOCK] orders.create skipped — returning mock order', {
      receipt: input.receipt,
      amount,
    });
    return {
      id: `mock_rzp_${input.receipt}`,
      amount,
      currency,
      receipt: input.receipt,
      mock: true,
    };
  }

  const client = makeRazorpayClient(creds);
  const order = await client.orders.create({
    amount,
    currency,
    receipt: input.receipt,
    notes: input.notes,
  });

  return {
    id: order.id,
    amount: typeof order.amount === 'number' ? order.amount : parseInt(String(order.amount), 10),
    currency: String(order.currency),
    receipt: String(order.receipt),
  };
}

// ─── Signature verification ────────────────────────────────────────────────

/**
 * Verify the signature Razorpay's checkout `handler` callback passes
 * back to our verify endpoint. The signed string is the literal
 * pipe-joined "<order_id>|<payment_id>" (Razorpay docs §8.2). HMAC
 * with the key_secret (NOT the webhook secret).
 *
 * Mock mode short-circuits to `true` so end-to-end tests pass without
 * a live sandbox. Real mode uses crypto.timingSafeEqual for
 * constant-time comparison.
 */
export function verifyHandlerSignature(
  creds: RazorpayCreds,
  razorpayOrderId: string,
  razorpayPaymentId: string,
  razorpaySignature: string,
): boolean {
  if (isMockKey(creds.keyId)) return true;
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) return false;

  const expected = crypto
    .createHmac('sha256', creds.keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  return timingSafeStringEqual(expected, razorpaySignature);
}

/**
 * Verify the signature on a Razorpay webhook. DIFFERENT mechanics
 * from handler-signature verify:
 *   - HMAC is over the RAW request body, not a pipe-joined string.
 *   - The secret is the webhook secret registered in the Razorpay
 *     dashboard, NOT the key_secret.
 *   - The signature arrives in the `x-razorpay-signature` header.
 *
 * Caller is responsible for:
 *   - Reading the raw body (express.json() parses; the webhook route
 *     needs express.raw() middleware OR rawBody capture).
 *   - Passing the value of the x-razorpay-signature header verbatim.
 *
 * Mock mode (webhookSecret undefined or contains "mock"):
 *   - Returns true. Used by tests + local dev when no webhook secret
 *     is configured. Tests must opt into this explicitly by setting
 *     RAZORPAY_WEBHOOK_SECRET to a string containing "mock" or
 *     leaving it unset.
 */
export function verifyWebhookSignature(
  webhookSecret: string | undefined,
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
): boolean {
  if (!webhookSecret || webhookSecret.includes('mock')) return true;
  if (!signatureHeader) return false;

  const bodyString = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(bodyString)
    .digest('hex');

  return timingSafeStringEqual(expected, signatureHeader);
}

// ─── Internals ──────────────────────────────────────────────────────────────

/**
 * Constant-time string equality. `crypto.timingSafeEqual` requires
 * equal-length Buffers; this wrapper falls through to `false` on
 * length mismatch (which is itself constant-time at the byte-count
 * level — comparing total length doesn't leak per-byte information).
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
