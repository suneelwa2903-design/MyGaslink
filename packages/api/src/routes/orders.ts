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
import { preflightDispatch, PreflightError } from '../services/gst/gstPreflightService.js';
import { generateTripSheetPdf, TripSheetError } from '../services/pdf/tripSheetPdfService.js';
import { mapOrder, mapOrders } from '../utils/mappers.js';
import { prisma } from '../lib/prisma.js';
import { z } from 'zod';

const preflightDispatchSchema = z.object({
  driverId: z.string().uuid(),
  assignmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const router = Router();

// GET /api/orders
router.get('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'driver'),
  validateQuery(orderFilterSchema),
  async (req, res) => {
    try {
      const filters = { ...((req.validated?.query || req.query) as any) };

      // Driver role auto-scoping. The Driver model has no user_id FK — the
      // convention (mirrored in driversVehicles.ts /me/* endpoints) is to
      // resolve the driver by phone + distributor_id. Without this, a driver
      // hitting /orders would see every other driver's orders in the same
      // distributor (multi-tenant within-tenant leak).
      //
      // If the user has the driver role but no matching driver record exists
      // in their distributor's roster, return an empty list rather than 403 —
      // a 403 would block legitimate users mid-app and look like a bug.
      if (req.user!.role === 'driver') {
        const user = await prisma.user.findUnique({
          where: { id: req.user!.userId },
          select: { phone: true },
        });
        const driver = user?.phone ? await prisma.driver.findFirst({
          where: { distributorId: req.user!.distributorId!, phone: user.phone, deletedAt: null },
          select: { id: true },
        }) : null;
        if (!driver) {
          return sendSuccess(res, { orders: [] }, 200, { page: 1, pageSize: 0, total: 0, totalPages: 0 });
        }
        filters.driverId = driver.id;
      }

      const result = await orderService.listOrders(req.user!.distributorId!, filters);
      return sendSuccess(res, { orders: mapOrders(result.data) }, 200, result.meta);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/orders/returns-only - Create returns-only order
router.post('/returns-only',
  requireRole('super_admin', 'distributor_admin', 'inventory'),
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
// Inventory creates orders during depot intake; admin/finance retain
// access (finance for invoicing-driven creation); customer covers the
// self-service portal flow.
router.post('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'customer'),
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
// Inventory can assign drivers as part of the morning dispatch flow.
router.post('/:id/assign-driver',
  requireRole('super_admin', 'distributor_admin', 'inventory'),
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
  requireRole('super_admin', 'distributor_admin', 'inventory'),
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

// POST /api/orders/preflight-dispatch
// WI-035 + amendment: For a driver's daily route, run pre-dispatch GST
// preflight (IRN + EWB for B2B, standalone EWB for every B2C / URP, no
// GST calls for GST-disabled tenants). Per-order partial dispatch —
// successes move to pending_delivery, failures revert to
// pending_dispatch and surface in the response + PendingActions queue.
router.post('/preflight-dispatch',
  requireRole('super_admin', 'distributor_admin', 'inventory'),
  validate(preflightDispatchSchema),
  auditLog('preflight_dispatch', 'order'),
  async (req, res) => {
    try {
      const result = await preflightDispatch({
        distributorId: req.user!.distributorId!,
        driverId: req.body.driverId,
        assignmentDate: req.body.assignmentDate,
        userId: req.user!.userId,
      });
      // 207 Multi-Status when at least one order succeeded AND at least
      // one failed — surfaces partial-success to clients without
      // overloading 200. Pure success or pure failure still gets 200.
      const status = result.summary.failed > 0 && result.summary.succeeded > 0 ? 207 : 200;
      return res.status(status).json({ success: true, data: result, error: null });
    } catch (err: any) {
      if (err instanceof PreflightError) {
        return sendError(res, err.message, err.statusCode, err.code);
      }
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// GET /api/orders/trip-sheet/:assignmentId
// WI-038: Returns the consolidated EWB trip sheet for a driver's day
// as a PDF. Tenant-scoped at the service layer; drivers see their
// route's trip sheet through the mobile assignments flow, which
// already enforces per-driver ownership separately.
router.get('/trip-sheet/:assignmentId',
  requireRole('super_admin', 'distributor_admin'),
  async (req, res) => {
    try {
      const assignmentId = param(req.params.assignmentId);
      const pdf = await generateTripSheetPdf(assignmentId, req.user!.distributorId!);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="trip-sheet-${assignmentId.substring(0, 8)}.pdf"`,
      );
      return res.send(pdf);
    } catch (err: any) {
      if (err instanceof TripSheetError) {
        return sendError(res, err.message, err.statusCode);
      }
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
