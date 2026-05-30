import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { param } from '../utils/params.js';
import { z } from 'zod';
import * as deliveryWorkflow from '../services/deliveryWorkflowService.js';
import { mapOrders } from '../utils/mappers.js';

const router = Router();

// ─── Customer Delivery Confirmation ─────────────────────────────────────────

// GET /api/delivery/customer/pending-confirmations
router.get('/customer/pending-confirmations',
  requireRole('customer'),
  async (req, res) => {
    try {
      const confirmations = await deliveryWorkflow.getCustomerPendingConfirmations(req.user!.customerId!);
      return sendSuccess(res, mapOrders(confirmations));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return sendError(res, message, 500);
    }
  }
);

// POST /api/delivery/customer/confirm/:orderId
router.post('/customer/confirm/:orderId',
  requireRole('customer'),
  validate(z.object({
    confirmed: z.boolean(),
    items: z.array(z.object({
      cylinderTypeId: z.string().uuid(),
      confirmedDelivered: z.number().int().min(0),
      confirmedEmpties: z.number().int().min(0),
    })).optional(),
    disputeReason: z.string().max(500).optional(),
  })),
  auditLog('confirm_delivery', 'order'),
  async (req, res) => {
    try {
      const result = await deliveryWorkflow.customerConfirmDelivery(
        param(req.params.orderId), req.user!.customerId!, req.body
      );

      // If dispute resulted in invoice needing regeneration, trigger it
      if ('requiresInvoiceRegeneration' in result && result.requiresInvoiceRegeneration && result.invoiceId) {
        try {
          const { cancelAndRegenerateInvoice } = await import('../services/gst/gstService.js');
          await cancelAndRegenerateInvoice(
            result.invoiceId, req.user!.distributorId!, req.user!.userId, param(req.params.orderId)
          );
        } catch (_err: unknown) {
          // Non-blocking - invoice regeneration failure doesn't block confirmation
        }
      }

      return sendSuccess(res, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return sendError(res, message, 500);
    }
  }
);

// ─── Driver Vehicle Return ──────────────────────────────────────────────────

// POST /api/delivery/driver/vehicle-returned
router.post('/driver/vehicle-returned',
  requireRole('driver', 'distributor_admin', 'inventory'),
  validate(z.object({
    vehicleId: z.string().uuid(),
  })),
  auditLog('vehicle_returned', 'vehicle'),
  async (req, res) => {
    try {
      const result = await deliveryWorkflow.markVehicleReturned(
        req.body.vehicleId, req.user!.userId, req.user!.distributorId!
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // WI-087: pending_delivery guard throws a descriptive error → 409 Conflict
      if (message.startsWith('Cannot mark vehicle as returned')) {
        return sendError(res, message, 409);
      }
      // WI-100 Gap C: already-reconciled guard → 409 Conflict
      if (message.startsWith('Vehicle has already been reconciled')) {
        return sendError(res, message, 409);
      }
      if (message === 'Vehicle not found') return sendError(res, message, 404);
      return sendError(res, message, 500);
    }
  }
);

// ─── Inventory Reconciliation ───────────────────────────────────────────────

// GET /api/delivery/reconciliation/pending
router.get('/reconciliation/pending',
  requireRole('inventory', 'distributor_admin', 'finance', 'super_admin'),
  async (req, res) => {
    try {
      const result = await deliveryWorkflow.getVehiclesPendingReconciliation(req.user!.distributorId!);
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return sendError(res, message, 500);
    }
  }
);

// POST /api/delivery/reconciliation/confirm/:vehicleId
router.post('/reconciliation/confirm/:vehicleId',
  requireRole('inventory', 'distributor_admin', 'finance', 'super_admin'),
  validate(z.object({
    physicalStockConfirmed: z.boolean(),
    notes: z.string().max(500).optional(),
    emptiesReturned: z.array(z.object({
      cylinderTypeId: z.string().uuid(),
      quantity: z.number().int().min(0),
    })).optional(),
  })),
  auditLog('reconcile_vehicle', 'vehicle'),
  async (req, res) => {
    try {
      const result = await deliveryWorkflow.confirmVehicleReconciliation(
        param(req.params.vehicleId), req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // The service throws a 400 with `statusCode: 400` for validation rejects
      // (e.g. empties verified > empties collected). Surface that distinctly so
      // the UI shows the actual validation message, not a generic 500.
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 400) return sendError(res, message, 400);
      return sendError(res, message, 500);
    }
  }
);

export default router;
