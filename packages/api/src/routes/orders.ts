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
  backdatedOrderSchema,
  backdatedTripSchema,
  localTodayISO,
} from '@gaslink/shared';
import * as orderService from '../services/orderService.js';
import { createBackdatedOrder } from '../services/backdatedOrderService.js';
import { createBackdatedTrip, BackdatedTripError } from '../services/backdatedTripService.js';
import { applyBackdatedInventoryAdjustment } from '../services/backdatedAdjustmentService.js';
import { preflightDispatch, preflightAddToTrip, PreflightError } from '../services/gst/gstPreflightService.js';
import { generateTripSheetPdf, TripSheetError } from '../services/pdf/tripSheetPdfService.js';
import * as deliveryProofService from '../services/deliveryProofService.js';
import { mapOrder, mapOrders } from '../utils/mappers.js';
import { prisma } from '../lib/prisma.js';
import { z } from 'zod';

const preflightDispatchSchema = z.object({
  driverId: z.string().uuid(),
  assignmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

type ServiceError = { message: string; statusCode?: number; code?: string };

const router = Router();

// GET /api/orders
router.get('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'driver', 'mini_operator_admin'),
  validateQuery(orderFilterSchema),
  async (req, res) => {
    try {
      const filters = {
        ...(req.validated?.query ?? req.query),
      } as Parameters<typeof orderService.listOrders>[1] & { driverId?: string };

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
      // meta nested in data — see invoices.ts list comment.
      return sendSuccess(res, { orders: mapOrders(result.data), meta: result.meta }, 200, result.meta);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/orders/returns-only - Create returns-only order
router.post('/returns-only',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(returnsOnlyOrderSchema),
  auditLog('create_returns_order', 'order'),
  async (req, res) => {
    try {
      const order = await orderService.createReturnsOnlyOrder(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendCreated(res, mapOrder(order));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/orders/backdated - Brief 3: on-demand backdated order+invoice
// (distributor_admin only). Route MUST be registered before GET /:id so the
// literal segment wins the router match — matches the same defensive
// ordering as /in-transit below.
router.post('/backdated',
  requireRole('distributor_admin', 'mini_operator_admin'),
  validate(backdatedOrderSchema),
  auditLog('create_backdated', 'order'),
  async (req, res) => {
    try {
      const result = await createBackdatedOrder(
        req.user!.distributorId!, req.user!.userId, req.body,
      );
      return sendCreated(res, {
        order: mapOrder(result.order),
        invoice: result.invoice ? { id: result.invoice.id, invoiceNumber: result.invoice.invoiceNumber } : null,
      });
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// POST /api/orders/backdated-trip - Item 6 (2026-07-09) — bulk backdated
// trip. One driver + one vehicle + one past date + N customer orders
// (up to 50). See backdatedTripService.ts for semantics. Route lives
// BEFORE /:id for the same reason as /backdated above.
router.post('/backdated-trip',
  requireRole('distributor_admin', 'mini_operator_admin'),
  validate(backdatedTripSchema),
  auditLog('create_backdated_trip', 'order'),
  async (req, res) => {
    try {
      const result = await createBackdatedTrip(
        req.user!.distributorId!, req.user!.userId, req.body,
      );
      return sendCreated(res, result);
    } catch (err: unknown) {
      if (err instanceof BackdatedTripError) {
        return sendError(res, err.message, err.statusCode);
      }
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// POST /api/orders/from-cancelled-stock - Create order from cancelled stock on vehicle
router.post('/from-cancelled-stock',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
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
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// GET /api/orders/in-transit
// WI-065: per-driver summary of trips that have been dispatched but
// not yet fully returned. Drives the new "In Transit" section on the
// web Driver Assignment tab — gives the admin visibility into existing
// trips before clicking Dispatch (so the 409 trap surfaces as a
// contextualised "+ Add to Trip" affordance instead of an opaque error).
//
// Route MUST be registered before GET /:id, otherwise "in-transit"
// would be caught by the `:id` route and 404 as a not-found order.
router.get('/in-transit',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId!;
      // Phase D (2026-06-12): local-TZ default — see localTodayISO docs.
      const dateParam = (req.query.date as string | undefined) ?? localTodayISO();
      const targetDate = new Date(dateParam);

      // Every DVA in flight today, scoped to (distributor, date,
      // loaded_and_dispatched). Drivers whose trip already advanced to
      // returned_inventory or that haven't yet dispatched don't appear.
      const dvas = await prisma.driverVehicleAssignment.findMany({
        where: {
          distributorId,
          assignmentDate: targetDate,
          status: 'loaded_and_dispatched',
        },
        include: {
          driver: { select: { id: true, driverName: true } },
          vehicle: { select: { id: true, vehicleNumber: true } },
        },
        orderBy: { tripNumber: 'asc' },
      });

      // WI-069: a DVA can sit at status=loaded_and_dispatched indefinitely
      // if the auto-reset block in confirmDelivery (WI-068) never had a
      // chance to run — e.g. orders delivered on a code version that
      // pre-dates WI-068, a non-transactional path that bypasses the
      // reset, or any future edge case. Surfacing such a driver in the
      // "In Transit" section is misleading: the trip is logically over,
      // any new pending_dispatch order should start a FRESH trip, and
      // the existing self-heal at gstPreflightService.ts (stale DVA →
      // bump tripNumber + reset) handles it the moment the user clicks
      // Dispatch ▶ from the Ready-to-Dispatch section.
      //
      // Filter on actual in-flight orders (pending_delivery /
      // preflight_in_progress), not DVA.status alone.
      const rows = (
        await Promise.all(dvas.map(async (dva) => {
          const [inTransitCount, deliveredCount, pendingCount] = await Promise.all([
            prisma.order.count({
              where: {
                distributorId, driverId: dva.driverId, deliveryDate: targetDate, deletedAt: null,
                status: { in: ['pending_delivery', 'preflight_in_progress'] },
              },
            }),
            prisma.order.count({
              where: {
                distributorId, driverId: dva.driverId, deliveryDate: targetDate, deletedAt: null,
                tripNumber: dva.tripNumber,
                status: { in: ['delivered', 'modified_delivered'] },
              },
            }),
            prisma.order.count({
              where: {
                distributorId, driverId: dva.driverId, deliveryDate: targetDate, deletedAt: null,
                status: 'pending_dispatch',
              },
            }),
          ]);
          if (inTransitCount === 0) return null;
          return {
            driverId: dva.driverId,
            driverName: dva.driver?.driverName ?? null,
            vehicleId: dva.vehicleId,
            vehicleNumber: dva.vehicle?.vehicleNumber ?? null,
            assignmentId: dva.id,
            tripNumber: dva.tripNumber,
            tripSheetNo: dva.tripSheetNo,
            tripSheetNo2: dva.tripSheetNo2,
            inTransitCount,
            deliveredCount,
            pendingCount,
          };
        }))
      ).filter((r): r is NonNullable<typeof r> => r !== null);

      return sendSuccess(res, { drivers: rows });
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/orders/:id/apply-inventory-adjustment
// Settle today's stock for a backdated order. Writes manual_adjustment
// (fulls) + reconciliation_empties_return (empties) events dated TODAY
// and stamps Order.inventoryAdjustedAt to block double-apply. No
// historical cascade. distributor_admin + inventory + finance — finance
// can close the billing loop (the apply step is what makes the
// backdated invoice's stock figures real).
router.post('/:id/apply-inventory-adjustment',
  requireRole('distributor_admin', 'inventory', 'finance', 'mini_operator_admin'),
  auditLog('apply_inventory_adjustment', 'order'),
  async (req, res) => {
    try {
      const result = await applyBackdatedInventoryAdjustment(
        req.user!.distributorId!, req.user!.userId, param(req.params.id),
      );
      return sendSuccess(res, {
        message: `Inventory adjusted for order ${result.order.orderNumber}`,
        eventsWritten: result.eventsWritten,
        order: result.order,
      });
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// GET /api/orders/:id
router.get('/:id',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'driver', 'mini_operator_admin'),
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
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'customer', 'mini_operator_admin'),
  validate(createOrderSchema),
  auditLog('create', 'order'),
  async (req, res) => {
    try {
      const order = await orderService.createOrder(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendCreated(res, mapOrder(order));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// PUT /api/orders/:id
router.put('/:id',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(updateOrderSchema),
  auditLog('update', 'order'),
  async (req, res) => {
    try {
      const order = await orderService.updateOrder(
        param(req.params.id), req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendSuccess(res, mapOrder(order));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// PUT /api/orders/:id/status
router.put('/:id/status',
  requireRole('super_admin', 'distributor_admin', 'finance', 'driver', 'inventory', 'mini_operator_admin'),
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
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/orders/:id/assign-driver
// Inventory can assign drivers as part of the morning dispatch flow.
router.post('/:id/assign-driver',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(assignDriverSchema),
  auditLog('assign_driver', 'order'),
  async (req, res) => {
    try {
      const order = await orderService.assignDriver(
        param(req.params.id), req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendSuccess(res, mapOrder(order));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/orders/bulk-assign-driver
router.post('/bulk-assign-driver',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(bulkAssignDriverSchema),
  auditLog('bulk_assign_driver', 'order'),
  async (req, res) => {
    try {
      const results = await orderService.bulkAssignDriver(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendSuccess(res, results);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
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
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
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
    } catch (err: unknown) {
      if (err instanceof PreflightError) {
        return sendError(res, err.message, err.statusCode, err.code);
      }
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/orders/preflight-add-to-trip
// WI-065: Add NEW orders to a driver's already-dispatched trip without
// bumping tripNumber or clearing the existing trip sheet. Generates a
// second consolidated EWB for the new batch (NIC's gencewb has no
// "append" semantics — a fresh CEWB per batch is the only legal path).
router.post('/preflight-add-to-trip',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(preflightDispatchSchema),
  auditLog('preflight_add_to_trip', 'order'),
  async (req, res) => {
    try {
      const result = await preflightAddToTrip({
        distributorId: req.user!.distributorId!,
        driverId: req.body.driverId,
        assignmentDate: req.body.assignmentDate,
        userId: req.user!.userId,
      });
      const status = result.summary.failed > 0 && result.summary.succeeded > 0 ? 207 : 200;
      return res.status(status).json({ success: true, data: result, error: null });
    } catch (err: unknown) {
      if (err instanceof PreflightError) {
        return sendError(res, err.message, err.statusCode, err.code);
      }
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// GET /api/orders/trip-sheet/:assignmentId
// WI-038: Returns the consolidated EWB trip sheet for a driver's day
// as a PDF. Tenant-scoped at the service layer; drivers see their
// route's trip sheet through the mobile assignments flow, which
// already enforces per-driver ownership separately.
router.get('/trip-sheet/:assignmentId',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
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
    } catch (err: unknown) {
      if (err instanceof TripSheetError) {
        return sendError(res, err.message, err.statusCode);
      }
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/orders/:id/confirm-delivery
router.post('/:id/confirm-delivery',
  requireRole('super_admin', 'distributor_admin', 'finance', 'driver', 'inventory', 'mini_operator_admin'),
  validate(deliveryConfirmationSchema),
  auditLog('confirm_delivery', 'order'),
  async (req, res) => {
    try {
      const order = await orderService.confirmDelivery(
        param(req.params.id), req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendSuccess(res, mapOrder(order));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// ─── Delivery-proof (proof-of-collection Phase 1, 2026-07-15) ──────────────
// Three routes. Called by the driver mobile app BEFORE /confirm-delivery
// when the order's customer has requireDeliveryVerification=true. Proof
// is written to a separate `delivery_proofs` table via upsert-by-orderId
// (decouples proof idempotency from delivery idempotency — plan §R1).

const deliveryProofUploadUrlSchema = z.object({
  proofType: z.enum(['signature', 'photo']),
});

const deliveryProofUpsertSchema = z.object({
  proofType: z.enum(['signature', 'photo', 'otp']),
  proofS3Key: z.string().max(200).optional(),
  proofSigningPartyPhone: z.string().min(10).max(15).optional(),
  otpCode: z.string().length(6).optional(),
  capturedLat: z.number().optional(),
  capturedLng: z.number().optional(),
});

// Path C (2026-07-16) — signature-vector submission body.
const signatureVectorSchema = z.object({
  points: z.array(
    z.array(z.tuple([z.number(), z.number()])).min(1).max(400),
  ).min(1).max(40),
  w: z.number().positive().max(4096),
  h: z.number().positive().max(4096),
});

// POST /api/orders/:id/delivery-proof-upload-url
router.post('/:id/delivery-proof-upload-url',
  requireRole('driver'),
  validate(deliveryProofUploadUrlSchema),
  async (req, res) => {
    try {
      // Resolve driver via phone-match (Driver.userId FK is nullable and
      // not populated for seeded drivers) — mirrors resolveDriverFromUser
      // in driversVehicles.ts. Copy-paste over inter-route import to
      // keep the routes self-contained.
      const usr = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { phone: true },
      });
      const driver = usr?.phone
        ? await prisma.driver.findFirst({
            where: { distributorId: req.user!.distributorId!, phone: usr.phone, deletedAt: null },
            select: { id: true },
          })
        : null;
      if (!driver) return sendNotFound(res, 'Driver profile not found for this user');
      const result = await deliveryProofService.getUploadUrl(
        req.user!.distributorId!,
        param(req.params.id),
        req.body.proofType,
        driver.id,
        req.get('host') || undefined,
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// POST /api/orders/:id/delivery-proof/signature-vector
// Path C (2026-07-16): server-side rasterization pipeline. Client sends
// a JSON point list captured via RN PanResponder; server persists as a
// .json file and returns the s3Key. Client then upserts the proof row
// via the existing /delivery-proof route with proofType='signature'.
router.post('/:id/delivery-proof/signature-vector',
  requireRole('driver'),
  validate(signatureVectorSchema),
  async (req, res) => {
    try {
      const usr = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { phone: true },
      });
      const driver = usr?.phone
        ? await prisma.driver.findFirst({
            where: { distributorId: req.user!.distributorId!, phone: usr.phone, deletedAt: null },
            select: { id: true },
          })
        : null;
      if (!driver) return sendNotFound(res, 'Driver profile not found for this user');
      const result = await deliveryProofService.submitSignatureVector(
        req.user!.distributorId!,
        param(req.params.id),
        driver.id,
        { points: req.body.points, w: req.body.w, h: req.body.h },
        req.get('host') || undefined,
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// POST /api/orders/:id/delivery-proof
router.post('/:id/delivery-proof',
  requireRole('driver'),
  validate(deliveryProofUpsertSchema),
  auditLog('upsert_delivery_proof', 'order'),
  async (req, res) => {
    try {
      const proof = await deliveryProofService.upsertProof(
        req.user!.distributorId!,
        param(req.params.id),
        {
          proofType: req.body.proofType,
          s3Key: req.body.proofS3Key,
          signingPartyPhone: req.body.proofSigningPartyPhone,
          otpCode: req.body.otpCode,
          capturedLat: req.body.capturedLat,
          capturedLng: req.body.capturedLng,
          capturedBy: req.user!.userId,
        },
      );
      return sendCreated(res, { deliveryProofId: proof.id });
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// GET /api/orders/:id/delivery-proof — driver reads own captures for retry
// diagnostics; admin/finance roles read for review (otpCode redacted).
router.get('/:id/delivery-proof',
  requireRole('driver', 'super_admin', 'distributor_admin', 'finance'),
  async (req, res) => {
    try {
      const proof = await deliveryProofService.getProof(
        req.user!.distributorId!,
        param(req.params.id),
      );
      if (!proof) return sendNotFound(res, 'No proof found for this order');
      // Never leak otpCode outside the driver role — even to admins
      // reviewing the row. Driver reads the code from the customer's
      // portal card in real time; nobody else needs to see it.
      if (req.user!.role !== 'driver') {
        return sendSuccess(res, { ...proof, otpCode: null });
      }
      return sendSuccess(res, proof);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// ─── Delivery-OTP (proof-of-collection Phase 3, 2026-07-15) ───────────────
// Two driver-only endpoints. Auto-generation happens elsewhere (fire-and-
// forget in transitionToPendingDelivery + createOrderFromCancelledStock);
// these routes cover the driver-initiated flows.

// POST /api/orders/:id/delivery-otp/resend — driver taps "Resend OTP" when
// the customer says they didn't see the code. Generates a fresh 6-digit
// code, overwrites the previous one, valid for the life of the order.
router.post('/:id/delivery-otp/resend',
  requireRole('driver'),
  auditLog('resend_delivery_otp', 'order'),
  async (req, res) => {
    try {
      const usr = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { phone: true },
      });
      const driver = usr?.phone
        ? await prisma.driver.findFirst({
            where: { distributorId: req.user!.distributorId!, phone: usr.phone, deletedAt: null },
            select: { id: true },
          })
        : null;
      if (!driver) return sendNotFound(res, 'Driver profile not found for this user');
      const order = await prisma.order.findFirst({
        where: {
          id: param(req.params.id),
          distributorId: req.user!.distributorId!,
          driverId: driver.id,
          status: 'pending_delivery',
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!order) return sendNotFound(res, 'Order not found or not in pending_delivery');
      const otp = await deliveryProofService.generateOrRefreshOtp(
        req.user!.distributorId!,
        order.id,
        'driver_resend',
      );
      // Deliberately do NOT return the OTP to the driver — the driver
      // reads it off the customer's portal card, not from this response.
      // A returned code here would be a leak vector if the driver's
      // device is ever screenshotted / compromised.
      if (otp == null) {
        return sendError(res, 'This customer does not require delivery verification', 400);
      }
      return sendSuccess(res, { refreshed: true });
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// POST /api/orders/:id/delivery-otp/verify — driver types the code the
// customer reads out. Body: { otpCode: string }. String-compares against
// the stored plaintext (per plan §1.3.3 — customer must be able to
// display it). Sets otpVerifiedAt on success; idempotent on already-verified.
const deliveryOtpVerifySchema = z.object({
  otpCode: z.string().length(6),
});

router.post('/:id/delivery-otp/verify',
  requireRole('driver'),
  validate(deliveryOtpVerifySchema),
  auditLog('verify_delivery_otp', 'order'),
  async (req, res) => {
    try {
      const usr = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { phone: true },
      });
      const driver = usr?.phone
        ? await prisma.driver.findFirst({
            where: { distributorId: req.user!.distributorId!, phone: usr.phone, deletedAt: null },
            select: { id: true },
          })
        : null;
      if (!driver) return sendNotFound(res, 'Driver profile not found for this user');
      const order = await prisma.order.findFirst({
        where: {
          id: param(req.params.id),
          distributorId: req.user!.distributorId!,
          driverId: driver.id,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!order) return sendNotFound(res, 'Order');
      const proof = await prisma.deliveryProof.findFirst({
        where: { orderId: order.id, distributorId: req.user!.distributorId! },
      });
      if (!proof || !proof.otpCode) {
        return sendError(res, 'No OTP found for this order', 400);
      }
      // Idempotent — already verified means the driver may be retrying
      // after a UI hiccup; return success without touching the row.
      if (proof.otpVerifiedAt) {
        return sendSuccess(res, { verified: true, alreadyVerified: true });
      }
      if (proof.otpCode !== req.body.otpCode) {
        return sendError(res, 'Incorrect code. Try again.', 400, 'OTP_INVALID');
      }
      await prisma.deliveryProof.update({
        where: { id: proof.id },
        data: {
          otpVerifiedAt: new Date(),
          // Now that verification succeeded, promote the proof row's
          // type from the provisional 'otp' set at auto-generation time
          // to the final 'otp' (idempotent — already 'otp'). Preserves
          // signingPartyPhone / s3Key if the driver had also captured
          // one of those first (unusual but not forbidden).
          proofType: 'otp',
        },
      });
      return sendSuccess(res, { verified: true });
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// POST /api/orders/:id/resolve-dispute — WI-127
router.post('/:id/resolve-dispute',
  requireRole('distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(z.object({
    resolutionNote: z.string().min(1).max(1000),
    issueCreditNote: z.boolean().optional(),
    creditNoteAmount: z.number().positive().optional(),
    creditNoteReason: z.string().min(1).max(500).optional(),
  })),
  auditLog('resolve_dispute', 'order'),
  async (req, res) => {
    try {
      const result = await orderService.resolveDispute(
        param(req.params.id), req.user!.distributorId!, req.user!.userId, req.body,
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/orders/:id/cancel
router.post('/:id/cancel',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(z.object({ reason: z.string().min(1, 'Cancellation reason is required') })),
  auditLog('cancel', 'order'),
  async (req, res) => {
    try {
      const order = await orderService.cancelOrder(
        param(req.params.id), req.user!.distributorId!, req.user!.userId, req.body.reason
      );
      return sendSuccess(res, mapOrder(order));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/orders/:id/confirm-returns - Confirm returns collection
router.post('/:id/confirm-returns',
  requireRole('super_admin', 'distributor_admin', 'finance', 'driver', 'inventory', 'mini_operator_admin'),
  validate(returnsConfirmationSchema),
  auditLog('confirm_returns', 'order'),
  async (req, res) => {
    try {
      const order = await orderService.confirmReturnsCollection(
        param(req.params.id), req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendSuccess(res, mapOrder(order));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

export default router;
