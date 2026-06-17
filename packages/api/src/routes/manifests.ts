/**
 * FLOAT-001 (2026-06-17): DVA load manifest routes.
 *
 * POST /api/manifests             — confirm per-cylinder-type loaded qty
 *                                   before dispatch.
 * GET  /api/manifests/dva/:dvaId  — read all manifest rows for a DVA
 *                                   (admin + driver both consume).
 */
import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { validate } from '../middleware/validate.js';
import { createManifestSchema } from '@gaslink/shared';
import {
  createOrUpdateManifest,
  getManifestForDVA,
  ManifestError,
} from '../services/dvaManifestService.js';

const router = Router();

// POST /api/manifests — confirm load manifest.
router.post(
  '/',
  requireRole('super_admin', 'distributor_admin', 'inventory', 'finance'),
  validate(createManifestSchema),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId!;
      const userId = req.user!.userId;
      const body = (req.validated?.body ?? req.body) as {
        dvaId: string;
        items: { cylinderTypeId: string; totalLoaded: number }[];
      };
      const rows = await createOrUpdateManifest(
        distributorId,
        body.dvaId,
        body.items,
        userId,
      );
      return sendSuccess(res, { manifest: rows });
    } catch (err) {
      if (err instanceof ManifestError) {
        return sendError(res, err.message, err.statusCode, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

// GET /api/manifests/dva/:dvaId — full per-trip manifest for a DVA.
router.get(
  '/dva/:dvaId',
  requireRole('super_admin', 'distributor_admin', 'inventory', 'finance', 'driver'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId!;
      const dvaId = req.params.dvaId;
      if (typeof dvaId !== 'string') return sendError(res, 'dvaId required', 400, 'VALIDATION');
      const rows = await getManifestForDVA(distributorId, dvaId);
      return sendSuccess(res, { manifest: rows });
    } catch (err) {
      if (err instanceof ManifestError) {
        return sendError(res, err.message, err.statusCode, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

export default router;
