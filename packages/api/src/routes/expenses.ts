/**
 * Mini-op #5 v2 (2026-07-27 evening) — Expenses routes.
 *
 * Category is now a FK (categoryId) — see routes/expenseCategories.ts
 * for the taxonomy CRUD. Read is open to admin + finance + inventory;
 * inventory can list (audit access) but the write endpoints stay
 * gated to admin + finance so they can record from the field.
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
  localTodayISO,
} from '@gaslink/shared';
import * as service from '../services/expenseService.js';
import { generateExpenseReportPdf } from '../services/pdf/expenseReportPdfService.js';

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

// GET /api/expenses/summary
// 2026-07-29 — accepts the same categoryId / paymentMethod / search filters
// as GET /api/expenses so the mobile "filtered total" strip stays in sync
// with the list scoped by the same filters.
const summaryQuerySchema = z.object({
  from: localDateString.optional(),
  to: localDateString.optional(),
  categoryId: z.string().uuid().optional(),
  paymentMethod: z.string().optional(),
  search: z.string().max(120).optional(),
});
router.get('/summary',
  validateQuery(summaryQuerySchema),
  async (req, res) => {
    try {
      const q = (req.validated?.query ?? req.query) as z.infer<typeof summaryQuerySchema>;
      const result = await service.summarizeExpenses(req.user!.distributorId!, {
        from: q.from,
        to: q.to,
        categoryId: q.categoryId,
        paymentMethod: q.paymentMethod,
        search: q.search,
      });
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  },
);

// GET /api/expenses/report/pdf
const reportQuerySchema = z.object({
  from: localDateString.optional(),
  to: localDateString.optional(),
  categoryId: z.string().uuid().optional(),
  headerId: z.string().uuid().optional(), // scope to a single header + its leaves
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
        categoryId: q.categoryId,
        headerId: q.headerId,
        vehicleId: q.vehicleId,
        driverId: q.driverId,
      });
      const suffix = q.categoryId ? 'category' : q.headerId ? 'header' : 'consolidated';
      const filename = `expense-report-${suffix}-${localTodayISO()}.pdf`;
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
