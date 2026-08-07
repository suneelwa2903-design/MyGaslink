/**
 * Mini-Operator (2026-07-16) — Source Distributor CRUD routes.
 *
 * Mounted at /api/source-distributors. All routes require
 * `mini_operator_admin` (super_admin auto-passes via requireRole's built-in
 * bypass). distributor_admin and other roles are intentionally excluded —
 * source distributors are a mini-operator-only concept.
 *
 * Tenant scoping: distributorId always sourced from `req.user.distributorId`
 * (set by the authenticate middleware from the JWT). Never trust the body
 * for tenant identity — anti-pattern #13.
 */
import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { param } from '../utils/params.js';
import { sendSuccess, sendCreated, sendError, sendNotFound } from '../utils/apiResponse.js';
import { createSourceDistributorSchema } from '@gaslink/shared';
import { z } from 'zod';
import * as sourceDistributorService from '../services/sourceDistributorService.js';

// 2026-07-23 — validation for supplier OB seed + edit routes.
// `empties` optional array of per-cylinder-type opening quantities the
// mini-op operator physically owes back to the supplier at seed time.
// Zero-qty rows are permitted (service filters them out).
const supplierOpeningStateSchema = z.object({
  amount: z.number().nonnegative().max(100_000_000),
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'asOfDate must be YYYY-MM-DD'),
  empties: z
    .array(
      z.object({
        cylinderTypeId: z.string().min(1),
        qty: z.number().int().nonnegative().max(100_000),
      }),
    )
    .optional(),
});

// `authenticate` + `resolveDistributor` + `requireDistributor` are wired in
// app.ts on the mount path — same pattern as every other tenant-scoped
// resource router.
const router = Router();

// F8 (2026-08-06) — widened from mini_operator_admin only. Regular
// distributors now use SourceDistributor rows too (auto-seeded from
// providerCodes on tenant creation + admin can manually add local
// depots / private marketers). Opening-state seed routes stay reachable
// to distributor_admin because a fresh regular tenant may want to seed
// what they owed the OMC at go-live (same shape as mini-op seed).
// super_admin auto-passes via requireRole's built-in bypass.
const SUPPLIER_ROLES = [
  'mini_operator_admin',
  'distributor_admin',
  'finance',
] as const;

// GET /api/source-distributors
router.get('/',
  requireRole(...SUPPLIER_ROLES),
  async (req, res) => {
    try {
      const rows = await sourceDistributorService.listSourceDistributors(
        req.user!.distributorId!,
      );
      return sendSuccess(res, rows);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  },
);

// POST /api/source-distributors
router.post('/',
  requireRole(...SUPPLIER_ROLES),
  validate(createSourceDistributorSchema),
  auditLog('create', 'source_distributor'),
  async (req, res) => {
    try {
      const created = await sourceDistributorService.createSourceDistributor(
        req.user!.distributorId!,
        req.body,
      );
      return sendCreated(res, created);
    } catch (err) {
      if (err instanceof sourceDistributorService.SourceDistributorError) {
        return sendError(res, err.message, err.statusCode);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

// 2026-07-23 — POST /api/source-distributors/:id/seed-opening-state
// One-shot: seeds the ₹ opening balance owed to the supplier. Refuses
// with 400 ALREADY_SEEDED on second call.
router.post('/:id/seed-opening-state',
  requireRole(...SUPPLIER_ROLES),
  validate(supplierOpeningStateSchema),
  auditLog('seed_opening_state', 'source_distributor'),
  async (req, res) => {
    try {
      const result = await sourceDistributorService.seedOpeningStateOnSupplier(
        req.user!.distributorId!,
        req.user!.userId,
        param(req.params.id),
        req.body.amount,
        req.body.asOfDate,
        req.body.empties,
      );
      return sendSuccess(res, result);
    } catch (err) {
      if (err instanceof sourceDistributorService.SourceDistributorError) {
        if (err.statusCode === 404) return sendNotFound(res, 'Source distributor');
        return sendError(res, err.message, err.statusCode);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

// 2026-07-23 — PUT /api/source-distributors/:id/opening-state
// Edit path — updates the ₹ balance in place. Refuses reduction below
// amountPaid on the underlying OB purchase entry.
router.put('/:id/opening-state',
  requireRole(...SUPPLIER_ROLES),
  validate(supplierOpeningStateSchema),
  auditLog('update_opening_state', 'source_distributor'),
  async (req, res) => {
    try {
      const result = await sourceDistributorService.updateOpeningStateOnSupplier(
        req.user!.distributorId!,
        param(req.params.id),
        req.body.amount,
        req.body.asOfDate,
        req.body.empties,
      );
      return sendSuccess(res, result);
    } catch (err) {
      if (err instanceof sourceDistributorService.SourceDistributorError) {
        if (err.statusCode === 404) return sendNotFound(res, 'Source distributor');
        return sendError(res, err.message, err.statusCode);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

// DELETE /api/source-distributors/:id
router.delete('/:id',
  requireRole(...SUPPLIER_ROLES),
  auditLog('delete', 'source_distributor'),
  async (req, res) => {
    try {
      await sourceDistributorService.deleteSourceDistributor(
        req.user!.distributorId!,
        param(req.params.id),
      );
      return sendSuccess(res, { id: param(req.params.id), deleted: true });
    } catch (err) {
      if (err instanceof sourceDistributorService.SourceDistributorError) {
        if (err.statusCode === 404) return sendNotFound(res, 'Source distributor');
        return sendError(res, err.message, err.statusCode);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

export default router;
