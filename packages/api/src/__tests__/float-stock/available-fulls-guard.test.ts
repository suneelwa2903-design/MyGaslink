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

  it('BUG #4 CASE 1 — DVA rolled to trip 2: float still available (manifest at trip 1)', async () => {
    // Manifest written at trip 1 (floatQty=8). DVA then rolls to trip 2
    // (regular order added + dispatched mid-day). Original code keyed the
    // manifest lookup on `tripNumber: effectiveTrip` (=2) → manifest miss
    // → returned 0 → driver could not create walk-ins despite physical
    // fulls on the truck. Fix: lookup ignores tripNumber.
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 10 }], adminUserId,
    );
    // Simulate roll: bump DVA to trip 2 + loaded_and_dispatched (mimics what
    // preflightDispatch does when a fresh order comes in after trip 1
    // completed delivery).
    await prisma.driverVehicleAssignment.update({
      where: { id: dvaId },
      data: { tripNumber: 2, status: 'loaded_and_dispatched', dispatchedAt: new Date() },
    });
    // Plant a regular pending_delivery order at trip 2 so resolveEffectiveTrip
    // resolves to 2 (latest with content).
    await prisma.order.create({
      data: {
        orderNumber: `TEST-AF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST, customerId, driverId, vehicleId,
        orderDate: todayMidnight, deliveryDate: todayMidnight,
        status: 'pending_delivery', orderSource: 'regular', tripNumber: 2, totalAmount: 1000,
        items: { create: [{ cylinderTypeId, quantity: 2, unitPrice: 500, totalPrice: 1000 }] },
      },
    });
    const avail = await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId);
    expect(avail).toBe(10); // floatQty (10) − no walk-ins = 10
  });

  it('BUG #4 CASE 2 — walk-ins span trip roll: trip-1 walk-in still counted against float', async () => {
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 10 }], adminUserId,
    );
    // Walk-in taken at trip 1
    await prisma.order.create({
      data: {
        orderNumber: `TEST-AF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST, customerId, driverId, vehicleId,
        orderDate: todayMidnight, deliveryDate: todayMidnight,
        status: 'pending_delivery', orderSource: 'walk_in', tripNumber: 1, totalAmount: 1500,
        items: { create: [{ cylinderTypeId, quantity: 3, unitPrice: 500, totalPrice: 1500 }] },
      },
    });
    // DVA rolls to trip 2
    await prisma.driverVehicleAssignment.update({
      where: { id: dvaId },
      data: { tripNumber: 2, status: 'loaded_and_dispatched', dispatchedAt: new Date() },
    });
    const avail = await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId);
    expect(avail).toBe(7); // floatQty 10 − walk-in 3 (across all trips) = 7
  });

  it('BUG #4 CASE 3 — regular orders never subtract from float pool', async () => {
    // Create 10 pending_dispatch regular orders BEFORE manifest so they
    // snapshot into orderedQty (10). floatQty = totalLoaded − orderedQty.
    // With totalLoaded=18, orderedQty=10 → floatQty=8.
    // Then promote those orders to pending_delivery (representing dispatched
    // state). They are REGULAR orders, so they must NOT subtract from
    // available — float is 8, unchanged.
    for (let i = 0; i < 10; i++) {
      await prisma.order.create({
        data: {
          orderNumber: `TEST-AF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
          distributorId: DIST, customerId, driverId, vehicleId,
          orderDate: todayMidnight, deliveryDate: todayMidnight,
          status: 'pending_dispatch', orderSource: 'regular', tripNumber: 1, totalAmount: 500,
          items: { create: [{ cylinderTypeId, quantity: 1, unitPrice: 500, totalPrice: 500 }] },
        },
      });
    }
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 18 }], adminUserId,
    );
    // Promote all 10 to pending_delivery (mid-trip / post-dispatch)
    await prisma.order.updateMany({
      where: { distributorId: DIST, deliveryDate: todayMidnight, orderSource: 'regular' },
      data: { status: 'pending_delivery' },
    });
    const avail = await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId);
    expect(avail).toBe(8); // floatQty 8, no walk-ins → 8
  });
});
