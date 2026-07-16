import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import { prisma } from '../lib/prisma.js';
import { z } from 'zod';

type ServiceError = { message: string; statusCode?: number; code?: string };

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
      // Case-insensitive global short-name check. The DB has a
      // (providerCode, shortName) unique constraint, but the product rule
      // is stricter: a shortName must be unique across the whole catalog
      // regardless of provider, ignoring case ("19KG" == "19kg").
      const existing = await prisma.providerCatalogCylinderType.findFirst({
        where: { shortName: { equals: req.body.shortName, mode: 'insensitive' } },
        select: { id: true, providerCode: true, shortName: true },
      });
      if (existing) {
        return sendError(
          res,
          'Cylinder type already exists in provider catalog',
          409,
          'CATALOG_DUPLICATE_SHORT_NAME',
        );
      }

      const item = await prisma.providerCatalogCylinderType.create({
        data: req.body,
      });
      return sendCreated(res, item);
    } catch (err: unknown) {
      const e = err as ServiceError;
      if (e.code === 'P2002') {
        return sendError(res, 'A cylinder type with this provider + short name (or provider + weight) already exists', 409);
      }
      return sendError(res, e.message);
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
    } catch (err: unknown) {
      const e = err as ServiceError;
      if (e.code === 'P2002') {
        return sendError(res, 'A cylinder type with this provider + short name (or provider + weight) already exists', 409);
      }
      return sendError(res, e.message);
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

// ─── For Distributor Admin: List catalog items for their providers ──────────

router.get('/for-distributor',
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');

      const distributor = await prisma.distributor.findUnique({
        where: { id: distributorId },
        select: { providerCodes: true },
      });

      if (!distributor) return sendNotFound(res, 'Distributor');

      const items = await prisma.providerCatalogCylinderType.findMany({
        where: {
          providerCode: { in: distributor.providerCodes },
          isActive: true,
        },
        orderBy: [{ providerCode: 'asc' }, { weight: 'asc' }],
      });

      // Mini-Operator (2026-07-16) bug fix — the previous dedup key was
      // `${typeName}-${capacity}` which meant HPCL 5KG and IOCL 5KG appeared
      // as the SAME row (both share shortName='5 KG', weight=5). Import
      // HPCL 5KG, then IOCL 5KG shows "alreadyAdded=true" even though it's
      // not imported — visible in the "Already Imported from Catalog"
      // section (8 chips) vs "Your Cylinder Types" table (5 rows). Correct
      // key is `providerCatalogId` which is unique per catalog row.
      const existing = await prisma.cylinderType.findMany({
        where: { distributorId, isActive: true },
        select: { providerCatalogId: true },
      });

      const importedCatalogIds = new Set(
        existing.map((e) => e.providerCatalogId).filter((id): id is string => !!id),
      );

      const itemsWithStatus = items.map((item) => ({
        ...item,
        alreadyAdded: importedCatalogIds.has(item.id),
      }));

      return sendSuccess(res, { items: itemsWithStatus, providers: distributor.providerCodes });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// ─── Import catalog items as distributor cylinder types ─────────────────────

router.post('/import',
  validate(z.object({
    catalogItemIds: z.array(z.string().uuid()).min(1, 'Select at least one cylinder type'),
  })),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId;
      if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');

      const catalogItems = await prisma.providerCatalogCylinderType.findMany({
        where: { id: { in: req.body.catalogItemIds }, isActive: true },
      });

      if (catalogItems.length === 0) return sendError(res, 'No valid catalog items found', 400);

      // Mini-Operator (2026-07-16) fix — dedupe by `providerCatalogId`
      // (unique per catalog row). The previous key `${typeName}-${capacity}`
      // meant HPCL 5KG and IOCL 5KG collided and the second import silently
      // failed with "All selected cylinder types already exist".
      const existing = await prisma.cylinderType.findMany({
        where: { distributorId },
        select: { typeName: true, providerCatalogId: true },
      });
      const importedCatalogIds = new Set(
        existing.map((e) => e.providerCatalogId).filter((id): id is string => !!id),
      );
      const existingTypeNames = new Set(existing.map((e) => e.typeName));

      const toCreate = catalogItems.filter((c) => !importedCatalogIds.has(c.id));

      if (toCreate.length === 0) {
        return sendError(res, 'All selected cylinder types are already imported', 400);
      }

      // typeName collision handling — Prisma constraint is
      // @@unique([distributorId, typeName]). If plain shortName ("5 KG") is
      // already used (e.g. HPCL 5KG imported earlier as "5 KG"), prefix the
      // new one with providerCode ("IOCL 5 KG") so both can co-exist.
      const created = await prisma.$transaction(
        toCreate.map((c) => {
          const shortName = c.shortName;
          const prefixedName = `${c.providerCode} ${shortName}`;
          const typeName = existingTypeNames.has(shortName) ? prefixedName : shortName;
          // Track the name we just decided on so a batch of two IOCL rows
          // in one call doesn't both fall through to shortName.
          existingTypeNames.add(typeName);
          return prisma.cylinderType.create({
            data: {
              distributorId,
              typeName,
              capacity: c.weight,
              unit: 'KG',
              hsnCode: c.hsnCode,
              providerCatalogId: c.id,
            },
          });
        }),
      );

      return sendCreated(res, { imported: created.length, cylinderTypes: created });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

export default router;
