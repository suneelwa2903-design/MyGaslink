/**
 * FLOAT-001 — available-fulls formula unit tests on the service.
 *
 * Pins getAvailableFullsForDriver invariants used both by
 * POST /drivers/me/orders (hard cap on walk-in quantity) and by
 * GET /drivers/me/trip-stock (per-type availableFulls badge on mobile):
 *
 *   availableFulls(type) =
 *     manifest.totalLoaded
 *       − Σ OrderItem.quantity  (IN_FLIGHT)
 *       − Σ OrderItem.deliveredQuantity  (TERMINAL)
 *
 * Returns 0 cleanly when: no active DVA, no manifest row for the type,
 * DVA reconciled. Clamped at 0 (never negative).
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

  it('subtracts pending order quantities (IN_FLIGHT)', async () => {
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
        status: 'pending_delivery',
        tripNumber: 1,
        totalAmount: 1500,
        items: { create: [{ cylinderTypeId, quantity: 3, unitPrice: 500, totalPrice: 1500 }] },
      },
    });
    const avail = await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId);
    expect(avail).toBe(7);
  });

  it('subtracts delivered quantities (TERMINAL)', async () => {
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

  it('handles mixed pending + delivered correctly', async () => {
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 10 }], adminUserId,
    );
    await prisma.order.create({
      data: {
        orderNumber: `TEST-AF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST, customerId, driverId, vehicleId,
        orderDate: todayMidnight, deliveryDate: todayMidnight,
        status: 'pending_delivery', tripNumber: 1, totalAmount: 1000,
        items: { create: [{ cylinderTypeId, quantity: 2, unitPrice: 500, totalPrice: 1000 }] },
      },
    });
    await prisma.order.create({
      data: {
        orderNumber: `TEST-AF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST, customerId, driverId, vehicleId,
        orderDate: todayMidnight, deliveryDate: todayMidnight,
        status: 'delivered', tripNumber: 1, totalAmount: 500,
        items: {
          create: [{ cylinderTypeId, quantity: 1, deliveredQuantity: 1, unitPrice: 500, totalPrice: 500 }],
        },
      },
    });
    // 10 - 2 (pending) - 1 (delivered) = 7
    expect(await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId)).toBe(7);
  });

  it('never returns negative — clamped at 0', async () => {
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 2 }], adminUserId,
    );
    await prisma.order.create({
      data: {
        orderNumber: `TEST-AF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST, customerId, driverId, vehicleId,
        orderDate: todayMidnight, deliveryDate: todayMidnight,
        status: 'delivered', tripNumber: 1, totalAmount: 2500,
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

  it('excludeOrderId drops that order from the sums', async () => {
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 10 }], adminUserId,
    );
    const order = await prisma.order.create({
      data: {
        orderNumber: `TEST-AF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST, customerId, driverId, vehicleId,
        orderDate: todayMidnight, deliveryDate: todayMidnight,
        status: 'pending_delivery', tripNumber: 1, totalAmount: 1500,
        items: { create: [{ cylinderTypeId, quantity: 3, unitPrice: 500, totalPrice: 1500 }] },
      },
    });
    const withOrder = await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId);
    expect(withOrder).toBe(7);
    const withoutOrder = await getAvailableFullsForDriver(DIST, driverId, cylinderTypeId, order.id);
    expect(withoutOrder).toBe(10);
  });
});
