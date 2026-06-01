import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated } from '../utils/apiResponse.js';
import { createPaymentSchema, paymentFilterSchema } from '@gaslink/shared';
import * as paymentService from '../services/paymentService.js';
import { mapPayment, mapPayments, mapInvoice } from '../utils/mappers.js';
import { prisma } from '../lib/prisma.js';
import { toNum } from '../utils/decimal.js';
import { z } from 'zod';

type ServiceError = { message: string; statusCode?: number; code?: string };

const router = Router();

const allocatePaymentSchema = z.object({
  invoiceId: z.string().uuid(),
  amount: z.number().positive(),
});

// GET /api/payments
router.get('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validateQuery(paymentFilterSchema),
  async (req, res) => {
    try {
      const result = await paymentService.listPayments(req.user!.distributorId!, (req.validated?.query || req.query) as Parameters<typeof paymentService.listPayments>[1]);
      return sendSuccess(res, { payments: mapPayments(result.data) }, 200, result.meta);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/payments
router.post('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(createPaymentSchema),
  auditLog('create', 'payment'),
  async (req, res) => {
    try {
      const payment = await paymentService.createPayment(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendCreated(res, mapPayment(payment));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/payments/:id/allocate — apply unallocated payment to an invoice
router.post('/:id/allocate',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(allocatePaymentSchema),
  auditLog('allocate', 'payment'),
  async (req, res) => {
    try {
      const result = await paymentService.allocatePayment(
        req.user!.distributorId!, req.user!.userId, param(req.params.id), req.body,
      );
      return sendSuccess(res, {
        payment: mapPayment(result.payment),
        invoice: mapInvoice(result.invoice),
      });
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

const ledgerQuerySchema = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// GET /api/payments/ledger/:customerId
//
// Returns the true ledger timeline (CustomerLedgerEntry rows: invoice
// debit, payment credit, credit/debit note adjustments, opening balance,
// cancellation reversals, accountability charges). Both web and mobile
// LedgerTab components were typed as `LedgerEntry[]` since they shipped,
// but the route previously returned the delivery-aggregate
// `CustomerLedgerResponse = { rows, summary }` (used by the PDF statement
// — kept intact at /api/customers/:id/ledger/pdf). The aggregate shape
// has zero overlap with the `entryType`/`amountDelta`/`entryDate`/
// `narration` fields the UI reads, so every ledger tab silently rendered
// "No ledger entries". Anti-pattern #9 — fixed 2026-06-01 by switching
// this endpoint to return what the UI actually wants. PDF callers stay
// on /api/customers/:id/ledger/pdf, which still calls getCustomerLedger.
router.get('/ledger/:customerId',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validateQuery(ledgerQuerySchema),
  async (req, res) => {
  try {
    const q = (req.validated?.query || req.query) as { dateFrom?: string; dateTo?: string };
    const entries = await prisma.customerLedgerEntry.findMany({
      where: {
        distributorId: req.user!.distributorId!,
        customerId: param(req.params.customerId),
        ...(q.dateFrom || q.dateTo
          ? { entryDate: {
              ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}),
              ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}),
            } }
          : {}),
      },
      orderBy: { entryDate: 'asc' },
    });
    return sendSuccess(res, entries.map((e) => ({
      id: e.id,
      distributorId: e.distributorId,
      customerId: e.customerId,
      entryType: e.entryType,
      referenceId: e.referenceId,
      invoiceId: e.invoiceId,
      amountDelta: toNum(e.amountDelta),
      narration: e.narration,
      entryDate: e.entryDate.toISOString(),
      createdBy: e.createdBy,
      createdAt: e.createdAt.toISOString(),
    })));
  } catch (err: unknown) {
    const e = err as ServiceError;
    return sendError(res, e.message, e.statusCode || 500);
  }
});

export default router;
