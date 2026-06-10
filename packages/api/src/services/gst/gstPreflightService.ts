/**
 * Pre-dispatch preflight (WI-035, WI-A).
 *
 * For a driver's daily route, ensure every order has the GST documents
 * required to legally leave the depot BEFORE the vehicle moves:
 *   - B2B (customer.gstin set, ≠ 'URP'): IRN + EWB
 *   - B2C (gstin null/URP): standalone EWB (always — no invoice-value gate)
 *
 * Lock semantics (founder Q3): orders transition pending_dispatch →
 * preflight_in_progress at the start, then → pending_delivery (success)
 * or back → pending_dispatch (failure). Concurrent preflight on the
 * same order races on this status update and the loser hits 409.
 *
 * Partial dispatch (founder Q1): each order is processed independently;
 * failures land in a PendingAction queue and the order returns to
 * pending_dispatch. Other orders in the same driver's batch still
 * proceed to pending_delivery.
 */

import { Prisma, type IrnStatus, type EwbStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../utils/logger.js';
import { toNum } from '../../utils/decimal.js';
import { getCredentials, pingEinvoiceSession, GstError } from './whitebooksClient.js';
import { callWithLog } from './apiLogger.js';
import { buildIrnPayload, buildEwbPayload } from './payloadBuilders.js';
import type { EwbResponse, IrnResponse, ConsolidatedEwbResponse } from './nicTypes.js';
import { notifyDriver } from '../../lib/sseManager.js';

/** The InvoiceData shape consumed by buildIrnPayload (kept un-exported there). */
type InvoiceData = Parameters<typeof buildIrnPayload>[0];
import {
  parseEwbResponse,
  parseWhitebooksDate,
  createPendingAction,
} from './gstService.js';
import { createInvoiceFromOrder } from '../invoiceService.js';
import { createInventoryEvent, recalculateSummariesFromDate } from '../inventoryService.js';
import { isDispatchDebitEnabled } from '../../utils/inventoryFlags.js';

const orderInclude = {
  customer: true,
  items: { include: { cylinderType: true } },
  vehicle: true,
  driver: { select: { id: true, driverName: true } },
} as const;

/** Order with the preflight includes (customer, items+cylinderType, vehicle, driver). */
type PreflightOrder = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

/** The distributor fields the preflight flow reads (subset of the Prisma model). */
type DistributorGstFields = Pick<
  Prisma.DistributorGetPayload<true>,
  | 'id' | 'gstMode' | 'gstin' | 'legalName' | 'businessName'
  | 'address' | 'city' | 'state' | 'pincode' | 'phone' | 'email'
>;

/** Narrow an unknown caught value to the GST error code/message shape. */
function errInfo(err: unknown): { code: string; message: string } {
  if (err instanceof GstError) return { code: err.code, message: err.message };
  if (err instanceof Error) return { code: '', message: err.message };
  return { code: '', message: String(err) };
}

/**
 * The subset of gst_documents columns the preflight branches write through
 * upsertLatestGstDocument. JSON columns take the raw payload/response objects;
 * Prisma narrows them at the column boundary (see toJson).
 */
interface GstDocumentWriteData {
  irnStatus?: IrnStatus;
  irn?: string | null;
  ackNo?: string | null;
  ackDate?: Date | null;
  signedQr?: string | null;
  ewbStatus?: EwbStatus;
  ewbNo?: string | null;
  ewbDate?: Date | null;
  ewbValidTill?: Date | null;
  requestPayload?: Prisma.InputJsonValue;
  responsePayload?: Prisma.InputJsonValue;
}

// JSON columns reject our precise payload interfaces (optional fields widen to
// `| undefined`, not valid JSON input). Narrow at the column boundary.
const toJson = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

export type PreflightResult = {
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  mode: 'B2B' | 'B2C' | 'GST_DISABLED';
  success: boolean;
  irn?: string | null;
  ackNo?: string | null;
  ewbNo?: string | null;
  ewbValidTill?: string | null;
  errorCode?: string;
  errorMessage?: string;
  pendingActionId?: string;
};

export type PreflightResponse = {
  summary: { total: number; succeeded: number; failed: number };
  results: PreflightResult[];
  dispatched: boolean; // true only when every order succeeded
};

export class PreflightError extends Error {
  statusCode: number;
  code: string;
  constructor(message: string, code: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * WI-091 — pre-dispatch NIC e-invoice health probe, run BEFORE the per-order
 * loop. The WhiteBooks↔NIC sandbox session flickers alive/dead (1005 "Invalid
 * Token" windows that self-heal). Without this gate, every order in the batch
 * independently hits the dead session and surfaces a confusing per-order
 * SESSION_EXPIRED, leaving a half-dispatched trip.
 *   - alive → returns (the underlying GSTNDETAILS call also warms the einvoice
 *             token cache for the loop that follows)
 *   - dead  → throws PreflightError(NIC_SESSION_DOWN, 503): nothing is
 *             committed, the client gets ONE clear "retry shortly" message.
 * Delegates to whitebooksClient.pingEinvoiceSession — a single seam the
 * integration tests mock, so the probe runs in tests WITHOUT consuming the
 * ordered IRN/EWB apiCall mocks. Only meaningful for GST-enabled tenants;
 * callers gate on gstMode.
 */
async function probeNicEinvoiceSession(distributorId: string, gstin: string): Promise<void> {
  try {
    await pingEinvoiceSession(distributorId, gstin);
  } catch (err: unknown) {
    const { code, message } = errInfo(err);
    logger.warn('Pre-dispatch NIC health probe failed — aborting batch before any IRN/EWB call', {
      distributorId, code, msg: message,
    });
    throw new PreflightError(
      'NIC e-invoice session is temporarily unavailable (upstream). No orders were dispatched — please retry in a few minutes.',
      'NIC_SESSION_DOWN',
      503,
    );
  }
}

/**
 * Run preflight for every pending_dispatch order assigned to a driver
 * on a given date. Per-order partial dispatch — see module docstring.
 */
export async function preflightDispatch(params: {
  distributorId: string;
  driverId: string;
  assignmentDate: string; // YYYY-MM-DD
  userId: string;
}): Promise<PreflightResponse> {
  const { distributorId, driverId, assignmentDate, userId } = params;
  const targetDate = new Date(assignmentDate);

  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { id: true, gstMode: true, gstin: true, legalName: true, businessName: true, address: true, city: true, state: true, pincode: true, phone: true, email: true },
  });
  if (!distributor) throw new PreflightError('Distributor not found', 'NOT_FOUND', 404);

  const driver = await prisma.driver.findFirst({
    where: { id: driverId, distributorId, deletedAt: null },
    select: { id: true, driverName: true, status: true },
  });
  if (!driver) throw new PreflightError('Driver not found', 'NOT_FOUND', 404);
  if (driver.status !== 'active') {
    throw new PreflightError('Driver is not active', 'DRIVER_INACTIVE', 400);
  }

  // Confirmed vehicle mapping for the date — same rule the order-assign
  // guard enforces. Absent mapping means no vehicle = no EWB.
  const mapping = await prisma.driverVehicleAssignment.findFirst({
    where: {
      driverId, distributorId,
      assignmentDate: targetDate,
      status: { not: 'cancelled' },
    },
    orderBy: { tripNumber: 'desc' },  // WI-083: prefer highest tripNumber to avoid stale-row collisions
    select: { id: true, vehicleId: true, status: true, isReconciled: true, vehicle: { select: { vehicleNumber: true } } },
  });
  if (distributor.gstMode !== 'disabled' && !mapping?.vehicleId) {
    throw new PreflightError(
      `Driver has no confirmed vehicle mapping for ${assignmentDate}. Assign a vehicle in Fleet → Vehicle Mapping first.`,
      'NO_VEHICLE_MAPPING',
      400,
    );
  }
  // WI-065 (fix 2): fetch pending_dispatch orders BEFORE any DVA mutation.
  // The legacy order was (a) check loaded_and_dispatched → reset DVA, then
  // (b) query pending_dispatch. A stale or no-op Dispatch click on a fully
  // delivered DVA destroyed the previous trip's metadata (tripSheetNo, etc)
  // before discovering there were no orders to dispatch. Order the work so
  // that any non-trivial state change requires real orders to act on.
  const orders = await prisma.order.findMany({
    where: {
      distributorId,
      driverId,
      deliveryDate: targetDate,
      status: 'pending_dispatch',
      deletedAt: null,
    },
    include: orderInclude,
    orderBy: { createdAt: 'asc' },
  });

  if (orders.length === 0) {
    throw new PreflightError(
      'No orders in pending_dispatch for this driver/date',
      'NO_ORDERS',
      400,
    );
  }

  // WI-100 Gap B: decide whether this dispatch starts a NEW trip on an
  // already-used DVA (→ roll tripNumber + clear the prior trip's state). Two
  // trigger cases:
  //   (a) status === 'dispatch_ready' && isReconciled — the NORMAL post-reconcile
  //       path. confirmVehicleReconciliation now leaves the DVA dispatch_ready
  //       (WI-100 Gap A). A brand-new first-trip DVA is also dispatch_ready but
  //       has isReconciled === false, so it does NOT roll (keeps tripNumber 1).
  //   (b) status === 'loaded_and_dispatched' with 0 in-flight orders —
  //       defence-in-depth for a completed trip whose DVA never got reconciled
  //       (escaped/pre-WI-100 rows). If orders ARE in flight the caller wanted
  //       "Add to Trip", so refuse the second dispatch with a 409.
  let shouldRoll = false;
  if (mapping?.status === 'loaded_and_dispatched') {
    const inFlightCount = await prisma.order.count({
      where: {
        distributorId,
        driverId,
        deliveryDate: targetDate,
        status: { in: ['pending_delivery', 'preflight_in_progress'] },
        deletedAt: null,
      },
    });
    if (inFlightCount > 0) {
      throw new PreflightError(
        `Driver has an active trip with ${inFlightCount} order${inFlightCount === 1 ? '' : 's'} in flight. Use "Add to Trip" to dispatch the new orders on the same trip, or wait for delivery confirmation before starting a new trip.`,
        'ALREADY_DISPATCHED',
        409,
      );
    }
    shouldRoll = true; // completed trip, 0 in-flight
  } else if (mapping?.status === 'dispatch_ready' && mapping.isReconciled) {
    shouldRoll = true; // reconciled trip → start the next one
  }

  if (shouldRoll && mapping?.id) {
    // Roll to a fresh trip: bump tripNumber, reset to dispatch_ready, clear the
    // prior trip's consolidated-EWB + timeline stamps (the new trip writes its
    // own). order_status_logs keeps the per-order audit trail. WI-096b moved
    // this roll out of confirmDelivery (which fired too early at last delivery).
    await prisma.driverVehicleAssignment.update({
      where: { id: mapping.id },
      data: {
        tripNumber: { increment: 1 },
        status: 'dispatch_ready',
        tripSheetNo: null,
        tripSheetGeneratedAt: null,
        tripSheetNo2: null,
        tripSheetNo2GeneratedAt: null,
        dispatchedAt: null,
        returnedAt: null,
        reconciledAt: null,
        isReconciled: false,
      },
    });
    mapping.status = 'dispatch_ready';
  }

  // Re-fetch DVA to get the post-reset tripNumber so we stamp the right
  // value on each order. Cheap — single row.
  const dvaForStamp = mapping?.id ? await prisma.driverVehicleAssignment.findUnique({
    where: { id: mapping.id }, select: { tripNumber: true },
  }) : null;
  const currentTripNumber = dvaForStamp?.tripNumber ?? 1;

  // WI-059 pre-warm: do a single auth fetch BEFORE the per-order loop
  // so the token cache is hot before any IRN/EWB call runs. Without this,
  // sequential per-order iterations on a cold cache each fire their
  // own auth fetch (slower) and a transient TLS drop on the very first
  // attempt fails an entire order. The in-flight dedup map in
  // whitebooksClient covers the parallel case; this covers the
  // sequential-cold-cache case. Pre-warm errors are non-fatal — per-order
  // calls will surface them with their own forensic context.
  if (distributor.gstMode !== 'disabled') {
    const { getAuthToken } = await import('./whitebooksClient.js');
    try {
      await getAuthToken(distributorId, 'einvoice');
    } catch (warmErr) {
      logger.warn('einvoice auth pre-warm failed; per-order calls will retry', {
        distributorId, err: (warmErr as Error).message,
      });
    }
    try {
      await getAuthToken(distributorId, 'ewaybill');
    } catch (warmErr) {
      logger.warn('ewaybill auth pre-warm failed; per-order calls will retry', {
        distributorId, err: (warmErr as Error).message,
      });
    }
    // WI-091: fail fast on a dead NIC window — before any order is touched.
    await probeNicEinvoiceSession(distributorId, distributor.gstin!);
  }

  const results: PreflightResult[] = [];
  for (const order of orders) {
    const r = await preflightOne({
      order,
      distributor,
      vehicleNumber: mapping?.vehicle?.vehicleNumber ?? null,
      userId,
      tripNumber: currentTripNumber,
    });
    results.push(r);
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;

  // WI-129: with dispatch-debit ON, preflightOne writes a `dispatch` inventory
  // event per item but nothing recomputed the daily summary, so the "Dispatched"
  // column lagged until the next delivery triggered a recompute. Recompute now
  // for every cylinder type that was just dispatched (all orders in this batch
  // share targetDate). No-op when the flag is OFF (no dispatch events written).
  if (isDispatchDebitEnabled(distributorId)) {
    const succeededOrderIds = new Set(
      results.filter((r) => r.success).map((r) => r.orderId),
    );
    const cylinderTypeIds = new Set<string>();
    for (const order of orders) {
      if (!succeededOrderIds.has(order.id)) continue;
      for (const item of order.items) cylinderTypeIds.add(item.cylinderTypeId);
    }
    for (const ctId of cylinderTypeIds) {
      await recalculateSummariesFromDate(distributorId, ctId, targetDate);
    }
  }

  // WI-098: stamp dispatchedAt whenever ANY order in the batch dispatched —
  // the vehicle physically left the depot, so the timeline should reflect when
  // it went, even on a partial dispatch. (WI-094 previously gated this on full
  // success, leaving partial dispatches with a null dispatchedAt — BUG F.)
  if (mapping?.id && succeeded > 0) {
    await prisma.driverVehicleAssignment.update({
      where: { id: mapping.id },
      data: { dispatchedAt: new Date() },
    });
  }

  // Drive the driver-vehicle assignment forward only when every order
  // succeeded — partial dispatch leaves it dispatch_ready so a retry of
  // the failing orders can still flip it.
  if (mapping?.id && failed === 0 && succeeded > 0) {
    await prisma.driverVehicleAssignment.update({
      where: { id: mapping.id },
      data: { status: 'loaded_and_dispatched' }, // dispatchedAt already set above (WI-098)
    });

    if (mapping.vehicleId) {
      await prisma.vehicle.update({
        where: { id: mapping.vehicleId },
        data: { status: 'dispatched' },
      });
    }

    // Push an SSE signal so the driver's Trip tab refreshes the moment
    // dispatch completes — no more 30s polling wait for the EWB list to
    // surface and Vehicle Stock to populate.
    notifyDriver(driverId, {
      type: 'trip_updated',
      payload: { dvaId: mapping.id },
    });

    // WI-038: bundle the per-order EWBs into a single consolidated EWB
    // (trip sheet) so the driver carries one printable doc. Single-order
    // drivers skip this — their per-order EWB IS the trip sheet. gencewb
    // failure is non-blocking; we already let the goods leave the depot.
    const ewbNumbers = results
      .map((r) => r.ewbNo)
      .filter((n): n is string => !!n);
    if (ewbNumbers.length >= 2 && mapping.vehicle?.vehicleNumber) {
      try {
        const tripSheetNo = await generateConsolidatedEwb({
          distributorId,
          distributor,
          ewbNumbers,
          vehicleNumber: mapping.vehicle.vehicleNumber,
        });
        await prisma.driverVehicleAssignment.update({
          where: { id: mapping.id },
          data: { tripSheetNo, tripSheetGeneratedAt: new Date() },
        });
        logger.info('Consolidated EWB generated', { assignmentId: mapping.id, tripSheetNo, count: ewbNumbers.length });
      } catch (err: unknown) {
        const message = errInfo(err).message;
        logger.warn('Consolidated EWB (gencewb) failed — dispatch already complete, raising LOW pending action', {
          assignmentId: mapping.id, err: message,
        });
        await createPendingAction(
          distributorId, mapping.id,
          'CONSOLIDATED_EWB_FAILED',
          `gencewb failed for assignment ${mapping.id}: ${message || 'unknown'}`,
          'low',
        );
      }
    }
  }

  return {
    summary: { total: results.length, succeeded, failed },
    results,
    dispatched: failed === 0,
  };
}

/**
 * WI-065: Add to Trip — dispatch NEW orders onto an already-dispatched
 * DriverVehicleAssignment WITHOUT bumping tripNumber or clearing the
 * existing tripSheetNo. The trip identity carried by `DVA.tripNumber`
 * is preserved; each new order is stamped with the SAME tripNumber so
 * the trip sheet PDF picks them up alongside the original batch.
 *
 * Hard requirements (founder Q&A inside WI-065 investigation report):
 *   - DVA.status MUST be 'loaded_and_dispatched'. Anything else: 400
 *     "No active trip". A fresh trip uses preflightDispatch.
 *   - At least one pending_dispatch order must exist for the driver+date.
 *     0 orders → 400 NO_ORDERS, DVA untouched.
 *   - DVA.tripNumber, tripSheetNo, tripSheetGeneratedAt stay frozen.
 *   - If 2+ new orders generated EWBs, a SECOND gencewb call produces
 *     tripSheetNo2 (NIC has no "append to consolidated" — sealed at gen).
 *
 * Same response envelope as preflightDispatch so the UI can reuse the
 * Dispatch Progress modal verbatim.
 */
export async function preflightAddToTrip(params: {
  distributorId: string;
  driverId: string;
  assignmentDate: string;
  userId: string;
}): Promise<PreflightResponse> {
  const { distributorId, driverId, assignmentDate, userId } = params;
  const targetDate = new Date(assignmentDate);

  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { id: true, gstMode: true, gstin: true, legalName: true, businessName: true, address: true, city: true, state: true, pincode: true, phone: true, email: true },
  });
  if (!distributor) throw new PreflightError('Distributor not found', 'NOT_FOUND', 404);

  const driver = await prisma.driver.findFirst({
    where: { id: driverId, distributorId, deletedAt: null },
    select: { id: true, driverName: true, status: true },
  });
  if (!driver) throw new PreflightError('Driver not found', 'NOT_FOUND', 404);
  if (driver.status !== 'active') {
    throw new PreflightError('Driver is not active', 'DRIVER_INACTIVE', 400);
  }

  const mapping = await prisma.driverVehicleAssignment.findFirst({
    where: {
      driverId, distributorId,
      assignmentDate: targetDate,
      status: { not: 'cancelled' },
    },
    orderBy: { tripNumber: 'desc' },  // WI-083: prefer highest tripNumber to avoid stale-row collisions
    select: {
      id: true, vehicleId: true, status: true, tripNumber: true,
      vehicle: { select: { vehicleNumber: true } },
    },
  });
  if (!mapping) {
    throw new PreflightError(
      `No driver-vehicle assignment for ${assignmentDate}. Assign a vehicle in Fleet → Vehicle Mapping first.`,
      'NO_VEHICLE_MAPPING',
      400,
    );
  }
  if (mapping.status !== 'loaded_and_dispatched') {
    throw new PreflightError(
      'No active trip found. Use "Dispatch" to start a new trip.',
      'NO_ACTIVE_TRIP',
      400,
    );
  }
  if (distributor.gstMode !== 'disabled' && !mapping.vehicleId) {
    throw new PreflightError(
      `Driver has no confirmed vehicle mapping for ${assignmentDate}. Assign a vehicle in Fleet → Vehicle Mapping first.`,
      'NO_VEHICLE_MAPPING',
      400,
    );
  }

  // WI-068: server-side guard against the "stale trip" Add-to-Trip path.
  // DVA.status='loaded_and_dispatched' alone is no longer sufficient —
  // we must ALSO have at least one order genuinely in transit. Without
  // this, an admin who clicks "+ Add to Trip" after every previous
  // order has been delivered ends up grafting new orders onto a
  // logically-finished trip (the 3 orders on 2026-05-19 all stamped
  // with tripNumber=1 trace back to exactly this hole). Defence in
  // depth: confirmDelivery (WI-068 Fix A) is supposed to auto-reset
  // the DVA to dispatch_ready when the last order delivers, but if
  // that path is bypassed (e.g. some future non-transactional delivery
  // confirmation), this gate is the second line of defence.
  const inFlightCount = await prisma.order.count({
    where: {
      distributorId,
      driverId,
      deliveryDate: targetDate,
      status: { in: ['pending_delivery', 'preflight_in_progress'] },
      deletedAt: null,
    },
  });
  if (inFlightCount === 0) {
    throw new PreflightError(
      'No orders currently in transit. All previous orders have been delivered. Use Dispatch to start a new trip.',
      'NO_ACTIVE_TRIP',
      409,
    );
  }

  const orders = await prisma.order.findMany({
    where: {
      distributorId,
      driverId,
      deliveryDate: targetDate,
      status: 'pending_dispatch',
      deletedAt: null,
    },
    include: orderInclude,
    orderBy: { createdAt: 'asc' },
  });
  if (orders.length === 0) {
    throw new PreflightError(
      'No new orders to add. Assign orders to driver first.',
      'NO_ORDERS',
      400,
    );
  }

  // Pre-warm auth tokens (same rationale as preflightDispatch).
  if (distributor.gstMode !== 'disabled') {
    const { getAuthToken } = await import('./whitebooksClient.js');
    try { await getAuthToken(distributorId, 'einvoice'); } catch { /* per-call retry */ }
    try { await getAuthToken(distributorId, 'ewaybill'); } catch { /* per-call retry */ }
    // WI-091: fail fast on a dead NIC window — before any order is touched.
    await probeNicEinvoiceSession(distributorId, distributor.gstin!);
  }

  const results: PreflightResult[] = [];
  for (const order of orders) {
    const r = await preflightOne({
      order,
      distributor,
      vehicleNumber: mapping.vehicle?.vehicleNumber ?? null,
      userId,
      tripNumber: mapping.tripNumber, // preserve existing trip identity
    });
    results.push(r);
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;

  // Mirror of the WI-129 block in preflightDispatch — without this, dispatches
  // through the Add-to-Trip path write the `dispatch` inventory event but never
  // recompute the daily summary, so the "Dispatched" / "In-Flight" columns on
  // the Daily Summary lag until the next delivery confirmation triggers a
  // recompute. With this, the snapshot reflects the dispatch immediately on
  // both paths. No-op when the flag is OFF (no dispatch events written).
  if (isDispatchDebitEnabled(distributorId)) {
    const succeededOrderIds = new Set(
      results.filter((r) => r.success).map((r) => r.orderId),
    );
    const cylinderTypeIds = new Set<string>();
    for (const order of orders) {
      if (!succeededOrderIds.has(order.id)) continue;
      for (const item of order.items) cylinderTypeIds.add(item.cylinderTypeId);
    }
    for (const ctId of cylinderTypeIds) {
      await recalculateSummariesFromDate(distributorId, ctId, targetDate);
    }
  }

  // WI-090: keep the vehicle 'dispatched' when orders are added to an
  // already-running trip. preflightDispatch (new-trip path) sets this on
  // first dispatch, but if the vehicle status was reset in the meantime
  // (e.g. a return/reconciliation, or a stale state), adding orders to the
  // trip must re-assert 'dispatched' — otherwise the Fleet "Mark as
  // Returned" button (which only renders for vehicle.status='dispatched')
  // never appears for add-to-trip dispatches. The DVA is already
  // 'loaded_and_dispatched' here (precondition above), so we only touch
  // the vehicle. Mirrors the preflightDispatch block (~line 263).
  if (failed === 0 && succeeded > 0 && mapping.vehicleId) {
    await prisma.vehicle.update({
      where: { id: mapping.vehicleId },
      data: { status: 'dispatched' },
    });
  }

  // Generate a SECOND consolidated EWB if at least 2 new orders got
  // EWBs. NIC's gencewb has no append semantics — the existing
  // tripSheetNo stays valid for the original batch; tripSheetNo2 covers
  // the add-to-trip batch. Driver carries both.
  if (failed === 0 && succeeded > 0 && mapping.vehicle?.vehicleNumber) {
    const newEwbNumbers = results
      .map((r) => r.ewbNo)
      .filter((n): n is string => !!n);
    if (newEwbNumbers.length >= 2) {
      try {
        const tripSheetNo2 = await generateConsolidatedEwb({
          distributorId,
          distributor,
          ewbNumbers: newEwbNumbers,
          vehicleNumber: mapping.vehicle.vehicleNumber,
        });
        await prisma.driverVehicleAssignment.update({
          where: { id: mapping.id },
          data: { tripSheetNo2, tripSheetNo2GeneratedAt: new Date() },
        });
        logger.info('Add-to-Trip consolidated EWB generated', { assignmentId: mapping.id, tripSheetNo2, count: newEwbNumbers.length });
      } catch (err: unknown) {
        const message = errInfo(err).message;
        logger.warn('Add-to-Trip consolidated EWB (gencewb) failed — orders already dispatched', {
          assignmentId: mapping.id, err: message,
        });
        await createPendingAction(
          distributorId, mapping.id,
          'CONSOLIDATED_EWB_FAILED',
          `Add-to-Trip gencewb failed for assignment ${mapping.id}: ${message || 'unknown'}`,
          'low',
        );
      }
    }
  }

  return {
    summary: { total: results.length, succeeded, failed },
    results,
    dispatched: failed === 0,
  };
}

/**
 * WI-038: call WhiteBooks gencewb to bundle a driver's per-order EWBs
 * into a single consolidated EWB. Returns the consolidated EWB number
 * (NIC docs call it tripSheetNo). The response shape is loose — data
 * may be a raw number, a string, or an object with `cEwbNo` /
 * `tripSheetNo` depending on the sandbox build.
 */
async function generateConsolidatedEwb(args: {
  distributorId: string;
  distributor: DistributorGstFields;
  ewbNumbers: string[];
  vehicleNumber: string;
}): Promise<string> {
  const { distributorId, distributor, ewbNumbers, vehicleNumber } = args;
  const credEmail =
    (await getCredentials(distributorId, 'ewaybill'))!.email;

  const fromState = parseInt((distributor.gstin || '').substring(0, 2), 10) || 0;
  const payload = {
    fromPlace: distributor.city || '',
    fromState,
    transMode: '1',
    tripSheetEwbBills: ewbNumbers.map((n) => ({ ewbNo: Number(n) })),
    vehicleNo: vehicleNumber,
    transDocNo: '',
    transDocDate: '',
  };

  const resp = await callWithLog<ConsolidatedEwbResponse>(
    distributorId, 'POST',
    `/ewaybillapi/v1.03/ewayapi/gencewb?email=${encodeURIComponent(credEmail)}`,
    payload, 'ewaybill',
    { apiType: 'CEWB_GENERATE' },
  );

  // gencewb response shapes seen in the wild:
  //   { data: '<tripSheetNo>' }       — raw string
  //   { data: { cEwbNo: '...' } }     — object with cEwbNo
  //   { data: { tripSheetNo: '...' }} — object with tripSheetNo
  const raw = resp?.data;
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
  if (raw && typeof raw === 'object') {
    return String(raw.cEwbNo ?? raw.tripSheetNo ?? raw.consolidatedEwbNo ?? '');
  }
  throw new Error('Consolidated EWB response did not include a trip sheet number');
}

/**
 * Preflight a single order. Acquires the preflight_in_progress lock via
 * a conditional UPDATE — only one process can claim a given order.
 */
async function preflightOne(params: {
  order: PreflightOrder;
  distributor: DistributorGstFields;
  vehicleNumber: string | null;
  userId: string;
  tripNumber: number; // WI-065: stamped on the order at pending_delivery transition
}): Promise<PreflightResult> {
  const { order, distributor, vehicleNumber, userId, tripNumber } = params;
  const orderId: string = order.id;
  const customerName: string | null = order.customer?.customerName ?? null;

  // 1. Acquire the lock — atomic conditional update. Race-safe.
  const claimed = await prisma.order.updateMany({
    where: { id: orderId, status: 'pending_dispatch' },
    data: { status: 'preflight_in_progress' },
  });
  if (claimed.count !== 1) {
    return {
      orderId,
      orderNumber: order.orderNumber,
      customerName,
      mode: 'B2B',
      success: false,
      errorCode: 'ALREADY_IN_PREFLIGHT',
      errorMessage: 'Order is not in pending_dispatch or another preflight is already running',
    };
  }

  try {
    const isB2C = !order.customer?.gstin || order.customer.gstin === 'URP';

    // GST-disabled tenants: just transition to pending_delivery.
    if (distributor.gstMode === 'disabled') {
      await transitionToPendingDelivery(orderId, userId, 'GST disabled — preflight skipped', tripNumber, buildDispatchCtx(order, vehicleNumber));
      return {
        orderId,
        orderNumber: order.orderNumber,
        customerName,
        mode: 'GST_DISABLED',
        success: true,
      };
    }

    // Compliance-eligible. We need a vehicle.
    if (!vehicleNumber) {
      await revertToPendingDispatch(orderId);
      return {
        orderId,
        orderNumber: order.orderNumber,
        customerName,
        mode: isB2C ? 'B2C' : 'B2B',
        success: false,
        errorCode: 'NO_VEHICLE_MAPPING',
        errorMessage: 'No vehicle assigned for delivery date',
      };
    }

    // Ensure a draft invoice exists. createInvoiceFromOrder needs the
    // order to be in 'delivered'/'modified_delivered' currently — we
    // generate the invoice using ordered quantities at preflight time,
    // so we temporarily set delivered=ordered for each item, run the
    // builder, then revert. Cleaner: factor out a draft-invoice variant.
    // For now reuse the existing helper but bypass its state check by
    // calling our own preflight invoice creator (see below).
    const invoice = await ensureDraftInvoice(orderId, distributor.id, userId);

    // B2B: IRN + EWB (inline preferred).
    if (!isB2C) {
      return await runB2bPreflight({
        order, invoice, distributor, vehicleNumber, userId, customerName, tripNumber,
      });
    }
    // B2C / URP: EWB only (standalone) — always, regardless of invoice value.
    return await runB2cPreflight({
      order, invoice, distributor, vehicleNumber, userId, customerName, tripNumber,
    });
  } catch (err: unknown) {
    const { code, message } = errInfo(err);
    logger.error('Preflight unexpected error', { orderId, error: message });
    await revertToPendingDispatch(orderId);
    const pa = await createPendingAction(
      distributor.id, orderId, 'DISPATCH_PREFLIGHT', message || 'Unknown error',
    );
    return {
      orderId,
      orderNumber: order.orderNumber,
      customerName,
      mode: 'B2B',
      success: false,
      errorCode: code || 'UNKNOWN',
      errorMessage: message,
      pendingActionId: pa?.id,
    };
  }
}

/**
 * Promote an order from preflight_in_progress → pending_delivery and write
 * the matching OrderStatusLog row in a single transaction.
 *
 * WI-065: the optional `tripNumber` arg lets preflightDispatch and
 * preflightAddToTrip stamp the per-order trip identifier here, atomic
 * with the status change. NULL trip numbers stay possible for any future
 * caller that wants the legacy behaviour (e.g. a one-off recovery).
 */
// WI-106: assemble the dispatch-debit context from an order (with items).
// Passed to transitionToPendingDelivery; only consumed when the flag is on.
function buildDispatchCtx(order: PreflightOrder, vehicleNumber: string | null) {
  return {
    distributorId: order.distributorId,
    deliveryDate: order.deliveryDate,
    vehicleNumber,
    items: (order.items ?? []).map((i) => ({
      cylinderTypeId: i.cylinderTypeId,
      quantity: i.quantity,
    })),
  };
}

async function transitionToPendingDelivery(
  orderId: string,
  userId: string,
  notes: string,
  tripNumber?: number,
  // WI-106: when present AND the flag is on, a `dispatch` inventory event
  // (−qty fulls) is written per item inside the same transaction.
  dispatchCtx?: {
    distributorId: string;
    deliveryDate: Date;
    vehicleNumber: string | null;
    items: { cylinderTypeId: string; quantity: number }[];
  },
) {
  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: {
        status: 'pending_delivery',
        ...(typeof tripNumber === 'number' ? { tripNumber } : {}),
      },
    });
    await tx.orderStatusLog.create({
      data: {
        orderId,
        oldStatus: 'preflight_in_progress',
        newStatus: 'pending_delivery',
        changedBy: userId,
        notes,
      },
    });

    // WI-106 — debit depot fulls at dispatch (cylinders leaving onto the
    // vehicle). Flag-gated: when off OR no dispatchCtx, this block is skipped
    // and the transaction is byte-for-byte identical to pre-WI-106.
    if (dispatchCtx && isDispatchDebitEnabled(dispatchCtx.distributorId)) {
      for (const item of dispatchCtx.items) {
        await createInventoryEvent(tx, {
          distributorId: dispatchCtx.distributorId,
          cylinderTypeId: item.cylinderTypeId,
          eventType: 'dispatch',
          fullsChange: -item.quantity,
          emptiesChange: 0,
          eventDate: dispatchCtx.deliveryDate,
          referenceId: orderId,
          referenceType: 'order',
          vehicleNumber: dispatchCtx.vehicleNumber ?? undefined,
          createdBy: userId,
          notes: 'Dispatched to vehicle',
        });
      }
    }
  });
}

