/**
 * F8 Supplier Ledger (2026-08-06) — Purchase Credit Note routes.
 *
 * Mounted at /api/purchase-credit-notes. Widened-role gate (same policy as
 * /api/purchase-entries + /api/purchase-payments): super_admin auto-passes,
 * distributor_admin + finance + mini_operator_admin allowed. `inventory`
 * INTENTIONALLY excluded — recording a supplier CN reduces what we owe an
 * OMC, which is a finance-tier action (matches /api/payments policy).
 *
 * Tenant scoping: distributorId sourced from `req.user.distributorId`;
 * cross-tenant reads return 404 via service-layer guards.
 *
 * Endpoints:
 *   POST   /api/purchase-credit-notes        — record a new CN with allocations
 *   GET    /api/purchase-credit-notes        — list (filterable by supplier + date range)
 *   GET    /api/purchase-credit-notes/:id    — fetch one
 *   DELETE /api/purchase-credit-notes/:id    — soft-delete reversal
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { param } from '../utils/params.js';
import { sendSuccess, sendCreated, sendError, sendNotFound } from '../utils/apiResponse.js';
import { createPurchaseCreditNoteSchema } from '@gaslink/shared';
import * as service from '../services/purchaseCreditNoteService.js';

const router = Router();

// Widened role gate — same policy as /api/purchase-entries + /purchase-payments.
const PCN_ROLES = [
  'mini_operator_admin',
  'distributor_admin',
  'finance',
] as const;

router.use(requireRole(...PCN_ROLES));

// POST /api/purchase-credit-notes
router.post(
  '/',
  validate(createPurchaseCreditNoteSchema),
  auditLog('create', 'purchase_credit_note'),
  async (req, res) => {
    try {
      const created = await service.createPurchaseCreditNote(
        req.user!.distributorId!,
        req.user!.userId,
        req.body,
      );
      return sendCreated(res, created);
    } catch (err) {
      if (err instanceof service.PurchaseCreditNoteError) {
        return sendError(res, err.message, err.statusCode);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

const listQuerySchema = z.object({
  sourceDistributorId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// GET /api/purchase-credit-notes
router.get('/', validateQuery(listQuerySchema), async (req, res) => {
  try {
    const q = (req.validated?.query ?? req.query) as z.infer<typeof listQuerySchema>;
    const rows = await service.listPurchaseCreditNotes(req.user!.distributorId!, q);
    return sendSuccess(res, rows);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/purchase-credit-notes/:id
router.get('/:id', async (req, res) => {
  try {
    const row = await service.getPurchaseCreditNote(
      req.user!.distributorId!,
      param(req.params.id),
    );
    if (!row) return sendNotFound(res, 'Credit note');
    return sendSuccess(res, row);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// DELETE /api/purchase-credit-notes/:id — soft-delete reversal
router.delete('/:id', auditLog('reverse', 'purchase_credit_note'), async (req, res) => {
  try {
    const result = await service.reversePurchaseCreditNote(
      req.user!.distributorId!,
      param(req.params.id),
    );
    return sendSuccess(res, result);
  } catch (err) {
    if (err instanceof service.PurchaseCreditNoteError) {
      if (err.statusCode === 404) return sendNotFound(res, 'Credit note');
      return sendError(res, err.message, err.statusCode);
    }
    return sendError(res, (err as Error).message);
  }
});

export default router;
