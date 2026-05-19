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

import { prisma } from '../../lib/prisma.js';
import { logger } from '../../utils/logger.js';
import { toNum } from '../../utils/decimal.js';
import { getCredentials } from './whitebooksClient.js';
import { callWithLog } from './apiLogger.js';
import { buildIrnPayload, buildEwbPayload } from './payloadBuilders.js';
import {
  parseEwbResponse,
  parseWhitebooksDate,
  createPendingAction,
} from './gstService.js';
import { createInvoiceFromOrder } from '../invoiceService.js';

const orderInclude = {
  customer: true,
  items: { include: { cylinderType: true } },
  vehicle: true,
  driver: { select: { id: true, driverName: true } },
} as const;

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
    select: { id: true, vehicleId: true, status: true, vehicle: { select: { vehicleNumber: true } } },
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

  if (mapping?.status === 'loaded_and_dispatched') {
    // The assignment row says "vehicle on the road". That's the right
    // block when orders are genuinely in flight — refuse the second
    // dispatch. But the old behaviour also blocked the legitimate case
    // where all the morning's orders have already been delivered: the
    // driver returned, new orders piled up for trip 2, but the
    // assignment status was never advanced (no auto-transition from
    // loaded_and_dispatched → returned_inventory after deliveries
    // complete). Gate on actual in-flight orders instead.
    //
    // WI-065 note: when this gate fires, the caller likely wanted Add to
    // Trip — they have a live trip AND new orders ready. Surface that as
    // an actionable error rather than a flat refusal.
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
    // WI-070 legacy recovery: a DVA shouldn't normally reach this
    // branch any more — confirmDelivery (orderService.ts, WI-068/070)
    // now auto-resets the DVA to dispatch_ready AND bumps tripNumber
    // when the last in-flight order is delivered. This block fires
    // only for DVAs that escaped that path: pre-WI-068 historical
    // rows, a future non-transactional confirmDelivery variant, a
    // crash that committed orders but skipped the auto-reset, etc.
    //
    // Bump tripNumber for the audit trail, reset the row to
    // dispatch_ready so the standard flow can write a fresh
    // consolidated EWB for the new batch. The prior tripSheetNo
    // is intentionally cleared — the driver already downloaded that
    // PDF; the new trip needs its own gencewb result.
    //
    // No double-increment risk: confirmDelivery's auto-reset is the
    // ONLY non-failure path out of loaded_and_dispatched, and it
    // leaves the DVA in dispatch_ready (not loaded_and_dispatched),
    // so this branch is genuinely mutually exclusive with the WI-070
    // increment in orderService.
    await prisma.driverVehicleAssignment.update({
      where: { id: mapping.id },
      data: {
        tripNumber: { increment: 1 },
        status: 'dispatch_ready',
        tripSheetNo: null,
        tripSheetGeneratedAt: null,
        tripSheetNo2: null,
        tripSheetNo2GeneratedAt: null,
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

  // Drive the driver-vehicle assignment forward only when every order
  // succeeded — partial dispatch leaves it dispatch_ready so a retry of
  // the failing orders can still flip it.
  if (mapping?.id && failed === 0 && succeeded > 0) {
    await prisma.driverVehicleAssignment.update({
      where: { id: mapping.id },
      data: { status: 'loaded_and_dispatched' },
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
      } catch (err: any) {
        logger.warn('Consolidated EWB (gencewb) failed — dispatch already complete, raising LOW pending action', {
          assignmentId: mapping.id, err: err.message,
        });
        await createPendingAction(
          distributorId, mapping.id,
          'CONSOLIDATED_EWB_FAILED',
          `gencewb failed for assignment ${mapping.id}: ${err.message ?? 'unknown'}`,
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
      } catch (err: any) {
        logger.warn('Add-to-Trip consolidated EWB (gencewb) failed — orders already dispatched', {
          assignmentId: mapping.id, err: err.message,
        });
        await createPendingAction(
          distributorId, mapping.id,
          'CONSOLIDATED_EWB_FAILED',
          `Add-to-Trip gencewb failed for assignment ${mapping.id}: ${err.message ?? 'unknown'}`,
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
  distributor: any;
  ewbNumbers: string[];
  vehicleNumber: string;
}): Promise<string> {
  const { distributorId, distributor, ewbNumbers, vehicleNumber } = args;
  const credEmail =
    (await getCredentials(distributorId, 'ewaybill'))?.email ||
    (await getCredentials(distributorId, 'einvoice'))?.email ||
    distributor.email ||
    'info@mygaslink.com';

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

  const resp: any = await callWithLog<any>(
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
  order: any;
  distributor: any;
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
      await transitionToPendingDelivery(orderId, userId, 'GST disabled — preflight skipped', tripNumber);
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
  } catch (err: any) {
    logger.error('Preflight unexpected error', { orderId, error: err.message });
    await revertToPendingDispatch(orderId);
    const pa = await createPendingAction(
      distributor.id, orderId, 'DISPATCH_PREFLIGHT', err.message ?? 'Unknown error',
    );
    return {
      orderId,
      orderNumber: order.orderNumber,
      customerName,
      mode: 'B2B',
      success: false,
      errorCode: err.code || 'UNKNOWN',
      errorMessage: err.message,
      pendingActionId: (pa as any)?.id,
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
async function transitionToPendingDelivery(
  orderId: string,
  userId: string,
  notes: string,
  tripNumber?: number,
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
    await createInvoiceFromOrder(tx as any, orderId, distributorId, userId);
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
  distributor: any,
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
): Promise<any> {
  const inv = await prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId },
    include: { items: { include: { cylinderType: true } }, customer: true, order: { include: { vehicle: true } } },
  });
  const sellerStateCode = (distributor.gstin || '').substring(0, 2);
  const buyerStateCode = inv.customer?.gstin ? inv.customer.gstin.substring(0, 2) : sellerStateCode;
  return {
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
    items: inv.items.map((item: any, idx: number) => ({
      slNo: idx + 1,
      description: item.description || item.cylinderType?.typeName || 'LPG Cylinder',
      hsnCode: item.hsnCode || '27111900',
      quantity: item.quantity,
      unit: 'NOS',
      unitPrice: toNum(item.unitPrice) + toNum(item.discountPerUnit),
      discountPerUnit: toNum(item.discountPerUnit),
      gstRate: item.gstRate || 18,
    })),
    isInterState: sellerStateCode !== buyerStateCode,
    transport,
  };
}

/**
 * Run the B2B path: IRN + EWB inline. If NIC doesn't return inline EWB,
 * recover via getIrnDetails (handles 604 / portal-pre-existing cases).
 */
async function runB2bPreflight(params: {
  order: any;
  invoice: { id: string; invoiceNumber: string };
  distributor: any;
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
    (await getCredentials(distributorId, 'einvoice'))?.email ||
    distributor.email ||
    'info@mygaslink.com';

  // CRITICAL — see comment in gstService.processInvoiceGst on the same flag.
  // Two invoices (INV-MP6FSGSNM1N, INV-MP6JW3EH46T) ended up with a real NIC
  // IRN but irn_status='failed' because an error in the EWB sub-step
  // propagated into the outer catch and overwrote irnStatus. The local flag
  // makes that overwrite conditional on "did we actually commit the IRN?".
  let irnPersisted = false;
  try {
    const irnPayload = buildIrnPayload(invoiceData);
    const irnResponse: any = await callWithLog<any>(
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
        requestPayload: irnPayload,
        responsePayload: irnResponse,
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
        const ewbResponse: any = await callWithLog<any>(
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
          logger.warn('EWB response missing ewayBillNo after IRN success', { invoiceId });
        }
      } catch (ewbErr: any) {
        // IRN already succeeded — don't fail the dispatch on a missed
        // EWB. Raise a HIGH pending action; admin can retry the EWB
        // via the existing /generate-gst flow on the invoice.
        logger.error('EWB generation failed after IRN success', { orderId, invoiceId, error: ewbErr.message });
        await prisma.invoice.update({
          where: { id: invoiceId },
          data: { ewbStatus: 'failed' },
        });
        await createPendingAction(
          distributorId, invoiceId, 'EWB_GENERATION',
          `Order ${order.orderNumber}: IRN succeeded but EWB failed — ${ewbErr.message}`,
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
    );

    return {
      orderId, orderNumber: order.orderNumber, customerName,
      mode: 'B2B', success: true,
      irn, ackNo: ackNo?.toString() ?? null,
      ewbNo, ewbValidTill,
    };
  } catch (err: any) {
    // Handle duplicate IRN (2150): IRN already on NIC portal — still try
    // to surface the existing one via GETIRNBYDOCDETAILS (out of scope
    // for v1; for now treat as recoverable failure and let admin retry).
    const code = String(err.code || '').replace(/[^0-9]/g, '');
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
      );
      return {
        orderId, orderNumber: order.orderNumber, customerName,
        mode: 'B2B', success: true,
        errorCode: '2150',
        errorMessage: 'Duplicate IRN — already on portal',
      };
    }
    logger.error('Preflight B2B failed', { orderId, invoiceId, error: err.message, irnPersisted });
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
        orderId, invoiceId, error: err.message,
      });
    }
    const pa = await createPendingAction(
      distributorId, invoiceId, 'IRN_GENERATION',
      `Order ${order.orderNumber}: ${err.message}`,
    );
    return {
      orderId, orderNumber: order.orderNumber, customerName,
      mode: 'B2B', success: false,
      errorCode: err.code || code || 'UNKNOWN',
      errorMessage: err.message,
      pendingActionId: (pa as any)?.id,
    };
  }
}

/** B2C / URP — standalone EWB endpoint (always, no invoice-value gate). */
async function runB2cPreflight(params: {
  order: any;
  invoice: { id: string; invoiceNumber: string };
  distributor: any;
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
    (await getCredentials(distributorId, 'ewaybill'))?.email ||
    (await getCredentials(distributorId, 'einvoice'))?.email ||
    distributor.email ||
    'info@mygaslink.com';

  try {
    const irnPayload = buildIrnPayload(invoiceData);
    // For B2C we don't generate an IRN; we just borrow the IRN-shaped
    // values to construct the EWB payload via buildEwbPayload. Import
    // locally to avoid a top-level cycle with gstService.
    const { buildEwbPayload } = await import('./payloadBuilders.js');
    const ewbPayload = buildEwbPayload(irnPayload, {
      vehicleNumber, transportMode: '1', distance: 1,
    });

    const ewbResponse: any = await callWithLog<any>(
      distributorId, 'POST',
      `/ewaybillapi/v1.03/ewayapi/genewaybill?email=${encodeURIComponent(credEmail)}`,
      ewbPayload, 'ewaybill',
      { apiType: 'EWB_GENERATE_STANDALONE', invoiceId, orderId },
    );

    const parsed = parseEwbResponse(ewbResponse);

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
        requestPayload: ewbPayload,
        responsePayload: ewbResponse,
      },
    });

    await transitionToPendingDelivery(
      orderId, userId,
      `B2C preflight succeeded: EWB=${parsed.ewbNo}`,
      tripNumber,
    );

    return {
      orderId, orderNumber: order.orderNumber, customerName,
      mode: 'B2C', success: true,
      ewbNo: parsed.ewbNo, ewbValidTill: parsed.validToDate?.toISOString() ?? null,
    };
  } catch (err: any) {
    logger.error('Preflight B2C failed', { orderId, invoiceId, error: err.message });
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { ewbStatus: 'failed' },
    });
    await revertToPendingDispatch(orderId);
    const pa = await createPendingAction(
      distributorId, invoiceId, 'EWB_GENERATION',
      `Order ${order.orderNumber}: ${err.message}`,
    );
    return {
      orderId, orderNumber: order.orderNumber, customerName,
      mode: 'B2C', success: false,
      errorCode: err.code || 'UNKNOWN',
      errorMessage: err.message,
      pendingActionId: (pa as any)?.id,
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
  data: Record<string, any>;
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

