/**
 * Phase E (2026-06-12) — Razorpay webhook (PUBLIC endpoint).
 *
 * Mounted at /api/billing/webhooks/razorpay BEFORE the authenticated
 * billing router in app.ts so it skips JWT + tenant resolution.
 * Signature verification is the ONLY gate — the webhook secret
 * registered in the Razorpay dashboard is the shared key.
 *
 * The HMAC must run over the EXACT bytes Razorpay sent, not the
 * JSON-parsed body. app.ts's express.json() captures rawBody via the
 * `verify` callback for this route; we read it back here.
 *
 * Anah-equivalent: app/api/webhooks/razorpay/route.ts.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { verifyWebhookSignature } from '../services/razorpayService.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.js';

const router = Router();

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, data: null, error: 'Too many webhook requests' },
});

router.post('/',
  webhookLimiter,
  async (req, res) => {
    try {
      // Raw body captured by app.ts express.json() verify hook. Falls
      // back to JSON.stringify(req.body) when rawBody is absent
      // (test environments that haven't wired the hook). The fallback
      // matches what the signature SHOULD be when the JSON has no
      // canonicalization issues; tests that exercise signature checks
      // use the same code path so they stay in lockstep.
      const rawBody: Buffer | string =
        (req as unknown as { rawBody?: Buffer }).rawBody ?? JSON.stringify(req.body);
      const signatureHeader = req.header('x-razorpay-signature');
      const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

      const signatureValid = verifyWebhookSignature(webhookSecret, rawBody, signatureHeader);
      if (!signatureValid) {
        logger.warn('Razorpay webhook signature invalid', {
          hasSignature: !!signatureHeader,
          hasSecret: !!webhookSecret,
        });
        return sendError(res, 'Invalid signature', 400, 'INVALID_WEBHOOK_SIGNATURE');
      }

      const payload = req.body as {
        event?: string;
        payload?: {
          payment?: { entity?: { order_id?: string; id?: string; method?: string } };
          order?: { entity?: { id?: string; receipt?: string } };
        };
      };

      // Both `payment.captured` and `order.paid` fire for the same
      // logical success. Anah handles both; so do we.
      if (payload.event === 'payment.captured' || payload.event === 'order.paid') {
        const payment = payload.payload?.payment?.entity;
        const razorpayOrderId = payment?.order_id ?? payload.payload?.order?.entity?.id;
        const razorpayPaymentId = payment?.id;
        const paymentMethod = payment?.method ?? null;

        if (razorpayOrderId && razorpayPaymentId) {
          // updateMany not update: razorpayOrderId is NOT a PK, and
          // update() throws on zero matches. We want a 200 + no-op
          // when the order belongs to a cancelled or already-paid
          // cycle (webhook + verify-payment race).
          const result = await prisma.billingCycle.updateMany({
            where: { razorpayOrderId, billingStatus: { not: 'paid_billing' } },
            data: {
              billingStatus: 'paid_billing',
              razorpayPaymentId,
              paymentMethod,
              paidAt: new Date(),
            },
          });
          // Also unsuspend the distributor if this was an overdue
          // payment that triggered suspension. Mirror billingService
          // .markBillingPaid.
          if (result.count > 0) {
            const cycle = await prisma.billingCycle.findFirst({
              where: { razorpayOrderId },
              select: { distributorId: true },
            });
            if (cycle) {
              await prisma.distributor.update({
                where: { id: cycle.distributorId },
                data: { billingSuspended: false },
              });
            }
          }
          logger.info('Razorpay webhook processed', {
            event: payload.event,
            razorpayOrderId,
            razorpayPaymentId,
            cyclesUpdated: result.count,
          });
        }
      }

      // Razorpay retries on non-200. Always 200 once signature is OK.
      return sendSuccess(res, { received: true });
    } catch (err) {
      logger.error('Razorpay webhook handler failed', {
        err: (err as Error).message,
      });
      // Still 200 — re-raising would just trigger Razorpay to retry
      // the same broken call. Log and ack.
      return sendSuccess(res, { received: true, error: 'handler error logged' });
    }
  },
);

export default router;