async function revertToPendingDispatch(orderId: string) {
  await prisma.order.update({
    where: { id: orderId },
    data: { status: 'pending_dispatch' },
  });
}

/**
 * Ensure a draft invoice exists for an order in preflight, using ordered
 * quantities. If the order has no items with prices, throws.
 * Side-effect: invoice is created with status='issued', linked to order.
 */
async function ensureDraftInvoice(
  orderId: string,
  distributorId: string,
  userId: string,
): Promise<{ id: string; invoiceNumber: string }> {
  const existing = await prisma.invoice.findFirst({
    where: { orderId, distributorId, deletedAt: null },
    select: { id: true, invoiceNumber: true },
  });
  if (existing) return existing;

  // createInvoiceFromOrder expects the order to be in delivered state.
  // Bypass that by setting delivered=ordered on every item temporarily
  // — the invoice will use those numbers, which are exactly the ordered
  // quantities. We restore deliveredQuantity to null after invoice
  // creation so the actual confirm-delivery flow remains accurate.
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirstOrThrow({
      where: { id: orderId, distributorId },
      include: { items: true },
    });
    const previousStatus = order.status;
    await tx.order.update({
      where: { id: orderId },
      // Cast through a known transitional state so createInvoiceFromOrder's
      // own status guard passes. We flip back below.
      data: { status: 'delivered' },
    });
    for (const item of order.items) {
      await tx.orderItem.update({
        where: { id: item.id },
        data: { deliveredQuantity: item.quantity },
      });
    }
    await createInvoiceFromOrder(tx, orderId, distributorId, userId);
    await tx.order.update({
      where: { id: orderId },
      data: { status: previousStatus },
    });
    for (const item of order.items) {
      await tx.orderItem.update({
        where: { id: item.id },
        data: { deliveredQuantity: null },
      });
    }
  });

  const created = await prisma.invoice.findFirstOrThrow({
    where: { orderId, distributorId, deletedAt: null },
    select: { id: true, invoiceNumber: true },
  });
  return created;
}

