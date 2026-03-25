import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import {
  createOrderSchema, updateOrderSchema, deliveryConfirmationSchema,
  assignDriverSchema, bulkAssignDriverSchema, orderFilterSchema,
  returnsOnlyOrderSchema, returnsConfirmationSchema,
} from '@gaslink/shared';
import * as orderService from '../services/orderService.js';
import { mapOrder, mapOrders } from '../utils/mappers.js';
import { z } from 'zod';

const router = Router();

// GET /api/orders
router.get('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'driver'),
  validateQuery(orderFilterSchema),
  async (req, res) => {
    try {
      const result = await orderService.listOrders(req.user!.distributorId!, (req.validated?.query || req.query) as any);
      return sendSuccess(res, { orders: mapOrders(result.data) }, 200, result.meta);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/orders/returns-only - Create returns-only order
router.post('/returns-only',
  requireRole('super_admin', 'distributor_admin'),
  validate(returnsOnlyOrderSchema),
  auditLog('create_returns_order', 'order'),
  async (req, res) => {
    try {
      const order = await orderService.createReturnsOnlyOrder(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendCreated(res, mapOrder(order));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// POST /api/orders/from-cancelled-stock - Create order from cancelled stock on vehicle
router.post('/from-cancelled-stock',
  requireRole('super_admin', 'distributor_admin'),
  validate(z.object({
    customerId: z.string().uuid(),
    deliveryDate: z.string(),
    cancelledStockEventId: z.string().uuid(),
    specialInstructions: z.string().max(500).optional(),
  })),
  auditLog('create_from_cancelled_stock', 'order'),
  async (req, res) => {
    try {
      const order = await orderService.createOrderFromCancelledStock(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendCreated(res, mapOrder(order));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// GET /api/orders/:id
router.get('/:id',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'driver'),
  async (req, res) => {
  try {
    const order = await orderService.getOrderById(param(req.params.id), req.user!.distributorId!);
    if (!order) return sendNotFound(res, 'Order');
    return sendSuccess(res, mapOrder(order));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// POST /api/orders
router.post('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'customer'),
  validate(createOrderSchema),
  auditLog('create', 'order'),
  async (req, res) => {
    try {
      const order = await orderService.createOrder(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendCreated(res, mapOrder(order));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// PUT /api/orders/:id
router.put('/:id',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  validate(updateOrderSchema),
  auditLog('update', 'order'),
  async (req, res) => {
    try {
      const order = await orderService.updateOrder(
        param(req.params.id), req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendSuccess(res, mapOrder(order));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// PUT /api/orders/:id/status
router.put('/:id/status',
  requireRole('super_admin', 'distributor_admin', 'driver'),
  validate(z.object({
    status: z.string().min(1),
    notes: z.string().optional(),
  })),
  auditLog('update_status', 'order'),
  async (req, res) => {
    try {
      const order = await orderService.updateOrderStatus(
        param(req.params.id), req.user!.distributorId!, req.user!.userId,
        req.body.status, req.body.notes
      );
      return sendSuccess(res, mapOrder(order));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// POST /api/orders/:id/assign-driver
router.post('/:id/assign-driver',
  requireRole('super_admin', 'distributor_admin'),
  validate(assignDriverSchema),
  auditLog('assign_driver', 'order'),
  async (req, res) => {
    try {
      const order = await orderService.assignDriver(
        param(req.params.id), req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendSuccess(res, mapOrder(order));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// POST /api/orders/bulk-assign-driver
router.post('/bulk-assign-driver',
  requireRole('super_admin', 'distributor_admin'),
  validate(bulkAssignDriverSchema),
  auditLog('bulk_assign_driver', 'order'),
  async (req, res) => {
    try {
      const results = await orderService.bulkAssignDriver(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendSuccess(res, results);
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// POST /api/orders/:id/confirm-delivery
router.post('/:id/confirm-delivery',
  requireRole('super_admin', 'distributor_admin', 'driver'),
  validate(deliveryConfirmationSchema),
  auditLog('confirm_delivery', 'order'),
  async (req, res) => {
    try {
      const order = await orderService.confirmDelivery(
        param(req.params.id), req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendSuccess(res, mapOrder(order));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// POST /api/orders/:id/cancel
router.post('/:id/cancel',
  requireRole('super_admin', 'distributor_admin'),
  validate(z.object({ reason: z.string().min(1, 'Cancellation reason is required') })),
  auditLog('cancel', 'order'),
  async (req, res) => {
    try {
      const order = await orderService.cancelOrder(
        param(req.params.id), req.user!.distributorId!, req.user!.userId, req.body.reason
      );
      return sendSuccess(res, mapOrder(order));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// POST /api/orders/:id/confirm-returns - Confirm returns collection
router.post('/:id/confirm-returns',
  requireRole('super_admin', 'distributor_admin', 'driver'),
  validate(returnsConfirmationSchema),
  auditLog('confirm_returns', 'order'),
  async (req, res) => {
    try {
      const order = await orderService.confirmReturnsCollection(
        param(req.params.id), req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendSuccess(res, mapOrder(order));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

export default router;
