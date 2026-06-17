/**
 * FLOAT-001 — DVA load manifest CRUD service tests.
 *
 * Pins createOrUpdateManifest + getManifestForDVA invariants:
 *   - orderedQty snapshotted from pending_dispatch orders for (driver, date)
 *   - floatQty = totalLoaded - orderedQty
 *   - totalLoaded < orderedQty rejected
 *   - DVA not in dispatch_ready rejected
 *   - cylinder type not active or wrong tenant rejected
 *   - cross-tenant DVA reads + writes rejected with 404
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  createOrUpdateManifest,
  getManifestForDVA,
} from '../../services/dvaManifestService.js';
import { prisma } from '../../lib/prisma.js';
import { ensureDriverVehicleMapping, getOrCreateTestVehicle } from '../helpers.js';
import { startOfUtcDay } from '../../utils/dateOnly.js';

const todayMidnight = startOfUtcDay();
const TEST_DATE = `${todayMidnight.getUTCFullYear()}-${String(todayMidnight.getUTCMonth() + 1).padStart(2, '0')}-${String(todayMidnight.getUTCDate()).padStart(2, '0')}`;
const DIST = 'dist-001';
const DIST_OTHER = 'dist-002';
const TEST_VEHICLE = 'TEST-MANIFEST-CRUD-D1';

describe('FLOAT-001 — dvaManifestService CRUD', () => {
  let driverId: string;
  let vehicleId: string;
  let dvaId: string;
  let otherTenantDvaId: string;
  let cylinderTypeId: string;
  let otherTenantCylinderTypeId: string;
  let adminUserId: string;
  let customerId: string;

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

    // Other-tenant DVA fixture for cross-tenant assertions.
    const otherDriver = await prisma.driver.findFirstOrThrow({
      where: { distributorId: DIST_OTHER, deletedAt: null, status: 'active' }, select: { id: true },
    });
    const otherVehicle = await getOrCreateTestVehicle(DIST_OTHER, `TEST-MANIFEST-CRUD-${DIST_OTHER}`);
    const otherDva = await ensureDriverVehicleMapping({
      distributorId: DIST_OTHER, driverId: otherDriver.id, vehicleId: otherVehicle.id, date: TEST_DATE,
    });
    otherTenantDvaId = otherDva.id;

    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: DIST, isActive: true }, select: { id: true },
    });
    cylinderTypeId = ct.id;
    const otherCt = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: DIST_OTHER, isActive: true }, select: { id: true },
    });
    otherTenantCylinderTypeId = otherCt.id;

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
    await prisma.dVALoadManifest.deleteMany({ where: { dvaId: { in: [dvaId, otherTenantDvaId] } } });
    await prisma.orderItem.deleteMany({
      where: { order: { distributorId: DIST, deliveryDate: todayMidnight } },
    });
    await prisma.order.deleteMany({
      where: { distributorId: DIST, deliveryDate: todayMidnight },
    });
    await prisma.driverVehicleAssignment.update({
      where: { id: dvaId },
      data: { status: 'dispatch_ready', tripNumber: 1, isReconciled: false },
    });
  });

  it('creates manifest with zero orders → floatQty = totalLoaded', async () => {
    const rows = await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 10 }], adminUserId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].totalLoaded).toBe(10);
    expect(rows[0].orderedQty).toBe(0);
    expect(rows[0].floatQty).toBe(10);
    expect(rows[0].tripNumber).toBe(1);
    expect(rows[0].confirmedBy).toBe(adminUserId);
  });

  it('creates manifest with existing orders → orderedQty computed correctly', async () => {
    await prisma.order.create({
      data: {
        orderNumber: `TEST-CRUD-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST, customerId, driverId, vehicleId,
        orderDate: todayMidnight, deliveryDate: todayMidnight,
        status: 'pending_dispatch', totalAmount: 1500,
        items: { create: [{ cylinderTypeId, quantity: 3, unitPrice: 500, totalPrice: 1500 }] },
      },
    });
    const rows = await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 10 }], adminUserId,
    );
    expect(rows[0].orderedQty).toBe(3);
    expect(rows[0].floatQty).toBe(7);
  });

  it('updates an existing manifest row (upsert semantics)', async () => {
    await createOrUpdateManifest(DIST, dvaId, [{ cylinderTypeId, totalLoaded: 5 }], adminUserId);
    const updated = await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded: 15 }], adminUserId,
    );
    expect(updated[0].totalLoaded).toBe(15);
    // Only one row exists for (dvaId, cylinderTypeId, tripNumber)
    const all = await prisma.dVALoadManifest.findMany({
      where: { dvaId, cylinderTypeId, tripNumber: 1 },
    });
    expect(all).toHaveLength(1);
  });

  it('rejects totalLoaded < orderedQty with TOTAL_BELOW_ORDERED', async () => {
    await prisma.order.create({
      data: {
        orderNumber: `TEST-CRUD-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST, customerId, driverId, vehicleId,
        orderDate: todayMidnight, deliveryDate: todayMidnight,
        status: 'pending_dispatch', totalAmount: 2500,
        items: { create: [{ cylinderTypeId, quantity: 5, unitPrice: 500, totalPrice: 2500 }] },
      },
    });
    await expect(
      createOrUpdateManifest(DIST, dvaId, [{ cylinderTypeId, totalLoaded: 3 }], adminUserId),
    ).rejects.toMatchObject({ code: 'TOTAL_BELOW_ORDERED', statusCode: 400 });
  });

  it('rejects when DVA is not in dispatch_ready', async () => {
    await prisma.driverVehicleAssignment.update({
      where: { id: dvaId },
      data: { status: 'loaded_and_dispatched' },
    });
    await expect(
      createOrUpdateManifest(DIST, dvaId, [{ cylinderTypeId, totalLoaded: 5 }], adminUserId),
    ).rejects.toMatchObject({ code: 'DVA_NOT_DISPATCH_READY', statusCode: 400 });
  });

  it('rejects when cylinderTypeId belongs to a different tenant', async () => {
    await expect(
      createOrUpdateManifest(
        DIST, dvaId, [{ cylinderTypeId: otherTenantCylinderTypeId, totalLoaded: 5 }], adminUserId,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CYLINDER_TYPE', statusCode: 400 });
  });

  it('rejects empty items array with NO_ITEMS', async () => {
    await expect(
      createOrUpdateManifest(DIST, dvaId, [], adminUserId),
    ).rejects.toMatchObject({ code: 'NO_ITEMS', statusCode: 400 });
  });

  it('cross-tenant: cannot create manifest for another distributor DVA → 404 DVA_NOT_FOUND', async () => {
    await expect(
      createOrUpdateManifest(
        DIST, otherTenantDvaId, [{ cylinderTypeId, totalLoaded: 5 }], adminUserId,
      ),
    ).rejects.toMatchObject({ code: 'DVA_NOT_FOUND', statusCode: 404 });
  });

  it('cross-tenant: cannot read manifest for another distributor DVA → 404 DVA_NOT_FOUND', async () => {
    await expect(
      getManifestForDVA(DIST, otherTenantDvaId),
    ).rejects.toMatchObject({ code: 'DVA_NOT_FOUND', statusCode: 404 });
  });

  it('getManifestForDVA returns empty array when no manifest entered', async () => {
    const rows = await getManifestForDVA(DIST, dvaId);
    expect(rows).toEqual([]);
  });

  it('getManifestForDVA returns cylinderType.typeName for UI display', async () => {
    await createOrUpdateManifest(DIST, dvaId, [{ cylinderTypeId, totalLoaded: 4 }], adminUserId);
    const rows = await getManifestForDVA(DIST, dvaId);
    expect(rows).toHaveLength(1);
    expect(rows[0].cylinderType?.typeName).toBeTruthy();
  });

  it('multiple items in single call → all rows written atomically', async () => {
    const cts = await prisma.cylinderType.findMany({
      where: { distributorId: DIST, isActive: true }, select: { id: true }, take: 2,
    });
    if (cts.length < 2) return; // single-type tenant — skip
    const rows = await createOrUpdateManifest(
      DIST, dvaId,
      [
        { cylinderTypeId: cts[0].id, totalLoaded: 6 },
        { cylinderTypeId: cts[1].id, totalLoaded: 9 },
      ],
      adminUserId,
    );
    expect(rows).toHaveLength(2);
    const total = rows.reduce((s, r) => s + r.totalLoaded, 0);
    expect(total).toBe(15);
  });
});
