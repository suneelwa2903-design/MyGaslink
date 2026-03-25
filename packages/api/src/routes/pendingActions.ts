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
    const actions = await pendingActionsService.listPendingActions(
      req.user!.distributorId!,
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
    const actions = await pendingActionsService.getOverdueSlaActions(req.user!.distributorId!);
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
      const action = await pendingActionsService.approvePendingAction(param(req.params.id), req.user!.userId);
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
      const action = await pendingActionsService.resolvePendingAction(
        param(req.params.id), req.user!.userId, req.body.notes
      );
      if (!action) return sendNotFound(res, 'Pending action');
      return sendSuccess(res, mapPendingAction(action));
    } catch (err) {
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
      const action = await pendingActionsService.rejectPendingAction(
        param(req.params.id), req.user!.userId, req.body.notes
      );
      if (!action) return sendNotFound(res, 'Pending action');
      return sendSuccess(res, mapPendingAction(action));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

export default router;
