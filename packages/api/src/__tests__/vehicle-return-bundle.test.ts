/**
 * Bundle-2 + 1F integration tests:
 *  - getVehiclesPendingReconciliation now returns per-CSE detail
 *    (`pendingCancelledStockLines`) with joined order/item data for the
 *    inline display on the Vehicle Return card.
 *  - preflightAddToTrip writes a `dispatch` event AND immediately recomputes
 *    the daily summary (mirror of the WI-129 fix on preflightDispatch) so the
 *    Daily Summary's "Dispatched" / "In-Flight" columns update at dispatch
 *    time on BOTH paths.
 *
 * All fixtures use dist-001 (GST disabled — no NIC) on a far-future date so
 * the shared dev DB stays clean.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { getVehiclesPendingReconciliation } from '../services/deliveryWorkflowService.js';
import { getOrCreateTestVehicle } from './helpers.js';

const DIST = 'dist-001';
const TEST_DATE = new Date('2099-12-23');

let cylTypeId: string;
let vehicleId: string;
let driverId: string;
let customerId: string;
let orderId: string;

beforeAll(async () => {
  process.env.INVENTORY_DISPATCH_DEBIT = 'true';
  const cyl = await prisma.cylinderType.create({
    data: { distributorId: DIST, typeName: `VR-BUNDLE-${Date.now()}`, capacity: 19, hsnCode: '27111900' },
  });
  cylTypeId = cyl.id;
  const vehicle = await getOrCreateTestVehicle(DIST, `VR-BUNDLE-${String(Date.now()).slice(-6)}`);
  vehicleId = vehicle.id;
  await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: 'returned' } });
  const driver = await prisma.driver.create({
    data: { distributorId: DIST, driverName: `VR Bundle Driver ${Date.now()}`, phone: `9${String(Date.now()).slice(-9)}` },
  });
  driverId = driver.id;
  const customer = await prisma.customer.create({
    data: { distributorId: DIST, customerName: `VR Bundle Cust ${Date.now()}`, phone: `8${String(Date.now()).slice(-9)}` },
  });
  customerId = customer.id;
  // A partially-delivered order — ordered 5, delivered 2, shortfall 3 on vehicle.
  const order = await prisma.order.create({
    data: {
      orderNumber: `VR-BUNDLE-${Date.now()}`,
      distributorId: DIST, customerId, driverId, vehicleId,
      orderDate: TEST_DATE, deliveryDate: TEST_DATE,
      status: 'modified_delivered',
      items: {
        create: [{
          cylinderTypeId: cylTypeId,
          quantity: 5,
          deliveredQuantity: 2,
          unitPrice: 1000,
          discountPerUnit: 0,
          totalPrice: 5000,
        }],
      },
    },
  });
  orderId = order.id;
  await prisma.cancelledStockEvent.create({
    data: {
      orderId, vehicleId, driverId, cylinderTypeId: cylTypeId, distributorId: DIST,
      quantity: 3, cancellationDate: TEST_DATE, status: 'on_vehicle',
    },
  });
});

afterAll(async () => {
  await prisma.cancelledStockEvent.deleteMany({ where: { orderId } });
  await prisma.inventoryEvent.deleteMany({ where: { distributorId: DIST, cylinderTypeId: cylTypeId } });
  await prisma.inventorySummary.deleteMany({ where: { distributorId: DIST, cylinderTypeId: cylTypeId } });
  await prisma.orderItem.deleteMany({ where: { orderId } });
  await prisma.order.deleteMany({ where: { id: orderId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.driver.deleteMany({ where: { id: driverId } });
  await prisma.vehicle.deleteMany({ where: { id: vehicleId } });
  await prisma.cylinderType.deleteMany({ where: { id: cylTypeId } });
});

describe('1F — preflightAddToTrip recompute symmetry', () => {
  // dist-001 (GST disabled) → preflight skips NIC and just transitions to
  // pending_delivery. We pre-build the "active trip" state (DVA in
  // loaded_and_dispatched + one order already pending_delivery), then call
  // preflightAddToTrip on a fresh pending_dispatch order and assert the
  // snapshot picks up the new dispatch BEFORE any delivery confirms it.
  let addCylTypeId: string;
  let addVehicleId: string;
  let addDriverId: string;
  let addCustomerId: string;
  let addExistingOrderId: string;
  let addNewOrderId: string;
  let addDvaId: string;
  const ADD_DATE = new Date('2099-12-22');
  const ADD_DATE_STR = '2099-12-22';

  beforeAll(async () => {
    const cyl = await prisma.cylinderType.create({
      data: { distributorId: DIST, typeName: `ADD-TRIP-${Date.now()}`, capacity: 19, hsnCode: '27111900' },
    });
    addCylTypeId = cyl.id;
    const v = await getOrCreateTestVehicle(DIST, `ADD-TRIP-${String(Date.now()).slice(-6)}`);
    addVehicleId = v.id;
    const drv = await prisma.driver.create({
      data: { distributorId: DIST, driverName: `Add-Trip Driver ${Date.now()}`, phone: `7${String(Date.now()).slice(-9)}` },
    });
    addDriverId = drv.id;
    const cust = await prisma.customer.create({
      data: { distributorId: DIST, customerName: `Add-Trip Cust ${Date.now()}`, phone: `6${String(Date.now()).slice(-9)}` },
    });
    addCustomerId = cust.id;
    // DVA already loaded_and_dispatched (i.e., a trip is mid-flight).
    const dva = await prisma.driverVehicleAssignment.create({
      data: { driverId: addDriverId, vehicleId: addVehicleId, distributorId: DIST, assignmentDate: ADD_DATE, tripNumber: 1, status: 'loaded_and_dispatched' },
    });
    addDvaId = dva.id;
    // Order already in-flight (pending_delivery) on this trip — preflightAddToTrip's
    // in-flight guard requires at least one.
    const existing = await prisma.order.create({
      data: {
        orderNumber: `ADD-TRIP-EXISTING-${Date.now()}`,
        distributorId: DIST, customerId: addCustomerId, driverId: addDriverId, vehicleId: addVehicleId,
        orderDate: ADD_DATE, deliveryDate: ADD_DATE,
        status: 'pending_delivery',
        tripNumber: 1,
        items: { create: [{ cylinderTypeId: addCylTypeId, quantity: 2, unitPrice: 1000, discountPerUnit: 0, totalPrice: 2000 }] },
      },
    });
    addExistingOrderId = existing.id;
    // The new order to be added to the trip.
    const newOrd = await prisma.order.create({
      data: {
        orderNumber: `ADD-TRIP-NEW-${Date.now()}`,
        distributorId: DIST, customerId: addCustomerId, driverId: addDriverId,
        orderDate: ADD_DATE, deliveryDate: ADD_DATE,
        status: 'pending_dispatch',
        items: { create: [{ cylinderTypeId: addCylTypeId, quantity: 3, unitPrice: 1000, discountPerUnit: 0, totalPrice: 3000 }] },
      },
    });
    addNewOrderId = newOrd.id;
  });

  afterAll(async () => {
    await prisma.inventoryEvent.deleteMany({ where: { distributorId: DIST, cylinderTypeId: addCylTypeId } });
    await prisma.inventorySummary.deleteMany({ where: { distributorId: DIST, cylinderTypeId: addCylTypeId } });
    await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: [addExistingOrderId, addNewOrderId] } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: [addExistingOrderId, addNewOrderId] } } });
    await prisma.order.deleteMany({ where: { id: { in: [addExistingOrderId, addNewOrderId] } } });
    await prisma.driverVehicleAssignment.deleteMany({ where: { id: addDvaId } });
    await prisma.customer.deleteMany({ where: { id: addCustomerId } });
    await prisma.driver.deleteMany({ where: { id: addDriverId } });
    await prisma.vehicle.deleteMany({ where: { id: addVehicleId } });
    await prisma.cylinderType.deleteMany({ where: { id: addCylTypeId } });
  });

  it('writes dispatch event AND recomputes summary on the same path as preflightDispatch', async () => {
    // setup.ts `beforeEach` deletes INVENTORY_DISPATCH_DEBIT before every test
    // for safety; re-set it inside this test (this is the flag the dispatch-
    // debit branch in transitionToPendingDelivery reads).
    process.env.INVENTORY_DISPATCH_DEBIT = 'true';
    try {
      const { preflightAddToTrip } = await import('../services/gst/gstPreflightService.js');
      await preflightAddToTrip({ distributorId: DIST, driverId: addDriverId, assignmentDate: ADD_DATE_STR, userId: 'add-trip-test' });

      // The dispatch event for the new order's 3 cylinders must exist.
      const dispatchEvents = await prisma.inventoryEvent.findMany({
        where: { distributorId: DIST, eventType: 'dispatch', referenceId: addNewOrderId },
      });
      expect(dispatchEvents).toHaveLength(1);
      expect(dispatchEvents[0].fullsChange).toBe(-3);

      // And — the key assertion — the snapshot reflects the dispatch IMMEDIATELY
      // (before any delivery), proving the recompute fired on the add-to-trip
      // path (closing the WI-129 asymmetry).
      const summary = await prisma.inventorySummary.findFirst({
        where: { distributorId: DIST, cylinderTypeId: addCylTypeId, summaryDate: ADD_DATE },
      });
      expect(summary).toBeTruthy();
      expect(summary!.dispatchedQty).toBeGreaterThanOrEqual(3);
      expect(summary!.deliveredQty).toBe(0); // no delivery yet
    } finally {
      delete process.env.INVENTORY_DISPATCH_DEBIT;
    }
  });
});

describe('2B — getVehiclesPendingReconciliation enrichment', () => {
  it('returns pendingCancelledStockLines with joined ordered/delivered/shortfall per CSE', async () => {
    const pending = await getVehiclesPendingReconciliation(DIST);
    const row = pending.find((v) => v.vehicleId === vehicleId);
    expect(row).toBeTruthy();
    expect(Array.isArray(row!.pendingCancelledStockLines)).toBe(true);
    const line = row!.pendingCancelledStockLines.find((l) => l.cylinderTypeId === cylTypeId);
    expect(line).toBeTruthy();
    expect(line!.orderedQty).toBe(5);
    expect(line!.deliveredQty).toBe(2);
    expect(line!.shortfallQty).toBe(3);
    expect(line!.cylinderTypeName).toMatch(/^VR-BUNDLE-/);
    expect(line!.status).toBe('on_vehicle');
    expect(line!.orderNumber).toContain('VR-BUNDLE-');
  });
});