/** Build the InvoiceData payload feeding buildIrnPayload. */
async function buildInvoiceData(
  invoiceId: string,
  distributor: DistributorGstFields,
  transport:
    | {
        vehicleNumber: string;
        transportMode: '1';
        distance: 0;
        // NIC requires both fields populated on inline EWB (see WI-035
        // amendment in payloadBuilders.ts) — fail-out 5002 otherwise.
        transDocNo: string;
        transDocDt: string;
      }
    | undefined,
): Promise<InvoiceData> {
  const inv = await prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId },
    include: { items: { include: { cylinderType: true } }, customer: true, order: { include: { vehicle: true } } },
  });
  const sellerStateCode = (distributor.gstin || '').substring(0, 2);
  const buyerStateCode = inv.customer?.gstin ? inv.customer.gstin.substring(0, 2) : sellerStateCode;
  const data = {
    docType: 'INV' as const,
    docNumber: inv.invoiceNumber,
    docDate: inv.issueDate,
    seller: {
      gstin: distributor.gstin!,
      legalName: distributor.legalName,
      tradeName: distributor.businessName,
      address: distributor.address || '',
      city: distributor.city || '',
      pincode: distributor.pincode || '',
      state: distributor.state || '',
      stateCode: sellerStateCode,
      phone: distributor.phone || undefined,
      email: distributor.email || undefined,
    },
    buyer: {
      gstin: inv.customer?.gstin || null,
      legalName: inv.customer?.businessName || inv.customer?.customerName || 'Consumer',
      tradeName: inv.customer?.customerName || undefined,
      address: inv.customer?.billingAddressLine1 || '',
      city: inv.customer?.billingCity || '',
      pincode: inv.customer?.billingPincode || '',
      state: inv.customer?.billingState || '',
      stateCode: buyerStateCode,
      phone: inv.customer?.phone || undefined,
      email: inv.customer?.email || undefined,
    },
    items: inv.items.map((item, idx) => ({
      slNo: idx + 1,
      description: item.description || item.cylinderType?.typeName || 'LPG Cylinder',
      hsnCode: item.hsnCode || '27111900',
      quantity: item.quantity,
      unit: 'NOS',
      // CLAUDE.md anti-pattern #16: InvoiceItem.unitPrice is GST-inclusive, before discount.
      unitPrice: toNum(item.unitPrice),
      discountPerUnit: toNum(item.discountPerUnit),
      gstRate: item.gstRate || 18,
    })),
    isInterState: sellerStateCode !== buyerStateCode,
    transport,
  };
  return data;
}

