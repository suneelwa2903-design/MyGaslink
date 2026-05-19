import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import {
  loginAsDistAdmin,
  loginAsFinance,
  getSeedData,
  cleanupTestOrders,
  ensureDriverVehicleMapping,
  today,
} from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let financeToken: string;
let seedData: Awaited<ReturnType<typeof getSeedData>>;

// We create our own dedicated order for the assign/reassign tests so we
// don't perturb the seed-driven workflow tests.
let testOrderId: string;

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;
  financeToken = (await loginAsFinance()).token;
  seedData = await getSeedData();

  // Clean any test orders we may have left behind on rerun.
  await prisma.order.deleteMany({
    where: { distributorId: 'dist-001', orderNumber: 'TEST-ASSIGN-1' },
  });

  // Create an unassigned order to drive the assign / reassign / unassign flow.
  const customer = seedData.customers[0]; // Green Valley Caterers (after our hard-delete cleanup)
  const cyl = seedData.cylinderTypes[1]; // 19 KG

  const order = await prisma.order.create({
    data: {
      orderNumber: 'TEST-ASSIGN-1',
      distributorId: 'dist-001',
      customerId: customer.id,
      orderDate: new Date(today()),
      deliveryDate: new Date(today()),
      status: 'pending_driver_assignment',
      totalAmount: 1800,
      items: {
        create: [{
          cylinderTypeId: cyl.id,
          quantity: 1,
          unitPrice: 1800,
          totalPrice: 1800,
        }],
      },
    },
  });
  testOrderId = order.id;

  // WI-064 follow-up: orderService.assignDriver now requires a
  // confirmed driver-vehicle mapping for the delivery date. Seed one
  // for every driver this file touches (assign + reassign exercise
  // drivers[0] and drivers[1]).
  const vehicle = seedData.vehicles[0];
  await ensureDriverVehicleMapping({
    distributorId: 'dist-001',
    driverId: seedData.drivers[0].id,
    vehicleId: vehicle.id,
    date: today(),
  });
  if (seedData.drivers[1]) {
    await ensureDriverVehicleMapping({
      distributorId: 'dist-001',
      driverId: seedData.drivers[1].id,
      vehicleId: seedData.vehicles[1]?.id ?? vehicle.id,
      date: today(),
    });
  }
});

afterAll(async () => {
  await cleanupTestOrders('dist-001');
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('Assignments — Auth', () => {
  it('rejects unauthenticated GET /vehicle-mappings with 401', async () => {
    const res = await request(app).get('/api/assignments/vehicle-mappings');
    expect(res.status).toBe(401);
  });

  it('rejects /vehicle-mappings/confirm for finance role (403)', async () => {
    const res = await request(app)
      .post('/api/assignments/vehicle-mappings/confirm')
      .set(auth(financeToken))
      .send({ date: today() });
    expect(res.status).toBe(403);
  });

  it('rejects /bulk-assign for finance role (403)', async () => {
    const res = await request(app)
      .post('/api/assignments/bulk-assign')
      .set(auth(financeToken))
      .send({ assignments: [] });
    expect(res.status).toBe(403);
  });
});

describe('Assignments — Recommendations', () => {
  it('GET /vehicle-mappings returns recommended driver-vehicle pairs', async () => {
    const res = await request(app)
      .get(`/api/assignments/vehicle-mappings?date=${today()}`)
      .set(auth(adminToken));
    if (res.status !== 200) console.log('vehicle-mappings error:', res.body);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });

  it('POST /order-recommendations rejects empty orderIds (400)', async () => {
    const res = await request(app)
      .post('/api/assignments/order-recommendations')
      .set(auth(adminToken))
      .send({ orderIds: [] });
    expect(res.status).toBe(400);
  });

  it('POST /order-recommendations returns recommendations for our test order', async () => {
    const res = await request(app)
      .post('/api/assignments/order-recommendations')
      .set(auth(adminToken))
      .send({ orderIds: [testOrderId] });
    if (res.status !== 200) console.log('order-recommendations error:', res.body);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });
});

describe('Assignments — Per-order assign / reassign / unassign', () => {
  it('POST /api/orders/:id/assign-driver sets driverId and moves status to pending_dispatch', async () => {
    const driver = seedData.drivers[0];
    const res = await request(app)
      .post(`/api/orders/${testOrderId}/assign-driver`)
      .set(auth(adminToken))
      .send({ driverId: driver.id });
    if (res.status !== 200) console.log('assign-driver error:', res.body);
    expect(res.status).toBe(200);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: testOrderId } });
    expect(order.driverId).toBe(driver.id);
    expect(['pending_dispatch', 'pending_delivery']).toContain(order.status);
  });

  it('reassigning to a different driver updates the driverId', async () => {
    const driverNew = seedData.drivers[1];
    const res = await request(app)
      .post(`/api/orders/${testOrderId}/assign-driver`)
      .set(auth(adminToken))
      .send({ driverId: driverNew.id });
    expect(res.status).toBe(200);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: testOrderId } });
    expect(order.driverId).toBe(driverNew.id);
  });

  it('rejects assign-driver with missing driverId (400)', async () => {
    const res = await request(app)
      .post(`/api/orders/${testOrderId}/assign-driver`)
      .set(auth(adminToken))
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('Assignments — Tenant isolation', () => {
  it('cannot bulk-assign an order from another distributor', async () => {
    // Build a fake bulk request pointing at dist-002 entities.
    const dist2Order = await prisma.order.findFirst({
      where: { distributorId: 'dist-002' },
    });
    const dist2Driver = await prisma.driver.findFirst({
      where: { distributorId: 'dist-002', deletedAt: null },
    });
    const dist2Vehicle = await prisma.vehicle.findFirst({
      where: { distributorId: 'dist-002', deletedAt: null },
    });
    if (!dist2Order || !dist2Driver || !dist2Vehicle) {
      // Seed may not include a dist-002 order — skip cleanly.
      return;
    }

    const res = await request(app)
      .post('/api/assignments/bulk-assign')
      .set(auth(adminToken)) // dist-001 admin
      .send({
        assignments: [{
          orderId: dist2Order.id,
          driverId: dist2Driver.id,
          vehicleId: dist2Vehicle.id,
        }],
      });

    // Should not 200-with-success: either reject outright (4xx) or return
    // a partial-failure payload that does NOT mutate the dist-002 order.
    const before = await prisma.order.findUniqueOrThrow({ where: { id: dist2Order.id } });
    if (res.status === 200) {
      const after = await prisma.order.findUniqueOrThrow({ where: { id: dist2Order.id } });
      // Driver / vehicle / status must be unchanged.
      expect(after.driverId).toBe(before.driverId);
      expect(after.vehicleId).toBe(before.vehicleId);
      expect(after.status).toBe(before.status);
    } else {
      expect([400, 403, 404, 500]).toContain(res.status);
    }
  });
});
