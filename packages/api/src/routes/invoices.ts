import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import {
  invoiceFilterSchema, createCreditNoteSchema, createDebitNoteSchema,
  type InvoiceFilterInput,
} from '@gaslink/shared';
import * as invoiceService from '../services/invoiceService.js';
import { mapInvoice, mapInvoices, mapCreditNote, mapDebitNote } from '../utils/mappers.js';
import * as gstService from '../services/gst/gstService.js';
import { tryAdvanceTripAfterRetry } from '../services/gst/gstPreflightService.js';
import { logger } from '../utils/logger.js';
import { generateInvoicePdf } from '../services/pdf/invoicePdfService.js';
import { generateCreditNotePdf } from '../services/pdf/creditNotePdfService.js';
import { generateDebitNotePdf } from '../services/pdf/debitNotePdfService.js';
import { prisma } from '../lib/prisma.js';
import { z } from 'zod';

type ServiceError = { message: string; statusCode?: number; code?: string };

const router = Router();

// GET /api/invoices
router.get('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validateQuery(invoiceFilterSchema),
  async (req, res) => {
    try {
      const result = await invoiceService.listInvoices(req.user!.distributorId!, (req.validated?.query || req.query) as InvoiceFilterInput);
      // meta also nested inside data: the web consumes
      // `apiGet<{ invoices, meta }>('/invoices', …)` which only sees
      // `res.data.data`. The 4th-arg `meta` lands at the envelope root
      // and gets stripped before the page sees it — old pagination
      // silently never rendered. Keep the 4th arg for the few external
      // callers that read the envelope root directly (if any).
      return sendSuccess(res, { invoices: mapInvoices(result.data), meta: result.meta }, 200, result.meta);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/invoices/validate-gstin - Validate a GSTIN via WhiteBooks
router.post('/validate-gstin',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(z.object({ gstin: z.string().length(15) })),
  async (req, res) => {
    try {
      const result = await gstService.validateGstin(
        req.user!.distributorId!, req.body.gstin
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// GET /api/invoices/:id
router.get('/:id',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  async (req, res) => {
  try {
    const invoice = await invoiceService.getInvoiceById(param(req.params.id), req.user!.distributorId!);
    if (!invoice) return sendNotFound(res, 'Invoice');
    return sendSuccess(res, mapInvoice(invoice));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// POST /api/invoices/from-order/:orderId
router.post('/from-order/:orderId',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  auditLog('create_from_order', 'invoice'),
  async (req, res) => {
    try {
      const { prisma } = await import('../lib/prisma.js');
      const invoice = await invoiceService.createInvoiceFromOrder(
        prisma,
        param(req.params.orderId),
        req.user!.distributorId!,
        req.user!.userId
      );
      return sendCreated(res, mapInvoice(invoice));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/invoices/manual
router.post('/manual',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(z.object({
    customerId: z.string().uuid(),
    issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    items: z.array(z.object({
      cylinderTypeId: z.string().uuid().optional(),
      description: z.string().min(1),
      hsnCode: z.string().optional(),
      quantity: z.number().int().positive(),
      unitPrice: z.number().positive(),
      discountPerUnit: z.number().min(0).optional(),
      gstRate: z.number().min(0).optional(),
    })).min(1),
  })),
  auditLog('create_manual', 'invoice'),
  async (req, res) => {
    try {
      const invoice = await invoiceService.createManualInvoice(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendCreated(res, mapInvoice(invoice));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/invoices/retroactive-gst - Generate GST invoices for pre-toggle orders
router.post('/retroactive-gst',
  requireRole('super_admin', 'distributor_admin'),
  validate(z.object({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  })),
  auditLog('retroactive_gst', 'invoice'),
  async (req, res) => {
    try {
      const result = await invoiceService.generateRetroactiveGstInvoices(
        req.user!.distributorId!, req.user!.userId, req.body.fromDate, req.body.toDate
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// PUT /api/invoices/:id/status
router.put('/:id/status',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(z.object({ status: z.string().min(1) })),
  auditLog('update_status', 'invoice'),
  async (req, res) => {
    try {
      const invoice = await invoiceService.updateInvoiceStatus(
        param(req.params.id), req.user!.distributorId!, req.body.status
      );
      return sendSuccess(res, mapInvoice(invoice));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/invoices/mark-overdue
router.post('/mark-overdue',
  requireRole('super_admin', 'distributor_admin'),
  auditLog('mark_overdue', 'invoice'),
  async (req, res) => {
    try {
      const result = await invoiceService.markOverdueInvoices(req.user!.distributorId!);
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/invoices/:id/pdf - Generate invoice PDF
router.get('/:id/pdf',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const pdfBuffer = await generateInvoicePdf(param(req.params.id), req.user!.distributorId!);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="invoice-${req.params.id}.pdf"`,
        'Content-Length': String(pdfBuffer.length),
      });
      return res.send(pdfBuffer);
    } catch (err: unknown) {
      const e = err as ServiceError;
      if (e.message === 'Invoice not found') return sendNotFound(res, 'Invoice');
      return sendError(res, e.message, 500);
    }
  }
);

// ─── GST Operations ─────────────────────────────────────────────────────────

// POST /api/invoices/:id/generate-gst - Trigger GST compliance (IRN + EWB)
router.post('/:id/generate-gst',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  auditLog('generate_gst', 'invoice'),
  async (req, res) => {
    try {
      const invoiceId = param(req.params.id);
      const distributorId = req.user!.distributorId!;
      const result = await gstService.processInvoiceGst(invoiceId, distributorId);
      // Fix 3 (2026-05-30): if the retry produced an active EWB, ask the trip-
      // advance helper to re-evaluate the DVA. Fire-and-forget; a helper error
      // must never fail the user-visible retry call.
      // `result` is a union — narrow out the skipped/disabled branch first.
      const ewbStatus = 'ewb' in result ? result.ewb?.status : undefined;
      if (ewbStatus === 'active' || ewbStatus === 'already_exists') {
        void tryAdvanceTripAfterRetry(invoiceId, distributorId, req.user!.userId).catch((err) => {
          logger.warn('tryAdvanceTripAfterRetry non-blocking failure', {
            invoiceId,
            err: (err as Error).message,
          });
        });
      }
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// GROUP-7S: cancel routes now require a structured reasonCode in addition
// to the free-text reason. NIC documents these codes as: 1=Duplicate,
// 2=Data Entry Mistake, 3=Order Cancelled, 4=Others. The web modal
// surfaces them as a dropdown so the operator's intent is captured
// explicitly instead of being guessed by keyword-matching the free text.
const cancelGstBodySchema = z.object({
  reason: z.string().min(1).max(100),
  reasonCode: z.enum(['1', '2', '3', '4']),
});

// POST /api/invoices/:id/cancel-irn - Cancel IRN
// WI-039: finance can also cancel IRN — they're the team raising CN/DN
// and need to clean up the upstream IRN before reissuing.
router.post('/:id/cancel-irn',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(cancelGstBodySchema),
  auditLog('cancel_irn', 'invoice'),
  async (req, res) => {
    try {
      // WI-086: standalone retry — evict stale token before calling.
      // (cancelOrder evicts once for the combined sequence; standalone
      // callers must do it themselves since gstService no longer does it.)
      const { clearTokenCache } = await import('../services/gst/whitebooksClient.js');
      clearTokenCache(req.user!.distributorId!);
      const result = await gstService.cancelIrn(
        param(req.params.id),
        req.user!.distributorId!,
        req.body.reason,
        req.body.reasonCode,
        req.user!.userId ?? null,
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/invoices/:id/cancel-ewb - Cancel e-Way Bill
// WI-039: finance can also cancel EWB (companion to cancel-irn above).
router.post('/:id/cancel-ewb',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(cancelGstBodySchema),
  auditLog('cancel_ewb', 'invoice'),
  async (req, res) => {
    try {
      // WI-086: standalone retry — evict stale token before calling.
      const { clearTokenCache } = await import('../services/gst/whitebooksClient.js');
      clearTokenCache(req.user!.distributorId!);
      const result = await gstService.cancelEwb(
        param(req.params.id),
        req.user!.distributorId!,
        req.body.reason,
        req.body.reasonCode,
        req.user!.userId ?? null,
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/invoices/:id/regenerate - Cancel old invoice and create new one (after delivery changes)
router.post('/:id/regenerate',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  auditLog('regenerate_invoice', 'invoice'),
  async (req, res) => {
    try {
      const invoice = await invoiceService.getInvoiceById(param(req.params.id), req.user!.distributorId!);
      if (!invoice) return sendNotFound(res, 'Invoice not found');
      if (!invoice.orderId) return sendError(res, 'Invoice not linked to an order', 400);

      const result = await gstService.cancelAndRegenerateInvoice(
        param(req.params.id), req.user!.distributorId!, req.user!.userId, invoice.orderId
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// GET /api/invoices/:id/gst-documents - Get GST documents for an invoice
router.get('/:id/gst-documents',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const invoiceId = param(req.params.id);
      // Tenant-scope via the invoice — match credit-notes/debit-notes routes
      // (#30 IDOR fix). Without this any tenant could read another tenant's
      // IRN/EWB numbers + NIC payloads by guessing an invoiceId. 404 (not 403)
      // on cross-tenant access for consistency with the rest of the API.
      const invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, distributorId: req.user!.distributorId! },
        select: { id: true },
      });
      if (!invoice) return sendNotFound(res, 'Invoice');
      const docs = await prisma.gstDocument.findMany({
        where: { invoiceId },
        orderBy: { createdAt: 'desc' },
      });
      return sendSuccess(res, docs);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, 500);
    }
  }
);

// ─── Credit Notes ───────────────────────────────────────────────────────────

// GET /api/invoices/:id/credit-notes - List CNs for an invoice (admin/finance)
// Used by the View Invoice modal to render the CN list section.
router.get('/:id/credit-notes',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const invoiceId = param(req.params.id);
      // Tenant-scope via the invoice — match cancel/regenerate routes.
      const invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, distributorId: req.user!.distributorId! },
        select: { id: true },
      });
      if (!invoice) return sendNotFound(res, 'Invoice');
      const notes = await prisma.creditNote.findMany({
        where: { invoiceId },
        orderBy: { createdAt: 'desc' },
      });
      return sendSuccess(res, { creditNotes: notes.map(mapCreditNote) });
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

router.post('/credit-notes',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(createCreditNoteSchema),
  auditLog('create', 'credit_note'),
  async (req, res) => {
    try {
      const cn = await invoiceService.createCreditNote(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendCreated(res, mapCreditNote(cn));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

router.put('/credit-notes/:id/approve',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  auditLog('approve', 'credit_note'),
  async (req, res) => {
    try {
      const cn = await invoiceService.approveCreditNote(param(req.params.id), req.user!.distributorId!, req.user!.userId);
      return sendSuccess(res, mapCreditNote(cn));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

router.put('/credit-notes/:id/reject',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  // Optional `reason` — captured by auditLog middleware in the request body
  // for compliance trail. Not stored on the credit_note row (no column
  // for it; deferred until a separate audit column is added).
  validate(z.object({ reason: z.string().max(500).optional() })),
  auditLog('reject', 'credit_note'),
  async (req, res) => {
    try {
      const cn = await invoiceService.rejectCreditNote(param(req.params.id), req.user!.distributorId!, req.user!.userId);
      return sendSuccess(res, mapCreditNote(cn));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// GET /api/invoices/credit-notes/:id/pdf - Generate credit note PDF
router.get('/credit-notes/:id/pdf',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const pdfBuffer = await generateCreditNotePdf(param(req.params.id), req.user!.distributorId!);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="credit-note-${req.params.id}.pdf"`,
        'Content-Length': String(pdfBuffer.length),
      });
      return res.send(pdfBuffer);
    } catch (err: unknown) {
      const e = err as ServiceError;
      if (e.message === 'Credit note not found') return sendNotFound(res, 'Credit note');
      return sendError(res, e.message, 500);
    }
  }
);

// ─── Debit Notes ────────────────────────────────────────────────────────────

// GET /api/invoices/:id/debit-notes - List DNs for an invoice
router.get('/:id/debit-notes',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const invoiceId = param(req.params.id);
      const invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, distributorId: req.user!.distributorId! },
        select: { id: true },
      });
      if (!invoice) return sendNotFound(res, 'Invoice');
      const notes = await prisma.debitNote.findMany({
        where: { invoiceId },
        orderBy: { createdAt: 'desc' },
      });
      return sendSuccess(res, { debitNotes: notes.map(mapDebitNote) });
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

router.post('/debit-notes',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(createDebitNoteSchema),
  auditLog('create', 'debit_note'),
  async (req, res) => {
    try {
      const dn = await invoiceService.createDebitNote(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendCreated(res, mapDebitNote(dn));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

router.put('/debit-notes/:id/approve',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  auditLog('approve', 'debit_note'),
  async (req, res) => {
    try {
      const dn = await invoiceService.approveDebitNote(param(req.params.id), req.user!.distributorId!, req.user!.userId);
      return sendSuccess(res, mapDebitNote(dn));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

router.put('/debit-notes/:id/reject',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  validate(z.object({ reason: z.string().max(500).optional() })),
  auditLog('reject', 'debit_note'),
  async (req, res) => {
    try {
      const dn = await invoiceService.rejectDebitNote(param(req.params.id), req.user!.distributorId!, req.user!.userId);
      return sendSuccess(res, mapDebitNote(dn));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// GET /api/invoices/debit-notes/:id/pdf - Generate debit note PDF (WI-039)
// Mirrors the credit-note PDF route; tenant-scoped at the service layer.
router.get('/debit-notes/:id/pdf',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const pdfBuffer = await generateDebitNotePdf(param(req.params.id), req.user!.distributorId!);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="debit-note-${req.params.id}.pdf"`,
        'Content-Length': String(pdfBuffer.length),
      });
      return res.send(pdfBuffer);
    } catch (err: unknown) {
      const e = err as ServiceError;
      if (e.message === 'Debit note not found') return sendNotFound(res, 'Debit note');
      return sendError(res, e.message, 500);
    }
  }
);

export default router;
