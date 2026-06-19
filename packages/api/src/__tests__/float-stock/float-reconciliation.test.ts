/**
 * FLOAT-001 — float-unsold reconciliation credit step (Phase 5).
 *
 * Pins the Step 2.5 wiring in confirmVehicleReconciliation:
 *   - Walk-in orders identified by Order.orderSource='walk_in' (NOT createdAt
 *     heuristic — Issue 3 in pre-flight).
 *   - For each manifest row with floatQty > 0:
 *       soldFromFloat = min(Σ walkIn.deliveredQuantity, floatQty)
 *       unsoldFloat   = floatQty - soldFromFloat
 *     When unsoldFloat > 0: write `cancellation_return` InventoryEvent with
 *     referenceType='dva_load_manifest', eventDate=DVA.assignmentDate.
 *   - Recompute affected cylinder types from assignmentDate (closes
 *     dispatched − returned on the same daily summary row).
 *   - Skip the whole step when INVENTORY_DISPATCH_DEBIT is OFF (no dispatch
 *     event was written → no credit needed; symmetric).
 *
 * Setup uses Bhargava (dist-001, gstMode='disabled') so we sidestep WhiteBooks
 * mocks. Orders are created in pending_dispatch then driven through preflight
 * which (under flag ON) writes the float dispatch event AND transitions orders
 * to pending_delivery. Tests then patch orders → delivered directly to avoid
 * pulling in the full confirmDelivery flow (which also writes delivery
 * events keyed on order — not what we're testing here).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { preflightDispatch } from '../../services/gst/gstPreflightService.js';
import {
  markVehicleReturned,
  confirmVehicleReconciliation,
} from '../../services/deliveryWorkflowService.js';
import { createOrUpdateManifest } from '../../services/dvaManifestService.js';
import { recalculateSummariesFromDate } from '../../services/inventoryService.js';
import { prisma } from '../../lib/prisma.js';
import { ensureDriverVehicleMapping, getOrCreateTestVehicle } from '../helpers.js';
import { startOfUtcDay } from '../../utils/dateOnly.js';

// markVehicleReturned + confirmVehicleReconciliation look up the DVA via
// `assignmentDate: startOfUtcDay()` — hard-coded to TODAY's UTC date.
// helpers.today() uses LOCAL date which can disagree with UTC in IST during
// the late-night/early-morning window. Derive TEST_DATE from startOfUtcDay()
// so every layer (preflight assignmentDate, DVA assignmentDate, deliveryDate,
// eventDate, summaryDate) lives on the SAME UTC calendar day.
const todayMidnight = startOfUtcDay();
const TEST_DATE = `${todayMidnight.getUTCFullYear()}-${String(todayMidnight.getUTCMonth() + 1).padStart(2, '0')}-${String(todayMidnight.getUTCDate()).padStart(2, '0')}`;
const priorMidnight = new Date(todayMidnight);
priorMidnight.setUTCDate(priorMidnight.getUTCDate() - 1);
const nextMidnight = new Date(todayMidnight);
nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
const DIST = 'dist-001';
const TEST_VEHICLE = 'TEST-FLOAT-RECON-D1';

describe('FLOAT-001 — float-unsold reconciliation credit', () => {
  let driverId: string;
  let vehicleId: string;
  let dvaId: string;
  let cylinderTypeId: string;
  let cylinderTypeId2: string;
  let adminUserId: string;
  let customerId: string;

  // Flip flag inside each test (setup.ts deletes it globally per beforeEach).
  // Also wipe any pre-existing pending_dispatch orders for THIS test's
  // (driver, deliveryDate) so manifest creation sees orderedQty=0 — defends
  // against contamination from prior test files in the same serial run
  // (pool: 'forks' + singleFork: true means files share a DB). Without this,
  // the "Float-only trip" tests in this suite see whatever pending_dispatch
  // orders the broader suite or seed has left on the shared dist-001 driver
  // for today's UTC date and hit `TOTAL_BELOW_ORDERED` at the manifest guard.
  beforeEach(async () => {
    process.env.INVENTORY_DISPATCH_DEBIT = 'true';
    if (driverId) {
      await prisma.orderItem.deleteMany({
        where: { order: { distributorId: DIST, driverId, deliveryDate: todayMidnight } },
      });
      await prisma.orderStatusLog.deleteMany({
        where: { order: { distributorId: DIST, driverId, deliveryDate: todayMidnight } },
      });
      await prisma.order.deleteMany({
        where: { distributorId: DIST, driverId, deliveryDate: todayMidnight },
      });
    }
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
      distributorId: DIST,
      driverId,
      vehicleId,
      date: TEST_DATE,
    });
    dvaId = dva.id;
    const cts = await prisma.cylinderType.findMany({
      where: { distributorId: DIST, isActive: true },
      select: { id: true },
      take: 2,
    });
    cylinderTypeId = cts[0].id;
    cylinderTypeId2 = cts[1]?.id ?? cts[0].id;
    const admin = await prisma.user.findFirstOrThrow({
      where: { distributorId: DIST, role: 'distributor_admin' },
      select: { id: true },
    });
    adminUserId = admin.id;
    const customer = await prisma.customer.findFirstOrThrow({
      where: { distributorId: DIST, deletedAt: null, customerType: 'B2C' },
      select: { id: true },
    });
    customerId = customer.id;

    // CI-CONTAMINATION fix: float-reconciliation reads via
    // `recalculateSummariesFromDate` which walks EVERY inventoryEvent
    // row in the (distributorId, cylinderTypeId) bucket. Other test
    // files that touch the same seeded cylinder type can leave events
    // behind (their afterEach scopes to a narrower date window than
    // this test's recompute spans). To get a clean slate regardless
    // of test-order on CI, wipe ALL inventoryEvent + inventorySummary
    // for THIS distributor + THESE two cylinder types here, before
    // any test in this file runs. afterEach's date-scoped cleanup
    // continues to handle per-test cleanup within the suite.
    const cylinderIds = Array.from(new Set([cylinderTypeId, cylinderTypeId2]));
    await prisma.inventoryEvent.deleteMany({
      where: { distributorId: DIST, cylinderTypeId: { in: cylinderIds } },
    });
    await prisma.inventorySummary.deleteMany({
      where: { distributorId: DIST, cylinderTypeId: { in: cylinderIds } },
    });
  });

  afterEach(async () => {
    const dates = [todayMidnight, priorMidnight, nextMidnight];
    await prisma.inventoryEvent.deleteMany({
      where: { distributorId: DIST, eventDate: { in: dates } },
    });
    await prisma.inventorySummary.deleteMany({
      where: { distributorId: DIST, summaryDate: { in: dates } },
    });
    await prisma.dVALoadManifest.deleteMany({ where: { dvaId } });
    await prisma.cancelledStockEvent.deleteMany({
      where: { distributorId: DIST, vehicleId },
    });
    await prisma.orderItem.deleteMany({
      where: { order: { distributorId: DIST, deliveryDate: todayMidnight } },
    });
    await prisma.orderStatusLog.deleteMany({
      where: { order: { distributorId: DIST, deliveryDate: todayMidnight } },
    });
    await prisma.order.deleteMany({
      where: { distributorId: DIST, deliveryDate: todayMidnight },
    });
    await prisma.driverVehicleAssignment.update({
      where: { id: dvaId },
      data: {
        status: 'dispatch_ready',
        tripNumber: 1,
        dispatchedAt: null,
        returnedAt: null,
        reconciledAt: null,
        isReconciled: false,
        tripSheetNo: null,
        tripSheetGeneratedAt: null,
        tripSheetNo2: null,
        tripSheetNo2GeneratedAt: null,
      },
    });
    await prisma.vehicle.update({
      where: { id: vehicleId },
      data: { status: 'idle' },
    });
  });

  /** Helper: dispatch + mark all delivered + return + reconcile in one go. */
  async function fullCycle(opts: {
    manifest: Array<{ cylinderTypeId: string; totalLoaded: number }>;
    walkInOrders?: Array<{ cylinderTypeId: string; quantity: number; deliveredQuantity: number }>;
  }) {
    await createOrUpdateManifest(DIST, dvaId, opts.manifest, adminUserId);
    for (const wi of opts.walkInOrders ?? []) {
      await prisma.order.create({
        data: {
          orderNumber: `TEST-WI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
          distributorId: DIST,
          customerId,
          driverId,
          vehicleId,
          orderDate: todayMidnight,
          deliveryDate: todayMidnight,
          status: 'pending_dispatch',
          orderSource: 'walk_in',
          totalAmount: wi.quantity * 500,
          items: {
            create: [
              {
                cylinderTypeId: wi.cylinderTypeId,
                quantity: wi.quantity,
                unitPrice: 500,
                totalPrice: wi.quantity * 500,
              },
            ],
          },
        },
      });
    }
    await preflightDispatch({
      distributorId: DIST,
      driverId,
      assignmentDate: TEST_DATE,
      userId: adminUserId,
    });
    // Walk-in orders are now pending_delivery. Mark each as delivered with
    // deliveredQuantity stamped — sidesteps the full confirmDelivery flow
    // (which writes its own delivery events keyed on order; not under test
    // here). The float-unsold computation reads OrderItem.deliveredQuantity
    // directly via the orderSource='walk_in' filter.
    for (const wi of opts.walkInOrders ?? []) {
      const order = await prisma.order.findFirstOrThrow({
        where: {
          distributorId: DIST,
          driverId,
          deliveryDate: todayMidnight,
          status: 'pending_delivery',
          orderSource: 'walk_in',
          items: { some: { cylinderTypeId: wi.cylinderTypeId, quantity: wi.quantity } },
        },
        include: { items: true },
      });
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'delivered', deliveredAt: new Date() },
      });
      for (const item of order.items) {
        if (item.cylinderTypeId === wi.cylinderTypeId) {
          await prisma.orderItem.update({
            where: { id: item.id },
            data: { deliveredQuantity: wi.deliveredQuantity },
          });
        }
      }
    }
    await markVehicleReturned(vehicleId, driverId, DIST);
    return confirmVehicleReconciliation(vehicleId, DIST, adminUserId, {
      physicalStockConfirmed: true,
    });
  }

  it('Float-only trip, all walk-ins delivered → cancellation_return for remaining float', async () => {
    // Loaded 10 fulls; walk-in sold 4 → 6 returned to depot
    await fullCycle({
      manifest: [{ cylinderTypeId, totalLoaded: 10 }],
      walkInOrders: [{ cylinderTypeId, quantity: 4, deliveredQuantity: 4 }],
    });
    const returnEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
    });
    expect(returnEvents).toHaveLength(1);
    expect(returnEvents[0].fullsChange).toBe(6);
    expect(returnEvents[0].cylinderTypeId).toBe(cylinderTypeId);
  });

  it('Float-only trip, ALL unsold (no walk-ins) → full floatQty returned', async () => {
    await fullCycle({ manifest: [{ cylinderTypeId, totalLoaded: 7 }] });
    const returnEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
    });
    expect(returnEvents).toHaveLength(1);
    expect(returnEvents[0].fullsChange).toBe(7);
  });

  it('Float-only trip, walk-ins fully consume float → NO cancellation_return event', async () => {
    await fullCycle({
      manifest: [{ cylinderTypeId, totalLoaded: 5 }],
      walkInOrders: [{ cylinderTypeId, quantity: 5, deliveredQuantity: 5 }],
    });
    const returnEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
    });
    expect(returnEvents).toHaveLength(0);
  });

  it('Float-only trip, walk-ins exceed float → soldFromFloat clamps at floatQty', async () => {
    // Manifest 5, walk-in delivered 8 (impossible in real flow but tests the
    // Math.min(...) clamp). soldFromFloat = 5, unsoldFloat = 0 → no event.
    await fullCycle({
      manifest: [{ cylinderTypeId, totalLoaded: 5 }],
      walkInOrders: [{ cylinderTypeId, quantity: 8, deliveredQuantity: 8 }],
    });
    const returnEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
    });
    expect(returnEvents).toHaveLength(0);
  });

  it('Float-only trip: closingFulls balances after reconciliation (no leakage)', async () => {
    // Pure float, no walk-ins → dispatched=10 then fully returned=10. Closing
    // should equal opening; no fulls leaked from depot accounting.
    // Daily formula (flag ON):
    //   closingFulls = opening − dispatched + returned
    //                = 100 − 10 + 10 = 100
    await prisma.inventoryEvent.create({
      data: {
        distributorId: DIST,
        cylinderTypeId,
        eventType: 'initial_balance',
        fullsChange: 100,
        emptiesChange: 0,
        eventDate: priorMidnight,
        createdBy: adminUserId,
      },
    });
    await recalculateSummariesFromDate(DIST, cylinderTypeId, priorMidnight);

    await fullCycle({ manifest: [{ cylinderTypeId, totalLoaded: 10 }] });
    const summary = await prisma.inventorySummary.findUnique({
      where: {
        distributorId_cylinderTypeId_summaryDate: {
          distributorId: DIST,
          cylinderTypeId,
          summaryDate: todayMidnight,
        },
      },
    });
    expect(summary).not.toBeNull();
    expect(summary!.openingFulls).toBe(100);
    expect(summary!.dispatchedQty).toBe(10);
    expect(summary!.cancelledStockQty).toBe(10);
    expect(summary!.closingFulls).toBe(100);
  });

  it('Multi-type manifest: per-type unsold tracked separately', async () => {
    // CT1: loaded 4, walk-in 1 → unsold 3
    // CT2: loaded 6, no walk-in → unsold 6
    await fullCycle({
      manifest: [
        { cylinderTypeId, totalLoaded: 4 },
        { cylinderTypeId: cylinderTypeId2, totalLoaded: 6 },
      ],
      walkInOrders: [{ cylinderTypeId, quantity: 1, deliveredQuantity: 1 }],
    });
    const returnEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
      orderBy: { fullsChange: 'asc' },
    });
    // If both cylinder types are distinct rows, expect 2. If only one
    // active type exists in this dev DB (single-type tenants), CT1==CT2
    // and the entries collapse to one row with totalLoaded summed.
    if (cylinderTypeId === cylinderTypeId2) {
      expect(returnEvents).toHaveLength(1);
      // Loaded 6 (last write wins on upsert), walk-in delivered 1 → unsold 5
      expect(returnEvents[0].fullsChange).toBe(5);
    } else {
      expect(returnEvents).toHaveLength(2);
      const byType = new Map(returnEvents.map((e) => [e.cylinderTypeId, e.fullsChange]));
      expect(byType.get(cylinderTypeId)).toBe(3);
      expect(byType.get(cylinderTypeId2)).toBe(6);
    }
  });

  it('cancellation_return event references manifest.id, not dvaId', async () => {
    const [manifest] = await Promise.all([
      createOrUpdateManifest(
        DIST,
        dvaId,
        [{ cylinderTypeId, totalLoaded: 3 }],
        adminUserId,
      ),
    ]);
    await preflightDispatch({
      distributorId: DIST,
      driverId,
      assignmentDate: TEST_DATE,
      userId: adminUserId,
    });
    await markVehicleReturned(vehicleId, driverId, DIST);
    await confirmVehicleReconciliation(vehicleId, DIST, adminUserId, {
      physicalStockConfirmed: true,
    });
    const event = await prisma.inventoryEvent.findFirstOrThrow({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
    });
    expect(event.referenceId).toBe(manifest[0].id);
    expect(event.referenceId).not.toBe(dvaId);
  });

  it('REGRESSION 2026-06-18 — manifest from trip 1 credited even after DVA rolled to trip 2 before reconcile', async () => {
    // Reproduces user-reported "On Vehicle inventory stuck > 0 after
    // reconcile" bug:
    //   1. Admin enters manifest at trip 1 (10 fulls; 2 ordered → float=8)
    //   2. Trip 1 dispatched + delivered
    //   3. Fresh order created; admin dispatches again → DVA rolls to trip 2
    //      (NO new manifest entered for trip 2)
    //   4. Trip 2 delivered, vehicle returned, reconcile
    // BUG: Step 2.5 used to filter manifest by `tripNumber: tripDva.tripNumber`
    // which was 2 by reconcile time. The trip-1 manifest never matched, no
    // cancellation_return events were written, and the depot's "On Vehicle"
    // column showed 8 cylinders stuck out for delivery permanently.
    // FIX: Step 2.5 now reads ALL un-settled float manifests for the DVA
    // regardless of tripNumber (idempotent via cancellation_return existence
    // check on referenceId).

    // ── Trip 1 ────────────────────────────────────────────────────────────
    await createOrUpdateManifest(
      DIST,
      dvaId,
      [{ cylinderTypeId, totalLoaded: 10 }],
      adminUserId,
    );
    await prisma.order.create({
      data: {
        orderNumber: `TEST-T1-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST,
        customerId,
        driverId,
        vehicleId,
        orderDate: todayMidnight,
        deliveryDate: todayMidnight,
        status: 'pending_dispatch',
        orderSource: 'regular',
        totalAmount: 1000,
        items: {
          create: [{ cylinderTypeId, quantity: 2, unitPrice: 500, totalPrice: 1000 }],
        },
      },
    });
    await preflightDispatch({
      distributorId: DIST,
      driverId,
      assignmentDate: TEST_DATE,
      userId: adminUserId,
    });
    const t1Order = await prisma.order.findFirstOrThrow({
      where: { distributorId: DIST, deliveryDate: todayMidnight, status: 'pending_delivery' },
      include: { items: true },
    });
    await prisma.order.update({
      where: { id: t1Order.id },
      data: { status: 'delivered', deliveredAt: new Date() },
    });
    for (const item of t1Order.items) {
      await prisma.orderItem.update({
        where: { id: item.id },
        data: { deliveredQuantity: item.quantity },
      });
    }

    // ── Trip 2 (no fresh manifest) ────────────────────────────────────────
    await prisma.order.create({
      data: {
        orderNumber: `TEST-T2-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST,
        customerId,
        driverId,
        vehicleId,
        orderDate: todayMidnight,
        deliveryDate: todayMidnight,
        status: 'pending_dispatch',
        orderSource: 'regular',
        totalAmount: 1500,
        items: {
          create: [{ cylinderTypeId, quantity: 3, unitPrice: 500, totalPrice: 1500 }],
        },
      },
    });
    await preflightDispatch({
      distributorId: DIST,
      driverId,
      assignmentDate: TEST_DATE,
      userId: adminUserId,
    });
    const dvaAfterRoll = await prisma.driverVehicleAssignment.findUniqueOrThrow({
      where: { id: dvaId },
      select: { tripNumber: true },
    });
    expect(dvaAfterRoll.tripNumber).toBeGreaterThan(1); // proves DVA actually rolled
    const t2Order = await prisma.order.findFirstOrThrow({
      where: { distributorId: DIST, deliveryDate: todayMidnight, status: 'pending_delivery' },
      include: { items: true },
    });
    await prisma.order.update({
      where: { id: t2Order.id },
      data: { status: 'delivered', deliveredAt: new Date() },
    });
    for (const item of t2Order.items) {
      await prisma.orderItem.update({
        where: { id: item.id },
        data: { deliveredQuantity: item.quantity },
      });
    }

    // ── Reconcile ─────────────────────────────────────────────────────────
    await markVehicleReturned(vehicleId, driverId, DIST);
    await confirmVehicleReconciliation(vehicleId, DIST, adminUserId, {
      physicalStockConfirmed: true,
    });

    // Manifest captured orderedQty=0 (order was created AFTER manifest
    // confirm — no pending_dispatch rows existed at snapshot time) so
    // floatQty=10. The 2-cylinder order is 'regular' (not 'walk_in'), so it
    // doesn't consume float → unsoldFloat=10. The fact that ONE event with
    // fullsChange=10 is written is itself the regression assertion: without
    // the fix, the array is empty.
    const returnEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
    });
    expect(returnEvents).toHaveLength(1);
    expect(returnEvents[0].fullsChange).toBe(10);
    expect(returnEvents[0].cylinderTypeId).toBe(cylinderTypeId);
  });

  it('REGRESSION 2026-06-18 #2 — walk-in order MUST NOT write a per-order dispatch event (already debited via float)', async () => {
    // User-reported (2026-06-18 ~07:02 IST, dist-002 Sharma):
    //   manifest 19 KG: loaded 10, ordered 2 → float 8
    //   walk-in delivered 5
    //   reconcile → "On Vehicle Fulls" stayed at 5 instead of 0
    // Root cause: walk-in order preflight wrote its own per-order dispatch
    // event (-5), in addition to the float manifest event (-8). Depot saw
    // -13 total dispatch when it should have seen -10. Reconcile credited
    // back only the unsold float (+3), leaving On-Vehicle = 13-7-3 = 5.
    // Fix: buildDispatchCtx() returns undefined for orderSource='walk_in'.
    // Test contract: after a walk-in dispatch + delivery, the only
    // dispatch events for that cylinder type on today are the manifest
    // float event and the regular order's event — NEVER one keyed to the
    // walk-in order itself.

    // Manifest 10 fulls, no pending regular orders → float 10
    await createOrUpdateManifest(
      DIST,
      dvaId,
      [{ cylinderTypeId, totalLoaded: 10 }],
      adminUserId,
    );
    // 1 walk-in order for 3 cylinders (driver creates mid-trip)
    await prisma.order.create({
      data: {
        orderNumber: `TEST-WI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST,
        customerId,
        driverId,
        vehicleId,
        orderDate: todayMidnight,
        deliveryDate: todayMidnight,
        status: 'pending_dispatch',
        orderSource: 'walk_in',
        totalAmount: 1500,
        items: {
          create: [{ cylinderTypeId, quantity: 3, unitPrice: 500, totalPrice: 1500 }],
        },
      },
    });
    await preflightDispatch({
      distributorId: DIST,
      driverId,
      assignmentDate: TEST_DATE,
      userId: adminUserId,
    });

    // Pin the exact dispatch-event shape: ONE float event (-10),
    // ZERO per-order dispatch events for the walk-in order.
    const dispatchEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'dispatch',
        cylinderTypeId,
        eventDate: todayMidnight,
      },
      select: { fullsChange: true, referenceType: true, referenceId: true },
    });
    const floatEvents = dispatchEvents.filter((e) => e.referenceType === 'dva_load_manifest');
    const orderDispatchEvents = dispatchEvents.filter((e) => e.referenceType === 'order');
    expect(floatEvents).toHaveLength(1);
    expect(floatEvents[0].fullsChange).toBe(-10);
    // Pre-fix: this would be 1 (the walk-in's per-order dispatch). Post-fix: 0.
    expect(orderDispatchEvents).toHaveLength(0);
  });

  it('REGRESSION 2026-06-18 #3 — walk-in shortfall uses ordered (not delivered) so CSE + float do not double-credit', async () => {
    // User repro 2026-06-18 ~07:02 IST, dist-002 Sharma:
    //   Bangalore Foods walk-in: ordered 8, delivered 7, 1 shortfall → CSE
    //   Float manifest 47.5 KG: loaded 10, ordered 2 → float 8
    //   Reconcile: CSE flow credited +1 (correct). Step 2.5 ALSO credited +1
    //   for "unsold float" using deliveredQuantity (8 − 7 = 1). The same
    //   physical cylinder was credited twice → On Vehicle stayed at +1.
    // Fix: Step 2.5 sums OrderItem.quantity (= ordered) instead of
    // deliveredQuantity. soldFromFloat = walkInOrdered ⇒ unsoldFloat = 0
    // when walk-in ordered consumed the entire float pool. Shortfall is
    // handled exclusively by the CancelledStockEvent path.

    // No pending regular orders at manifest confirm → manifest snapshot
    // floatQty=10. Then create a single walk-in order ordered=10,
    // delivered=8 (2 shortfall). The CSE for that shortfall is created
    // by modify-delivery elsewhere; here we directly construct the same
    // shape (order delivered+modified, OrderItem.deliveredQuantity=8) and
    // assert Step 2.5 credits 0 (not 2).
    await createOrUpdateManifest(
      DIST,
      dvaId,
      [{ cylinderTypeId, totalLoaded: 10 }],
      adminUserId,
    );
    await prisma.order.create({
      data: {
        orderNumber: `TEST-SHRT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST,
        customerId,
        driverId,
        vehicleId,
        orderDate: todayMidnight,
        deliveryDate: todayMidnight,
        status: 'pending_dispatch',
        orderSource: 'walk_in',
        totalAmount: 5000,
        items: {
          create: [{ cylinderTypeId, quantity: 10, unitPrice: 500, totalPrice: 5000 }],
        },
      },
    });
    await preflightDispatch({
      distributorId: DIST,
      driverId,
      assignmentDate: TEST_DATE,
      userId: adminUserId,
    });
    const shortOrder = await prisma.order.findFirstOrThrow({
      where: { distributorId: DIST, orderSource: 'walk_in', status: 'pending_delivery' },
      include: { items: true },
    });
    // Mark as MODIFIED_DELIVERED with deliveredQuantity=8 (2 shortfall)
    await prisma.order.update({
      where: { id: shortOrder.id },
      data: { status: 'modified_delivered', deliveredAt: new Date() },
    });
    for (const item of shortOrder.items) {
      await prisma.orderItem.update({
        where: { id: item.id },
        data: { deliveredQuantity: 8 },
      });
    }

    await markVehicleReturned(vehicleId, driverId, DIST);
    await confirmVehicleReconciliation(vehicleId, DIST, adminUserId, {
      physicalStockConfirmed: true,
    });

    // Float credit MUST be 0 (walk-in ordered 10 ≥ floatQty 10 → unsold = 0).
    // The 2-cylinder shortfall belongs to the CSE path; if no CSE row was
    // created by this test setup, the depot just won't see those 2 back —
    // but the float-side calculation must NOT compensate for them.
    const floatReturnEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
    });
    expect(floatReturnEvents).toHaveLength(0);
  });

  it('Flag OFF: dispatch event not written → cancellation_return event also skipped', async () => {
    process.env.INVENTORY_DISPATCH_DEBIT = 'false';
    await createOrUpdateManifest(
      DIST,
      dvaId,
      [{ cylinderTypeId, totalLoaded: 6 }],
      adminUserId,
    );
    await preflightDispatch({
      distributorId: DIST,
      driverId,
      assignmentDate: TEST_DATE,
      userId: adminUserId,
    });
    await markVehicleReturned(vehicleId, driverId, DIST);
    await confirmVehicleReconciliation(vehicleId, DIST, adminUserId, {
      physicalStockConfirmed: true,
    });
    const dispatchEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'dispatch',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
    });
    const returnEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
    });
    expect(dispatchEvents).toHaveLength(0);
    expect(returnEvents).toHaveLength(0);
  });

  // ── Bug #7 regression cluster (2026-06-18) ──────────────────────────────
  //
  // confirmVehicleReconciliation now increments DVA.tripNumber as part of
  // its terminal state update. Before this fix tripNumber was only bumped
  // by preflightDispatch's shouldRoll on the NEXT dispatch — leaving a
  // window where a manifest save would overwrite the prior trip's rows
  // in place (destroying audit trail and breaking Step 2.5 idempotency
  // by manifest.id on the next reconcile).

  it('BUG #7 — DVA.tripNumber increments immediately at reconciliation', async () => {
    await fullCycle({ manifest: [{ cylinderTypeId, totalLoaded: 5 }] });
    const dva = await prisma.driverVehicleAssignment.findUniqueOrThrow({
      where: { id: dvaId },
    });
    expect(dva.tripNumber).toBe(2); // was 1 at dispatch, now 2 immediately after reconcile
    expect(dva.status).toBe('dispatch_ready');
    expect(dva.isReconciled).toBe(true);
  });

  it('BUG #7 — manifest save after reconcile creates NEW trip-2 rows (not overwrite trip-1)', async () => {
    // Trip 1: dispatch + reconcile → manifest row at trip 1, DVA at trip 2
    await fullCycle({ manifest: [{ cylinderTypeId, totalLoaded: 8 }] });
    const t1Rows = await prisma.dVALoadManifest.findMany({
      where: { dvaId, cylinderTypeId },
    });
    expect(t1Rows).toHaveLength(1);
    expect(t1Rows[0].tripNumber).toBe(1);
    expect(t1Rows[0].totalLoaded).toBe(8);
    const t1RowId = t1Rows[0].id;

    // Admin saves a fresh manifest for trip 2 with DIFFERENT value
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 12 }], adminUserId,
    );

    const allRows = await prisma.dVALoadManifest.findMany({
      where: { dvaId, cylinderTypeId },
      orderBy: { tripNumber: 'asc' },
    });
    // Expect 2 rows now — trip 1 UNCHANGED + trip 2 NEW
    expect(allRows).toHaveLength(2);
    expect(allRows[0].tripNumber).toBe(1);
    expect(allRows[0].id).toBe(t1RowId); // same id — not overwritten
    expect(allRows[0].totalLoaded).toBe(8); // trip-1 value preserved
    expect(allRows[1].tripNumber).toBe(2);
    expect(allRows[1].id).not.toBe(t1RowId); // distinct id
    expect(allRows[1].totalLoaded).toBe(12); // new value
  });

  it('BUG #7 — Step 2.5 fires correctly on trip-2 reconcile (idempotency-by-id not broken)', async () => {
    // Trip 1 full cycle with 5 float, no walk-ins → +5 return event for trip-1 row
    await fullCycle({ manifest: [{ cylinderTypeId, totalLoaded: 5 }] });
    const trip1Returns = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
    });
    expect(trip1Returns).toHaveLength(1);
    expect(trip1Returns[0].fullsChange).toBe(5);
    const trip1ManifestId = trip1Returns[0].referenceId;

    // Trip 2: fresh manifest with 4 float, full cycle → expect +4 return event
    // with a DIFFERENT manifest id (the trip-2 row)
    await fullCycle({ manifest: [{ cylinderTypeId, totalLoaded: 4 }] });
    const allReturns = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(allReturns).toHaveLength(2);
    expect(allReturns[0].fullsChange).toBe(5); // trip 1 — unchanged
    expect(allReturns[0].referenceId).toBe(trip1ManifestId);
    expect(allReturns[1].fullsChange).toBe(4); // trip 2 — fresh credit
    expect(allReturns[1].referenceId).not.toBe(trip1ManifestId);
  });

  it('BUG #11 — historical orders for same (driver, tripNumber) on prior days do NOT pollute soldFromFloat', async () => {
    // Live user repro dist-002 2026-06-19 ~13:19 IST: 19 KG manifest's
    // cancellation_return wrote +4 instead of +9 because historical
    // OSHD582 (2026-06-12) + OSHD610 (2026-06-15) + today's OSHD697 all
    // matched (driver, tripNumber=1, 19 KG, active status) — sum qty=5
    // — and 5 phantom cylinders were silently lost from depot.
    // Fix: add deliveryDate=tripDva.assignmentDate filter so historical
    // days don't pollute today's trip math.

    // Plant a HISTORICAL delivered order at a far-past date with the
    // same (driver, tripNumber=1, cylinderType) tuple. With the fix,
    // Step 2.5 must NOT count this against today's manifest.
    await prisma.order.create({
      data: {
        orderNumber: `TEST-HIST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST,
        customerId,
        driverId,
        vehicleId,
        orderDate: priorMidnight,
        deliveryDate: priorMidnight, // PRIOR DAY
        status: 'delivered',
        orderSource: 'regular',
        tripNumber: 1, // SAME tripNumber as today's trip-1 manifest
        totalAmount: 1000,
        items: { create: [{ cylinderTypeId, quantity: 2, unitPrice: 500, totalPrice: 1000, deliveredQuantity: 2 }] },
      },
    });
    // No per-order dispatch event for the historical order — simulates
    // the worst case where the pollution would slip into fromFloatQty.

    // Today's float-only trip: 5 fulls loaded, no orders dispatched.
    // Pre-fix: Step 2.5 would count the historical order's qty 2 into
    // fromFloatQty → cancellation_return = 5 - 2 = 3. Post-fix: deliveryDate
    // filter excludes the historical order → fromFloatQty = 0 →
    // cancellation_return = 5 (full float returned).
    await fullCycle({ manifest: [{ cylinderTypeId, totalLoaded: 5 }] });

    const returnEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
    });
    expect(returnEvents).toHaveLength(1);
    expect(returnEvents[0].fullsChange).toBe(5); // NOT 3 — historical order excluded
  });

  it('BUG #10 — mid-trip regular order via Add to Trip consumes from float (not phantom credit)', async () => {
    // User repro 2026-06-18 ~21:04 IST, dist-002: OSHD677 was a regular
    // order added mid-trip via "+ Add to Trip" for 1 cylinder of 19 KG.
    // Bug #6 correctly skipped its per-order dispatch event (came from
    // float). But Step 2.5's old formula counted only orderSource='walk_in'
    // for soldFromFloat → mid-trip regular missed → credited the full 9
    // float back to depot instead of 8 → Inventory On Vehicle = -1 for 19 KG.
    // Fix: discriminate via "has per-order dispatch event" (walk-ins AND
    // mid-trip regulars both lack one — both consume float).

    // Pre-book a regular order (qty 1) BEFORE manifest confirm so the
    // manifest captures orderedQty=1, floatQty=9.
    await prisma.order.create({
      data: {
        orderNumber: `TEST-PB-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST,
        customerId,
        driverId,
        vehicleId,
        orderDate: todayMidnight,
        deliveryDate: todayMidnight,
        status: 'pending_dispatch',
        orderSource: 'regular',
        totalAmount: 500,
        items: { create: [{ cylinderTypeId, quantity: 1, unitPrice: 500, totalPrice: 500 }] },
      },
    });
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 10 }], adminUserId,
    );
    await preflightDispatch({
      distributorId: DIST, driverId, assignmentDate: TEST_DATE, userId: adminUserId,
    });
    // Deliver the pre-booked order
    const preBooked = await prisma.order.findFirstOrThrow({
      where: { distributorId: DIST, deliveryDate: todayMidnight, status: 'pending_delivery' },
      include: { items: true },
    });
    await prisma.order.update({
      where: { id: preBooked.id },
      data: { status: 'delivered', deliveredAt: new Date() },
    });
    for (const item of preBooked.items) {
      await prisma.orderItem.update({
        where: { id: item.id },
        data: { deliveredQuantity: item.quantity },
      });
    }

    // Admin adds a mid-trip regular order (NOT walk_in) and dispatches
    // via preflightAddToTrip → Bug #6 skips per-order dispatch event.
    const midTrip = await prisma.order.create({
      data: {
        orderNumber: `TEST-MT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST,
        customerId,
        driverId,
        vehicleId,
        orderDate: todayMidnight,
        deliveryDate: todayMidnight,
        status: 'pending_dispatch',
        orderSource: 'regular',
        totalAmount: 500,
        items: { create: [{ cylinderTypeId, quantity: 1, unitPrice: 500, totalPrice: 500 }] },
      },
    });
    const { preflightAddToTrip } = await import('../../services/gst/gstPreflightService.js');
    await preflightAddToTrip({
      distributorId: DIST, driverId, assignmentDate: TEST_DATE, userId: adminUserId,
    });
    // Mid-trip order should now be pending_delivery with no dispatch event
    const midDispatchEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'dispatch',
        referenceType: 'order',
        referenceId: midTrip.id,
      },
    });
    expect(midDispatchEvents).toHaveLength(0); // Bug #6 — pre-condition

    // Deliver the mid-trip order
    const midTripFresh = await prisma.order.findUniqueOrThrow({
      where: { id: midTrip.id }, include: { items: true },
    });
    await prisma.order.update({
      where: { id: midTrip.id },
      data: { status: 'delivered', deliveredAt: new Date() },
    });
    for (const item of midTripFresh.items) {
      await prisma.orderItem.update({
        where: { id: item.id },
        data: { deliveredQuantity: item.quantity },
      });
    }

    // Reconcile
    await markVehicleReturned(vehicleId, driverId, DIST);
    await confirmVehicleReconciliation(vehicleId, DIST, adminUserId, {
      physicalStockConfirmed: true,
    });

    // CRITICAL: Step 2.5 must credit 8 (not 9) — 1 cylinder from float
    // was consumed by the mid-trip regular order.
    const floatReturns = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'dva_load_manifest',
        eventDate: todayMidnight,
      },
    });
    expect(floatReturns).toHaveLength(1);
    expect(floatReturns[0].fullsChange).toBe(8); // 9 float − 1 mid-trip = 8

    // Net inventory: dispatched (-10) + delivered (-2) + return (+8) = -4 on vehicle?
    // No wait — "on vehicle" = dispatched - delivered - returned = 10 - 2 - 8 = 0 ✓
    // Verify by recomputing the daily summary and checking closingFulls vs opening.
  });

  it('BUG #8 — pending_dispatch order cancelled at reconcile writes NO phantom credit', async () => {
    // User repro 2026-06-18 ~20:14 IST, dist-002: OSHD673 was a regular
    // pending_dispatch order for 6 cylinders (never went through preflight,
    // never debited depot). At reconcile, Step 2's cancel-undelivered branch
    // force-cancelled it AND wrote +6 cancellation_return → depot got a
    // phantom credit for cylinders that never left → Inventory showed
    // On Vehicle = -6 for 425 KG.
    // Fix: cancellation_return + CSE only fire when the order was actually
    // dispatched (status in pending_delivery / preflight_in_progress /
    // modified_delivered). pending_dispatch just transitions to cancelled.

    // Setup: float manifest + dispatch (writes float event, depot debit ok)
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 5 }], adminUserId,
    );
    await preflightDispatch({
      distributorId: DIST, driverId, assignmentDate: TEST_DATE, userId: adminUserId,
    });
    // Now create a NEW regular order pending_dispatch — never dispatched.
    const undispatched = await prisma.order.create({
      data: {
        orderNumber: `TEST-PD-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST,
        customerId,
        driverId,
        vehicleId,
        orderDate: todayMidnight,
        deliveryDate: todayMidnight,
        status: 'pending_dispatch',
        orderSource: 'regular',
        totalAmount: 3000,
        items: { create: [{ cylinderTypeId, quantity: 6, unitPrice: 500, totalPrice: 3000 }] },
      },
    });

    // Mark vehicle returned then reconcile (Bug #9 guard is bypassed by
    // calling confirmVehicleReconciliation directly — Bug #9 separately
    // covers the markVehicleReturned guard).
    // Mark vehicle returned would 400 because of the pending_dispatch
    // guard (Bug #9). For this Bug #8 test we want to reach Step 2's
    // cancel-undelivered branch, so we flip vehicle/DVA state manually.
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: 'returned' } });
    await prisma.driverVehicleAssignment.update({
      where: { id: dvaId }, data: { returnedAt: new Date() },
    });
    await confirmVehicleReconciliation(vehicleId, DIST, adminUserId, {
      physicalStockConfirmed: true,
    });

    // Order should be cancelled.
    const cancelled = await prisma.order.findUniqueOrThrow({ where: { id: undispatched.id } });
    expect(cancelled.status).toBe('cancelled');

    // CRITICAL: no cancellation_return event referencing this order.
    const phantomEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'cancellation_return',
        referenceType: 'order',
        referenceId: undispatched.id,
      },
    });
    expect(phantomEvents).toHaveLength(0);

    // No CancelledStockEvent for this order either.
    const phantomCse = await prisma.cancelledStockEvent.findMany({
      where: { orderId: undispatched.id },
    });
    expect(phantomCse).toHaveLength(0);
  });

  it('BUG #9 — markVehicleReturned blocks when pending_dispatch orders exist', async () => {
    const { markVehicleReturned } = await import('../../services/deliveryWorkflowService.js');
    // Setup: dispatch a float-only trip so the DVA is loaded_and_dispatched.
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 5 }], adminUserId,
    );
    await preflightDispatch({
      distributorId: DIST, driverId, assignmentDate: TEST_DATE, userId: adminUserId,
    });

    // Create a regular order in pending_dispatch (assigned to this vehicle
    // but never dispatched — admin clicked Mark Returned without first
    // running "+ Add to Trip" or cancelling).
    await prisma.order.create({
      data: {
        orderNumber: `TEST-VR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST,
        customerId,
        driverId,
        vehicleId,
        orderDate: todayMidnight,
        deliveryDate: todayMidnight,
        status: 'pending_dispatch',
        orderSource: 'regular',
        totalAmount: 1000,
        items: { create: [{ cylinderTypeId, quantity: 2, unitPrice: 500, totalPrice: 1000 }] },
      },
    });

    // Mark returned should throw with PENDING_DISPATCH_ORDERS_EXIST.
    let caught: (Error & { code?: string; statusCode?: number }) | null = null;
    try {
      await markVehicleReturned(vehicleId, driverId, DIST);
    } catch (e) {
      caught = e as Error & { code?: string; statusCode?: number };
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('PENDING_DISPATCH_ORDERS_EXIST');
    expect(caught!.statusCode).toBe(400);
    expect(caught!.message).toMatch(/not yet dispatched/);

    // Vehicle status NOT changed (still dispatched, not returned).
    const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
    expect(vehicle.status).toBe('dispatched');
  });

  it('BUG #7 — preflightDispatch shouldRoll does NOT double-bump tripNumber on reconciled path', async () => {
    // Trip 1 → reconciled → DVA at trip 2 already (per Bug #7 fix above).
    await fullCycle({ manifest: [{ cylinderTypeId, totalLoaded: 3 }] });
    const beforeTrip2 = await prisma.driverVehicleAssignment.findUniqueOrThrow({
      where: { id: dvaId },
    });
    expect(beforeTrip2.tripNumber).toBe(2);
    expect(beforeTrip2.isReconciled).toBe(true);

    // Admin enters trip-2 manifest + dispatches. shouldRoll path triggers
    // (status=dispatch_ready, isReconciled=true) → must NOT bump again.
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 4 }], adminUserId,
    );
    await preflightDispatch({
      distributorId: DIST, driverId, assignmentDate: TEST_DATE, userId: adminUserId,
    });

    const afterT2Dispatch = await prisma.driverVehicleAssignment.findUniqueOrThrow({
      where: { id: dvaId },
    });
    expect(afterT2Dispatch.tripNumber).toBe(2); // STILL 2, not 3
    expect(afterT2Dispatch.isReconciled).toBe(false); // cleared by shouldRoll block
    expect(afterT2Dispatch.status).toBe('loaded_and_dispatched');
  });
});
