import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import {
  invoiceFilterSchema, createCreditNoteSchema, createDebitNoteSchema,
} from '@gaslink/shared';
import * as invoiceService from '../services/invoiceService.js';
import { mapInvoice, mapInvoices, mapCreditNote, mapDebitNote } from '../utils/mappers.js';
import * as gstService from '../services/gst/gstService.js';
import { generateInvoicePdf } from '../services/pdf/invoicePdfService.js';
import { generateCreditNotePdf } from '../services/pdf/creditNotePdfService.js';
import { generateDebitNotePdf } from '../services/pdf/debitNotePdfService.js';
import { prisma } from '../lib/prisma.js';
import { z } from 'zod';

const router = Router();

// GET /api/invoices
router.get('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validateQuery(invoiceFilterSchema),
  async (req, res) => {
    try {
      const result = await invoiceService.listInvoices(req.user!.distributorId!, (req.validated?.query || req.query) as any);
      return sendSuccess(res, { invoices: mapInvoices(result.data) }, 200, result.meta);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/invoices/validate-gstin - Validate a GSTIN via WhiteBooks
router.post('/validate-gstin',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(z.object({ gstin: z.string().length(15) })),
  async (req, res) => {
    try {
      const result = await gstService.validateGstin(
        req.user!.distributorId!, req.body.gstin
      );
      return sendSuccess(res, result);
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// GET /api/invoices/:id
router.get('/:id',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
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
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
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
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// POST /api/invoices/manual
router.post('/manual',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
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
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
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
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// PUT /api/invoices/:id/status
router.put('/:id/status',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(z.object({ status: z.string().min(1) })),
  auditLog('update_status', 'invoice'),
  async (req, res) => {
    try {
      const invoice = await invoiceService.updateInvoiceStatus(
        param(req.params.id), req.user!.distributorId!, req.body.status
      );
      return sendSuccess(res, mapInvoice(invoice));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
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
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
    try {
      const pdfBuffer = await generateInvoicePdf(param(req.params.id), req.user!.distributorId!);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="invoice-${req.params.id}.pdf"`,
        'Content-Length': String(pdfBuffer.length),
      });
      return res.send(pdfBuffer);
    } catch (err: any) {
      if (err.message === 'Invoice not found') return sendNotFound(res, 'Invoice');
      return sendError(res, err.message, 500);
    }
  }
);

// ─── GST Operations ─────────────────────────────────────────────────────────

// POST /api/invoices/:id/generate-gst - Trigger GST compliance (IRN + EWB)
router.post('/:id/generate-gst',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  auditLog('generate_gst', 'invoice'),
  async (req, res) => {
    try {
      const result = await gstService.processInvoiceGst(
        param(req.params.id), req.user!.distributorId!
      );
      return sendSuccess(res, result);
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// POST /api/invoices/:id/cancel-irn - Cancel IRN
// WI-039: finance can also cancel IRN — they're the team raising CN/DN
// and need to clean up the upstream IRN before reissuing.
router.post('/:id/cancel-irn',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(z.object({ reason: z.string().min(1).max(100) })),
  auditLog('cancel_irn', 'invoice'),
  async (req, res) => {
    try {
      // WI-086: standalone retry — evict stale token before calling.
      // (cancelOrder evicts once for the combined sequence; standalone
      // callers must do it themselves since gstService no longer does it.)
      const { clearTokenCache } = await import('../services/gst/whitebooksClient.js');
      clearTokenCache(req.user!.distributorId!);
      const result = await gstService.cancelIrn(
        param(req.params.id), req.user!.distributorId!, req.body.reason
      );
      return sendSuccess(res, result);
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// POST /api/invoices/:id/cancel-ewb - Cancel e-Way Bill
// WI-039: finance can also cancel EWB (companion to cancel-irn above).
router.post('/:id/cancel-ewb',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(z.object({ reason: z.string().min(1).max(100) })),
  auditLog('cancel_ewb', 'invoice'),
  async (req, res) => {
    try {
      // WI-086: standalone retry — evict stale token before calling.
      const { clearTokenCache } = await import('../services/gst/whitebooksClient.js');
      clearTokenCache(req.user!.distributorId!);
      const result = await gstService.cancelEwb(
        param(req.params.id), req.user!.distributorId!, req.body.reason
      );
      return sendSuccess(res, result);
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// POST /api/invoices/:id/regenerate - Cancel old invoice and create new one (after delivery changes)
router.post('/:id/regenerate',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
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
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// GET /api/invoices/:id/gst-documents - Get GST documents for an invoice
router.get('/:id/gst-documents',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
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
    } catch (err: any) {
      return sendError(res, err.message, 500);
    }
  }
);

// ─── Credit Notes ───────────────────────────────────────────────────────────

// GET /api/invoices/:id/credit-notes - List CNs for an invoice (admin/finance)
// Used by the View Invoice modal to render the CN list section.
router.get('/:id/credit-notes',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
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
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

router.post('/credit-notes',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(createCreditNoteSchema),
  auditLog('create', 'credit_note'),
  async (req, res) => {
    try {
      const cn = await invoiceService.createCreditNote(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendCreated(res, mapCreditNote(cn));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

router.put('/credit-notes/:id/approve',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  auditLog('approve', 'credit_note'),
  async (req, res) => {
    try {
      const cn = await invoiceService.approveCreditNote(param(req.params.id), req.user!.distributorId!, req.user!.userId);
      return sendSuccess(res, mapCreditNote(cn));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

router.put('/credit-notes/:id/reject',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  // Optional `reason` — captured by auditLog middleware in the request body
  // for compliance trail. Not stored on the credit_note row (no column
  // for it; deferred until a separate audit column is added).
  validate(z.object({ reason: z.string().max(500).optional() })),
  auditLog('reject', 'credit_note'),
  async (req, res) => {
    try {
      const cn = await invoiceService.rejectCreditNote(param(req.params.id), req.user!.distributorId!, req.user!.userId);
      return sendSuccess(res, mapCreditNote(cn));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// GET /api/invoices/credit-notes/:id/pdf - Generate credit note PDF
router.get('/credit-notes/:id/pdf',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
    try {
      const pdfBuffer = await generateCreditNotePdf(param(req.params.id), req.user!.distributorId!);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="credit-note-${req.params.id}.pdf"`,
        'Content-Length': String(pdfBuffer.length),
      });
      return res.send(pdfBuffer);
    } catch (err: any) {
      if (err.message === 'Credit note not found') return sendNotFound(res, 'Credit note');
      return sendError(res, err.message, 500);
    }
  }
);

// ─── Debit Notes ────────────────────────────────────────────────────────────

// GET /api/invoices/:id/debit-notes - List DNs for an invoice
router.get('/:id/debit-notes',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
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
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

router.post('/debit-notes',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(createDebitNoteSchema),
  auditLog('create', 'debit_note'),
  async (req, res) => {
    try {
      const dn = await invoiceService.createDebitNote(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendCreated(res, mapDebitNote(dn));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

router.put('/debit-notes/:id/approve',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  auditLog('approve', 'debit_note'),
  async (req, res) => {
    try {
      const dn = await invoiceService.approveDebitNote(param(req.params.id), req.user!.distributorId!, req.user!.userId);
      return sendSuccess(res, mapDebitNote(dn));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

router.put('/debit-notes/:id/reject',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(z.object({ reason: z.string().max(500).optional() })),
  auditLog('reject', 'debit_note'),
  async (req, res) => {
    try {
      const dn = await invoiceService.rejectDebitNote(param(req.params.id), req.user!.distributorId!, req.user!.userId);
      return sendSuccess(res, mapDebitNote(dn));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// GET /api/invoices/debit-notes/:id/pdf - Generate debit note PDF (WI-039)
// Mirrors the credit-note PDF route; tenant-scoped at the service layer.
router.get('/debit-notes/:id/pdf',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
    try {
      const pdfBuffer = await generateDebitNotePdf(param(req.params.id), req.user!.distributorId!);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="debit-note-${req.params.id}.pdf"`,
        'Content-Length': String(pdfBuffer.length),
      });
      return res.send(pdfBuffer);
    } catch (err: any) {
      if (err.message === 'Debit note not found') return sendNotFound(res, 'Debit note');
      return sendError(res, err.message, 500);
    }
  }
);

export default router;
