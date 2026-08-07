/**
 * F8 v2 Supplier Ledger (2026-08-06) — Purchase Debit Note routes.
 * Mirror of purchaseCreditNotes.ts. Same role gate + tenant scoping.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { param } from '../utils/params.js';
import { sendSuccess, sendCreated, sendError, sendNotFound } from '../utils/apiResponse.js';
import { createPurchaseDebitNoteSchema } from '@gaslink/shared';
import * as service from '../services/purchaseDebitNoteService.js';

const router = Router();

const PDN_ROLES = ['mini_operator_admin', 'distributor_admin', 'finance'] as const;
router.use(requireRole(...PDN_ROLES));

router.post(
  '/',
  validate(createPurchaseDebitNoteSchema),
  auditLog('create', 'purchase_debit_note'),
  async (req, res) => {
    try {
      const created = await service.createPurchaseDebitNote(
        req.user!.distributorId!,
        req.user!.userId,
        req.body,
      );
      return sendCreated(res, created);
    } catch (err) {
      if (err instanceof service.PurchaseDebitNoteError) {
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

router.get('/', validateQuery(listQuerySchema), async (req, res) => {
  try {
    const q = (req.validated?.query ?? req.query) as z.infer<typeof listQuerySchema>;
    const rows = await service.listPurchaseDebitNotes(req.user!.distributorId!, q);
    return sendSuccess(res, rows);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

router.delete('/:id', auditLog('reverse', 'purchase_debit_note'), async (req, res) => {
  try {
    const result = await service.reversePurchaseDebitNote(
      req.user!.distributorId!,
      param(req.params.id),
    );
    return sendSuccess(res, result);
  } catch (err) {
    if (err instanceof service.PurchaseDebitNoteError) {
      if (err.statusCode === 404) return sendNotFound(res, 'Debit note');
      return sendError(res, err.message, err.statusCode);
    }
    return sendError(res, (err as Error).message);
  }
});

export default router;
