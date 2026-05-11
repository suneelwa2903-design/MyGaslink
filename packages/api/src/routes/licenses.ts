import { Router } from 'express';
import { z } from 'zod';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendCreated, sendError, sendNotFound } from '../utils/apiResponse.js';
import * as settingsService from '../services/settingsService.js';

// Web client expects `licenseId` on each row (shared License type); Prisma
// returns `id`. Re-shape here so callers don't depend on Prisma column names.
function mapLicense<T extends { id: string }>(l: T): Omit<T, 'id'> & { licenseId: string } {
  const { id, ...rest } = l;
  return { licenseId: id, ...rest };
}

const router = Router();

const createLicenseSchema = z.object({
  licenseType: z.string().min(1),
  licenseName: z.string().min(1).max(200),
  licenseNumber: z.string().optional(),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  documentUrl: z.string().url().optional(),
});

// GET /api/licenses — list licenses for the caller's distributor
router.get('/', async (req, res) => {
  try {
    const distributorId = req.user!.distributorId;
    if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
    const licenses = await settingsService.listLicenses(distributorId);
    return sendSuccess(res, licenses.map(mapLicense));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// POST /api/licenses — create a license for the caller's distributor
router.post('/',
  requireRole('super_admin', 'distributor_admin'),
  validate(createLicenseSchema),
  auditLog('create', 'license'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      const license = await settingsService.createLicense(distributorId, req.body);
      return sendCreated(res, mapLicense(license));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  },
);

// DELETE /api/licenses/:id — delete with ownership check
router.delete('/:id',
  requireRole('super_admin', 'distributor_admin'),
  auditLog('delete', 'license'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');
      // settingsService.deleteLicense already verifies that the license's
      // distributorId matches before deleting; returns null otherwise.
      const result = await settingsService.deleteLicense(param(req.params.id), distributorId);
      if (!result) return sendNotFound(res, 'License');
      return sendSuccess(res, { message: 'License deleted' });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  },
);

export default router;
