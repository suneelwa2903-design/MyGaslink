/**
 * Mini-Operator (2026-07-16) — Purchase Entry routes.
 *
 * Mounted at /api/purchase-entries. All routes require `mini_operator_admin`
 * (super_admin auto-passes via requireRole's built-in bypass).
 *
 * Tenant scoping: distributorId always sourced from `req.user.distributorId`.
 * Every service call gets both `distributorId` + the target entity id so
 * cross-tenant reads return 404, never 200.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { param } from '../utils/params.js';
import { sendSuccess, sendCreated, sendError, sendNotFound } from '../utils/apiResponse.js';
import { createPurchaseEntrySchema } from '@gaslink/shared';
import * as purchaseEntryService from '../services/purchaseEntryService.js';
import { generatePurchaseLedgerPdf } from '../services/pdf/purchaseLedgerPdfService.js';

// `authenticate` + `resolveDistributor` + `requireDistributor` are wired in
// app.ts on the mount path — same pattern as every other tenant-scoped
// resource router.
const router = Router();

const listQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sourceDistributorId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(25).optional(),
});

// GET /api/purchase-entries
router.get('/',
  requireRole('mini_operator_admin'),
  validateQuery(listQuerySchema),
  async (req, res) => {
    try {
      const q = (req.validated?.query ?? req.query) as z.infer<typeof listQuerySchema>;
      const result = await purchaseEntryService.listPurchaseEntries(
        req.user!.distributorId!,
        q,
      );
      return sendSuccess(res, { purchaseEntries: result.data, meta: result.meta }, 200, result.meta);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  },
);

// POST /api/purchase-entries
router.post('/',
  requireRole('mini_operator_admin'),
  validate(createPurchaseEntrySchema),
  auditLog('create', 'purchase_entry'),
  async (req, res) => {
    try {
      const created = await purchaseEntryService.createPurchaseEntry(
        req.user!.distributorId!,
        req.user!.userId,
        req.body,
      );
      return sendCreated(res, created);
    } catch (err) {
      if (err instanceof purchaseEntryService.PurchaseEntryError) {
        return sendError(res, err.message, err.statusCode);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

// GET /api/purchase-entries/ledger.pdf
//
// Mini-Operator (2026-07-17) — downloadable purchase ledger.
// Filterable by date range, source distributor, and/or cylinder type.
// MUST be registered BEFORE the wildcard GET /:id below or Express will
// treat "ledger.pdf" as an :id param and hand it to getPurchaseEntry.
const ledgerQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sourceDistributorId: z.string().uuid().optional(),
  cylinderTypeId: z.string().uuid().optional(),
});

router.get('/ledger.pdf',
  requireRole('mini_operator_admin'),
  validateQuery(ledgerQuerySchema),
  async (req, res) => {
    try {
      const q = (req.validated?.query ?? req.query) as z.infer<typeof ledgerQuerySchema>;
      const pdf = await generatePurchaseLedgerPdf(req.user!.distributorId!, q);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="purchase-ledger-${q.from ?? 'beginning'}-${q.to ?? 'today'}.pdf"`,
      );
      return res.send(pdf);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  },
);

// GET /api/purchase-entries/:id
router.get('/:id',
  requireRole('mini_operator_admin'),
  async (req, res) => {
    try {
      const entry = await purchaseEntryService.getPurchaseEntry(
        req.user!.distributorId!,
        param(req.params.id),
      );
      if (!entry) return sendNotFound(res, 'Purchase entry');
      return sendSuccess(res, entry);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  },
);

// DELETE /api/purchase-entries/:id
router.delete('/:id',
  requireRole('mini_operator_admin'),
  auditLog('delete', 'purchase_entry'),
  async (req, res) => {
    try {
      await purchaseEntryService.deletePurchaseEntry(
        req.user!.distributorId!,
        param(req.params.id),
      );
      return sendSuccess(res, { id: param(req.params.id), deleted: true });
    } catch (err) {
      if (err instanceof purchaseEntryService.PurchaseEntryError) {
        if (err.statusCode === 404) return sendNotFound(res, 'Purchase entry');
        return sendError(res, err.message, err.statusCode);
      }
      return sendError(res, (err as Error).message);
    }
  },
);

export default router;
