import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import { prisma } from '../lib/prisma.js';
import { z } from 'zod';

const router = Router();

const PROVIDER_CODES = ['IOCL', 'HPCL', 'BPCL', 'GOGAS', 'SUPERGAS', 'TOTALGAS', 'OTHERS'] as const;

const createProviderCatalogSchema = z.object({
  providerCode: z.enum(PROVIDER_CODES),
  shortName: z.string().min(1).max(50),
  longName: z.string().min(1).max(200),
  weight: z.number().positive(),
  hsnCode: z.string().max(20).default('27111900'),
  isActive: z.boolean().optional().default(true),
});

// ─── List all (with optional ?provider= filter) ─────────────────────────────

router.get('/',
  requireRole('super_admin'),
  async (req, res) => {
    try {
      const providerFilter = req.query.provider as string | undefined;
      const where: Record<string, unknown> = {};

      if (providerFilter) {
        where.providerCode = providerFilter;
      }

      const items = await prisma.providerCatalogCylinderType.findMany({
        where,
        orderBy: [{ providerCode: 'asc' }, { weight: 'asc' }],
      });

      return sendSuccess(res, { items });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// ─── Create ─────────────────────────────────────────────────────────────────

router.post('/',
  requireRole('super_admin'),
  validate(createProviderCatalogSchema),
  auditLog('create', 'provider_catalog_cylinder_type'),
  async (req, res) => {
    try {
      const item = await prisma.providerCatalogCylinderType.create({
        data: req.body,
      });
      return sendCreated(res, item);
    } catch (err: any) {
      if (err.code === 'P2002') {
        return sendError(res, 'A cylinder type with this provider + short name (or provider + weight) already exists', 409);
      }
      return sendError(res, err.message);
    }
  }
);

// ─── Update ─────────────────────────────────────────────────────────────────

router.put('/:id',
  requireRole('super_admin'),
  validate(createProviderCatalogSchema.partial()),
  auditLog('update', 'provider_catalog_cylinder_type'),
  async (req, res) => {
    try {
      const item = await prisma.providerCatalogCylinderType.findUnique({
        where: { id: param(req.params.id) },
      });
      if (!item) return sendNotFound(res, 'Provider catalog entry');

      const updated = await prisma.providerCatalogCylinderType.update({
        where: { id: param(req.params.id) },
        data: req.body,
      });
      return sendSuccess(res, updated);
    } catch (err: any) {
      if (err.code === 'P2002') {
        return sendError(res, 'A cylinder type with this provider + short name (or provider + weight) already exists', 409);
      }
      return sendError(res, err.message);
    }
  }
);

// ─── Soft Delete (set isActive=false) ───────────────────────────────────────

router.delete('/:id',
  requireRole('super_admin'),
  auditLog('delete', 'provider_catalog_cylinder_type'),
  async (req, res) => {
    try {
      const item = await prisma.providerCatalogCylinderType.findUnique({
        where: { id: param(req.params.id) },
      });
      if (!item) return sendNotFound(res, 'Provider catalog entry');

      await prisma.providerCatalogCylinderType.update({
        where: { id: param(req.params.id) },
        data: { isActive: false },
      });
      return sendSuccess(res, { message: 'Provider catalog entry deactivated' });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

export default router;
