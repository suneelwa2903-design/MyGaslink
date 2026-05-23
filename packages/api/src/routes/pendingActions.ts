import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/apiResponse.js';
import * as pendingActionsService from '../services/pendingActionsService.js';
import { mapPendingAction, mapPendingActions } from '../utils/mappers.js';
import { z } from 'zod';

const router = Router();

// GET /api/pending-actions
router.get('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
  try {
    const distributorId = req.user!.distributorId;
    // Super_admin without a selected distributor: return empty list rather
    // than 400 — the notification bell polls this on every page load.
    if (!distributorId) return sendSuccess(res, { actions: [] });

    const actions = await pendingActionsService.listPendingActions(
      distributorId,
      {
        module: req.query.module as string,
        status: req.query.status as string,
        severity: req.query.severity as string,
      }
    );
    return sendSuccess(res, { actions: mapPendingActions(actions) });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/pending-actions/overdue
router.get('/overdue',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
  try {
    const distributorId = req.user!.distributorId;
    if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
    const actions = await pendingActionsService.getOverdueSlaActions(distributorId);
    return sendSuccess(res, mapPendingActions(actions));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// PUT /api/pending-actions/:id/approve
router.put('/:id/approve',
  requireRole('super_admin', 'distributor_admin'),
  auditLog('approve', 'pending_action'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      const action = await pendingActionsService.approvePendingAction(param(req.params.id), distributorId, req.user!.userId);
      if (!action) return sendNotFound(res, 'Pending action');
      return sendSuccess(res, mapPendingAction(action));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// PUT /api/pending-actions/:id/resolve
router.put('/:id/resolve',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(z.object({ notes: z.string().optional() })),
  auditLog('resolve', 'pending_action'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      const action = await pendingActionsService.resolvePendingAction(
        param(req.params.id), distributorId, req.user!.userId, req.body.notes
      );
      if (!action) return sendNotFound(res, 'Pending action');
      return sendSuccess(res, mapPendingAction(action));
    } catch (err) {
      // WI-105 PART 3 — NIC pre-flight failed: surface a 503 so the UI tells
      // the admin to retry later instead of marking the action resolved.
      if (err instanceof pendingActionsService.NicUnavailableError) {
        return sendError(res, err.message, 503, 'NIC_UNAVAILABLE');
      }
      return sendError(res, (err as Error).message);
    }
  }
);

// PUT /api/pending-actions/:id/reject
router.put('/:id/reject',
  requireRole('super_admin', 'distributor_admin'),
  validate(z.object({ notes: z.string().optional() })),
  auditLog('reject', 'pending_action'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      const action = await pendingActionsService.rejectPendingAction(
        param(req.params.id), distributorId, req.user!.userId, req.body.notes
      );
      if (!action) return sendNotFound(res, 'Pending action');
      return sendSuccess(res, mapPendingAction(action));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

export default router;
