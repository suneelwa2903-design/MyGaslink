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
import { prisma } from '../lib/prisma.js';
import { z } from 'zod';

const router = Router();

// GET /api/invoices
router.get('/',
  requireRole('super_admin', 'distributor_admin', 'finance'),
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
  requireRole('super_admin', 'distributor_admin', 'finance'),
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
  requireRole('super_admin', 'distributor_admin', 'finance'),
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
  requireRole('super_admin', 'distributor_admin', 'finance'),
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
  requireRole('super_admin', 'distributor_admin', 'finance'),
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
  requireRole('super_admin', 'distributor_admin', 'finance'),
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
  requireRole('super_admin', 'distributor_admin', 'finance'),
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
  requireRole('super_admin', 'distributor_admin', 'finance'),
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
router.post('/:id/cancel-irn',
  requireRole('super_admin', 'distributor_admin'),
  validate(z.object({ reason: z.string().min(1).max(100) })),
  auditLog('cancel_irn', 'invoice'),
  async (req, res) => {
    try {
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
router.post('/:id/cancel-ewb',
  requireRole('super_admin', 'distributor_admin'),
  validate(z.object({ reason: z.string().min(1).max(100) })),
  auditLog('cancel_ewb', 'invoice'),
  async (req, res) => {
    try {
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
  requireRole('super_admin', 'distributor_admin'),
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
  requireRole('super_admin', 'distributor_admin', 'finance'),
  async (req, res) => {
    try {
      const docs = await prisma.gstDocument.findMany({
        where: { invoiceId: param(req.params.id) },
        orderBy: { createdAt: 'desc' },
      });
      return sendSuccess(res, docs);
    } catch (err: any) {
      return sendError(res, err.message, 500);
    }
  }
);

// ─── Credit Notes ───────────────────────────────────────────────────────────

router.post('/credit-notes',
  requireRole('super_admin', 'distributor_admin', 'finance'),
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
  requireRole('super_admin', 'distributor_admin'),
  auditLog('approve', 'credit_note'),
  async (req, res) => {
    try {
      const cn = await invoiceService.approveCreditNote(param(req.params.id), req.user!.userId);
      return sendSuccess(res, mapCreditNote(cn));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

router.put('/credit-notes/:id/reject',
  requireRole('super_admin', 'distributor_admin'),
  auditLog('reject', 'credit_note'),
  async (req, res) => {
    try {
      const cn = await invoiceService.rejectCreditNote(param(req.params.id), req.user!.userId);
      return sendSuccess(res, mapCreditNote(cn));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// GET /api/invoices/credit-notes/:id/pdf - Generate credit note PDF
router.get('/credit-notes/:id/pdf',
  requireRole('super_admin', 'distributor_admin', 'finance'),
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

router.post('/debit-notes',
  requireRole('super_admin', 'distributor_admin', 'finance'),
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
  requireRole('super_admin', 'distributor_admin'),
  auditLog('approve', 'debit_note'),
  async (req, res) => {
    try {
      const dn = await invoiceService.approveDebitNote(param(req.params.id), req.user!.userId);
      return sendSuccess(res, mapDebitNote(dn));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

router.put('/debit-notes/:id/reject',
  requireRole('super_admin', 'distributor_admin'),
  auditLog('reject', 'debit_note'),
  async (req, res) => {
    try {
      const dn = await invoiceService.rejectDebitNote(param(req.params.id), req.user!.userId);
      return sendSuccess(res, mapDebitNote(dn));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

export default router;
