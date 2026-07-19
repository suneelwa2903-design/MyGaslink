/**
 * Mini-Operator (2026-07-19) — Purchase Payments routes.
 *
 * Mounted at /api/purchase-payments. All routes require `mini_operator_admin`
 * only (super_admin auto-passes via requireRole's built-in bypass).
 * distributor_admin + finance INTENTIONALLY excluded — per Suneel:
 * only mini_operator uses this; no one else needs access. Same gate
 * pattern as /api/purchase-entries.
 *
 * Tenant scoping: distributorId always sourced from `req.user.distributorId`.
 * The service double-checks `distributorId` on every read + write so a
 * cross-tenant paymentId returns 404, never 200.
 *
 * Endpoints:
 *   POST   /api/purchase-payments           — record a payment (FIFO or manual)
 *   GET    /api/purchase-payments           — list payments (filterable)
 *   POST   /api/purchase-payments/:id/reverse — soft-delete + roll back allocations
 *   GET    /api/purchase-payments/supplier-balances — per-source rollup for the mobile Purchases tab
 *   GET    /api/purchase-payments/supplier-ledger/:sourceId — chronological ledger (debits+credits+balance)
 *   GET    /api/purchase-payments/outstanding/:sourceId — per-entry outstanding list for the Record Payment sheet
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { param } from '../utils/params.js';
import { sendSuccess, sendCreated, sendError } from '../utils/apiResponse.js';
import * as service from '../services/purchasePaymentService.js';

const router = Router();

// Every route is mini_operator_admin only. Applied at the router level so
// a future GET can't accidentally leak.
router.use(requireRole('mini_operator_admin'));

const createSchema = z.object({
  sourceDistributorId: z.string().uuid(),
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number().positive(),
  paymentMethod: z.enum(['cash', 'cheque', 'online', 'upi', 'bank_transfer', 'credit']).optional(),
  referenceNumber: z.string().max(100).optional(),
  notes: z.string().max(500).optional(),
  // Optional manual override; when omitted, service auto-allocates FIFO.
  allocations: z.array(z.object({
    purchaseEntryId: z.string().uuid(),
    amount: z.number().positive(),
  })).optional(),
});

const listQuerySchema = z.object({
  sourceDistributorId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

const ledgerQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// ─── POST / — record a payment ───────────────────────────────────────────
router.post('/',
  validate(createSchema),
  auditLog('create', 'purchase_payment'),
  async (req, res) => {
    try {
      const body = (req.validated?.body ?? req.body) as z.infer<typeof createSchema>;
      const result = await service.createPurchasePayment(
        req.user!.distributorId!,
        req.user!.userId,
        body,
      );
      return sendCreated(res, result);
    } catch (err) {
      if (err instanceof service.PurchasePaymentError) {
        return sendError(res, err.message, err.statusCode, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

// ─── GET / — list payments ───────────────────────────────────────────────
router.get('/',
  validateQuery(listQuerySchema),
  async (req, res) => {
    try {
      const q = (req.validated?.query ?? req.query) as z.infer<typeof listQuerySchema>;
      const result = await service.listPurchasePayments(req.user!.distributorId!, q);
      return sendSuccess(res, { payments: result.data, meta: result.meta }, 200, result.meta);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  },
);

// ─── GET /supplier-balances — per-source rollup for the Purchases tab ────
router.get('/supplier-balances', async (req, res) => {
  try {
    const rows = await service.listSupplierBalances(req.user!.distributorId!);
    return sendSuccess(res, { suppliers: rows });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// ─── GET /supplier-ledger/:sourceId ──────────────────────────────────────
router.get('/supplier-ledger/:sourceId',
  validateQuery(ledgerQuerySchema),
  async (req, res) => {
    try {
      const sourceId = param(req.params.sourceId);
      const q = (req.validated?.query ?? req.query) as z.infer<typeof ledgerQuerySchema>;
      const result = await service.getSupplierLedger(
        req.user!.distributorId!,
        sourceId,
        q,
      );
      return sendSuccess(res, result);
    } catch (err) {
      if (err instanceof service.PurchasePaymentError) {
        return sendError(res, err.message, err.statusCode, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

// ─── GET /outstanding/:sourceId — per-entry outstanding list ─────────────
router.get('/outstanding/:sourceId', async (req, res) => {
  try {
    const sourceId = param(req.params.sourceId);
    const rows = await service.listOutstandingEntries(
      req.user!.distributorId!,
      sourceId,
    );
    return sendSuccess(res, { entries: rows });
  } catch (err) {
    if (err instanceof service.PurchasePaymentError) {
      return sendError(res, err.message, err.statusCode, err.code);
    }
    return sendError(res, (err as Error).message);
  }
});

// ─── POST /:id/reverse — soft-delete + roll back ─────────────────────────
router.post('/:id/reverse',
  auditLog('reverse', 'purchase_payment'),
  async (req, res) => {
    try {
      const id = param(req.params.id);
      const result = await service.reversePurchasePayment(
        req.user!.distributorId!,
        id,
      );
      return sendSuccess(res, result);
    } catch (err) {
      if (err instanceof service.PurchasePaymentError) {
        return sendError(res, err.message, err.statusCode, err.code);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

export default router;
