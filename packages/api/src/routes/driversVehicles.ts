import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import { prisma } from '../lib/prisma.js';
import * as driverService from '../services/driverService.js';
import * as vehicleService from '../services/vehicleService.js';
import { mapDriver, mapDrivers, mapVehicle, mapVehicles, mapAssignment, mapAssignments, mapOrders } from '../utils/mappers.js';
import { startOfUtcDay } from '../utils/dateOnly.js';
import { z } from 'zod';

/**
 * Resolve the Driver record for the requesting user.
 *
 * The Driver model has NO `user_id` FK — the convention (also used in
 * orders.ts driver-scoping and the /me/* endpoints below) is shared phone
 * + distributor_id. We centralise the lookup here so all five callers
 * stay in sync if the rule ever changes.
 *
 * Returns null when (a) the user has no phone on file or (b) no driver
 * row matches that phone in their distributor's roster. Callers must
 * handle null gracefully — typically by returning an empty result, NOT
 * a 403 (a 403 on a legitimate driver mid-app would read as a generic bug).
 */
async function resolveDriverFromUser(userId: string, distributorId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { phone: true },
  });
  if (!user?.phone) return null;
  return prisma.driver.findFirst({
    where: { distributorId, phone: user.phone, deletedAt: null },
    select: { id: true },
  });
}

/**
 * WI-096: resolve which trip number to DISPLAY for a driver today.
 *
 * The single DVA row rolls `tripNumber++` the instant the last order of a trip
 * is delivered (confirmDelivery auto-reset). So the latest DVA can point at a
 * brand-new EMPTY trip while the just-completed trip still holds the orders /
 * EWBs / cargo the driver needs to see. The driver-facing screens
 * (assignment, trip-stock, trip-ewbs) were scoping blindly to the latest
 * tripNumber and snapping to that empty trip — so Compliance Docs went empty
 * (BUG A), the Trip tab jumped to the next trip on reload (BUG B), and Vehicle
 * Stock reset to 0 (BUG C).
 *
 * Rule: if the latest trip has NO real orders (none in
 * pending_delivery/delivered/modified_delivered), fall back to the most recent
 * trip that does. A genuine "no orders yet" state (brand-new driver / first
 * trip) has no earlier trip with orders, so we return the latest tripNumber
 * unchanged — the screens correctly show an empty trip, not a crash.
 */
const TRIP_CONTENT_STATUSES = ['pending_delivery', 'delivered', 'modified_delivered'] as const;
async function resolveEffectiveTripNumber(
  distributorId: string, driverId: string, today: Date, latestTripNumber: number,
): Promise<number> {
  const latestHasOrders = await prisma.order.count({
    where: {
      distributorId, driverId, deliveryDate: today, deletedAt: null,
      tripNumber: latestTripNumber, status: { in: [...TRIP_CONTENT_STATUSES] },
    },
  });
  if (latestHasOrders > 0) return latestTripNumber;
  // Latest trip is empty — find the most recent EARLIER trip that has orders.
  const prev = await prisma.order.findFirst({
    where: {
      distributorId, driverId, deliveryDate: today, deletedAt: null,
      tripNumber: { not: null, lt: latestTripNumber }, status: { in: [...TRIP_CONTENT_STATUSES] },
    },
    orderBy: { tripNumber: 'desc' },
    select: { tripNumber: true },
  });
  return prev?.tripNumber ?? latestTripNumber;
}

type ServiceError = { message: string; statusCode?: number; code?: string };

// We export two routers: one for drivers, one for vehicles
const driverRouter = Router();
const vehicleRouter = Router();

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVERS
// ═══════════════════════════════════════════════════════════════════════════════

