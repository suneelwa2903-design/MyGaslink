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
import * as sourceDistributorService from '../services/sourceDistributorService.js';

// `authenticate` + `resolveDistributor` + `requireDistributor` are wired in
// app.ts on the mount path — same pattern as every other tenant-scoped
// resource router.
const router = Router();

// GET /api/source-distributors
router.get('/',
  requireRole('mini_operator_admin'),
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
  requireRole('mini_operator_admin'),
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

// DELETE /api/source-distributors/:id
router.delete('/:id',
  requireRole('mini_operator_admin'),
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
