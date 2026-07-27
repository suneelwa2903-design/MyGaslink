/**
 * Mini-op #5 (2026-07-27) — Expenses routes.
 *
 * Mounted at /api/expenses. Available to BOTH distributor + mini-op tenants.
 * Roles allowed: super_admin, distributor_admin, finance, mini_operator_admin.
 * Inventory role is intentionally excluded — recording money-out isn't their
 * job (same rule as payment verification, see WI-PENDING-PAYMENTS notes).
 */
import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { param } from '../utils/params.js';
import { sendSuccess, sendCreated, sendError, sendNotFound } from '../utils/apiResponse.js';
import { z } from 'zod';
import {
  createExpenseSchema,
  updateExpenseSchema,
  listExpensesQuerySchema,
} from '@gaslink/shared';
import * as service from '../services/expenseService.js';
import { generateExpenseReportPdf } from '../services/pdf/expenseReportPdfService.js';
import { EXPENSE_CATEGORIES } from '@gaslink/shared';

// Local dateString helper — same shape as the one in shared/schemas
// but not re-exported. Trivial pattern; inlining here avoids widening
// the shared surface just for this route.
const localDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

const router = Router();

router.use(requireRole('super_admin', 'distributor_admin', 'finance', 'mini_operator_admin'));

// POST /api/expenses
router.post('/',
  validate(createExpenseSchema),
  auditLog('create', 'expense'),
  async (req, res) => {
    try {
      const created = await service.createExpense(
        req.user!.distributorId!,
        req.user!.userId,
        req.body,
      );
      return sendCreated(res, created);
    } catch (err) {
      if (err instanceof service.ExpenseError) {
        return sendError(res, err.message, err.statusCode, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

// GET /api/expenses
router.get('/',
  validateQuery(listExpensesQuerySchema),
  async (req, res) => {
    try {
      const q = (req.validated?.query ?? req.query) as z.infer<typeof listExpensesQuerySchema>;
      const result = await service.listExpenses(req.user!.distributorId!, q);
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  },
);

// GET /api/expenses/summary — per-category rollup + grand total.
const summaryQuerySchema = z.object({
  from: localDateString.optional(),
  to: localDateString.optional(),
});
router.get('/summary',
  validateQuery(summaryQuerySchema),
  async (req, res) => {
    try {
      const q = (req.validated?.query ?? req.query) as z.infer<typeof summaryQuerySchema>;
      const result = await service.summarizeExpenses(req.user!.distributorId!, {
        from: q.from,
        to: q.to,
      });
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  },
);

// GET /api/expenses/report/pdf — category-filtered or consolidated PDF.
// Query: from, to, category (optional; omit for consolidated), vehicleId, driverId.
const reportQuerySchema = z.object({
  from: localDateString.optional(),
  to: localDateString.optional(),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  vehicleId: z.string().uuid().optional(),
  driverId: z.string().uuid().optional(),
});
router.get('/report/pdf',
  validateQuery(reportQuerySchema),
  async (req, res) => {
    try {
      const q = (req.validated?.query ?? req.query) as z.infer<typeof reportQuerySchema>;
      const pdf = await generateExpenseReportPdf(req.user!.distributorId!, {
        from: q.from,
        to: q.to,
        category: q.category,
        vehicleId: q.vehicleId,
        driverId: q.driverId,
      });
      const suffix = q.category ? q.category : 'consolidated';
      const filename = `expense-report-${suffix}-${new Date().toISOString().slice(0, 10)}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(pdf);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  },
);

// PUT /api/expenses/:id
router.put('/:id',
  validate(updateExpenseSchema),
  auditLog('update', 'expense'),
  async (req, res) => {
    try {
      const updated = await service.updateExpense(
        req.user!.distributorId!,
        param(req.params.id),
        req.body,
      );
      return sendSuccess(res, updated);
    } catch (err) {
      if (err instanceof service.ExpenseError) {
        if (err.statusCode === 404) return sendNotFound(res, 'Expense');
        return sendError(res, err.message, err.statusCode, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

// DELETE /api/expenses/:id
router.delete('/:id',
  auditLog('delete', 'expense'),
  async (req, res) => {
    try {
      await service.deleteExpense(
        req.user!.distributorId!,
        param(req.params.id),
      );
      return sendSuccess(res, { id: param(req.params.id), deleted: true });
    } catch (err) {
      if (err instanceof service.ExpenseError) {
        if (err.statusCode === 404) return sendNotFound(res, 'Expense');
        return sendError(res, err.message, err.statusCode, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

export default router;