const createDriverSchema = z.object({
  driverName: z.string().min(1).max(100),
  phone: z.string().min(10).max(15),
  licenseNumber: z.string().optional(),
  employmentType: z.string().optional(),
  joiningDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

driverRouter.get('/', async (req, res) => {
  try {
    // ?unlinked=true — Group B Part 3, used by the smart Add User modal
    // when role=driver. Returns only drivers without an app-login user row.
    const unlinkedOnly = req.query.unlinked === 'true' || req.query.unlinked === '1';
    const drivers = await driverService.listDrivers(
      req.user!.distributorId!,
      req.query.status as string,
      { unlinkedOnly },
    );
    return sendSuccess(res, { drivers: mapDrivers(drivers) });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

driverRouter.get('/:id', async (req, res) => {
  try {
    const driver = await driverService.getDriverById(param(req.params.id), req.user!.distributorId!);
    if (!driver) return sendNotFound(res, 'Driver');
    return sendSuccess(res, mapDriver(driver));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

driverRouter.post('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(createDriverSchema),
  auditLog('create', 'driver'),
  async (req, res) => {
    try {
      const driver = await driverService.createDriver(req.user!.distributorId!, req.body);
      return sendCreated(res, mapDriver(driver));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

driverRouter.put('/:id',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(createDriverSchema.partial().extend({
    status: z.enum(['active', 'inactive']).optional(),
    availableToday: z.boolean().optional(),
    deactivationNotes: z.string().optional(),
    preferredVehicleId: z.string().uuid().optional(),
  })),
  auditLog('update', 'driver'),
  async (req, res) => {
    try {
      const driver = await driverService.updateDriver(param(req.params.id), req.user!.distributorId!, req.body);
      if (!driver) return sendNotFound(res, 'Driver');
      return sendSuccess(res, mapDriver(driver));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

driverRouter.delete('/:id',
  requireRole('super_admin', 'distributor_admin', 'inventory'),
  auditLog('delete', 'driver'),
  async (req, res) => {
    try {
      const result = await driverService.deleteDriver(param(req.params.id), req.user!.distributorId!);
      if (!result) return sendNotFound(res, 'Driver');
      return sendSuccess(res, { message: 'Driver deactivated' });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// PUT /api/drivers/:id/availability
driverRouter.put('/:id/availability',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(z.object({ available: z.boolean() })),
  auditLog('toggle_availability', 'driver'),
  async (req, res) => {
    try {
      const driver = await driverService.toggleAvailability(
        param(req.params.id), req.user!.distributorId!, req.body.available
      );
      if (!driver) return sendNotFound(res, 'Driver');
      return sendSuccess(res, mapDriver(driver));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/drivers/:id/performance
driverRouter.get('/:id/performance', async (req, res) => {
  try {
    const perf = await driverService.getDriverPerformance(
      req.user!.distributorId!, param(req.params.id),
      req.query.dateFrom as string, req.query.dateTo as string
    );
    return sendSuccess(res, perf);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// ─── Driver-Vehicle Assignments ─────────────────────────────────────────────

driverRouter.get('/assignments/list', async (req, res) => {
  try {
    const assignments = await driverService.listAssignments(
      req.user!.distributorId!,
      req.query.date as string,
      req.query.driverId as string
    );
    return sendSuccess(res, mapAssignments(assignments));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

driverRouter.post('/assignments',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(z.object({
    driverId: z.string().uuid(),
    vehicleId: z.string().uuid(),
    assignmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })),
  auditLog('create', 'driver_vehicle_assignment'),
  async (req, res) => {
    try {
      const assignment = await driverService.createDriverVehicleAssignment(
        req.user!.distributorId!, req.body
      );
      return sendCreated(res, mapAssignment(assignment));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

driverRouter.put('/assignments/:id/status',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'driver'),
  validate(z.object({
    status: z.enum(['dispatch_ready', 'loaded_and_dispatched', 'returned_inventory', 'reconciled', 'cancelled']),
  })),
  auditLog('update_status', 'driver_vehicle_assignment'),
  async (req, res) => {
    try {
      const assignment = await driverService.updateAssignmentStatus(
        param(req.params.id), req.user!.distributorId!, req.body.status
      );
      return sendSuccess(res, mapAssignment(assignment));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// ─── Driver "My" Endpoints (for mobile app) ────────────────────────────────

// GET /api/drivers/me/assignment - Get current driver's today assignment
// Returns the DriverVehicleAssignment for the requesting driver on today's
// date, with the day's orders (and order items) attached so the mobile
// Trip screen can render Customer, Items, Status in one round-trip.
// Returns `null` (HTTP 200) when the driver has no assignment for today —
// the mobile UI shows an "No active trip" empty state on null.
// GET /api/drivers/me/events — SSE stream of trip/order events for the
// authenticated driver. Replaces the 30-second polls in (driver)/orders.tsx
// and (driver)/trip.tsx — see lib/sseManager.ts for the rationale.
//
// The handler ends the response on disconnect; sseManager handles
// heartbeats and notifyDriver fan-out.
driverRouter.get('/me/events',
  requireRole('driver'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId!;
      const driver = await resolveDriverFromUser(req.user!.userId, distributorId);
      if (!driver) {
        return sendError(res, 'Driver record not found for this user', 404);
      }

      // SSE response headers. `X-Accel-Buffering: no` is required to defeat
      // nginx's default proxy_buffering; without it the chunks pile up in
      // the nginx buffer and the client gets nothing for ~minutes.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      // Flush headers immediately so the client can begin parsing.
      res.flushHeaders?.();

      // Initial event so the client knows the stream is live.
      res.write(`data: ${JSON.stringify({ type: 'connected', driverId: driver.id })}\n\n`);

      const { addConnection, removeConnection } = await import('../lib/sseManager.js');
      addConnection(driver.id, res);

      const cleanup = () => removeConnection(driver.id, res);
      req.on('close', cleanup);
      req.on('error', cleanup);
      // Do not call next() / sendSuccess — the response stays open until
      // the client disconnects.
      return;
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  },
);

driverRouter.get('/me/assignment',
  requireRole('driver'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId!;
      const driver = await resolveDriverFromUser(req.user!.userId, distributorId);
      if (!driver) return sendSuccess(res, null);

      // Date math: use start-of-today as the date column is `@db.Date`.
      // Prisma equality on a `Date` column matches by the calendar day.
      // @db.Date column → bound by UTC calendar day, not local midnight
      // (utils/dateOnly.ts). setHours(0,0,0,0) was off-by-one on this IST server.
      const today = startOfUtcDay();

      const assignment = await prisma.driverVehicleAssignment.findFirst({
        where: { driverId: driver.id, distributorId, assignmentDate: today },
        include: {
          driver: { select: { id: true, driverName: true, phone: true } },
          // WI-094c: surface vehicle.status so the driver app can show the
          // "vehicle returned — waiting for inventory to reconcile" state
          // (vehicle goes 'returned' before the DVA rolls to the next trip).
          vehicle: { select: { id: true, vehicleNumber: true, status: true } },
        },
        orderBy: { tripNumber: 'desc' }, // multiple trips same day: pick latest
      });
      if (!assignment) return sendSuccess(res, null);

      // WI-096: if the latest DVA rolled to a new empty trip, display the most
      // recent trip that actually has orders (else the Trip tab jumps to an
      // empty trip on reload — BUG B).
      const effectiveTrip = await resolveEffectiveTripNumber(distributorId, driver.id, today, assignment.tripNumber);

      // Pull today's orders separately so mapAssignment stays a pure
      // shape transform and the orders query can opt into the heavier
      // orderInclude (items + cylinderType + customer). We scope to the
      // driver to keep the EW within-tenant + within-driver guarantee.
      // WI-094c: scope the order list to the CURRENT trip. The DVA row is
      // reused across trips (tripNumber++ in place), so an unscoped "today"
      // query showed every order the driver touched all day (11 orders across
      // 4 trips in the live report). Mirror the trip-stock OR pattern:
      //   - orders stamped with this trip's number (any status: pending /
      //     delivered / cancelled-in-trip)
      //   - pending_dispatch orders not yet stamped (tripNumber NULL) — the
      //     upcoming load, so the pre-dispatch view isn't empty
      //   - legacy NULL-tripNumber pending_delivery dispatched before WI-065
      //     (pinned via the DVA updatedAt window, same as tripSheetPdfService)
      // WI-096b Fix 2: scope "Orders in Trip" to the effective trip ONLY.
      // The previous OR also pulled NULL-tripNumber pending_dispatch orders,
      // which belong to the NEXT (not-yet-dispatched) trip — so a trip in
      // fallback showed Trip N's delivered orders mixed with Trip N+1's
      // pending-dispatch orders. Orders are "in the trip" once dispatched
      // (tripNumber stamped); pre-dispatch pending_dispatch orders are not.
      const orders = await prisma.order.findMany({
        where: {
          distributorId,
          driverId: driver.id,
          deliveryDate: today,
          deletedAt: null,
          tripNumber: effectiveTrip,
        },
        include: {
          customer: { select: { id: true, customerName: true, stopSupply: true, creditPeriodDays: true } },
          items: { include: { cylinderType: { select: { typeName: true } } } },
        },
        orderBy: { createdAt: 'asc' },
      });

      const mapped = mapAssignment(assignment)!;
      // WI-096: surface the effective trip so the header matches the orders
      // shown (avoids "Trip #N" with the previous trip's deliveries).
      mapped.tripNumber = effectiveTrip;
      mapped.orders = mapOrders(orders);
      return sendSuccess(res, mapped);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/drivers/me/trip-stock - Aggregated cylinder cargo for the
// driver's trip today, derived from the orders assigned to them. We do
// NOT read `vehicle_inventory` (admin-managed static table; never written
// on dispatch). Instead we sum per cylinder type across this driver's
// today orders:
//   - totalFulls   = sum of item.quantity across pending_dispatch /
//                    pending_delivery orders
//   - deliveredFulls = sum of item.deliveredQuantity for already-
//                      delivered orders (visibility on what's gone)
//   - emptiesCollected = sum of item.emptiesCollected across delivered
//                        orders (what's now riding back to the depot)
// For GST-disabled tenants this is the only stock view the driver gets.
driverRouter.get('/me/trip-stock',
  requireRole('driver'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId!;
      const driver = await resolveDriverFromUser(req.user!.userId, distributorId);
      if (!driver) return sendSuccess(res, { items: [] });

      // @db.Date column → bound by UTC calendar day, not local midnight
      // (utils/dateOnly.ts). setHours(0,0,0,0) was off-by-one on this IST server.
      const today = startOfUtcDay();

      // WI-094b Fix 3/4: scope the cargo to the driver's CURRENT trip, not
      // every order they touched today. A driver who finishes Trip 1 (all
      // delivered/reconciled) and starts Trip 2 was previously shown Trip 1's
      // delivered fulls + empties on top of Trip 2's — a wildly inflated truck
      // count. We pin to the latest DVA's tripNumber, mirroring the trip-sheet
      // PDF service (tripSheetPdfService.ts:103-113):
      //   - dispatched/delivered orders carry order.tripNumber === DVA.tripNumber
      //     (stamped at the pending_delivery transition by preflightOne)
      //   - pending_dispatch orders are not yet stamped (tripNumber NULL) but
      //     belong to the upcoming load for this same (driver, date), so they
      //     count toward fulls about to go on the truck.
      const currentDva = await prisma.driverVehicleAssignment.findFirst({
        where: { driverId: driver.id, distributorId, assignmentDate: today, status: { not: 'cancelled' } },
        orderBy: { tripNumber: 'desc' },
        select: { tripNumber: true, updatedAt: true, isReconciled: true },
      });
      if (!currentDva) return sendSuccess(res, { items: [] });
      // 2026-06-01: once the supervisor runs Confirm & Reconcile (or a
      // Report-Mismatch write-off that fully closes the gap, which calls
      // confirmVehicleReconciliation under the hood), the DVA is flipped
      // isReconciled=true. The trip is over for the driver — the truck has
      // been physically swept back to the depot. Without this short-circuit
      // the loop below would keep summing every delivered order's
      // `emptiesCollected` forever, leaving stale "remaining cargo" on the
      // driver screen even though the vehicle has been idle for hours.
      if (currentDva.isReconciled) return sendSuccess(res, { items: [] });

      // WI-096: if the latest DVA rolled to a new empty trip, report cargo for
      // the most recent trip that has orders (else stock resets to 0 — BUG C).
      const effectiveTrip = await resolveEffectiveTripNumber(distributorId, driver.id, today, currentDva.tripNumber);

      const orders = await prisma.order.findMany({
        where: {
          distributorId,
          driverId: driver.id,
          deliveryDate: today,
          deletedAt: null,
          // Exclude cancelled — those aren't on the truck.
          status: { not: 'cancelled' },
          OR: [
            // On/returned with this trip: dispatched + delivered fulls/empties.
            { tripNumber: effectiveTrip, status: { in: ['pending_delivery', 'delivered', 'modified_delivered'] } },
            // Queued for the next load (not yet dispatched → tripNumber NULL).
            { tripNumber: null, status: 'pending_dispatch' },
            // Legacy fallback (mirrors tripSheetPdfService.ts:112): orders
            // dispatched BEFORE WI-065's per-order tripNumber stamping have
            // tripNumber = NULL while pending_delivery. Pin them to the
            // current DVA via the updatedAt window so historical trucks still
            // report their cargo. New dispatches always carry tripNumber.
            { tripNumber: null, status: 'pending_delivery', updatedAt: { gte: currentDva.updatedAt } },
          ],
        },
        include: {
          items: { include: { cylinderType: { select: { id: true, typeName: true } } } },
        },
      });

      // Aggregate per cylinder type. Use a Map for deterministic insertion
      // order; we serialise to an array at the end so the mobile UI can
      // .map directly (anti-pattern #9: every list response shape is the
      // envelope `{ items: [...] }`).
      type Row = {
        cylinderTypeId: string;
        cylinderTypeName: string;
        fullQuantity: number;     // still to deliver
        deliveredQuantity: number; // already handed over today
        emptyQuantity: number;     // returned by customers, on truck
      };
      const rows = new Map<string, Row>();

      for (const order of orders) {
        const isDelivered = order.status === 'delivered' || order.status === 'modified_delivered';
        for (const item of order.items) {
          const key = item.cylinderTypeId;
          const existing = rows.get(key) ?? {
            cylinderTypeId: key,
            cylinderTypeName: item.cylinderType?.typeName ?? 'Unknown',
            fullQuantity: 0,
            deliveredQuantity: 0,
            emptyQuantity: 0,
          };
          if (isDelivered) {
            const delivered = item.deliveredQuantity ?? 0;
            const ordered = item.quantity ?? 0;
            existing.deliveredQuantity += delivered;
            existing.emptyQuantity += item.emptiesCollected ?? 0;
            // 2026-06-01: a `modified_delivered` (or partial `delivered`)
            // order has `deliveredQuantity < quantity` — the customer
            // rejected some cylinders and they are STILL ON THE TRUCK
            // until reconciliation. Previously this branch added nothing
            // to fullQuantity, silently zeroing out the leftover cargo on
            // the driver screen. The driver would arrive at the depot
            // showing 0 fulls when the truck actually still held N.
            existing.fullQuantity += Math.max(0, ordered - delivered);
          } else {
            existing.fullQuantity += item.quantity ?? 0;
          }
          rows.set(key, existing);
        }
      }

      return sendSuccess(res, { items: Array.from(rows.values()) });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/drivers/me/trip-ewbs - List of EWB compliance docs for today's
// orders, scoped to this driver. Joins gst_documents to orders so the
// driver can read out / share the EWB number at the customer site (NIC
// rule: the EWB must accompany the goods, not just the invoice).
//
// For GST-disabled tenants, returns `{ items: [] }` without querying — no
// gst_documents rows exist for those distributors anyway, but skipping the
// query keeps the response O(1) and the intent obvious.
driverRouter.get('/me/trip-ewbs',
  requireRole('driver'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId!;
      const empty = { tripNumber: null, tripSheetNo: null, tripSheetNo2: null, items: [] as unknown[] };
      const driver = await resolveDriverFromUser(req.user!.userId, distributorId);
      if (!driver) return sendSuccess(res, empty);

      // Short-circuit for GST-disabled tenants.
      const distributor = await prisma.distributor.findUnique({
        where: { id: distributorId },
        select: { gstMode: true },
      });
      if (!distributor || distributor.gstMode === 'disabled') {
        return sendSuccess(res, empty);
      }

      // @db.Date column → bound by UTC calendar day, not local midnight
      // (utils/dateOnly.ts). setHours(0,0,0,0) was off-by-one on this IST server.
      const today = startOfUtcDay();

      // WI-094c: scope to the CURRENT trip and include the just-completed
      // trip's EWBs (delivered orders), so the driver can still show the EWB
      // at a checkpoint after handing over. We also return the consolidated
      // trip-sheet numbers so the mobile knows whether to offer a PDF
      // download. Mirrors the trip-stock / tripSheetPdfService scoping:
      //   - orders stamped with this trip's number (pending or delivered)
      //   - legacy NULL-tripNumber pending_delivery (pre-WI-065) via the
      //     DVA updatedAt window.
      const assignment = await prisma.driverVehicleAssignment.findFirst({
        where: { driverId: driver.id, distributorId, assignmentDate: today },
        orderBy: { tripNumber: 'desc' },
        select: { tripNumber: true, tripSheetNo: true, tripSheetNo2: true, updatedAt: true },
      });
      if (!assignment) return sendSuccess(res, empty);

      // WI-096: if the latest DVA rolled to a new empty trip, show the EWBs of
      // the most recent trip that has orders (else Compliance Docs is empty
      // right after the driver delivers — BUG A).
      const effectiveTrip = await resolveEffectiveTripNumber(distributorId, driver.id, today, assignment.tripNumber);

      // We need order_id + ewb_no + ewb_status + valid_till, joined to orders
      // for the customer name, order number, and cylinder type/qty. doc_type
      // ='INV' filters out CN/DN docs which carry separate EWBs on the same
      // table. ewbStatus in [active, cancelled] excludes failed/pending docs
      // that never got a real NIC EWB number (e.g. B2C below threshold).
      //
      // WI-107 fix: filter by isLatest=true so a reissued EWB does not show
      // the superseded original alongside the new one. The reissue path runs
      // `updateMany({ isLatest:true } → { isLatest:false })` + create
      // new-row atomically (gstReissueService.upsertLatestGstDoc), so the
      // current EWB for each order is exactly the isLatest=true row. A
      // single-doc lifecycle that ends in 'cancelled' (no reissue) keeps
      // isLatest=true and still surfaces — the driver retains the
      // checkpoint reference for that order. Pre-fix the endpoint returned
      // both the cancelled OLD and the active NEW after a reissue (gst-
      // reissue.test.ts > WI-107 — trip-ewbs Compliance Docs).
      const docs = await prisma.gstDocument.findMany({
        where: {
          distributorId,
          docType: 'INV',
          isLatest: true,
          ewbNo: { not: null },
          ewbStatus: { in: ['active', 'cancelled'] },
          order: {
            driverId: driver.id,
            deliveryDate: today,
            deletedAt: null,
            OR: [
              { tripNumber: effectiveTrip, status: { in: ['pending_delivery', 'delivered', 'modified_delivered'] } },
              { tripNumber: null, status: 'pending_delivery', updatedAt: { gte: assignment.updatedAt } },
            ],
          },
        },
        select: {
          orderId: true,
          ewbNo: true,
          ewbDate: true,
          ewbValidTill: true,
          ewbStatus: true,
          order: {
            select: {
              orderNumber: true,
              status: true,
              customer: { select: { customerName: true } },
              items: { select: { quantity: true, deliveredQuantity: true, cylinderType: { select: { typeName: true } } } },
            },
          },
          invoice: { select: { invoiceNumber: true } },
        },
        orderBy: { ewbDate: 'desc' },
      });

      const items = docs.map((d) => {
        const orderItems = d.order?.items ?? [];
        // WI-111: once the order is delivered the EWB reflects what actually
        // moved, so Compliance Docs must show the DELIVERED qty (e.g. 19KG×3
        // after a modified-MORE delivery), not the ordered qty. For
        // pending_delivery orders deliveredQuantity is null → fall back to the
        // ordered quantity.
        const isDelivered = d.order?.status === 'delivered' || d.order?.status === 'modified_delivered';
        return {
          orderId: d.orderId,
          orderNumber: d.order?.orderNumber ?? null,
          customerName: d.order?.customer?.customerName ?? null,
          invoiceNumber: d.invoice?.invoiceNumber ?? null,
          ewbNo: d.ewbNo,
          ewbDate: d.ewbDate,
          ewbValidTill: d.ewbValidTill,
          ewbStatus: d.ewbStatus,
          cylinderType: orderItems[0]?.cylinderType?.typeName ?? null,
          quantity: orderItems.reduce(
            (s, it) => s + (isDelivered ? (it.deliveredQuantity ?? it.quantity ?? 0) : (it.quantity ?? 0)),
            0,
          ),
        };
      });
      return sendSuccess(res, {
        // WI-096: report the effective (orders-bearing) trip, matching the items.
        tripNumber: effectiveTrip,
        tripSheetNo: assignment.tripSheetNo,
        tripSheetNo2: assignment.tripSheetNo2,
        items,
      });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/drivers/me/trip-sheet-pdf - Driver-scoped wrapper around the
// existing trip-sheet PDF service (WI-038). We find the requesting driver's
// today DVA and stream the same PDF the admin already gets at
// /api/orders/trip-sheet/:assignmentId. Returns 404 when there's no DVA
// for today (no trip → no sheet). GST-disabled tenants are blocked at the
// PDF service level (it requires at least one EWB to render), but we also
// short-circuit here for a cleaner error.
driverRouter.get('/me/trip-sheet-pdf',
  requireRole('driver'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId!;
      const driver = await resolveDriverFromUser(req.user!.userId, distributorId);
      if (!driver) return sendNotFound(res, 'Trip sheet');

      // Short-circuit for GST-disabled tenants — no EWBs ever exist.
      const distributor = await prisma.distributor.findUnique({
        where: { id: distributorId },
        select: { gstMode: true },
      });
      if (!distributor || distributor.gstMode === 'disabled') {
        return sendNotFound(res, 'Trip sheet');
      }

      // @db.Date column → bound by UTC calendar day, not local midnight
      // (utils/dateOnly.ts). setHours(0,0,0,0) was off-by-one on this IST server.
      const today = startOfUtcDay();
      const assignment = await prisma.driverVehicleAssignment.findFirst({
        where: { driverId: driver.id, distributorId, assignmentDate: today },
        select: { id: true },
        orderBy: { tripNumber: 'desc' },
      });
      if (!assignment) return sendNotFound(res, 'Trip sheet');

      // Reuse the existing service. Dynamic import keeps the pdfkit cold
      // path out of the cold-start path of this hot driver router.
      const { generateTripSheetPdf, TripSheetError } = await import('../services/pdf/tripSheetPdfService.js');
      try {
        const pdf = await generateTripSheetPdf(assignment.id, distributorId);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="trip-sheet-${assignment.id.substring(0, 8)}.pdf"`);
        return res.send(pdf);
      } catch (svcErr: unknown) {
        // WI-063 follow-up — map inner TripSheetError to a clean 404 for
        // the driver-scoped wrapper. The service throws 400 with
        // "No EWB available for trip sheet — no orders on this route
        // have an e-Way Bill yet" when the route is empty (post-WI-061
        // this also fires when all orders are delivered). Either way,
        // the mobile UI wants "no document" semantics → 404 → empty
        // state, not a generic 400 error toast.
        if (svcErr instanceof TripSheetError) {
          return sendNotFound(res, svcErr.message);
        }
        throw svcErr;
      }
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// GET /api/drivers/me/vehicle-inventory - Static vehicle inventory (admin-
// managed via PUT /api/vehicles/:id/inventory). Useful when a tenant
// chooses to maintain per-vehicle stock manually. For per-trip cargo
// derived from orders, use /me/trip-stock above.
driverRouter.get('/me/vehicle-inventory',
  requireRole('driver'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId!;
      const driver = await resolveDriverFromUser(req.user!.userId, distributorId);
      if (!driver) return sendSuccess(res, []);

      // @db.Date column → bound by UTC calendar day, not local midnight
      // (utils/dateOnly.ts). setHours(0,0,0,0) was off-by-one on this IST server.
      const today = startOfUtcDay();
      const assignment = await prisma.driverVehicleAssignment.findFirst({
        where: { driverId: driver.id, assignmentDate: today, status: { not: 'cancelled' } },
        orderBy: { createdAt: 'desc' },
      });
      if (!assignment) return sendSuccess(res, []);

      const inv = await vehicleService.getVehicleInventory(assignment.vehicleId, distributorId);
      return sendSuccess(res, inv);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/drivers/me/cancelled-stock - Get cancelled stock on driver's vehicle
driverRouter.get('/me/cancelled-stock',
  requireRole('driver'),
  async (req, res) => {
    try {
      const distributorId = req.user!.distributorId!;
      const driver = await resolveDriverFromUser(req.user!.userId, distributorId);
      if (!driver) return sendSuccess(res, []);

      // @db.Date column → bound by UTC calendar day, not local midnight
      // (utils/dateOnly.ts). setHours(0,0,0,0) was off-by-one on this IST server.
      const today = startOfUtcDay();
      const assignment = await prisma.driverVehicleAssignment.findFirst({
        where: { driverId: driver.id, assignmentDate: today, status: { not: 'cancelled' } },
        orderBy: { createdAt: 'desc' },
      });
      if (!assignment) return sendSuccess(res, []);

      const events = await vehicleService.getCancelledStockByVehicle(
        distributorId, assignment.vehicleId
      );
      return sendSuccess(res, events);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// VEHICLES
// ═══════════════════════════════════════════════════════════════════════════════

const createVehicleSchema = z.object({
  vehicleNumber: z.string().min(1).max(20),
  vehicleType: z.string().optional(),
  capacity: z.number().int().positive().optional(),
});

vehicleRouter.get('/', async (req, res) => {
  try {
    const vehicles = await vehicleService.listVehicles(
      req.user!.distributorId!, req.query.status as string
    );
    return sendSuccess(res, { vehicles: mapVehicles(vehicles) });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

vehicleRouter.get('/:id', async (req, res) => {
  try {
    const vehicle = await vehicleService.getVehicleById(param(req.params.id), req.user!.distributorId!);
    if (!vehicle) return sendNotFound(res, 'Vehicle');
    return sendSuccess(res, mapVehicle(vehicle));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

vehicleRouter.post('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(createVehicleSchema),
  auditLog('create', 'vehicle'),
  async (req, res) => {
    try {
      const vehicle = await vehicleService.createVehicle(req.user!.distributorId!, req.body);
      return sendCreated(res, mapVehicle(vehicle));
    } catch (err: unknown) {
      const e = err as ServiceError;
      if (e.code === 'P2002') return sendError(res, 'Vehicle number already exists', 409);
      return sendError(res, e.message);
    }
  }
);

vehicleRouter.put('/:id',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(createVehicleSchema.partial().extend({
    status: z.enum(['idle', 'dispatched', 'returned', 'inactive']).optional(),
    deactivationNotes: z.string().optional(),
  })),
  auditLog('update', 'vehicle'),
  async (req, res) => {
    try {
      const vehicle = await vehicleService.updateVehicle(param(req.params.id), req.user!.distributorId!, req.body);
      if (!vehicle) return sendNotFound(res, 'Vehicle');
      return sendSuccess(res, mapVehicle(vehicle));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

vehicleRouter.delete('/:id',
  requireRole('super_admin', 'distributor_admin', 'inventory'),
  auditLog('delete', 'vehicle'),
  async (req, res) => {
    try {
      const result = await vehicleService.deleteVehicle(param(req.params.id), req.user!.distributorId!);
      if (!result) return sendNotFound(res, 'Vehicle');
      return sendSuccess(res, { message: 'Vehicle deactivated' });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/vehicles/:id/inventory
vehicleRouter.get('/:id/inventory', async (req, res) => {
  try {
    const inv = await vehicleService.getVehicleInventory(param(req.params.id), req.user!.distributorId!);
    return sendSuccess(res, inv);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// PUT /api/vehicles/:id/inventory
vehicleRouter.put('/:id/inventory',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(z.object({
    cylinderTypeId: z.string().uuid(),
    fullQuantity: z.number().int().min(0).optional(),
    emptyQuantity: z.number().int().min(0).optional(),
  })),
  auditLog('update', 'vehicle_inventory'),
  async (req, res) => {
    try {
      const result = await vehicleService.updateVehicleInventory(
        param(req.params.id), req.body.cylinderTypeId, req.user!.distributorId!, req.body
      );
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/vehicles/:id/cancelled-stock
vehicleRouter.get('/:id/cancelled-stock', async (req, res) => {
  try {
    const events = await vehicleService.getCancelledStockByVehicle(
      req.user!.distributorId!, param(req.params.id)
    );
    return sendSuccess(res, events);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

export { driverRouter, vehicleRouter };