/**
 * Run the B2B path: IRN + EWB inline. If NIC doesn't return inline EWB,
 * recover via getIrnDetails (handles 604 / portal-pre-existing cases).
 */
async function runB2bPreflight(params: {
  order: PreflightOrder;
  invoice: { id: string; invoiceNumber: string };
  distributor: DistributorGstFields;
  vehicleNumber: string;
  userId: string;
  customerName: string | null;
  tripNumber: number;
}): Promise<PreflightResult> {
  const { order, invoice, distributor, vehicleNumber, userId, customerName, tripNumber } = params;
  const distributorId: string = distributor.id;
  const invoiceId = invoice.id;
  const orderId: string = order.id;

  // IRN is called WITHOUT inline EwbDtls. NIC's /einvoice GENERATE
  // endpoint accepts inline EWB in theory (Postman example shows it),
  // but in practice both PascalCase (VehNo/TransDocNo) and the
  // canonical mixed-case (Vehno/Transdocno) variants are rejected with
  // generic 5002 against the WhiteBooks sandbox. The two-step pattern
  // — IRN-only then explicit /ewaybillapi/genewaybill — is the path
  // used by gstService.processInvoiceGst and has 5 historical
  // successes today, so we mirror it here. One extra API call per
  // order; correctness wins over the "1-call" optimization promised
  // in WI-035.
  const invoiceData = await buildInvoiceData(invoiceId, distributor, undefined);

  const credEmail =
    (await getCredentials(distributorId, 'einvoice'))!.email;

  // CRITICAL — see comment in gstService.processInvoiceGst on the same flag.
  // Two invoices (INV-MP6FSGSNM1N, INV-MP6JW3EH46T) ended up with a real NIC
  // IRN but irn_status='failed' because an error in the EWB sub-step
  // propagated into the outer catch and overwrote irnStatus. The local flag
  // makes that overwrite conditional on "did we actually commit the IRN?".
  let irnPersisted = false;
  try {
    const irnPayload = buildIrnPayload(invoiceData);
    const irnResponse = await callWithLog<IrnResponse>(
      distributorId, 'POST',
      `/einvoice/type/GENERATE/version/V1_03?email=${encodeURIComponent(credEmail)}`,
      irnPayload, 'einvoice',
      { apiType: 'IRN_GENERATE', invoiceId, orderId },
    );

    const irn = irnResponse.data?.Irn ?? irnResponse.Irn;
    const ackNo = irnResponse.data?.AckNo ?? irnResponse.AckNo;
    const ackDt = irnResponse.data?.AckDt ?? irnResponse.AckDt;
    const signedQr = irnResponse.data?.SignedQRCode ?? irnResponse.SignedQRCode;
    const irnEwbNo = irnResponse.data?.EwbNo ?? irnResponse.EwbNo;
    const irnEwbDt = irnResponse.data?.EwbDt ?? irnResponse.EwbDt;
    const irnEwbValidTill = irnResponse.data?.EwbValidTill ?? irnResponse.EwbValidTill;
    const hasIrnEwb = !!irnEwbNo && irnEwbNo !== 0 && irnEwbNo !== '0';

    // Persist IRN + (inline EWB if present). NIC dates come back in Indian
    // DD/MM/YYYY hh:mm:ss AM/PM format — JS Date() can't parse that, so we
    // route every date through parseWhitebooksDate.
    const ackDate = parseWhitebooksDate(ackDt);
    const ewbDate = parseWhitebooksDate(irnEwbDt);
    const ewbValidTillDate = parseWhitebooksDate(irnEwbValidTill);

    await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        irn,
        ackNo: ackNo?.toString(),
        ackDate,
        irnStatus: 'success',
        ...(hasIrnEwb ? { ewbStatus: 'active' } : {}),
      },
    });
    // Past this line, any throw must NOT cause the outer catch to set
    // irnStatus back to 'failed' — the IRN is real and on the NIC portal.
    irnPersisted = true;

    await upsertLatestGstDocument({
      invoiceId, orderId, distributorId,
      gstDocNo: invoice.invoiceNumber,
      data: {
        irnStatus: 'success', irn,
        ackNo: ackNo?.toString(),
        ackDate,
        signedQr,
        ...(hasIrnEwb ? {
          ewbStatus: 'active',
          ewbNo: irnEwbNo?.toString(),
          ewbDate,
          ewbValidTill: ewbValidTillDate,
        } : {}),
        requestPayload: toJson(irnPayload),
        responsePayload: toJson(irnResponse),
      },
    });

    let ewbNo: string | null = hasIrnEwb ? String(irnEwbNo) : null;
    let ewbValidTill: string | null = irnEwbValidTill ? String(irnEwbValidTill) : null;
    let ewbDateOut: Date | null = ewbDate;
    let ewbValidTillOut: Date | null = ewbValidTillDate;

    if (!hasIrnEwb) {
      // IRN succeeded but no inline EWB came back (expected after the
      // 2026-05-15 fix that strips the inline EwbDtls block). Generate
      // the EWB via the standalone endpoint — the proven path from
      // gstService.processInvoiceGst.
      try {
        const ewbCredEmail =
          (await getCredentials(distributorId, 'ewaybill'))?.email ||
          credEmail;
        const ewbPayload = buildEwbPayload(irnPayload, {
          vehicleNumber,
          transportMode: '1',
          distance: 1, // standalone EWB rejects distance:0 (error 721)
        });
        const ewbResponse = await callWithLog<EwbResponse>(
          distributorId, 'POST',
          `/ewaybillapi/v1.03/ewayapi/genewaybill?email=${encodeURIComponent(ewbCredEmail)}`,
          ewbPayload, 'ewaybill',
          { apiType: 'EWB_GENERATE_BY_IRN', invoiceId, orderId },
        );
        const parsed = parseEwbResponse(ewbResponse);
        if (parsed.ewbNo) {
          ewbNo = parsed.ewbNo;
          ewbValidTill = parsed.validToDate?.toISOString() ?? null;
          ewbDateOut = parsed.validFromDate;
          ewbValidTillOut = parsed.validToDate;
          await prisma.invoice.update({
            where: { id: invoiceId },
            data: { ewbStatus: 'active' },
          });
          await upsertLatestGstDocument({
            invoiceId, orderId, distributorId,
            gstDocNo: invoice.invoiceNumber,
            data: {
              ewbStatus: 'active',
              ewbNo: parsed.ewbNo,
              ewbDate: parsed.validFromDate,
              ewbValidTill: parsed.validToDate,
            },
          });
        } else {
          // WI-131: NIC returned status_cd=1 but NO ewayBillNo. Previously this
          // was a silent logger.warn — the order looked dispatched with no EWB
          // and no follow-up. Treat it as a failure (same as a thrown EWB error
          // below): mark the EWB failed + raise a HIGH pending action for retry.
          logger.error('EWB response had status_cd success but no ewayBillNo after IRN success', { orderId, invoiceId });
          await prisma.invoice.update({
            where: { id: invoiceId },
            data: { ewbStatus: 'failed' },
          });
          await createPendingAction(
            distributorId, invoiceId, 'EWB_GENERATION',
            `Order ${order.orderNumber}: NIC returned success but no EWB number. Manual retry required.`,
            'high',
          );
        }
      } catch (ewbErr: unknown) {
        // IRN already succeeded — don't fail the dispatch on a missed
        // EWB. Raise a HIGH pending action; admin can retry the EWB
        // via the existing /generate-gst flow on the invoice.
        const ewbErrMessage = errInfo(ewbErr).message;
        logger.error('EWB generation failed after IRN success', { orderId, invoiceId, error: ewbErrMessage });
        await prisma.invoice.update({
          where: { id: invoiceId },
          data: { ewbStatus: 'failed' },
        });
        await createPendingAction(
          distributorId, invoiceId, 'EWB_GENERATION',
          `Order ${order.orderNumber}: IRN succeeded but EWB failed — ${ewbErrMessage}`,
          'high',
        );
      }
    }
    // Suppress unused-var lint — kept for future audit hooks.
    void ewbDateOut; void ewbValidTillOut;

    await transitionToPendingDelivery(
      orderId, userId,
      `Preflight succeeded: IRN=${irn?.substring(0, 16)}… EWB=${ewbNo ?? 'n/a'}`,
      tripNumber,
      buildDispatchCtx(order, vehicleNumber),
    );

    return {
      orderId, orderNumber: order.orderNumber, customerName,
      mode: 'B2B', success: true,
      irn, ackNo: ackNo?.toString() ?? null,
      ewbNo, ewbValidTill,
    };
  } catch (err: unknown) {
    const { code: rawCode, message: errMessage } = errInfo(err);
    // Handle duplicate IRN (2150): IRN already on NIC portal — still try
    // to surface the existing one via GETIRNBYDOCDETAILS (out of scope
    // for v1; for now treat as recoverable failure and let admin retry).
    const code = String(rawCode || '').replace(/[^0-9]/g, '');
    if (code === '2150') {
      // Mark as success since portal already accepts this doc — but we
      // can't fill irn locally without the lookup call. Best-effort: mark
      // the IRN status without value.
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { irnStatus: 'success' },
      });
      await transitionToPendingDelivery(
        orderId, userId, 'Preflight: duplicate IRN (2150) — accepted',
        tripNumber,
        buildDispatchCtx(order, vehicleNumber),
      );
      return {
        orderId, orderNumber: order.orderNumber, customerName,
        mode: 'B2B', success: true,
        errorCode: '2150',
        errorMessage: 'Duplicate IRN — already on portal',
      };
    }
    logger.error('Preflight B2B failed', { orderId, invoiceId, error: errMessage, irnPersisted });
    if (!irnPersisted) {
      // IRN never made it to NIC (or never landed in our DB) — safe to
      // mark failed and bounce the order back to pending_dispatch.
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { irnStatus: 'failed' },
      });
      await revertToPendingDispatch(orderId);
    } else {
      // IRN succeeded; the error came from a downstream step (gst_documents
      // write, EWB, status transition). Do NOT corrupt irnStatus. Leave the
      // order at its current state — admin can retry EWB via /generate-gst.
      logger.error('Preflight error after IRN persisted — leaving irnStatus=success', {
        orderId, invoiceId, error: errMessage,
      });
    }
    const pa = await createPendingAction(
      distributorId, invoiceId, 'IRN_GENERATION',
      `Order ${order.orderNumber}: ${errMessage}`,
    );
    return {
      orderId, orderNumber: order.orderNumber, customerName,
      mode: 'B2B', success: false,
      errorCode: rawCode || code || 'UNKNOWN',
      errorMessage: errMessage,
      pendingActionId: pa?.id,
    };
  }
}

