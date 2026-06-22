/**
 * FLOAT-001 — available-fulls formula unit tests on the service.
 *
 * Pins getAvailableFullsForDriver invariants used both by
 * POST /drivers/me/orders (hard cap on walk-in quantity) and by
 * GET /drivers/me/trip-stock (per-type availableFulls badge on mobile).
 *
 * Formula (post Bug #4 fix, 2026-06-18):
 *
 *   availableFulls(type) = manifest.floatQty
 *                        − Σ OrderItem.quantity
 *                          where orderSource='walk_in'
 *                                AND status in {pending_dispatch,
 *                                  preflight_in_progress, pending_delivery,
 *                                  delivered, modified_delivered}
 *
 * Decoupled from tripNumber: one DVA = one truck = one float pool for the
 * day. Regular orders (pre-booked, pending_delivery, delivered) do NOT
 * subtract — they were never part of the float pool (orderedQty was
 * snapshot at manifest confirm and totalLoaded = orderedQty + floatQty).
 *
 * Returns 0 cleanly when: no active DVA, no manifest, DVA reconciled,
 * floatQty <= 0. Clamped at 0 (never negative).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  createOrUpdateManifest,
  getAvailableFullsForDriver,
} from '../../services/dvaManifestService.js';
import { prisma } from '../../lib/prisma.js';
import { ensureDriverVehicleMapping, getOrCreateTestVehicle } from '../helpers.js';
import { startOfUtcDay } from '../../utils/dateOnly.js';

const todayMidnight = startOfUtcDay();
const TEST_DATE = `${todayMidnight.getUTCFullYear()}-${String(todayMidnight.getUTCMonth() + 1).padStart(2, '0')}-${String(todayMidnight.getUTCDate()).padStart(2, '0')}`;
const DIST = 'dist-001';
const TEST_VEHICLE = 'TEST-AVAIL-FULLS-D1';

describe('FLOAT-001 — getAvailableFullsForDriver', () => {
  let driverId: string;
  let vehicleId: string;
  let dvaId: string;
  let cylinderTypeId: string;
  let adminUserId: string;
  let customerId: string;

  beforeEach(() => {
    process.env.INVENTORY_DISPATCH_DEBIT = 'true';
  });

  beforeAll(async () => {
    const driver = await prisma.driver.findFirstOrThrow({
      where: { distributorId: DIST, deletedAt: null, status: 'active' },
      select: { id: true },
    });
    driverId = driver.id;
    const vehicle = await getOrCreateTestVehicle(DIST, TEST_VEHICLE);
    vehicleId = vehicle.id;
    const dva = await ensureDriverVehicleMapping({
      distributorId: DIST, driverId, vehicleId, date: TEST_DATE,
    });
    dvaId = dva.id;
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: DIST, isActive: true }, select: { id: true },
    });
    cylinderTypeId = ct.id;
    const admin = await prisma.user.findFirstOrThrow({
      where: { distributorId: DIST, role: 'distributor_admin' }, select: { id: true },
    });
    adminUserId = admin.id;
    const customer = await prisma.customer.findFirstOrThrow({
      where: { distributorId: DIST, deletedAt: null, customerType: 'B2C' }, select: { id: true },
    });
    customerId = customer.id;
  });

  afterEach(async () => {
    await prisma.driverAssignment.deleteMany({
      where: { order: { distributorId: DIST, deliveryDate: todayMidnight } },
    });
    await prisma.inventoryEvent.deleteMany({
      where: { distributorId: DIST, eventDate: todayMidnight },
    });
    await prisma.inventorySummary.deleteMany({
      where: { distributorId: DIST, summaryDate: todayMidnight },
    });
    await prisma.dVALoadManifest.deleteMany({ where: { dvaId } });
    await prisma.orderItem.deleteMany({
      where: { order: { distributorId: DIST, deliveryDate: todayMidnight } },
    });
    await prisma.order.deleteMany({
      where: { distributorId: DIST, deliveryDate: todayMidnight },
    });
    await prisma.driverVehicleAssignment.update({
      where: { id: dvaId },
      data: {
        status: 'dispatch_ready', tripNumber: 1,
        isReconciled: false, dispatchedAt: null, returnedAt: null, reconciledAt: null,
      },
    });
  });

  it('returns 0 when no manifest exists for the cylinder type', async () => {
    const avail = await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId);
    expect(avail).toBe(0);
  });

  it('returns totalLoaded when no orders consume it', async () => {
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 10 }], adminUserId,
    );
    const avail = await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId);
    expect(avail).toBe(10);
  });

  it('subtracts pending walk-in quantities (IN_FLIGHT) from float', async () => {
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 10 }], adminUserId,
    );
    // No pre-existing pending_dispatch orders at manifest confirm → floatQty=10.
    await prisma.order.create({
      data: {
        orderNumber: `TEST-AF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST,
        customerId,
        driverId,
        vehicleId,
        orderDate: todayMidnight, deliveryDate: todayMidnight,
        status: 'pending_delivery',
        orderSource: 'walk_in',
        tripNumber: 1,
        totalAmount: 1500,
        items: { create: [{ cylinderTypeId, quantity: 3, unitPrice: 500, totalPrice: 1500 }] },
      },
    });
    const avail = await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId);
    expect(avail).toBe(7);
  });

  it('subtracts delivered walk-in quantities (TERMINAL) from float', async () => {
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 10 }], adminUserId,
    );
    await prisma.order.create({
      data: {
        orderNumber: `TEST-AF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST,
        customerId,
        driverId,
        vehicleId,
        orderDate: todayMidnight, deliveryDate: todayMidnight,
        status: 'delivered',
        orderSource: 'walk_in',
        tripNumber: 1,
        totalAmount: 1000,
        items: {
          create: [
            { cylinderTypeId, quantity: 2, deliveredQuantity: 2, unitPrice: 500, totalPrice: 1000 },
          ],
        },
      },
    });
    const avail = await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId);
    expect(avail).toBe(8);
  });

  it('handles mixed pending + delivered walk-ins correctly', async () => {
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 10 }], adminUserId,
    );
    await prisma.order.create({
      data: {
        orderNumber: `TEST-AF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST, customerId, driverId, vehicleId,
        orderDate: todayMidnight, deliveryDate: todayMidnight,
        status: 'pending_delivery', orderSource: 'walk_in', tripNumber: 1, totalAmount: 1000,
        items: { create: [{ cylinderTypeId, quantity: 2, unitPrice: 500, totalPrice: 1000 }] },
      },
    });
    await prisma.order.create({
      data: {
        orderNumber: `TEST-AF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST, customerId, driverId, vehicleId,
        orderDate: todayMidnight, deliveryDate: todayMidnight,
        status: 'delivered', orderSource: 'walk_in', tripNumber: 1, totalAmount: 500,
        items: {
          create: [{ cylinderTypeId, quantity: 1, deliveredQuantity: 1, unitPrice: 500, totalPrice: 500 }],
        },
      },
    });
    // floatQty 10 − walk-in (2 pending + 1 delivered) = 7
    expect(await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId)).toBe(7);
  });

  it('never returns negative — clamped at 0', async () => {
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 2 }], adminUserId,
    );
    // floatQty = 2. Walk-in took 5 (impossible in real flow because the
    // route enforces the cap, but pins the Math.max(0, ...) clamp).
    await prisma.order.create({
      data: {
        orderNumber: `TEST-AF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST, customerId, driverId, vehicleId,
        orderDate: todayMidnight, deliveryDate: todayMidnight,
        status: 'delivered', orderSource: 'walk_in', tripNumber: 1, totalAmount: 2500,
        items: {
          create: [{ cylinderTypeId, quantity: 5, deliveredQuantity: 5, unitPrice: 500, totalPrice: 2500 }],
        },
      },
    });
    expect(await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId)).toBe(0);
  });

  it('returns 0 when DVA is reconciled (trip closed)', async () => {
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 10 }], adminUserId,
    );
    await prisma.driverVehicleAssignment.update({
      where: { id: dvaId },
      data: { status: 'dispatch_ready', isReconciled: true, reconciledAt: new Date() },
    });
    expect(await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId)).toBe(0);
  });

  it('excludeOrderId drops that walk-in order from the sum', async () => {
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 10 }], adminUserId,
    );
    const order = await prisma.order.create({
      data: {
        orderNumber: `TEST-AF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST, customerId, driverId, vehicleId,
        orderDate: todayMidnight, deliveryDate: todayMidnight,
        status: 'pending_delivery', orderSource: 'walk_in', tripNumber: 1, totalAmount: 1500,
        items: { create: [{ cylinderTypeId, quantity: 3, unitPrice: 500, totalPrice: 1500 }] },
      },
    });
    const withOrder = await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId);
    expect(withOrder).toBe(7);
    const withoutOrder = await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId, order.id);
    expect(withoutOrder).toBe(10);
  });

  // ── Bug #4 regression tests (2026-06-18) ─────────────────────────────────

  it('BUG #4 CASE 1 (rewritten under Bug #7+#11) — DVA at trip 2 with manifest at trip 2 returns trip-2 float', async () => {
    // Bug #4 originally tested the artificial state "DVA at trip 2 but
    // manifest stayed at trip 1". After Bug #7 (tripNumber bumps at
    // reconciliation) and Bug #11 (current-trip manifest filter), that
    // state cannot occur in production — reconcile bumps the DVA AND
    // settles the prior trip's manifest; the admin then enters a fresh
    // manifest for the new trip. This rewrite pins the post-Bug-#7
    // invariant: DVA + manifest move together.
    await prisma.driverVehicleAssignment.update({
      where: { id: dvaId },
      data: { tripNumber: 2, status: 'dispatch_ready' },
    });
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 10 }], adminUserId,
    );
    await prisma.driverVehicleAssignment.update({
      where: { id: dvaId },
      data: { status: 'loaded_and_dispatched', dispatchedAt: new Date() },
    });
    const avail = await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId);
    expect(avail).toBe(10); // current trip's floatQty, no consumers
  });

  it('BUG #4 CASE 2 (rewritten under Bug #7+#11) — walk-in on the CURRENT trip subtracts from float', async () => {
    // Pre-Bug-#7 this tested "walk-in at trip 1 still counts after DVA
    // rolls to trip 2 with no new manifest" — impossible scenario now.
    // New contract: walk-ins on the current trip subtract from that
    // trip's float. Settled prior trips' walk-ins are irrelevant
    // (already accounted for at that trip's reconcile).
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 10 }], adminUserId,
    );
    await prisma.driverVehicleAssignment.update({
      where: { id: dvaId },
      data: { status: 'loaded_and_dispatched', dispatchedAt: new Date() },
    });
    // Walk-in taken on the current trip (DVA still at trip 1)
    await prisma.order.create({
      data: {
        orderNumber: `TEST-AF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST, customerId, driverId, vehicleId,
        orderDate: todayMidnight, deliveryDate: todayMidnight,
        status: 'pending_delivery', orderSource: 'walk_in', tripNumber: 1, totalAmount: 1500,
        items: { create: [{ cylinderTypeId, quantity: 3, unitPrice: 500, totalPrice: 1500 }] },
      },
    });
    const avail = await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId);
    expect(avail).toBe(7); // floatQty 10 − walk-in 3 on current trip = 7
  });

  it('BUG #4 CASE 3 (rewritten under Bug #10) — pre-booked regulars (WITH dispatch event) do NOT subtract; mid-trip regulars (NO dispatch event) DO', async () => {
    // BUG #10 (2026-06-19) redefined the rule: "from float" is identified
    // by absence of a per-order dispatch event, NOT by orderSource. The
    // previous version of this test asserted "regular orders never
    // subtract" — that's false now. The new contract:
    //   - Pre-booked regulars (preflightDispatch wrote a dispatch event)
    //     → NOT from float → don't subtract
    //   - Mid-trip regulars via Add to Trip (no dispatch event per Bug #6)
    //     → from float → DO subtract
    // Setup: manifest floatQty=8. Plant 3 pre-booked regulars (with
    // dispatch events) + 2 mid-trip regulars (without). Expect
    // avail = 8 − 2 (only the no-dispatch ones).
    // Create 5 pending_dispatch regulars BEFORE manifest. They'll snapshot
    // into orderedQty=5; manifest totalLoaded=13 → floatQty=8.
    const preBookedIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const o = await prisma.order.create({
        data: {
          orderNumber: `TEST-PB-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
          distributorId: DIST, customerId, driverId, vehicleId,
          orderDate: todayMidnight, deliveryDate: todayMidnight,
          status: 'pending_dispatch', orderSource: 'regular', tripNumber: 1, totalAmount: 500,
          items: { create: [{ cylinderTypeId, quantity: 1, unitPrice: 500, totalPrice: 500 }] },
        },
      });
      preBookedIds.push(o.id);
    }
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 13 }], adminUserId,
    );
    // Promote pre-booked to pending_delivery + WRITE dispatch events for
    // each (simulates what preflightDispatch would do).
    await prisma.order.updateMany({
      where: { id: { in: preBookedIds } },
      data: { status: 'pending_delivery' },
    });
    for (const id of preBookedIds) {
      await prisma.inventoryEvent.create({
        data: {
          distributorId: DIST,
          cylinderTypeId,
          eventType: 'dispatch',
          fullsChange: -1, emptiesChange: 0,
          eventDate: todayMidnight,
          referenceId: id,
          referenceType: 'order',
          createdBy: adminUserId,
        },
      });
    }

    // Now add 2 mid-trip regulars in pending_delivery WITHOUT dispatch
    // events (simulates preflightAddToTrip's Bug #6 skip).
    for (let i = 0; i < 2; i++) {
      await prisma.order.create({
        data: {
          orderNumber: `TEST-MT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
          distributorId: DIST, customerId, driverId, vehicleId,
          orderDate: todayMidnight, deliveryDate: todayMidnight,
          status: 'pending_delivery', orderSource: 'regular', tripNumber: 1, totalAmount: 500,
          items: { create: [{ cylinderTypeId, quantity: 1, unitPrice: 500, totalPrice: 500 }] },
        },
      });
    }

    const avail = await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId);
    // floatQty 8 − 2 (mid-trip from-float) = 6. Pre-booked 5 are excluded
    // because they have dispatch events (depot was already debited for them).
    expect(avail).toBe(6);
  });

  // ── Bug #12 regression (2026-06-22) ──────────────────────────────────────
  // dist-demo live evidence: trip 1 walk-in of 10 cyl delivered + reconciled
  // OK. Trip 2 manifest loaded 11 (10 float). Trip 2 walk-in attempt for any
  // qty returned available=0 because the tripOrders query inside
  // getAvailableFullsForDriver lacked a `tripNumber` filter — trip 1's
  // walk-in order (status='delivered', deliveryDate=today) was counted
  // against trip 2's float pool, collapsing availability to 0.
  //
  // The 60cc3ed fix added tripNumber scope to the MANIFEST lookup in this
  // same function but missed the adjacent ORDERS lookup. Companion-query
  // miss, same class as anti-patterns #9 / #16 / #17 in CLAUDE.md.
  it('BUG #12 — trip-2 walk-in availability ignores prior-trip walk-ins (companion miss to 60cc3ed)', async () => {
    // ── TRIP 1 ────────────────────────────────────────────────────────────
    // Manifest: totalLoaded=10, no pre-existing orders so floatQty=10.
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 10 }], adminUserId,
    );
    await prisma.driverVehicleAssignment.update({
      where: { id: dvaId },
      data: { status: 'loaded_and_dispatched', dispatchedAt: new Date() },
    });

    // Trip 1 walk-in: 4 cyl, delivered (consumed 4 from trip-1 float pool).
    await prisma.order.create({
      data: {
        orderNumber: `TEST-T1WI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST, customerId, driverId, vehicleId,
        orderDate: todayMidnight, deliveryDate: todayMidnight,
        status: 'delivered', orderSource: 'walk_in', tripNumber: 1, totalAmount: 2000,
        items: {
          create: [{ cylinderTypeId, quantity: 4, deliveredQuantity: 4, unitPrice: 500, totalPrice: 2000 }],
        },
      },
    });

    // Sanity: mid-trip-1 available = 10 − 4 = 6.
    expect(await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId)).toBe(6);

    // ── RECONCILE TRIP 1 + ROLL TO TRIP 2 ───────────────────────────────────
    // Simulate confirmVehicleReconciliation: DVA gets tripNumber=2 and
    // returns to dispatch_ready so a new manifest can be entered. The
    // trip-1 manifest row stays in DB (it's not deleted; cancellation_return
    // event in production handles the depot-credit side, but that's outside
    // the unit boundary of getAvailableFullsForDriver).
    await prisma.driverVehicleAssignment.update({
      where: { id: dvaId },
      data: {
        tripNumber: 2,
        status: 'dispatch_ready',
        isReconciled: false,    // ready for next dispatch, not closed
        dispatchedAt: null,
        returnedAt: null,
        reconciledAt: null,
      },
    });

    // ── TRIP 2 ────────────────────────────────────────────────────────────
    // Fresh manifest for trip 2: totalLoaded=11, floatQty=11 (no pre-booked
    // orders for trip 2 yet either, so orderedQty=0).
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 11 }], adminUserId,
    );
    await prisma.driverVehicleAssignment.update({
      where: { id: dvaId },
      data: { status: 'loaded_and_dispatched', dispatchedAt: new Date() },
    });

    // ── CORE ASSERTION ──────────────────────────────────────────────────────
    // PRE-FIX: 11 (trip-2 floatQty) − 4 (trip-1 walk-in counted!) = 7
    //          → real-world fail: driver couldn't even attempt 5-cyl walk-in
    //            on dist-demo when trip-2 had 10 float and trip-1 walk-in
    //            was 10.
    // POST-FIX: 11 − 0 (trip-1 walk-in is on tripNumber=1, scoped out) = 11
    const availMidTrip2 = await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId);
    expect(availMidTrip2).toBe(11);

    // ── ADD A TRIP-2 WALK-IN, VERIFY IT NOW DOES SUBTRACT ──────────────────
    await prisma.order.create({
      data: {
        orderNumber: `TEST-T2WI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST, customerId, driverId, vehicleId,
        orderDate: todayMidnight, deliveryDate: todayMidnight,
        status: 'pending_delivery', orderSource: 'walk_in', tripNumber: 2, totalAmount: 2500,
        items: { create: [{ cylinderTypeId, quantity: 5, unitPrice: 500, totalPrice: 2500 }] },
      },
    });

    // Trip 2 float (11) minus trip-2 walk-in (5) = 6. Trip-1 walk-in still
    // ignored.
    const availAfterT2Walkin = await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId);
    expect(availAfterT2Walkin).toBe(6);
  });
});
