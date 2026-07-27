// 2026-07-27 — Fix 3 guard: reportsService.vehicleLedger() must:
//   1. Surface backdated-trip events (manual_adjustment + backdated_inventory_adjustment)
//      with driver/vehicle attribution resolved via the parent Order.
//   2. Surface float dispatches (dispatch + dva_load_manifest) with attribution via DVA.
//   3. Surface godown/mini-op dispatches with the correct bucket.
//   4. NOT surface bare manual_adjustment rows (referenceType=null) — those
//      are Adjust-Stock corrections, not trips.
//
// See feedback and the prod audit at commit context for the referenceType
// distribution that motivated this scoping.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { vehicleLedger } from '../services/reportsService.js';
import { getSeedData } from './helpers.js';

// Anti-pattern #7 — far-future date to avoid contaminating shared-dev-DB
// manual test data. Any date in this test picks a bucket real live data
// never occupies.
const TEST_DATE = new Date('2099-12-31T00:00:00.000Z');
const TEST_DATE_STR = '2099-12-31';

let ctx: {
  distributorId: string;
  cylinderTypeId: string;
  driverId: string;
  driverName: string;
  vehicleId: string;
  vehicleNumber: string;
};

const createdOrderIds: string[] = [];
const createdDvaIds: string[] = [];
const createdManifestIds: string[] = [];
const createdCseIds: string[] = [];

beforeAll(async () => {
  const seed = await getSeedData();
  const cyl = seed.cylinderTypes.find((c) => c.typeName.includes('19')) ?? seed.cylinderTypes[0];
  const driver = seed.drivers[0];
  const vehicle = seed.vehicles[0];
  ctx = {
    distributorId: seed.distributor.id,
    cylinderTypeId: cyl.id,
    driverId: driver.id,
    driverName: driver.driverName,
    vehicleId: vehicle.id,
    vehicleNumber: vehicle.vehicleNumber,
  };
});

afterAll(async () => {
  // Clean up in dependency order — events → manifests → DVAs → orders → CSEs
  await prisma.inventoryEvent.deleteMany({
    where: {
      distributorId: ctx.distributorId,
      eventDate: TEST_DATE,
    },
  });
  if (createdManifestIds.length) {
    await prisma.dVALoadManifest.deleteMany({ where: { id: { in: createdManifestIds } } });
  }
  if (createdCseIds.length) {
    await prisma.cancelledStockEvent.deleteMany({ where: { id: { in: createdCseIds } } });
  }
  if (createdDvaIds.length) {
    await prisma.driverVehicleAssignment.deleteMany({ where: { id: { in: createdDvaIds } } });
  }
  if (createdOrderIds.length) {
    await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  }
});

/** Create a delivered Order and return its id. Used as the reference target
 *  for backdated / godown / mini-op events. */
async function seedOrder(overrides: { isGodownPickup?: boolean; orderNumberSuffix: string }): Promise<string> {
  const customer = await prisma.customer.findFirstOrThrow({
    where: { distributorId: ctx.distributorId, deletedAt: null },
  });
  const order = await prisma.order.create({
    data: {
      distributorId: ctx.distributorId,
      customerId: customer.id,
      orderNumber: `TEST-VL-${overrides.orderNumberSuffix}-${Date.now()}`,
      orderType: 'delivery',
      status: 'delivered',
      orderDate: TEST_DATE,
      deliveryDate: TEST_DATE,
      driverId: overrides.isGodownPickup ? null : ctx.driverId,
      vehicleId: overrides.isGodownPickup ? null : ctx.vehicleId,
      tripNumber: overrides.isGodownPickup ? null : 1,
      isGodownPickup: overrides.isGodownPickup ?? false,
      items: {
        create: [{
          cylinderTypeId: ctx.cylinderTypeId,
          quantity: 10,
          deliveredQuantity: 10,
          emptiesCollected: 10,
          unitPrice: 1180,
          totalPrice: 11800,
        }],
      },
    },
  });
  createdOrderIds.push(order.id);
  return order.id;
}

async function seedDVA(): Promise<string> {
  const dva = await prisma.driverVehicleAssignment.create({
    data: {
      distributorId: ctx.distributorId,
      driverId: ctx.driverId,
      vehicleId: ctx.vehicleId,
      assignmentDate: TEST_DATE,
      tripNumber: 42,
      status: 'dispatch_ready',
    },
  });
  createdDvaIds.push(dva.id);
  return dva.id;
}

