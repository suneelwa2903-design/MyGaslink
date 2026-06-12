import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import * as billingService from '../services/billingService.js';
import {
  createRazorpayOrder,
  verifyHandlerSignature,
  isMockKey,
  type RazorpayCreds,
} from '../services/razorpayService.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.js';
import { mapBillingCycle, mapBillingCycles } from '../utils/mappers.js';
import { z } from 'zod';

type ServiceError = { message: string; statusCode?: number; code?: string };

const router = Router();

// GET /api/billing/cycles
router.get('/cycles', async (req, res) => {
  try {
    // Super_admin without an X-Distributor-Id header sees all distributors;
    // every other role is locked to req.user.distributorId by middleware.
    const distributorId = req.user!.distributorId ?? undefined;

    const result = await billingService.listBillingCycles(distributorId, {
      status: req.query.status as string,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined,
    });
    return sendSuccess(res, { cycles: mapBillingCycles(result.data) }, 200, result.meta);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/billing/cycles/:id
router.get('/cycles/:id', async (req, res) => {
  try {
    const cycle = await billingService.getBillingCycleById(param(req.params.id));
    if (!cycle) return sendNotFound(res, 'Billing cycle');
    // Authorization check
    if (req.user!.role !== 'super_admin' && cycle.distributorId !== req.user!.distributorId) {
      return sendNotFound(res, 'Billing cycle');
    }
    return sendSuccess(res, mapBillingCycle(cycle));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// POST /api/billing/generate
router.post('/generate',
  requireRole('super_admin'),
  validate(z.object({
    distributorId: z.string().min(1),
    periodType: z.enum(['monthly', 'quarterly', 'half_yearly', 'yearly']),
    periodStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    // Phase 4b (2026-06-12): optional ad-hoc discount. Used for promotional
    // first-cycle waivers, partial-month proration, support-credit refunds,
    // etc. Reason is required when amount is non-zero so the audit trail is
    // intelligible. Upper bound (<= subtotal) is enforced in the service.
    discountAmount: z.number().min(0).optional(),
    discountReason: z.string().max(500).optional(),
  }).refine(
    (d) => !d.discountAmount || d.discountAmount === 0 || (d.discountReason && d.discountReason.trim().length > 0),
    { message: 'discountReason is required when discountAmount is non-zero', path: ['discountReason'] },
  )),
  auditLog('generate', 'billing_cycle'),
  async (req, res) => {
    try {
      const cycle = await billingService.generateBillingCycle(req.body.distributorId, req.body);
      return sendCreated(res, mapBillingCycle(cycle));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// PUT /api/billing/cycles/:id/mark-paid
router.put('/cycles/:id/mark-paid',
  requireRole('super_admin'),
  auditLog('mark_paid', 'billing_cycle'),
  async (req, res) => {
    try {
      const cycle = await billingService.markBillingPaid(param(req.params.id));
      return sendSuccess(res, mapBillingCycle(cycle));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/billing/suspend/:distributorId
router.post('/suspend/:distributorId',
  requireRole('super_admin'),
  auditLog('suspend', 'billing'),
  async (req, res) => {
    try {
      const result = await billingService.suspendForOverdueBilling(param(req.params.distributorId));
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/billing/unsuspend/:distributorId
router.post('/unsuspend/:distributorId',
  requireRole('super_admin'),
  auditLog('unsuspend', 'billing'),
  async (req, res) => {
    try {
      const result = await billingService.unsuspendDistributor(param(req.params.distributorId));
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/billing/check-expiry
router.post('/check-expiry',
  requireRole('super_admin'),
  auditLog('check_expiry', 'billing'),
  async (_req, res) => {
    try {
      const result = await billingService.checkBillingExpiryAndCreatePendingActions();
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/billing/mark-overdue (for cron)
router.post('/mark-overdue',
  requireRole('super_admin'),
  auditLog('mark_overdue', 'billing'),
  async (_req, res) => {
    try {
      const result = await billingService.markOverdueBillingCycles();
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// ─── Phase E: Razorpay subscription payments ─────────────────────────────────
//
// Three endpoints, each Anah-pattern verbatim:
//   POST /cycles/:id/create-payment-order  — distributor_admin
//   POST /cycles/:id/verify-payment        — distributor_admin
//   POST /webhooks/razorpay                — public (Razorpay calls it)
//
// Credentials come from GasLink's own env vars (Phase E single account):
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
// Mock mode triggers when keyId.includes('mock') OR the secret is unset.
// Tests rely on this — leave RAZORPAY_KEY_ID=rzp_test_mock in CI env.

function getGaslinkRazorpayCreds(): RazorpayCreds {
  return {
    keyId: process.env.RAZORPAY_KEY_ID ?? 'rzp_test_mock',
    keySecret: process.env.RAZORPAY_KEY_SECRET ?? '',
  };
}

// Per-IP limiter on the payment-creation + verification endpoints. The
// global 1000/15min cap (app.ts) is too loose for a payment surface;
// per-IP 60/15min is generous for a single user clicking through
// checkout but kills any abuse vector. Webhook is unauthenticated and
// gets its own limiter below.
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 60 : 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, data: null, error: 'Too many payment requests', code: 'RATE_LIMITED' },
});

// POST /api/billing/cycles/:id/create-payment-order
// Auth: distributor_admin paying for THEIR OWN distributor's cycle.
// Tenant isolation: the cycle's distributorId must match req.user!.distributorId.
// Cycle must be in pending or overdue status (paid cycles cannot be re-paid).
router.post('/cycles/:id/create-payment-order',
  paymentLimiter,
  requireRole('distributor_admin', 'super_admin'),
  auditLog('create_payment_order', 'billing_cycle'),
  async (req, res) => {
    try {
      const cycleId = param(req.params.id);
      const cycle = await prisma.billingCycle.findUnique({ where: { id: cycleId } });
      if (!cycle) return sendNotFound(res, 'Billing cycle not found');

      // Tenant isolation (anti-pattern #1 + #13 prep). Super_admin
      // bypass is intentional — they pay on behalf of any tenant.
      if (req.user!.role !== 'super_admin' && cycle.distributorId !== req.user!.distributorId) {
        return sendError(res, 'Billing cycle does not belong to this distributor', 403, 'CROSS_TENANT_ACCESS');
      }

      // 9-issues Issue 3 (2026-06-12): widened from
      // pending_payment | overdue_billing to also include
      // invoice_generated — that's the post-issue status the
      // distributor lands on before a separate payment-cycle
      // transition that doesn't always happen automatically. Mirror
      // of the web Pay Now gate at SettingsPage.tsx. Paid, suspended,
      // and pending_generation cycles still 400.
      const payableStatuses = new Set(['pending_payment', 'overdue_billing', 'invoice_generated']);
      if (!payableStatuses.has(cycle.billingStatus)) {
        return sendError(
          res,
          `Cycle is in status "${cycle.billingStatus}" — only pending, overdue, or generated cycles can be paid.`,
          400,
          'CYCLE_NOT_PAYABLE',
        );
      }

      const creds = getGaslinkRazorpayCreds();
      const amountInPaise = Math.round(Number(cycle.totalAmountInclGst) * 100);
      const order = await createRazorpayOrder(creds, {
        amountInPaise,
        receipt: cycle.id,
        notes: {
          cycleId: cycle.id,
          distributorId: cycle.distributorId,
          periodType: cycle.periodType,
          periodStartDate: cycle.periodStartDate.toISOString().slice(0, 10),
          periodEndDate: cycle.periodEndDate.toISOString().slice(0, 10),
        },
      });

      // Persist the orderId so the verify endpoint + webhook can find
      // the row. update (not updateMany) — single row, known PK.
      await prisma.billingCycle.update({
        where: { id: cycle.id },
        data: { razorpayOrderId: order.id },
      });

      return sendCreated(res, {
        razorpayOrderId: order.id,
        amount: order.amount,
        currency: order.currency,
        // key_id is public — required by the frontend checkout modal.
        // Never return key_secret here (or anywhere else).
        keyId: creds.keyId,
        // Surface mock flag so the web/mobile frontend can short-
        // circuit to verify-payment without actually opening the
        // Razorpay modal during local dev.
        mock: isMockKey(creds.keyId),
      });
    } catch (err: unknown) {
      const e = err as ServiceError;
      logger.error('create-payment-order failed', {
        cycleId: req.params.id,
        err: (err as Error).message,
      });
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// POST /api/billing/cycles/:id/verify-payment
// Synchronous verification from the Razorpay checkout `handler` callback.
// Idempotent: a cycle already in paid status returns success without
// re-processing (matches Anah's posture; defends against the webhook +
// handler-callback double-confirm race).
const verifyPaymentSchema = z.object({
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});

router.post('/cycles/:id/verify-payment',
  paymentLimiter,
  requireRole('distributor_admin', 'super_admin'),
  validate(verifyPaymentSchema),
  auditLog('verify_payment', 'billing_cycle'),
  async (req, res) => {
    try {
      const cycleId = param(req.params.id);
      const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

      const cycle = await prisma.billingCycle.findUnique({ where: { id: cycleId } });
      if (!cycle) return sendNotFound(res, 'Billing cycle not found');

      // Tenant isolation — same gate as create-payment-order.
      if (req.user!.role !== 'super_admin' && cycle.distributorId !== req.user!.distributorId) {
        return sendError(res, 'Billing cycle does not belong to this distributor', 403, 'CROSS_TENANT_ACCESS');
      }

      // Idempotency: paid cycles return success without re-processing.
      // The webhook may have landed first; the handler may have racing
      // tabs. Either way the user should see "Payment confirmed".
      if (cycle.billingStatus === 'paid_billing') {
        return sendSuccess(res, { alreadyPaid: true, billingCycle: mapBillingCycle(cycle) });
      }

      // Order ID cross-check — defends against an attacker passing a
      // valid signature for cycle A while claiming to confirm cycle B.
      if (!cycle.razorpayOrderId || cycle.razorpayOrderId !== razorpayOrderId) {
        return sendError(res, 'Order id mismatch', 400, 'ORDER_ID_MISMATCH');
      }

      const creds = getGaslinkRazorpayCreds();
      const signatureValid = verifyHandlerSignature(creds, razorpayOrderId, razorpayPaymentId, razorpaySignature);
      if (!signatureValid) {
        return sendError(res, 'Invalid payment signature', 400, 'INVALID_SIGNATURE');
      }

      // Mark paid. Reuses billingService.markBillingPaid so the
      // suspended → active flip + transaction semantics stay in one
      // place. Then layer in the Razorpay forensic fields.
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.billingCycle.update({
          where: { id: cycle.id },
          data: {
            billingStatus: 'paid_billing',
            razorpayPaymentId,
            razorpaySignature,
            paidAt: new Date(),
          },
        });
        // Mirror markBillingPaid's unsuspend behaviour.
        await tx.distributor.update({
          where: { id: cycle.distributorId },
          data: { billingSuspended: false },
        });
        return row;
      });

      return sendSuccess(res, { billingCycle: mapBillingCycle(updated) });
    } catch (err: unknown) {
      const e = err as ServiceError;
      logger.error('verify-payment failed', {
        cycleId: req.params.id,
        err: (err as Error).message,
      });
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

export default router;