/** B2C / URP — standalone EWB endpoint (always, no invoice-value gate). */
async function runB2cPreflight(params: {
  order: PreflightOrder;
  invoice: { id: string; invoiceNumber: string };
  distributor: DistributorGstFields;
  vehicleNumber: string;
  userId: string;
  customerName: string | null;
  tripNumber: number;
}): Promise<PreflightResult> {
  const { order, invoice, distributor, vehicleNumber, userId, customerName, tripNumber } = params;
  const distributorId: string = distributor.id;
  const invoiceId = invoice.id;
  const orderId: string = order.id;

  const invoiceData = await buildInvoiceData(invoiceId, distributor, undefined);
  const credEmail =
    (await getCredentials(distributorId, 'ewaybill'))!.email;

  try {
    const irnPayload = buildIrnPayload(invoiceData);
    // For B2C we don't generate an IRN; we just borrow the IRN-shaped
    // values to construct the EWB payload via buildEwbPayload. Import
    // locally to avoid a top-level cycle with gstService.
    const { buildEwbPayload } = await import('./payloadBuilders.js');
    const ewbPayload = buildEwbPayload(irnPayload, {
      vehicleNumber, transportMode: '1', distance: 1,
    });

    // WI-074 debug: log full payload BEFORE the WhiteBooks call so the
    // actual wire shape is visible in the dev console. gst_api_logs
    // also persists this row; the dev-console log is for immediate
    // visibility during the WI-074 live verification.
    logger.info('[WI-074-DEBUG] B2C preflight EWB request payload', {
      invoiceId, orderId,
      payload: JSON.stringify(ewbPayload, null, 2),
    });

    const ewbResponse = await callWithLog<EwbResponse>(
      distributorId, 'POST',
      `/ewaybillapi/v1.03/ewayapi/genewaybill?email=${encodeURIComponent(credEmail)}`,
      ewbPayload, 'ewaybill',
      { apiType: 'EWB_GENERATE_STANDALONE', invoiceId, orderId },
    );

    // WI-074 debug: log full NIC response (including any info[] array
    // NIC sometimes includes) BEFORE parseEwbResponse normalises it.
    logger.info('[WI-074-DEBUG] B2C preflight EWB response', {
      invoiceId, orderId,
      response: JSON.stringify(ewbResponse, null, 2),
    });

    const parsed = parseEwbResponse(ewbResponse);
    // WI-091 phantom-active guard (dispatch path). NIC sandbox sometimes
    // returns status_cd=1 with NO ewayBillNo (bare "Sucess"). Mark such a
    // number-less success as FAILED + raise a pending action — but DO NOT
    // block the dispatch: the cylinder is on the vehicle, so the order still
    // moves to pending_delivery and the trip proceeds. The post-delivery
    // path (gstService.processInvoiceGst) already has this guard; this brings
    // the preflight/dispatch path in line. Live bug: Bangalore Foods
    // INV-MPFK6QBLCD5 (2026-05-21) — green EWB badge, ewb_no=NULL.
    const ewbOk = !!parsed.ewbNo;

    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { ewbStatus: ewbOk ? 'active' : 'failed' },
    });
    await upsertLatestGstDocument({
      invoiceId, orderId, distributorId,
      gstDocNo: invoice.invoiceNumber,
      data: {
        ewbStatus: ewbOk ? 'active' : 'failed',
        ewbNo: parsed.ewbNo,
        ewbDate: parsed.validFromDate,
        ewbValidTill: parsed.validToDate,
        requestPayload: toJson(ewbPayload),
        responsePayload: toJson(ewbResponse),
      },
    });

    if (!ewbOk) {
      logger.warn('B2C EWB: NIC returned status_cd=1 with no ewayBillNo — marked failed (phantom-active guard); dispatch continues', {
        orderId, invoiceId, statusDesc: ewbResponse?.status_desc,
      });
      await createPendingAction(
        distributorId, invoiceId, 'EWB_GENERATION',
        `Order ${order.orderNumber}: NIC returned success but no e-Way Bill number. Cylinder dispatched; retry EWB generation from Billing once NIC is healthy.`,
        'high',
      );
    }

    // Dispatch is NOT blocked by a missing EWB — the order moves to
    // pending_delivery regardless (vehicle loaded, driver must deliver).
    await transitionToPendingDelivery(
      orderId, userId,
      ewbOk ? `B2C preflight succeeded: EWB=${parsed.ewbNo}` : 'B2C dispatched; EWB pending (no number returned by NIC)',
      tripNumber,
      buildDispatchCtx(order, vehicleNumber),
    );

    return {
      orderId, orderNumber: order.orderNumber, customerName,
      mode: 'B2C', success: true,
      ewbNo: parsed.ewbNo, ewbValidTill: parsed.validToDate?.toISOString() ?? null,
    };
  } catch (err: unknown) {
    const { message } = errInfo(err);
    // Fix 4 (2026-05-30): commit forward, do NOT revert. Aligns the B2C
    // EWB-throw branch with (a) the B2B EWB-after-IRN catch above which
    // already commits forward, and (b) the B2C no-ewayBillNo branch
    // immediately above which also commits forward. Pre-fix behavior
    // (revert to pending_dispatch + return success:false) was the lone
    // outlier — it broke the trip-level advance every time a single B2C
    // order's EWB call threw (NIC error 225 on the live 2026-05-29 demo
    // session was the proximate failure). The cylinder still leaves the
    // depot, the operator gets a HIGH pending action to retry the EWB,
    // and the trip can now advance once that retry succeeds (Fix 3's
    // tryAdvanceTripAfterRetry).
    logger.error('Preflight B2C EWB failed — dispatch continues (vehicle loaded)', {
      orderId, invoiceId, error: message,
    });
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { ewbStatus: 'failed' },
    });
    const pa = await createPendingAction(
      distributorId, invoiceId, 'EWB_GENERATION',
      `Order ${order.orderNumber}: ${message}`,
    );
    await transitionToPendingDelivery(
      orderId, userId,
      `B2C dispatched; EWB pending — ${message.slice(0, 80)}`,
      tripNumber,
      buildDispatchCtx(order, vehicleNumber),
    );
    return {
      orderId, orderNumber: order.orderNumber, customerName,
      mode: 'B2C', success: true,
      errorMessage: message,
      pendingActionId: pa?.id,
    };
  }
}

