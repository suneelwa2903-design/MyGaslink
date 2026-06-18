/**
 * FLOAT-001 — float-only and mixed dispatch.
 *
 * Pins the Phase 4 wire-up of preflightDispatch:
 *   - relaxed NO_ORDERS guard (now NO_ORDERS_OR_MANIFEST)
 *   - float `dispatch` InventoryEvent written with referenceType='dva_load_manifest'
 *   - DVA → loaded_and_dispatched + Vehicle → dispatched + dispatchedAt stamped
 *     ALSO fire when isFloatOnlyDispatch (zero orders, manifest only)
 *   - InventorySummary recompute includes manifest cylinder types
 *
 * Uses Bhargava (dist-001, gstMode='disabled') so the per-order loop short-
 * circuits to transitionToPendingDelivery without WhiteBooks mocks. The
 * regression test below seeds an order to exercise the mixed-dispatch path
 * on the same tenant.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { preflightDispatch, preflightAddToTrip } from '../../services/gst/gstPreflightService.js';
import { createOrUpdateManifest } from '../../services/dvaManifestService.js';
import { prisma } from '../../lib/prisma.js';
import { ensureDriverVehicleMapping, getOrCreateTestVehicle } from '../helpers.js';

const TEST_DATE = '2099-12-15';
const PRIOR_DATE = '2099-12-14';
const DIST = 'dist-001';
const TEST_VEHICLE = 'TEST-FLOAT-VEHICLE-D1';

describe('FLOAT-001 — float-only + mixed dispatch', () => {
  // setup.ts's global beforeEach DELETES INVENTORY_DISPATCH_DEBIT before each
  // test (safety net for the default-OFF suites). Re-set it ON here so every
  // test in this suite runs with dispatch-debit accounting enabled — that's
  // the production default and what every assertion in this file pins.
  beforeEach(() => {
    process.env.INVENTORY_DISPATCH_DEBIT = 'true';
  });
  let driverId: string;
  let vehicleId: string;
  let dvaId: string;
  let cylinderTypeId: string;
  let adminUserId: string;

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
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: DIST, isActive: true },
      select: { id: true },
    });
    cylinderTypeId = ct.id;
    const admin = await prisma.user.findFirstOrThrow({
      where: { distributorId: DIST, role: 'distributor_admin' },
      select: { id: true },
    });
    adminUserId = admin.id;
  });

  afterEach(async () => {
    // Wipe everything this test could have created. Order matters for FKs.
    await prisma.inventoryEvent.deleteMany({
      where: {
        distributorId: DIST,
        eventDate: { in: [new Date(TEST_DATE), new Date(PRIOR_DATE)] },
      },
    });
    await prisma.inventorySummary.deleteMany({
      where: {
        distributorId: DIST,
        summaryDate: { in: [new Date(TEST_DATE), new Date(PRIOR_DATE)] },
      },
    });
    await prisma.dVALoadManifest.deleteMany({ where: { dvaId } });
    await prisma.orderItem.deleteMany({
      where: { order: { distributorId: DIST, deliveryDate: new Date(TEST_DATE) } },
    });
    await prisma.orderStatusLog.deleteMany({
      where: { order: { distributorId: DIST, deliveryDate: new Date(TEST_DATE) } },
    });
    await prisma.order.deleteMany({
      where: { distributorId: DIST, deliveryDate: new Date(TEST_DATE) },
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

  it('Float-only dispatch: DVA → loaded_and_dispatched + dispatchedAt set', async () => {
    await createOrUpdateManifest(
      DIST,
      dvaId,
      [{ cylinderTypeId, totalLoaded: 5 }],
      adminUserId,
    );
    await preflightDispatch({
      distributorId: DIST,
      driverId,
      assignmentDate: TEST_DATE,
      userId: adminUserId,
    });
    const dva = await prisma.driverVehicleAssignment.findUniqueOrThrow({
      where: { id: dvaId },
    });
    expect(dva.status).toBe('loaded_and_dispatched');
    expect(dva.dispatchedAt).not.toBeNull();
  });

  it('Float-only dispatch: Vehicle → dispatched', async () => {
    await createOrUpdateManifest(
      DIST,
      dvaId,
      [{ cylinderTypeId, totalLoaded: 3 }],
      adminUserId,
    );
    await preflightDispatch({
      distributorId: DIST,
      driverId,
      assignmentDate: TEST_DATE,
      userId: adminUserId,
    });
    const vehicle = await prisma.vehicle.findUniqueOrThrow({
      where: { id: vehicleId },
    });
    expect(vehicle.status).toBe('dispatched');
  });

  it('Float-only dispatch: writes dispatch InventoryEvent with referenceType=dva_load_manifest', async () => {
    const manifest = await createOrUpdateManifest(
      DIST,
      dvaId,
      [{ cylinderTypeId, totalLoaded: 7 }],
      adminUserId,
    );
    await preflightDispatch({
      distributorId: DIST,
      driverId,
      assignmentDate: TEST_DATE,
      userId: adminUserId,
    });
    const events = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'dispatch',
        referenceType: 'dva_load_manifest',
        eventDate: new Date(TEST_DATE),
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].fullsChange).toBe(-7);
    expect(events[0].cylinderTypeId).toBe(cylinderTypeId);
    expect(events[0].referenceId).toBe(manifest[0].id);
    expect(events[0].vehicleNumber).toBe(TEST_VEHICLE);
  });

  it('Float-only dispatch: InventorySummary.dispatchedQty reflects float qty', async () => {
    await createOrUpdateManifest(
      DIST,
      dvaId,
      [{ cylinderTypeId, totalLoaded: 4 }],
      adminUserId,
    );
    await preflightDispatch({
      distributorId: DIST,
      driverId,
      assignmentDate: TEST_DATE,
      userId: adminUserId,
    });
    const summary = await prisma.inventorySummary.findUnique({
      where: {
        distributorId_cylinderTypeId_summaryDate: {
          distributorId: DIST,
          cylinderTypeId,
          summaryDate: new Date(TEST_DATE),
        },
      },
    });
    expect(summary).not.toBeNull();
    expect(summary!.dispatchedQty).toBe(4);
  });

  it('Float-only dispatch: closingFulls debited by floatQty', async () => {
    // Seed an opening balance the day BEFORE and recompute the summary for
    // that day so the carry-forward chain pulls openingFulls=100 on TEST_DATE.
    const { recalculateSummariesFromDate } = await import('../../services/inventoryService.js');
    await prisma.inventoryEvent.create({
      data: {
        distributorId: DIST,
        cylinderTypeId,
        eventType: 'initial_balance',
        fullsChange: 100,
        emptiesChange: 0,
        eventDate: new Date(PRIOR_DATE),
        createdBy: adminUserId,
      },
    });
    await recalculateSummariesFromDate(DIST, cylinderTypeId, new Date(PRIOR_DATE));
    await createOrUpdateManifest(
      DIST,
      dvaId,
      [{ cylinderTypeId, totalLoaded: 8 }],
      adminUserId,
    );
    await preflightDispatch({
      distributorId: DIST,
      driverId,
      assignmentDate: TEST_DATE,
      userId: adminUserId,
    });
    const summary = await prisma.inventorySummary.findUnique({
      where: {
        distributorId_cylinderTypeId_summaryDate: {
          distributorId: DIST,
          cylinderTypeId,
          summaryDate: new Date(TEST_DATE),
        },
      },
    });
    expect(summary).not.toBeNull();
    expect(summary!.openingFulls).toBe(100);
    expect(summary!.dispatchedQty).toBe(8);
    expect(summary!.closingFulls).toBe(92);
  });

  it('Mixed dispatch (orders + float): both order dispatch event AND float event written', async () => {
    const customer = await prisma.customer.findFirstOrThrow({
      where: { distributorId: DIST, deletedAt: null, customerType: 'B2C' },
      select: { id: true },
    });
    await prisma.order.create({
      data: {
        orderNumber: `TEST-FLOAT-MIX-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST,
        customerId: customer.id,
        driverId,
        vehicleId,
        orderDate: new Date(TEST_DATE),
        deliveryDate: new Date(TEST_DATE),
        status: 'pending_dispatch',
        totalAmount: 1000,
        items: {
          create: [
            {
              cylinderTypeId,
              quantity: 2,
              unitPrice: 500,
              totalPrice: 1000,
            },
          ],
        },
      },
    });
    // Manifest: totalLoaded=5 → orderedQty=2, floatQty=3
    await createOrUpdateManifest(
      DIST,
      dvaId,
      [{ cylinderTypeId, totalLoaded: 5 }],
      adminUserId,
    );
    await preflightDispatch({
      distributorId: DIST,
      driverId,
      assignmentDate: TEST_DATE,
      userId: adminUserId,
    });
    const orderEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'dispatch',
        referenceType: 'order',
        eventDate: new Date(TEST_DATE),
      },
    });
    const floatEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'dispatch',
        referenceType: 'dva_load_manifest',
        eventDate: new Date(TEST_DATE),
      },
    });
    expect(orderEvents).toHaveLength(1);
    expect(orderEvents[0].fullsChange).toBe(-2);
    expect(floatEvents).toHaveLength(1);
    expect(floatEvents[0].fullsChange).toBe(-3);
  });

  it('Mixed dispatch: total dispatchedQty = ordered + float', async () => {
    const customer = await prisma.customer.findFirstOrThrow({
      where: { distributorId: DIST, deletedAt: null, customerType: 'B2C' },
      select: { id: true },
    });
    await prisma.order.create({
      data: {
        orderNumber: `TEST-FLOAT-SUM-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST,
        customerId: customer.id,
        driverId,
        vehicleId,
        orderDate: new Date(TEST_DATE),
        deliveryDate: new Date(TEST_DATE),
        status: 'pending_dispatch',
        totalAmount: 1500,
        items: {
          create: [
            {
              cylinderTypeId,
              quantity: 3,
              unitPrice: 500,
              totalPrice: 1500,
            },
          ],
        },
      },
    });
    await createOrUpdateManifest(
      DIST,
      dvaId,
      [{ cylinderTypeId, totalLoaded: 10 }],
      adminUserId,
    );
    await preflightDispatch({
      distributorId: DIST,
      driverId,
      assignmentDate: TEST_DATE,
      userId: adminUserId,
    });
    const summary = await prisma.inventorySummary.findUnique({
      where: {
        distributorId_cylinderTypeId_summaryDate: {
          distributorId: DIST,
          cylinderTypeId,
          summaryDate: new Date(TEST_DATE),
        },
      },
    });
    expect(summary).not.toBeNull();
    // ordered=3 (order dispatch event) + float=7 (manifest dispatch event) = 10
    expect(summary!.dispatchedQty).toBe(10);
  });

  it('No orders and no manifest → throws NO_ORDERS_OR_MANIFEST 400', async () => {
    await expect(
      preflightDispatch({
        distributorId: DIST,
        driverId,
        assignmentDate: TEST_DATE,
        userId: adminUserId,
      }),
    ).rejects.toMatchObject({ code: 'NO_ORDERS_OR_MANIFEST', statusCode: 400 });
  });

  it('Manifest with all totalLoaded=0 + no orders → still NO_ORDERS_OR_MANIFEST', async () => {
    // hasManifest is false when no manifest row has totalLoaded > 0
    await createOrUpdateManifest(
      DIST,
      dvaId,
      [{ cylinderTypeId, totalLoaded: 0 }],
      adminUserId,
    );
    await expect(
      preflightDispatch({
        distributorId: DIST,
        driverId,
        assignmentDate: TEST_DATE,
        userId: adminUserId,
      }),
    ).rejects.toMatchObject({ code: 'NO_ORDERS_OR_MANIFEST' });
  });

  it('Regression: existing dispatch with orders and no manifest behaves as before', async () => {
    const customer = await prisma.customer.findFirstOrThrow({
      where: { distributorId: DIST, deletedAt: null, customerType: 'B2C' },
      select: { id: true },
    });
    const order = await prisma.order.create({
      data: {
        orderNumber: `TEST-FLOAT-REG-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST,
        customerId: customer.id,
        driverId,
        vehicleId,
        orderDate: new Date(TEST_DATE),
        deliveryDate: new Date(TEST_DATE),
        status: 'pending_dispatch',
        totalAmount: 1000,
        items: {
          create: [{ cylinderTypeId, quantity: 2, unitPrice: 500, totalPrice: 1000 }],
        },
      },
    });
    const result = await preflightDispatch({
      distributorId: DIST,
      driverId,
      assignmentDate: TEST_DATE,
      userId: adminUserId,
    });
    expect(result.summary.succeeded).toBe(1);
    const updatedOrder = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(updatedOrder.status).toBe('pending_delivery');
    const dva = await prisma.driverVehicleAssignment.findUniqueOrThrow({
      where: { id: dvaId },
    });
    expect(dva.status).toBe('loaded_and_dispatched');
    // Critically: NO manifest event should exist
    const manifestEvents = await prisma.inventoryEvent.count({
      where: {
        distributorId: DIST,
        referenceType: 'dva_load_manifest',
        eventDate: new Date(TEST_DATE),
      },
    });
    expect(manifestEvents).toBe(0);
  });

  // ── Bug #6 regression cluster (2026-06-18) ──────────────────────────────
  //
  // Operational rule confirmed by Suneel: once a vehicle is dispatched, ALL
  // orders (walk-in OR regular) added via "+ Add to Trip" come from the
  // float stock already on the truck. The depot was fully debited at first
  // dispatch via the manifest's float event. preflightAddToTrip must NOT
  // write per-order dispatch events — that would double-debit depot.
  //
  // Bug #2 (commit fc12e04) handled the walk-in subset. These tests pin
  // the broader rule: ALL mid-trip orders skip the per-order dispatch
  // event, AND first-dispatch (preflightDispatch) STILL writes them for
  // regular orders so we don't accidentally regress the depot accounting
  // on a fresh trip.

  /** Helper: seed a dispatched trip with a float manifest so the DVA is in
   * loaded_and_dispatched, ready for preflightAddToTrip calls. */
  async function dispatchFloatTrip(totalLoaded: number) {
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded }], adminUserId,
    );
    await preflightDispatch({
      distributorId: DIST, driverId, assignmentDate: TEST_DATE, userId: adminUserId,
    });
  }

  it('BUG #6 — regular order added mid-trip via preflightAddToTrip writes NO dispatch event', async () => {
    // Setup: dispatched trip with 10-fulls manifest, no orders yet.
    await dispatchFloatTrip(10);
    const customer = await prisma.customer.findFirstOrThrow({
      where: { distributorId: DIST, deletedAt: null, customerType: 'B2C' },
      select: { id: true },
    });
    // Count dispatch events that exist BEFORE we add the mid-trip order.
    // Should be 1: the float manifest event from initial dispatch.
    const eventsBefore = await prisma.inventoryEvent.count({
      where: {
        distributorId: DIST,
        eventType: 'dispatch',
        eventDate: new Date(TEST_DATE),
      },
    });
    expect(eventsBefore).toBe(1);

    // Office adds a fresh regular order mid-trip.
    const newOrder = await prisma.order.create({
      data: {
        orderNumber: `TEST-A2T-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST,
        customerId: customer.id,
        driverId,
        vehicleId,
        orderDate: new Date(TEST_DATE),
        deliveryDate: new Date(TEST_DATE),
        status: 'pending_dispatch',
        orderSource: 'regular',
        totalAmount: 1000,
        items: {
          create: [{ cylinderTypeId, quantity: 2, unitPrice: 500, totalPrice: 1000 }],
        },
      },
    });
    // Admin clicks "+ Add to Trip" → preflightAddToTrip
    const result = await preflightAddToTrip({
      distributorId: DIST, driverId, assignmentDate: TEST_DATE, userId: adminUserId,
    });
    expect(result.summary.succeeded).toBe(1);

    // Order moved to pending_delivery
    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: newOrder.id } });
    expect(fresh.status).toBe('pending_delivery');

    // CRITICAL: dispatch event count is UNCHANGED. The order's cylinders
    // came from float, not from depot — no new depot debit.
    const eventsAfter = await prisma.inventoryEvent.count({
      where: {
        distributorId: DIST,
        eventType: 'dispatch',
        eventDate: new Date(TEST_DATE),
      },
    });
    expect(eventsAfter).toBe(eventsBefore);

    // No order-keyed dispatch event for this newOrder specifically
    const orderDispatchEvents = await prisma.inventoryEvent.count({
      where: {
        distributorId: DIST,
        eventType: 'dispatch',
        referenceType: 'order',
        referenceId: newOrder.id,
      },
    });
    expect(orderDispatchEvents).toBe(0);
  });

  it('BUG #6 — walk-in via preflightAddToTrip also writes NO dispatch event (existing Bug #2 still holds)', async () => {
    await dispatchFloatTrip(10);
    const customer = await prisma.customer.findFirstOrThrow({
      where: { distributorId: DIST, deletedAt: null, customerType: 'B2C' },
      select: { id: true },
    });
    const walkInOrder = await prisma.order.create({
      data: {
        orderNumber: `TEST-WIA2T-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST,
        customerId: customer.id,
        driverId,
        vehicleId,
        orderDate: new Date(TEST_DATE),
        deliveryDate: new Date(TEST_DATE),
        status: 'pending_dispatch',
        orderSource: 'walk_in',
        totalAmount: 500,
        items: { create: [{ cylinderTypeId, quantity: 1, unitPrice: 500, totalPrice: 500 }] },
      },
    });
    await preflightAddToTrip({
      distributorId: DIST, driverId, assignmentDate: TEST_DATE, userId: adminUserId,
    });
    const orderDispatchEvents = await prisma.inventoryEvent.count({
      where: {
        distributorId: DIST,
        eventType: 'dispatch',
        referenceType: 'order',
        referenceId: walkInOrder.id,
      },
    });
    expect(orderDispatchEvents).toBe(0);
  });

  it('BUG #6 negative control — first dispatch (preflightDispatch) STILL writes dispatch event for regular orders (no regression)', async () => {
    // Critical guard against over-applying the Bug #6 fix to the initial
    // dispatch path. preflightDispatch runs with DVA.status='dispatch_ready',
    // which IS the moment fresh cylinders genuinely leave depot — those
    // dispatch events must fire.
    const customer = await prisma.customer.findFirstOrThrow({
      where: { distributorId: DIST, deletedAt: null, customerType: 'B2C' },
      select: { id: true },
    });
    const order = await prisma.order.create({
      data: {
        orderNumber: `TEST-FD-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST,
        customerId: customer.id,
        driverId,
        vehicleId,
        orderDate: new Date(TEST_DATE),
        deliveryDate: new Date(TEST_DATE),
        status: 'pending_dispatch',
        orderSource: 'regular',
        totalAmount: 1000,
        items: { create: [{ cylinderTypeId, quantity: 2, unitPrice: 500, totalPrice: 1000 }] },
      },
    });
    await preflightDispatch({
      distributorId: DIST, driverId, assignmentDate: TEST_DATE, userId: adminUserId,
    });
    const orderDispatchEvents = await prisma.inventoryEvent.findMany({
      where: {
        distributorId: DIST,
        eventType: 'dispatch',
        referenceType: 'order',
        referenceId: order.id,
      },
    });
    expect(orderDispatchEvents).toHaveLength(1);
    expect(orderDispatchEvents[0].fullsChange).toBe(-2);
  });

  it('BUG #6 inventory balance — dispatch + add-to-trip + deliver = depot debited exactly once for float', async () => {
    // End-to-end ledger check. Seed opening=100 on the day before, dispatch
    // float-only=10, add-to-trip a regular order qty=4, deliver it.
    // Depot should be debited by exactly 10 (the float), NOT 14.
    const PRIOR = new Date(PRIOR_DATE);
    await prisma.inventoryEvent.create({
      data: {
        distributorId: DIST, cylinderTypeId,
        eventType: 'initial_balance', fullsChange: 100, emptiesChange: 0,
        eventDate: PRIOR, createdBy: adminUserId,
      },
    });
    const { recalculateSummariesFromDate } = await import('../../services/inventoryService.js');
    await recalculateSummariesFromDate(DIST, cylinderTypeId, PRIOR);

    await dispatchFloatTrip(10);
    const customer = await prisma.customer.findFirstOrThrow({
      where: { distributorId: DIST, deletedAt: null, customerType: 'B2C' },
      select: { id: true },
    });
    await prisma.order.create({
      data: {
        orderNumber: `TEST-LDG-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST, customerId: customer.id, driverId, vehicleId,
        orderDate: new Date(TEST_DATE), deliveryDate: new Date(TEST_DATE),
        status: 'pending_dispatch', orderSource: 'regular', totalAmount: 2000,
        items: { create: [{ cylinderTypeId, quantity: 4, unitPrice: 500, totalPrice: 2000 }] },
      },
    });
    await preflightAddToTrip({
      distributorId: DIST, driverId, assignmentDate: TEST_DATE, userId: adminUserId,
    });
    const summary = await prisma.inventorySummary.findUnique({
      where: {
        distributorId_cylinderTypeId_summaryDate: {
          distributorId: DIST, cylinderTypeId, summaryDate: new Date(TEST_DATE),
        },
      },
    });
    expect(summary).not.toBeNull();
    // openingFulls = 100. Float dispatched = 10. The add-to-trip wrote NO
    // dispatch event, so dispatchedQty stays at 10 (not 14).
    expect(summary!.openingFulls).toBe(100);
    expect(summary!.dispatchedQty).toBe(10);
  });
});
