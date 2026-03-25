import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import { createDistributorSchema, updateDistributorSchema } from '@gaslink/shared';
import * as distributorService from '../services/distributorService.js';
import { mapDistributor, mapDistributors } from '../utils/mappers.js';

const router = Router();

// GET /api/distributors
router.get('/', requireRole('super_admin'), async (_req, res) => {
  try {
    const distributors = await distributorService.listDistributors();
    return sendSuccess(res, { distributors: mapDistributors(distributors) });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/distributors/:id
router.get('/:id', requireRole('super_admin'), async (req, res) => {
  try {
    const distributor = await distributorService.getDistributorById(param(req.params.id));
    if (!distributor) return sendNotFound(res, 'Distributor');
    return sendSuccess(res, mapDistributor(distributor));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// POST /api/distributors
router.post('/',
  requireRole('super_admin'),
  validate(createDistributorSchema),
  auditLog('create', 'distributor'),
  async (req, res) => {
    try {
      const distributor = await distributorService.createDistributor(req.body);
      return sendCreated(res, mapDistributor(distributor));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// PUT /api/distributors/:id
router.put('/:id',
  requireRole('super_admin'),
  validate(updateDistributorSchema),
  auditLog('update', 'distributor'),
  async (req, res) => {
    try {
      const existing = await distributorService.getDistributorById(param(req.params.id));
      if (!existing) return sendNotFound(res, 'Distributor');
      const distributor = await distributorService.updateDistributor(param(req.params.id), req.body);
      return sendSuccess(res, mapDistributor(distributor));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/distributors/:id/settings
router.get('/:id/settings', requireRole('super_admin'), async (req, res) => {
  try {
    const settings = await distributorService.getDistributorSettings(param(req.params.id));
    return sendSuccess(res, settings);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

export default router;
