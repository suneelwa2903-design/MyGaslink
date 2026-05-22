import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated } from '../utils/apiResponse.js';
import { createPaymentSchema, paymentFilterSchema } from '@gaslink/shared';
import * as paymentService from '../services/paymentService.js';
import { mapPayment, mapPayments, mapInvoice } from '../utils/mappers.js';
import { z } from 'zod';

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
      const result = await paymentService.listPayments(req.user!.distributorId!, (req.validated?.query || req.query) as any);
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
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
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
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// GET /api/payments/ledger/:customerId
router.get('/ledger/:customerId',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
  try {
    const ledger = await paymentService.getCustomerLedger(
      req.user!.distributorId!, param(req.params.customerId)
    );
    return sendSuccess(res, ledger);
  } catch (err: any) {
    return sendError(res, err.message, err.statusCode || 500);
  }
});

export default router;
