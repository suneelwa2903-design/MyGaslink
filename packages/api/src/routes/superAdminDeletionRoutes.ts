/**
 * M14 v1.0 — super-admin read-only monitor for account deletion requests.
 *
 * Read-only in v1.0. No execute, no cancel. The v1.1 cron worker handles
 * actual anonymization (IOS-ACCOUNT-DELETION-SPEC §8); admin override
 * paths land in v1.1 too. This page lets the super admin see who has
 * requested deletion and how many days remain before automatic processing.
 */
import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import { sendSuccess } from '../utils/apiResponse.js';
import type { DeletionRequestSummary } from '@gaslink/shared';

const router = Router();

router.get('/deletion-requests', requireRole('super_admin'), async (_req, res) => {
  const rows = await prisma.accountDeletionRequest.findMany({
    include: {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          role: true,
          distributorId: true,
          distributor: { select: { businessName: true } },
        },
      },
    },
    orderBy: { scheduledCompletionAt: 'asc' },
  });

  const now = Date.now();
  const summaries: DeletionRequestSummary[] = rows.map((r) => {
    const scheduledMs = r.scheduledCompletionAt.getTime();
    const daysRemaining = Math.max(0, Math.ceil((scheduledMs - now) / 86_400_000));
    const status: DeletionRequestSummary['status'] = r.completedAt
      ? 'executed'
      : r.cancelledAt
        ? 'cancelled'
        : scheduledMs < now
          ? 'overdue'
          : 'pending';
    return {
      id: r.id,
      userId: r.userId,
      userName: `${r.user.firstName} ${r.user.lastName}`.trim(),
      userEmail: r.user.email,
      userPhone: r.user.phone ?? '',
      userRole: r.user.role,
      distributorName: r.user.distributor?.businessName ?? null,
      requestedAt: r.requestedAt.toISOString(),
      scheduledAt: r.scheduledCompletionAt.toISOString(),
      daysRemaining,
      status,
      executedAt: r.completedAt?.toISOString() ?? null,
      cancelledAt: r.cancelledAt?.toISOString() ?? null,
    };
  });

  return sendSuccess(res, summaries);
});

export default router;
