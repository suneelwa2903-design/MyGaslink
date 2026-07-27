/**
 * Mini-op #5 v2 (2026-07-27 evening) — Expense category routes.
 *
 * Mounted at /api/expense-categories. Read is open to any authenticated
 * user in the tenant (finance / inventory / etc. need it to render the
 * expense picker). Mutations gated to admin roles only.
 */
import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { param } from '../utils/params.js';
import { sendSuccess, sendCreated, sendError, sendNotFound } from '../utils/apiResponse.js';
import {
  createExpenseCategorySchema,
  updateExpenseCategorySchema,
} from '@gaslink/shared';
import * as service from '../services/expenseCategoryService.js';

const router = Router();

// ── Reads: any authenticated user in the tenant ──────────────────────────
router.get('/', async (req, res) => {
  try {
    const rows = await service.listCategories(req.user!.distributorId!);
    return sendSuccess(res, { categories: rows });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// ── Mutations: admin roles only ──────────────────────────────────────────
router.post('/',
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
  validate(createExpenseCategorySchema),
  auditLog('create', 'expense_category'),
  async (req, res) => {
    try {
      const created = await service.createCategory(req.user!.distributorId!, req.body);
      return sendCreated(res, created);
    } catch (err) {
      if (err instanceof service.CategoryError) {
        return sendError(res, err.message, err.statusCode, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

router.put('/:id',
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
  validate(updateExpenseCategorySchema),
  auditLog('update', 'expense_category'),
  async (req, res) => {
    try {
      const updated = await service.updateCategory(
        req.user!.distributorId!,
        param(req.params.id),
        req.body,
      );
      return sendSuccess(res, updated);
    } catch (err) {
      if (err instanceof service.CategoryError) {
        if (err.statusCode === 404) return sendNotFound(res, 'Category');
        return sendError(res, err.message, err.statusCode, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

router.delete('/:id',
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
  auditLog('delete', 'expense_category'),
  async (req, res) => {
    try {
      await service.deleteCategory(req.user!.distributorId!, param(req.params.id));
      return sendSuccess(res, { id: param(req.params.id), deleted: true });
    } catch (err) {
      if (err instanceof service.CategoryError) {
        if (err.statusCode === 404) return sendNotFound(res, 'Category');
        return sendError(res, err.message, err.statusCode, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

router.post('/restore-system-defaults',
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
  auditLog('update', 'expense_category'),
  async (req, res) => {
    try {
      const rows = await service.restoreSystemDefaults(req.user!.distributorId!);
      return sendSuccess(res, { categories: rows });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  },
);

export default router;
