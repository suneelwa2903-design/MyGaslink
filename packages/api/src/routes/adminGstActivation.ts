/**
 * Group A Step 5 — Admin GST activation routes.
 *
 * Mounted at /api/admin/distributors/:id/gst/* — super-admin only.
 *
 * Endpoints:
 *   POST /:id/gst/activate          — atomic activation (Layer 2 creds + mode flip)
 *   POST /:id/gst/disable           — disable with reason + in-flight guard
 *   POST /:id/gst/test-connection   — stateless probe with body-supplied creds
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { param } from '../utils/params.js';
import {
  sendSuccess,
  sendError,
  sendNotFound,
} from '../utils/apiResponse.js';
import {
  gstActivationSchema,
  gstDisableSchema,
  gstTestConnectionRequestSchema,
} from '@gaslink/shared';
import {
  activateGst,
  disableGst,
  previewTestConnection,
  GstActivationError,
} from '../services/gst/gstActivationService.js';
import { GstTransitionError } from '../services/gst/transitionGuards.js';
import { prisma } from '../lib/prisma.js';

const router = Router({ mergeParams: true });

// ─── POST /api/admin/distributors/:id/gst/test-connection ────────────────────
// Body-supplied creds. Stateless probe — no DB write. The UI uses this BEFORE
// the activation submit so the operator sees red/green per scope without
// committing.
router.post(
  '/test-connection',
  requireRole('super_admin'),
  validate(gstTestConnectionRequestSchema),
  async (req, res) => {
    try {
      const distributorId = param(req.params.id);
      const dist = await prisma.distributor.findUnique({
        where: { id: distributorId },
        select: { gstin: true },
      });
      if (!dist) return sendNotFound(res, 'Distributor');
      if (!dist.gstin) {
        return sendError(res, 'Distributor has no GSTIN — cannot probe', 400, 'NO_DISTRIBUTOR_GSTIN');
      }
      const { scope, mode, credentials } = req.body as z.infer<typeof gstTestConnectionRequestSchema>;
      if (!credentials) {
        return sendError(
          res,
          'credentials body is required for the activation preview',
          400,
          'CREDENTIALS_REQUIRED',
        );
      }
      const result = await previewTestConnection(dist.gstin, mode, scope, credentials);
      return sendSuccess(res, result);
    } catch (err) {
      if (err instanceof GstActivationError) {
        return sendError(res, err.message, 400, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

// ─── POST /api/admin/distributors/:id/gst/activate ───────────────────────────
router.post(
  '/activate',
  requireRole('super_admin'),
  validate(gstActivationSchema),
  async (req, res) => {
    try {
      const distributorId = param(req.params.id);
      const result = await activateGst(distributorId, req.body, req.user!.userId);
      return sendSuccess(res, result);
    } catch (err) {
      if (err instanceof GstTransitionError) {
        return sendError(res, err.message, 400, err.code);
      }
      if (err instanceof GstActivationError) {
        // TEST_CONNECTION_FAILED carries per-scope detail in `.details`. Surface
        // it via the standard sendError body so the UI can render two indicators.
        if (err.code === 'TEST_CONNECTION_FAILED') {
          return res.status(400).json({
            success: false,
            data: err.details ?? null,
            error: err.message,
            code: err.code,
          });
        }
        return sendError(res, err.message, 400, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

// ─── POST /api/admin/distributors/:id/gst/disable ────────────────────────────
router.post(
  '/disable',
  requireRole('super_admin'),
  validate(gstDisableSchema),
  async (req, res) => {
    try {
      const distributorId = param(req.params.id);
      const result = await disableGst(distributorId, req.body, req.user!.userId);
      return sendSuccess(res, result);
    } catch (err) {
      if (err instanceof GstTransitionError) {
        return sendError(res, err.message, 400, err.code);
      }
      if (err instanceof GstActivationError) {
        return sendError(res, err.message, 400, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

export default router;
