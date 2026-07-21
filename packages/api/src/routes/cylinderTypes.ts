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

type ServiceError = { message: string; statusCode?: number; code?: string };

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
    // 2026-07-21 opening-state seed: when ?customerId= is passed and
    // that customer has preferred cylinder types, return the FULL list
    // but sorted so preferred types come first, each row tagged with
    // `isPreferred: boolean`. NEVER filter — a customer's mix can
    // change over time, so the order form must always show every
    // type in the distributor's catalog.
    const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : '';
    let preferredSet = new Set<string>();
    if (customerId) {
      const prisma = await import('../lib/prisma.js').then((m) => m.prisma);
      const preferred = await prisma.customerAllowedCylinderType.findMany({
        where: {
          customerId,
          customer: { distributorId: req.user!.distributorId!, deletedAt: null },
        },
        select: { cylinderTypeId: true },
      });
      preferredSet = new Set(preferred.map((p) => p.cylinderTypeId));
    }
    const mapped = mapCylinderTypes(types);
    // Attach isPreferred flag + stable sort (preferred first, then
    // original order). Original order preserved via Array.prototype
    // .sort() being stable in modern V8.
    const enriched = (mapped as Array<Record<string, unknown> & { cylinderTypeId?: string }>).map((row) => ({
      ...row,
      isPreferred: !!row.cylinderTypeId && preferredSet.has(row.cylinderTypeId),
    }));
    enriched.sort((a, b) => (b.isPreferred ? 1 : 0) - (a.isPreferred ? 1 : 0));
    return sendSuccess(res, { cylinderTypes: enriched });
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
  requireRole('super_admin', 'distributor_admin', 'inventory', 'finance', 'mini_operator_admin'),
  validate(createCylinderTypeSchema),
  auditLog('create', 'cylinder_type'),
  async (req, res) => {
    try {
      const type = await cylinderTypeService.createCylinderType(req.user!.distributorId!, req.body);
      return sendCreated(res, mapCylinderType(type));
    } catch (err: unknown) {
      const e = err as ServiceError;
      if (e.code === 'P2002') return sendError(res, 'Cylinder type with this name already exists', 409);
      return sendError(res, e.message);
    }
  }
);

// ─── Prices ─────────────────────────────────────────────────────────────────
// NOTE: All static-path routes (no :id param) MUST be registered before the
// wildcard PUT /:id and DELETE /:id handlers, otherwise Express matches the
// param route first and the specific handlers are never reached.

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
  requireRole('super_admin', 'distributor_admin', 'inventory', 'finance', 'mini_operator_admin'),
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
  requireRole('super_admin', 'distributor_admin', 'inventory', 'finance', 'mini_operator_admin'),
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

// PUT /empty-prices must be before PUT /:id (static beats param in registration order).
// WI-2: admin-only — deposit price drives downstream mismatch unit-amount calcs;
// inventory/finance roles must not be able to silently shift those amounts.
router.put('/empty-prices',
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
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

// PUT /thresholds must be before PUT /:id (static beats param in registration order).
router.put('/thresholds',
  requireRole('super_admin', 'distributor_admin', 'inventory', 'finance', 'mini_operator_admin'),
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

// ─── Cylinder Type by ID (must come AFTER all static-path PUT/DELETE routes) ──

router.put('/:id',
  requireRole('super_admin', 'distributor_admin', 'inventory', 'finance', 'mini_operator_admin'),
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
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
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

export default router;
