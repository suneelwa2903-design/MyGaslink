/**
 * M14 v1.0 — Account deletion request endpoints (IOS-ACCOUNT-DELETION-SPEC §4).
 *
 * Three endpoints, all under `/api/users/me/deletion-request*`. Mounted via
 * the existing `userRoutes` aggregator so they inherit `authenticate` +
 * `resolveDistributor` from the parent mount in app.ts.
 *
 * Spec authority: docs/IOS-ACCOUNT-DELETION-SPEC.md
 *
 * Notes:
 *   - Request-and-queue model (v1.0). NO actual deletion or anonymization
 *     happens here — that lands in the v1.1 cron worker. v1.0 ships the
 *     queue, the auth-middleware login block, and the cancel path. Apple
 *     §5.1.1(v) explicitly allows queued deletion provided the disclosure
 *     copy promises a deadline (30 days) — see §7 of the spec.
 *   - Refresh-token revocation in v1.0 is `User.refreshToken = null` since
 *     this codebase stores refresh tokens directly on the User row (verified
 *     packages/api/prisma/schema.prisma User.refreshToken).
 *   - Email confirmation deferred (spec §13 Q2): no generic sendEmail helper
 *     exists today and the spec marks email best-effort. Log line only for
 *     now; a follow-up adds sendAccountDeletionRequestEmail.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { validate } from '../middleware/validate.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { logBusinessEvent, logger } from '../utils/logger.js';
import { computeCustomerOverdue } from '../services/paymentService.js';

const router = Router();

const GRACE_PERIOD_DAYS = 30;
const GRACE_PERIOD_MS = GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
const OUTSTANDING_BALANCE_THRESHOLD = 100; // ₹100 — allows rounding tails (spec §4.1 step 5)

const submitDeletionSchema = z.object({
  confirmText: z.literal('DELETE MY ACCOUNT'),
  reason: z.string().max(500).optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users/me/deletion-request — submit
// ─────────────────────────────────────────────────────────────────────────────
router.post('/me/deletion-request', validate(submitDeletionSchema), async (req, res) => {
  const userId = req.user!.userId;
  const role = req.user!.role;
  const distributorId = req.user!.distributorId;
  const customerId = req.user!.customerId;
  const { reason } = req.body as z.infer<typeof submitDeletionSchema>;

  // Spec §4.1 step 3 — Super-admin self-delete block. UI also hides the
  // entry point but the server is the source of truth.
  if (role === 'super_admin') {
    return sendError(
      res,
      'Super-admin accounts cannot be self-deleted. Contact another super-admin.',
      423,
      'SUPERADMIN_SELF_DELETE_BLOCKED',
    );
  }

  // Spec §4.1 step 2 — Sole-admin block. A tenant must always have at
  // least one active distributor_admin.
  if (role === 'distributor_admin' && distributorId) {
    const otherAdmins = await prisma.user.count({
      where: {
        distributorId,
        role: 'distributor_admin',
        id: { not: userId },
        status: 'active',
        deletedAt: null,
      },
    });
    if (otherAdmins === 0) {
      return sendError(
        res,
        'You are the only admin for this distributor; add a second admin before deleting your account.',
        423,
        'SOLE_ADMIN_BLOCK',
      );
    }
  }

  // Spec §4.1 step 4 — Duplicate-request guard. The client SHOULD redirect
  // to the pending-deletion screen before reaching here, but enforce on the
  // server too. Cancelled requests do NOT block a re-submit.
  const existing = await prisma.accountDeletionRequest.findUnique({
    where: { userId },
    select: { status: true, scheduledCompletionAt: true },
  });
  if (existing && existing.status === 'pending') {
    return sendError(
      res,
      `Deletion already requested. Scheduled completion: ${existing.scheduledCompletionAt.toISOString()}`,
      409,
      'DELETION_ALREADY_PENDING',
    );
  }

  // Spec §4.1 step 5 — Outstanding-balance check (customer role only).
  // Must include distributorId in the query (CLAUDE.md anti-pattern #13).
  if (role === 'customer' && customerId && distributorId) {
    try {
      const outstanding = await computeCustomerOverdue(distributorId, customerId);
      if (outstanding > OUTSTANDING_BALANCE_THRESHOLD) {
        return sendError(
          res,
          `You have ₹${outstanding.toFixed(2)} outstanding. Please contact the distributor to settle the balance before deleting your account.`,
          409,
          'OUTSTANDING_BALANCE',
        );
      }
    } catch (err) {
      logger.warn('Outstanding-balance check failed; allowing deletion request to proceed', {
        userId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Spec §4.1 step 6-7 — Insert request row and revoke refresh token in
  // one transaction.
  const scheduledCompletionAt = new Date(Date.now() + GRACE_PERIOD_MS);
  const requestIp = req.ip ?? null;
  const requestUserAgent = req.headers['user-agent'] ?? null;

  const saved = await prisma.$transaction(async (tx) => {
    const row = await tx.accountDeletionRequest.upsert({
      where: { userId },
      update: {
        status: 'pending',
        requestedAt: new Date(),
        scheduledCompletionAt,
        cancelledAt: null,
        completedAt: null,
        reason: reason ?? null,
        requestIp,
        requestUserAgent: typeof requestUserAgent === 'string' ? requestUserAgent : null,
        distributorId: distributorId ?? null,
      },
      create: {
        userId,
        distributorId: distributorId ?? null,
        scheduledCompletionAt,
        reason: reason ?? null,
        requestIp,
        requestUserAgent: typeof requestUserAgent === 'string' ? requestUserAgent : null,
      },
    });
    // Revoke refresh token — forces next refresh to fail; access token
    // will naturally expire within 15 min.
    await tx.user.update({
      where: { id: userId },
      data: { refreshToken: null },
    });
    return row;
  });

  logBusinessEvent({
    action: 'user.account.deletion_requested',
    entityType: 'user',
    entityId: userId,
    userId,
    distributorId: distributorId ?? undefined,
    requestId: req.requestId,
    details: {
      requestId: saved.id,
      scheduledCompletionAt: saved.scheduledCompletionAt.toISOString(),
    },
  });

  return sendSuccess(res, {
    requestId: saved.id,
    requestedAt: saved.requestedAt.toISOString(),
    scheduledCompletionAt: saved.scheduledCompletionAt.toISOString(),
    cancellationDeadline: saved.scheduledCompletionAt.toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users/me/deletion-request/cancel — cancel
// ─────────────────────────────────────────────────────────────────────────────
router.post('/me/deletion-request/cancel', async (req, res) => {
  const userId = req.user!.userId;

  const pending = await prisma.accountDeletionRequest.findFirst({
    where: { userId, status: 'pending' },
  });
  if (!pending) {
    return sendError(res, 'No pending deletion request to cancel', 404, 'NOT_FOUND');
  }

  await prisma.accountDeletionRequest.update({
    where: { id: pending.id },
    data: { status: 'cancelled', cancelledAt: new Date() },
  });

  logBusinessEvent({
    action: 'user.account.deletion_cancelled',
    entityType: 'user',
    entityId: userId,
    userId,
    distributorId: req.user!.distributorId ?? undefined,
    requestId: req.requestId,
    details: { requestId: pending.id },
  });

  // 204 No Content per spec §4.2.
  return res.status(204).send();
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/me/deletion-request — status
// ─────────────────────────────────────────────────────────────────────────────
router.get('/me/deletion-request', async (req, res) => {
  const userId = req.user!.userId;

  const request = await prisma.accountDeletionRequest.findFirst({
    where: { userId, status: { in: ['pending', 'cancelled'] } },
    orderBy: { requestedAt: 'desc' },
  });
  if (!request) {
    return sendSuccess(res, { requested: false });
  }

  const daysRemaining = request.status === 'pending'
    ? Math.max(0, Math.ceil((request.scheduledCompletionAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;

  return sendSuccess(res, {
    requestId: request.id,
    status: request.status,
    requested: request.status === 'pending',
    requestedAt: request.requestedAt.toISOString(),
    scheduledCompletionAt: request.scheduledCompletionAt.toISOString(),
    daysRemaining,
    cancelledAt: request.cancelledAt?.toISOString() ?? null,
  });
});

export default router;
