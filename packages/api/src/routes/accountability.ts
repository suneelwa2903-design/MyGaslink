import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import { createAccountabilitySchema, resolveAccountabilitySchema, paginationSchema } from '@gaslink/shared';
import * as accountabilityService from '../services/accountabilityService.js';
import { mapAccountabilityLog, mapAccountabilityLogs } from '../utils/mappers.js';

const router = Router();

// GET /api/accountability
router.get('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
  try {
    const result = await accountabilityService.listAccountabilityLogs(
      req.user!.distributorId!,
      {
        status: req.query.status as string,
        driverId: req.query.driverId as string,
        customerId: req.query.customerId as string,
        incidentType: req.query.incidentType as string,
        page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
        pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined,
      }
    );
    return sendSuccess(res, { logs: mapAccountabilityLogs(result.data) }, 200, result.meta);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/accountability/:id
router.get('/:id',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
  try {
    const log = await accountabilityService.getAccountabilityLogById(
      param(req.params.id), req.user!.distributorId!
    );
    if (!log) return sendNotFound(res, 'Accountability log');
    return sendSuccess(res, mapAccountabilityLog(log));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// POST /api/accountability
router.post('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(createAccountabilitySchema),
  auditLog('create', 'accountability_log'),
  async (req, res) => {
    try {
      const log = await accountabilityService.createAccountabilityLog(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendCreated(res, mapAccountabilityLog(log));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// PUT /api/accountability/:id/resolve
router.put('/:id/resolve',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(resolveAccountabilitySchema),
  auditLog('resolve', 'accountability_log'),
  async (req, res) => {
    try {
      const log = await accountabilityService.resolveAccountabilityLog(
        param(req.params.id), req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendSuccess(res, mapAccountabilityLog(log));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

export default router;
