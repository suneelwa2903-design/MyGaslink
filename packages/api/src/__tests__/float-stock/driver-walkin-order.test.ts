/**
 * FLOAT-001 — Phase 6: driver walk-in order route + customer-search permission.
 *
 * Pins the contract for POST /api/drivers/me/orders:
 *   - 201 success: order created + preflight succeeded
 *   - 207 partial: order created + preflight failed (driver flow continues)
 *   - 400 INSUFFICIENT_VEHICLE_STOCK: requested qty > availableFulls
 *   - 400 NO_ACTIVE_TRIP: DVA not in loaded_and_dispatched
 *   - 400 INVALID_DATE: deliveryDate != today
 *   - 403 CUSTOMER_NOT_FOUND: cross-tenant customer
 *   - GET /api/customers now permits driver role (tenant-scoped).
 *   - Created orders carry orderSource='walk_in'.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { createOrUpdateManifest } from '../../services/dvaManifestService.js';
import { preflightDispatch } from '../../services/gst/gstPreflightService.js';
import {
  ensureDriverVehicleMapping,
  getOrCreateTestVehicle,
  generateToken,
  loginAsDistAdmin,
} from '../helpers.js';
import { startOfUtcDay } from '../../utils/dateOnly.js';
import { UserRole } from '@gaslink/shared';
import type { Express } from 'express';

const todayMidnight = startOfUtcDay();
const TEST_DATE = `${todayMidnight.getUTCFullYear()}-${String(todayMidnight.getUTCMonth() + 1).padStart(2, '0')}-${String(todayMidnight.getUTCDate()).padStart(2, '0')}`;
const DIST = 'dist-001';
const DIST_OTHER = 'dist-002';
const TEST_VEHICLE = 'TEST-WALKIN-D1';

let app: Express;
let driverId: string;
let driverUserId: string;
let driverToken: string;
let adminToken: string;
let vehicleId: string;
let dvaId: string;
let cylinderTypeId: string;
let customerId: string;
let otherTenantCustomerId: string;
let adminUserId: string;

describe('FLOAT-001 — POST /api/drivers/me/orders + driver customer search', () => {
  beforeEach(() => {
    process.env.INVENTORY_DISPATCH_DEBIT = 'true';
  });

  beforeAll(async () => {
    app = createApp();

    const adminLogin = await loginAsDistAdmin();
    adminToken = adminLogin.token;
    adminUserId = adminLogin.user.id;

    // Resolve driver + bind a User account with a matching phone (the
    // resolveDriverFromUser helper used by /me/* routes matches on phone).
    const driver = await prisma.driver.findFirstOrThrow({
      where: { distributorId: DIST, deletedAt: null, status: 'active' },
      select: { id: true, phone: true },
    });
    driverId = driver.id;
    // Find or create a User row with the driver's phone for this tenant.
    let user = await prisma.user.findFirst({
      where: { distributorId: DIST, role: UserRole.DRIVER, phone: driver.phone ?? undefined, deletedAt: null },
      select: { id: true, email: true },
    });
    if (!user) {
      const bcrypt = await import('bcryptjs');
      const hash = await bcrypt.hash('TestDriver@123', 10);
      user = await prisma.user.create({
        data: {
          email: `test-walkin-driver-${Date.now()}@test.local`,
          passwordHash: hash,
          firstName: 'WalkIn', lastName: 'Test',
          phone: driver.phone ?? '9900000000',
          role: UserRole.DRIVER,
          status: 'active',
          distributorId: DIST,
          requiresPasswordReset: false,
        },
        select: { id: true, email: true },
      });
    }
    driverUserId = user.id;
    driverToken = generateToken({
      userId: driverUserId, email: user.email, role: UserRole.DRIVER,
      distributorId: DIST, customerId: null,
    });

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
    const customer = await prisma.customer.findFirstOrThrow({
      where: { distributorId: DIST, deletedAt: null, customerType: 'B2C' }, select: { id: true },
    });
    customerId = customer.id;
    const otherTenantCust = await prisma.customer.findFirstOrThrow({
      where: { distributorId: DIST_OTHER, deletedAt: null }, select: { id: true },
    });
    otherTenantCustomerId = otherTenantCust.id;
  });

  afterEach(async () => {
    // Wipe today's orders + manifest + events
    await prisma.inventoryEvent.deleteMany({
      where: { distributorId: DIST, eventDate: todayMidnight },
    });
    await prisma.inventorySummary.deleteMany({
      where: { distributorId: DIST, summaryDate: todayMidnight },
    });
    await prisma.dVALoadManifest.deleteMany({ where: { dvaId } });
    await prisma.cancelledStockEvent.deleteMany({ where: { distributorId: DIST, vehicleId } });
    await prisma.driverAssignment.deleteMany({
      where: { order: { distributorId: DIST, deliveryDate: todayMidnight } },
    });
    await prisma.orderItem.deleteMany({
      where: { order: { distributorId: DIST, deliveryDate: todayMidnight } },
    });
    await prisma.orderStatusLog.deleteMany({
      where: { order: { distributorId: DIST, deliveryDate: todayMidnight } },
    });
    await prisma.invoice.deleteMany({
      where: { order: { distributorId: DIST, deliveryDate: todayMidnight } },
    });
    await prisma.gstDocument.deleteMany({
      where: { order: { distributorId: DIST, deliveryDate: todayMidnight } },
    });
    await prisma.order.deleteMany({
      where: { distributorId: DIST, deliveryDate: todayMidnight },
    });
    await prisma.driverVehicleAssignment.update({
      where: { id: dvaId },
      data: {
        status: 'dispatch_ready', tripNumber: 1,
        dispatchedAt: null, returnedAt: null, reconciledAt: null, isReconciled: false,
        tripSheetNo: null, tripSheetGeneratedAt: null,
        tripSheetNo2: null, tripSheetNo2GeneratedAt: null,
      },
    });
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: 'idle' } });
  });

  /** Helper: dispatch the trip with a float-only manifest so the DVA is in
   * loaded_and_dispatched ready to accept walk-in orders. */
  async function dispatchFloatTrip(totalLoaded: number) {
    await createOrUpdateManifest(
      DIST, dvaId, [{ cylinderTypeId, totalLoaded }], adminUserId,
    );
    await preflightDispatch({
      distributorId: DIST, driverId, assignmentDate: TEST_DATE, userId: adminUserId,
    });
  }

  it('POST /drivers/me/orders: 201 on success — order created with orderSource=walk_in', async () => {
    await dispatchFloatTrip(10);
    const res = await request(app)
      .post('/api/drivers/me/orders')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        customerId, cylinderTypeId, quantity: 2, deliveryDate: TEST_DATE, paymentMode: 'cash',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.preflightStatus).toBe('success');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.data.orderId } });
    expect(order.orderSource).toBe('walk_in');
    expect(order.driverId).toBe(driverId);
    expect(order.vehicleId).toBe(vehicleId);
  });

  it('POST /drivers/me/orders: 400 INSUFFICIENT_VEHICLE_STOCK when qty > availableFulls', async () => {
    await dispatchFloatTrip(3);
    const res = await request(app)
      .post('/api/drivers/me/orders')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ customerId, cylinderTypeId, quantity: 5, deliveryDate: TEST_DATE });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSUFFICIENT_VEHICLE_STOCK');
    expect(res.body.error).toMatch(/requested 5/);
    expect(res.body.error).toMatch(/only 3 available/);
  });

  it('POST /drivers/me/orders: qty exactly equals availableFulls → succeeds', async () => {
    await dispatchFloatTrip(4);
    const res = await request(app)
      .post('/api/drivers/me/orders')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ customerId, cylinderTypeId, quantity: 4, deliveryDate: TEST_DATE });
    expect(res.status).toBe(201);
  });

  it('POST /drivers/me/orders: 400 NO_ACTIVE_TRIP when DVA still in dispatch_ready', async () => {
    // Manifest entered but NO dispatch — DVA stays dispatch_ready
    await createOrUpdateManifest(DIST, dvaId, [{ cylinderTypeId, totalLoaded: 5 }], adminUserId);
    const res = await request(app)
      .post('/api/drivers/me/orders')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ customerId, cylinderTypeId, quantity: 1, deliveryDate: TEST_DATE });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_ACTIVE_TRIP');
  });

  it('POST /drivers/me/orders: 400 INVALID_DATE when deliveryDate is not today', async () => {
    await dispatchFloatTrip(5);
    const res = await request(app)
      .post('/api/drivers/me/orders')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ customerId, cylinderTypeId, quantity: 1, deliveryDate: '2099-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  it('POST /drivers/me/orders: 403 CUSTOMER_NOT_FOUND for cross-tenant customer', async () => {
    await dispatchFloatTrip(5);
    const res = await request(app)
      .post('/api/drivers/me/orders')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        customerId: otherTenantCustomerId, cylinderTypeId, quantity: 1, deliveryDate: TEST_DATE,
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CUSTOMER_NOT_FOUND');
  });

  it('POST /drivers/me/orders: 400 when manifest has zero availableFulls (no manifest at all)', async () => {
    // No manifest, no orders → DVA in dispatch_ready → fails NO_ACTIVE_TRIP first
    const res = await request(app)
      .post('/api/drivers/me/orders')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ customerId, cylinderTypeId, quantity: 1, deliveryDate: TEST_DATE });
    expect(res.status).toBe(400);
  });

  it('GET /api/customers permits driver role (tenant-scoped)', async () => {
    const res = await request(app)
      .get('/api/customers?limit=5')
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.customers)).toBe(true);
    for (const c of res.body.data.customers) {
      // Driver only sees its tenant's customers — implicit from listCustomers
      // signature using distributorId from JWT.
      expect(c).toHaveProperty('customerId');
    }
  });

  it('POST /api/customers still REJECTS driver role (mutations stay gated)', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ customerName: 'Rejected Walk-in', phone: '9100000001' });
    expect(res.status).toBe(403);
  });

  it('Auth: POST /drivers/me/orders requires driver role (admin token → 403)', async () => {
    await dispatchFloatTrip(5);
    const res = await request(app)
      .post('/api/drivers/me/orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ customerId, cylinderTypeId, quantity: 1, deliveryDate: TEST_DATE });
    expect(res.status).toBe(403);
  });

  it('REGRESSION 2026-06-18 #5 — walk-in succeeds after DVA rolled to trip 2 (manifest at trip 1)', async () => {
    // Live user repro 2026-06-18 ~21:00 IST, dist-002 Sharma:
    //   1. Manifest 10 float on trip 1, dispatched → DVA at trip 1 loaded_and_dispatched
    //   2. Admin added a fresh regular order mid-trip → DVA rolled to trip 2
    //   3. Driver tried walk-in qty=3 → 207 with preflightError=NO_ACTIVE_TRIP
    // OSHD2627000654 was created but stuck in pending_dispatch, no gst_documents.
    // Root cause: preflightAddToTrip's floatManifestExists guard
    // (gstPreflightService.ts:590) filtered by tripNumber=mapping.tripNumber
    // (=2). Manifest was at trip 1 → count returned 0 → guard threw
    // NO_ACTIVE_TRIP before any WhiteBooks call. Same bug class as Step 2.5
    // (Bug #1) and getAvailableFullsForDriver (Bug #4) — fixed by dropping
    // the tripNumber filter. One DVA = one truck = one float pool.
    await dispatchFloatTrip(10);
    // Simulate the trip roll that prod would do when admin dispatches a fresh
    // regular order mid-trip via preflightDispatch's roll path.
    await prisma.driverVehicleAssignment.update({
      where: { id: dvaId },
      data: { tripNumber: 2, status: 'loaded_and_dispatched' },
    });
    // Plant a pending_delivery regular order at trip 2 so resolveEffectiveTrip
    // resolves to 2 (the post-roll state).
    await prisma.order.create({
      data: {
        orderNumber: `TEST-ROLL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        distributorId: DIST,
        customerId,
        driverId,
        vehicleId,
        orderDate: todayMidnight,
        deliveryDate: todayMidnight,
        status: 'pending_delivery',
        orderSource: 'regular',
        tripNumber: 2,
        totalAmount: 1000,
        items: { create: [{ cylinderTypeId, quantity: 2, unitPrice: 500, totalPrice: 1000 }] },
      },
    });
    // Walk-in from the driver mobile — before the fix this returned 207 with
    // preflightError=NO_ACTIVE_TRIP.
    const res = await request(app)
      .post('/api/drivers/me/orders')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ customerId, cylinderTypeId, quantity: 3, deliveryDate: TEST_DATE });
    // Bhargava is GST-disabled so preflight short-circuits to success (no
    // WhiteBooks call). 201 confirms the floatManifestExists guard now sees
    // the trip-1 manifest and allows the add.
    expect(res.status).toBe(201);
    expect(res.body.data.preflightStatus).toBe('success');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.data.orderId } });
    expect(order.orderSource).toBe('walk_in');
    // tripNumber stamped at preflight time — should match the current DVA trip
    expect(order.tripNumber).toBe(2);
  });

  it('GET /api/manifests/dva/:dvaId returns manifest for the DVA (driver allowed)', async () => {
    await createOrUpdateManifest(DIST, dvaId, [{ cylinderTypeId, totalLoaded: 7 }], adminUserId);
    const res = await request(app)
      .get(`/api/manifests/dva/${dvaId}`)
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.manifest).toHaveLength(1);
    expect(res.body.data.manifest[0].totalLoaded).toBe(7);
    expect(res.body.data.manifest[0].floatQty).toBe(7);
  });

  it('POST /api/manifests creates manifest (admin), rejects driver (403)', async () => {
    const allowed = await request(app)
      .post('/api/manifests')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ dvaId, items: [{ cylinderTypeId, totalLoaded: 5 }] });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.manifest[0].totalLoaded).toBe(5);

    const denied = await request(app)
      .post('/api/manifests')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ dvaId, items: [{ cylinderTypeId, totalLoaded: 9 }] });
    expect(denied.status).toBe(403);
  });
});