describe('reportsService.vehicleLedger — Fix 3 attribution scenarios', () => {
  it('backdated trip (manual_adjustment + backdated_inventory_adjustment) surfaces with Order → driver/vehicle attribution', async () => {
    const orderId = await seedOrder({ orderNumberSuffix: 'BACKDATED' });
    await prisma.inventoryEvent.create({
      data: {
        distributorId: ctx.distributorId,
        cylinderTypeId: ctx.cylinderTypeId,
        eventType: 'manual_adjustment',
        fullsChange: -10,
        emptiesChange: 0,
        eventDate: TEST_DATE,
        referenceId: orderId,
        referenceType: 'backdated_inventory_adjustment',
        notes: 'Backdated test',
        createdBy: (await prisma.user.findFirstOrThrow({ where: { distributorId: ctx.distributorId } })).id,
      },
    });

    const res = await vehicleLedger(ctx.distributorId, {
      dateFrom: TEST_DATE_STR,
      dateTo: TEST_DATE_STR,
      groupBy: 'day',
    });
    const ourRow = res.rows.find((r) => (r as { driverName: string }).driverName === ctx.driverName);
    expect(ourRow, 'backdated trip should appear as a movement row').toBeDefined();
    expect((ourRow as { vehicleNumber: string }).vehicleNumber).toBe(ctx.vehicleNumber);
    // manual_adjustment counts as fullsDelivered (see switch case).
    expect((ourRow as { fullsDelivered: number }).fullsDelivered).toBe(10);
  });

  it('bare manual_adjustment (referenceType=null) is EXCLUDED — Adjust Stock corrections are not trips', async () => {
    await prisma.inventoryEvent.create({
      data: {
        distributorId: ctx.distributorId,
        cylinderTypeId: ctx.cylinderTypeId,
        eventType: 'manual_adjustment',
        fullsChange: -5,
        emptiesChange: 0,
        eventDate: TEST_DATE,
        referenceId: null,
        referenceType: null,
        notes: 'Bare stock correction — must not appear in vehicle ledger',
        createdBy: (await prisma.user.findFirstOrThrow({ where: { distributorId: ctx.distributorId } })).id,
      },
    });

    const res = await vehicleLedger(ctx.distributorId, {
      dateFrom: TEST_DATE_STR,
      dateTo: TEST_DATE_STR,
      groupBy: 'day',
    });
    // Sum of every row's fullsDelivered on this date should NOT include the −5 correction.
    // We seeded 10 (backdated) in the previous test; the correction is another 5 that must be filtered out.
    const totalDelivered = res.rows.reduce((s, r) => s + ((r as { fullsDelivered: number }).fullsDelivered ?? 0), 0);
    expect(totalDelivered, 'null-refType manual_adjustment must not contribute').toBe(10);
  });

  it('float dispatch (dispatch + dva_load_manifest) resolves vehicle/driver via DVA → manifest', async () => {
    const dvaId = await seedDVA();
    const manifest = await prisma.dVALoadManifest.create({
      data: {
        distributorId: ctx.distributorId,
        dvaId,
        cylinderTypeId: ctx.cylinderTypeId,
        tripNumber: 42,
        totalLoaded: 20,
        orderedQty: 15,
        floatQty: 5,
        confirmedBy: (await prisma.user.findFirstOrThrow({ where: { distributorId: ctx.distributorId } })).id,
      },
    });
    createdManifestIds.push(manifest.id);

    await prisma.inventoryEvent.create({
      data: {
        distributorId: ctx.distributorId,
        cylinderTypeId: ctx.cylinderTypeId,
        eventType: 'dispatch',
        fullsChange: -5,
        emptiesChange: 0,
        eventDate: TEST_DATE,
        referenceId: manifest.id,
        referenceType: 'dva_load_manifest',
        notes: 'Float dispatch test',
        createdBy: (await prisma.user.findFirstOrThrow({ where: { distributorId: ctx.distributorId } })).id,
      },
    });

    const res = await vehicleLedger(ctx.distributorId, {
      dateFrom: TEST_DATE_STR,
      dateTo: TEST_DATE_STR,
      groupBy: 'trip',
    });
    // Find the trip-42 row (float dispatches sit on their own trip number).
    const floatRow = res.rows.find((r) => (r as { tripNumber: number | string }).tripNumber === 42);
    expect(floatRow, 'float dispatch should surface as a trip row').toBeDefined();
    expect((floatRow as { vehicleNumber: string }).vehicleNumber).toBe(ctx.vehicleNumber);
    expect((floatRow as { driverName: string }).driverName).toBe(ctx.driverName);
    expect((floatRow as { fullsDispatched: number }).fullsDispatched).toBe(5);
  });

  it('godown pickup renders as the synthetic "GODOWN" / "Godown Pickup" bucket, not a real driver', async () => {
    const orderId = await seedOrder({ isGodownPickup: true, orderNumberSuffix: 'GODOWN' });
    await prisma.inventoryEvent.create({
      data: {
        distributorId: ctx.distributorId,
        cylinderTypeId: ctx.cylinderTypeId,
        eventType: 'dispatch',
        fullsChange: -10,
        emptiesChange: 0,
        eventDate: TEST_DATE,
        referenceId: orderId,
        referenceType: 'godown_pickup',
        notes: 'Godown dispatch test',
        createdBy: (await prisma.user.findFirstOrThrow({ where: { distributorId: ctx.distributorId } })).id,
      },
    });

    const res = await vehicleLedger(ctx.distributorId, {
      dateFrom: TEST_DATE_STR,
      dateTo: TEST_DATE_STR,
      groupBy: 'day',
    });
    const godownRow = res.rows.find((r) => (r as { vehicleNumber: string }).vehicleNumber === 'GODOWN');
    expect(godownRow, 'godown pickup should render as GODOWN bucket').toBeDefined();
    expect((godownRow as { driverName: string }).driverName).toBe('Godown Pickup');
    expect((godownRow as { fullsDispatched: number }).fullsDispatched).toBe(10);
  });
});
