/**
 * defectiveReturns.ts — Express routes for F1 Defective Cylinder Returns.
 * See docs/F1-DEFECTIVE-RETURNS-DESIGN.md for the full flow.
 *
 * Route surface:
 *   GET  /api/defective-returns/eligible-invoices?customerId=...  → invoice picker
 *   POST /api/defective-returns                                   → Step 1 capture
 *   POST /api/defective-returns/:id/raise-cn                      → Step 2 raise CN
 *   POST /api/defective-returns/:id/cancel                        → cancel before CN
 *   GET  /api/defective-returns                                   → history
 *   GET  /api/defective-returns/pending-count                     → sidebar chip
 *   GET  /api/defective-returns/depot-bucket                      → send-to-corp modal source
 *   POST /api/defective-returns/batches                           → send to corp
 *   POST /api/defective-returns/batches/:id/corp-credit           → mark credit received
 *
 * Role gates (Suneel guidance + trace of createCreditNote route):
 *   - Capture / list / bucket: staff-tier (super_admin, distributor_admin,
 *     finance, inventory, mini_operator_admin) — mirrors empties-return.
 *   - Raise CN + cancel + mark corp credit received: CN-approve tier only
 *     (super_admin, distributor_admin, finance, mini_operator_admin) —
 *     matches invoiceService.approveCreditNote's role gate. Inventory role
 *     can PHYSICALLY capture and route to corp, but does NOT get CN power.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated } from '../utils/apiResponse.js';
import { param } from '../utils/params.js';
import {
  captureDefectiveReturnSchema,
  raiseDefectiveCnSchema,
  createDefectiveBatchSchema,
  cancelDefectiveReturnSchema,
} from '@gaslink/shared';
import {
  listDefectiveEligibleInvoices,
  captureDefectiveReturn,
  raiseDefectiveCn,
  listDefectiveHistory,
  getPendingCnCount,
  getDefectiveDepotBucket,
  cancelDefectiveReturn,
  createDefectiveReturnBatch,
  markBatchCorpCreditReceived,
  DefectiveReturnError,
} from '../services/defectiveReturnService.js';

type ServiceError = { message: string; statusCode?: number; code?: string };

const router = Router();

// ─── Invoice picker for New Entry UI ─────────────────────────────────────────
router.get('/eligible-invoices',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : '';
      if (!customerId) return sendError(res, 'customerId query param required', 400);
      const daysRaw = req.query.days;
      const days = typeof daysRaw === 'string' && !isNaN(Number(daysRaw))
        ? Math.max(1, Math.min(365, Number(daysRaw)))
        : 90;
      const invoices = await listDefectiveEligibleInvoices(
        req.user!.distributorId!,
        customerId,
        days,
      );
      return sendSuccess(res, invoices);
    } catch (err) {
      if (err instanceof DefectiveReturnError) {
        return sendError(res, err.message, err.statusCode);
      }
      return sendError(res, (err as ServiceError).message);
    }
  },
);

// ─── Step 1 — capture ────────────────────────────────────────────────────────
router.post('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(captureDefectiveReturnSchema),
  auditLog('defective_return_capture', 'inventory'),
  async (req, res) => {
    try {
      const result = await captureDefectiveReturn(
        req.user!.distributorId!,
        req.user!.userId,
        req.body,
      );
      return sendCreated(res, result);
    } catch (err) {
      if (err instanceof DefectiveReturnError) {
        return sendError(res, err.message, err.statusCode);
      }
      return sendError(res, (err as ServiceError).message);
    }
  },
);

// ─── Step 2 — raise CN ───────────────────────────────────────────────────────
// Route param `:id` is passed for symmetry / audit; the actual list of
// defective ids comes from the body (allows raising CN for N rows in one call).
// The body's defectiveIds must include the URL id.
router.post('/:id/raise-cn',
  requireRole('super_admin', 'distributor_admin', 'finance', 'mini_operator_admin'),
  validate(raiseDefectiveCnSchema),
  auditLog('defective_return_raise_cn', 'invoice'),
  async (req, res) => {
    try {
      const urlId = param(req.params.id);
      const body = req.body as z.infer<typeof raiseDefectiveCnSchema>;
      // Ensure URL id is in the body list — defensive check to prevent
      // callers from raising CN on a DR they didn't intend by mis-typing the URL.
      if (!body.defectiveIds.includes(urlId)) {
        return sendError(res, 'URL defective id must be present in defectiveIds body list', 400);
      }
      const result = await raiseDefectiveCn(
        req.user!.distributorId!,
        req.user!.userId,
        body,
      );
      return sendSuccess(res, result);
    } catch (err) {
      if (err instanceof DefectiveReturnError) {
        return sendError(res, err.message, err.statusCode);
      }
      return sendError(res, (err as ServiceError).message);
    }
  },
);

// ─── Cancel (before CN) ──────────────────────────────────────────────────────
router.post('/:id/cancel',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  validate(cancelDefectiveReturnSchema),
  auditLog('defective_return_cancel', 'inventory'),
  async (req, res) => {
    try {
      await cancelDefectiveReturn(
        req.user!.distributorId!,
        req.user!.userId,
        param(req.params.id),
        req.body,
      );
      return sendSuccess(res, { cancelled: true });
    } catch (err) {
      if (err instanceof DefectiveReturnError) {
        return sendError(res, err.message, err.statusCode);
      }
      return sendError(res, (err as ServiceError).message);
    }
  },
);

// ─── History list ────────────────────────────────────────────────────────────
router.get('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const filters: { status?: string; customerId?: string; from?: string; to?: string } = {};
      if (typeof req.query.status === 'string') filters.status = req.query.status;
      if (typeof req.query.customerId === 'string') filters.customerId = req.query.customerId;
      if (typeof req.query.from === 'string') filters.from = req.query.from;
      if (typeof req.query.to === 'string') filters.to = req.query.to;
      const rows = await listDefectiveHistory(req.user!.distributorId!, filters);
      return sendSuccess(res, rows);
    } catch (err) {
      return sendError(res, (err as ServiceError).message);
    }
  },
);

// ─── Sidebar pending-CN chip count ───────────────────────────────────────────
router.get('/pending-count',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const count = await getPendingCnCount(req.user!.distributorId!);
      return sendSuccess(res, { count });
    } catch (err) {
      return sendError(res, (err as ServiceError).message);
    }
  },
);

// ─── Depot bucket (for Send-to-Corp modal auto-populate) ────────────────────
router.get('/depot-bucket',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const rows = await getDefectiveDepotBucket(req.user!.distributorId!);
      return sendSuccess(res, rows);
    } catch (err) {
      return sendError(res, (err as ServiceError).message);
    }
  },
);

// ─── Send batch to corporation ───────────────────────────────────────────────
router.post('/batches',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(createDefectiveBatchSchema),
  auditLog('defective_return_batch_create', 'inventory'),
  async (req, res) => {
    try {
      const result = await createDefectiveReturnBatch(
        req.user!.distributorId!,
        req.user!.userId,
        req.body,
      );
      return sendCreated(res, result);
    } catch (err) {
      if (err instanceof DefectiveReturnError) {
        return sendError(res, err.message, err.statusCode);
      }
      return sendError(res, (err as ServiceError).message);
    }
  },
);

// ─── Mark corp credit received ───────────────────────────────────────────────
const markCorpCreditSchema = z.object({
  corpCreditAmount: z.number().min(0, 'Corp credit amount must be >= 0'),
});

router.post('/batches/:id/corp-credit',
  requireRole('super_admin', 'distributor_admin', 'finance', 'mini_operator_admin'),
  validate(markCorpCreditSchema),
  auditLog('defective_return_batch_corp_credit', 'inventory'),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof markCorpCreditSchema>;
      await markBatchCorpCreditReceived(
        req.user!.distributorId!,
        req.user!.userId,
        param(req.params.id),
        body.corpCreditAmount,
      );
      return sendSuccess(res, { updated: true });
    } catch (err) {
      if (err instanceof DefectiveReturnError) {
        return sendError(res, err.message, err.statusCode);
      }
      return sendError(res, (err as ServiceError).message);
    }
  },
);

export default router;