/**
 * Find-or-update the `is_latest` gst_documents row for an invoice; create
 * if none exists. Used by both B2B and B2C preflight branches so a retry
 * after partial failure updates the existing row instead of duplicating.
 */
async function upsertLatestGstDocument(args: {
  invoiceId: string;
  orderId: string;
  distributorId: string;
  gstDocNo: string;
  data: GstDocumentWriteData;
}) {
  const existing = await prisma.gstDocument.findFirst({
    where: { invoiceId: args.invoiceId, isLatest: true, deletedAt: null },
    select: { id: true },
  });
  if (existing) {
    await prisma.gstDocument.update({
      where: { id: existing.id },
      data: args.data,
    });
    return;
  }
  await prisma.gstDocument.create({
    data: {
      invoiceId: args.invoiceId,
      orderId: args.orderId,
      distributorId: args.distributorId,
      docType: 'INV',
      gstDocNo: args.gstDocNo,
      isLatest: true,
      ...args.data,
    },
  });
}

/**
 * Trip auto-advance after a per-invoice GST retry succeeds.
 *
 * Background (live IRN+EWB E2E session, 2026-05-29): preflightDispatch advances
 * `DVA.status → loaded_and_dispatched` only when every order in the batch
 * succeeded (`failed === 0`, see the gate inside preflightDispatch). When the
 * admin later fixes the cause and retries via `POST /api/invoices/:id/generate-
 * gst`, processInvoiceGst updates the invoice but never re-evaluates the trip.
 * Result: the trip permanently shows "Ready" on the driver app even after all
 * EWBs are live. This helper closes that gap.
 *
 * Behaviour:
 *   - No-op if the invoice's EWB isn't active (caller checks too, but the
 *     internal guard makes the helper safely callable from anywhere).
 *   - Handles the B2C revert edge case from Fix 4: if the order is still at
 *     `pending_dispatch` (was reverted by the pre-Fix-4 B2C catch branch on a
 *     prior failed preflight), transition it forward before advancing the trip.
 *   - Counts "blockers" — any other order on the same (driver, date, trip)
 *     coordinate still at pending_dispatch/preflight_in_progress, or with a
 *     failed invoice IRN/EWB status. Only advances when blockers == 0.
 *
 * Non-blocking by design: the caller invokes this with a `.catch` so a helper
 * error never fails the user-visible retry API call.
 */
