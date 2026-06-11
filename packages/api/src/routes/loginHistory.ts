/**
 * Group DPDP (2026-06-11) — login history maintenance.
 *
 * Mounted at /api/admin/login-history. Currently exposes ONE endpoint:
 * a manual purge of rows older than 180 days. A proper scheduled job
 * should land in a follow-up sprint (see TODO comment); until then a
 * super-admin can invoke this endpoint to keep the table bounded.
 *
 * Why 180 days: DPDP §43 doesn't pin an exact retention period but
 * "purpose limitation" is the spirit. Six months is the same window
 * Apple App Review and most India-based SaaS security audits expect
 * for auth-event records.
 */
import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';

const router = Router();

// TODO (post-launch): convert to a scheduled job (node-cron or a
// pg_cron entry). See CLAUDE.md DPDP section.
router.post(
  '/purge-old',
  authenticate,
  requireRole('super_admin'),
  async (req, res) => {
    try {
      const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
      const result = await prisma.loginHistory.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      return sendSuccess(res, { deleted: result.count, cutoff: cutoff.toISOString() });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  },
);

export default router;
