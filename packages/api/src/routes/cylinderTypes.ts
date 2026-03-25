import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import { cylinderThresholdSchema } from '@gaslink/shared';
import * as cylinderTypeService from '../services/cylinderTypeService.js';
import { mapCylinderType, mapCylinderTypes } from '../utils/mappers.js';
import { z } from 'zod';

const router = Router();

const createCylinderTypeSchema = z.object({
  typeName: z.string().min(1).max(100),
  capacity: z.number().positive(),
  unit: z.string().max(10).optional(),
  hsnCode: z.string().max(20).optional(),
});

const createPriceSchema = z.object({
  cylinderTypeId: z.string().uuid(),
  price: z.number().positive(),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const emptyPriceSchema = z.object({
  cylinderTypeId: z.string().uuid(),
  emptyCylinderPrice: z.number().min(0),
});

// ─── Cylinder Types ─────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const types = await cylinderTypeService.listCylinderTypes(req.user!.distributorId!);
    return sendSuccess(res, { cylinderTypes: mapCylinderTypes(types) });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const type = await cylinderTypeService.getCylinderTypeById(param(req.params.id), req.user!.distributorId!);
    if (!type) return sendNotFound(res, 'Cylinder type');
    return sendSuccess(res, mapCylinderType(type));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

router.post('/',
  requireRole('super_admin', 'distributor_admin'),
  validate(createCylinderTypeSchema),
  auditLog('create', 'cylinder_type'),
  async (req, res) => {
    try {
      const type = await cylinderTypeService.createCylinderType(req.user!.distributorId!, req.body);
      return sendCreated(res, mapCylinderType(type));
    } catch (err: any) {
      if (err.code === 'P2002') return sendError(res, 'Cylinder type with this name already exists', 409);
      return sendError(res, err.message);
    }
  }
);

router.put('/:id',
  requireRole('super_admin', 'distributor_admin'),
  validate(createCylinderTypeSchema.partial()),
  auditLog('update', 'cylinder_type'),
  async (req, res) => {
    try {
      const type = await cylinderTypeService.updateCylinderType(param(req.params.id), req.user!.distributorId!, req.body);
      if (!type) return sendNotFound(res, 'Cylinder type');
      return sendSuccess(res, mapCylinderType(type));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

router.delete('/:id',
  requireRole('super_admin', 'distributor_admin'),
  auditLog('delete', 'cylinder_type'),
  async (req, res) => {
    try {
      const type = await cylinderTypeService.deleteCylinderType(param(req.params.id), req.user!.distributorId!);
      if (!type) return sendNotFound(res, 'Cylinder type');
      return sendSuccess(res, { message: 'Cylinder type deactivated' });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// ─── Prices ─────────────────────────────────────────────────────────────────

router.get('/prices/list', async (req, res) => {
  try {
    const prices = await cylinderTypeService.listPrices(
      req.user!.distributorId!,
      req.query.cylinderTypeId as string
    );
    return sendSuccess(res, prices);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

router.post('/prices',
  requireRole('super_admin', 'distributor_admin'),
  validate(createPriceSchema),
  auditLog('create', 'cylinder_price'),
  async (req, res) => {
    try {
      const price = await cylinderTypeService.createPrice(req.user!.distributorId!, req.body);
      return sendCreated(res, price);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

router.delete('/prices/:id',
  requireRole('super_admin', 'distributor_admin'),
  auditLog('delete', 'cylinder_price'),
  async (req, res) => {
    try {
      const price = await cylinderTypeService.deletePrice(param(req.params.id), req.user!.distributorId!);
      if (!price) return sendNotFound(res, 'Cylinder price');
      return sendSuccess(res, { message: 'Price deleted' });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// ─── Empty Cylinder Prices ──────────────────────────────────────────────────

router.get('/empty-prices/list', async (req, res) => {
  try {
    const prices = await cylinderTypeService.listEmptyPrices(req.user!.distributorId!);
    return sendSuccess(res, prices);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

router.put('/empty-prices',
  requireRole('super_admin', 'distributor_admin'),
  validate(emptyPriceSchema),
  auditLog('upsert', 'empty_cylinder_price'),
  async (req, res) => {
    try {
      const price = await cylinderTypeService.upsertEmptyPrice(req.user!.distributorId!, req.body);
      return sendSuccess(res, price);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// ─── Thresholds ─────────────────────────────────────────────────────────────

router.put('/thresholds',
  requireRole('super_admin', 'distributor_admin', 'inventory'),
  validate(cylinderThresholdSchema),
  auditLog('upsert', 'cylinder_threshold'),
  async (req, res) => {
    try {
      const threshold = await cylinderTypeService.upsertThreshold(req.user!.distributorId!, req.body);
      return sendSuccess(res, threshold);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

export default router;