export async function tryAdvanceTripAfterRetry(
  invoiceId: string,
  distributorId: string,
  userId: string,
): Promise<{ advanced: boolean; dvaId?: string }> {
  // Step 1: invoice → order
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, distributorId },
    select: { orderId: true, ewbStatus: true },
  });
  if (!invoice?.orderId || invoice.ewbStatus !== 'active') {
    return { advanced: false };
  }

  // Step 2: order → driver + date + status
  const order = await prisma.order.findUnique({
    where: { id: invoice.orderId },
    select: {
      driverId: true,
      deliveryDate: true,
      distributorId: true,
      tripNumber: true,
      status: true,
    },
  });
  if (!order?.driverId) {
    return { advanced: false };
  }

  // Step 3: handle the B2C revert edge case. If the order is still at
  // pending_dispatch (i.e. was reverted by the pre-Fix-4 B2C catch branch on a
  // prior failed preflight), transition it forward to pending_delivery first —
  // otherwise the blockers count below would see this order itself as a
  // blocker and we'd never advance.
  if (order.status === 'pending_dispatch') {
    await transitionToPendingDelivery(
      invoice.orderId,
      userId,
      'EWB retry succeeded — advancing order to pending_delivery',
      order.tripNumber ?? undefined,
      undefined,
    );
  }

  // Step 4: find the dispatch-ready DVA for this driver+date. Iterate from the
  // highest tripNumber so a partial-recovery on an old trip doesn't pick up the
  // wrong DVA. If the DVA is already loaded_and_dispatched (someone else got
  // there first) we do nothing — the trip is already advanced.
  const dva = await prisma.driverVehicleAssignment.findFirst({
    where: {
      driverId: order.driverId,
      distributorId,
      assignmentDate: order.deliveryDate,
      status: 'dispatch_ready',
    },
    orderBy: { tripNumber: 'desc' },
    select: { id: true, vehicleId: true, tripNumber: true },
  });
  if (!dva) {
    return { advanced: false };
  }

  // Step 5: count remaining blockers on this trip. A "blocker" is any other
  // order on the same coordinate that would also need to be fixed before the
  // trip can legitimately advance.
  const blockers = await prisma.order.count({
    where: {
      driverId: order.driverId,
      distributorId,
      deliveryDate: order.deliveryDate,
      tripNumber: dva.tripNumber,
      deletedAt: null,
      OR: [
        { status: { in: ['pending_dispatch', 'preflight_in_progress'] } },
        { invoice: { ewbStatus: { in: ['failed', 'pending'] } } },
        { invoice: { irnStatus: 'failed' } },
      ],
    },
  });
  if (blockers > 0) {
    return { advanced: false };
  }

  // Step 6: all clear — advance DVA + vehicle, fire the SSE notify. Mirrors the
  // happy-path block inside preflightDispatch but skips the consolidated EWB
  // (gencewb) regeneration — that's a best-effort post-dispatch artefact, and
  // re-issuing it on a partial-recovery path can race the driver's existing
  // trip sheet. Deferring to the next full preflight is safer.
  await prisma.driverVehicleAssignment.update({
    where: { id: dva.id },
    data: {
      status: 'loaded_and_dispatched',
      dispatchedAt: new Date(),
    },
  });
  if (dva.vehicleId) {
    await prisma.vehicle.update({
      where: { id: dva.vehicleId },
      data: { status: 'dispatched' },
    });
  }
  notifyDriver(order.driverId, {
    type: 'trip_updated',
    payload: { dvaId: dva.id },
  });
  return { advanced: true, dvaId: dva.id };
}

