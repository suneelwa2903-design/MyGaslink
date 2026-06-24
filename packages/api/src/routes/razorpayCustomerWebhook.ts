/**
 * Phase F (2026-06-12) — Razorpay customer-portal webhook (PUBLIC).
 *
 * Mounted at POST /api/customer-portal/webhooks/razorpay/:distributorId
 * BEFORE the authenticated customer-portal router in app.ts. Per-
 * distributor because each tenant has their OWN Razorpay account +
 * webhook secret.
 *
 * Path includes distributorId so the handler knows which
 * razorpayWebhookSecret to verify with. Same raw-body capture
 * mechanism as the Phase E subscription webhook (app.ts express.json
 * verify hook).
 *
 * Recording goes through paymentService.createPayment (same code
 * path as the synchronous /verify-payment endpoint + the manually-
 * recorded admin path), with idempotency on razorpayPaymentId so a
 * webhook + verify race only records once.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { verifyWebhookSignature } from '../services/razorpayService.js';
import * as paymentService from '../services/paymentService.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.js';
import { param } from '../utils/params.js';
import { localTodayISO } from '@gaslink/shared';

const router = Router();

/**
 * Map Razorpay's payment method classification (card | upi | netbanking
 * | wallet | emi) to our PaymentMethod enum (cash | cheque | online | upi
 * | bank_transfer | credit). UPI stays UPI; everything else collapses to
 * `online`. The original Razorpay method string is preserved in
 * the audit log + the razorpayPaymentId reference for forensic value.
 */
function mapRazorpayMethod(m: string | undefined | null): string {
  if (m === 'upi') return 'upi';
  return 'online';
}

// Per-distributor limiter — webhook for tenant A doesn't affect
// tenant B's quota. Razorpay's retry budget is per-account so 120/min
// is plenty.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, data: null, error: 'Too many webhook requests' },
});

router.post('/:distributorId',
  webhookLimiter,
  async (req, res) => {
    try {
      const distributorId = param(req.params.distributorId);

      // Look up the distributor's webhook secret. NEVER returned in
      // any API response — only ever read internally for the HMAC.
      const dist = await prisma.distributor.findUnique({
        where: { id: distributorId },
        select: {
          razorpayEnabled: true,
          razorpayWebhookSecret: true,
        },
      });
      if (!dist) {
        // 404 — distributor doesn't exist. Razorpay shouldn't retry
        // this; a 404 sends a clear "stop" signal.
        return sendError(res, 'Distributor not found', 404);
      }
      if (!dist.razorpayEnabled) {
        return sendError(res, 'Razorpay not enabled for this distributor', 400);
      }

      const rawBody: Buffer | string =
        (req as unknown as { rawBody?: Buffer }).rawBody ?? JSON.stringify(req.body);
      const signatureHeader = req.header('x-razorpay-signature');

      const signatureValid = verifyWebhookSignature(
        dist.razorpayWebhookSecret ?? undefined,
        rawBody,
        signatureHeader,
      );
      if (!signatureValid) {
        logger.warn('Customer-portal Razorpay webhook signature invalid', {
          distributorId,
          hasSignature: !!signatureHeader,
          hasSecret: !!dist.razorpayWebhookSecret,
        });
        return sendError(res, 'Invalid signature', 400, 'INVALID_WEBHOOK_SIGNATURE');
      }

      const payload = req.body as {
        event?: string;
        payload?: {
          payment?: {
            entity?: {
              order_id?: string;
              id?: string;
              method?: string;
              amount?: number;
              notes?: Record<string, string>;
            };
          };
        };
      };

      if (payload.event === 'payment.captured' || payload.event === 'order.paid') {
        const payment = payload.payload?.payment?.entity;
        const razorpayOrderId = payment?.order_id;
        const razorpayPaymentId = payment?.id;
        const amountPaise = typeof payment?.amount === 'number' ? payment.amount : 0;
        const amount = amountPaise / 100;
        const invoiceId = payment?.notes?.invoiceId;
        const customerId = payment?.notes?.customerId;

        if (!razorpayOrderId || !razorpayPaymentId || !invoiceId || !customerId || amount <= 0) {
          logger.warn('Customer-portal webhook missing required fields', {
            distributorId, razorpayOrderId, razorpayPaymentId, invoiceId, customerId,
          });
          // Still 200 — Razorpay shouldn't retry; the payload is
          // structurally bad. Log and ack.
          return sendSuccess(res, { received: true, processed: false });
        }

        // Idempotency: skip if we already recorded this payment.
        const existing = await prisma.paymentTransaction.findFirst({
          where: { razorpayPaymentId, distributorId },
        });
        if (existing) {
          return sendSuccess(res, { received: true, alreadyRecorded: true });
        }

        await paymentService.createPayment(distributorId, null, {
          customerId,
          amount,
          paymentMethod: mapRazorpayMethod(payment?.method),
          referenceNumber: razorpayPaymentId,
          transactionDate: localTodayISO(),
          allocations: [{ invoiceId, amount }],
          razorpay: {
            razorpayOrderId,
            razorpayPaymentId,
            razorpaySignature: signatureHeader ?? 'webhook-verified',
          },
        });

        logger.info('Customer-portal webhook processed', {
          distributorId,
          event: payload.event,
          razorpayOrderId,
          razorpayPaymentId,
        });
      }

      return sendSuccess(res, { received: true });
    } catch (err) {
      logger.error('Customer-portal webhook handler failed', {
        err: (err as Error).message,
      });
      // Still 200 — non-200 triggers Razorpay retry.
      return sendSuccess(res, { received: true, error: 'handler error logged' });
    }
  },
);

export default router;
