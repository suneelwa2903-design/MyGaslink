import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, loginAsFinance, today } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let financeToken: string;

const TEST_DRIVER_NAME = 'TEST Driver Alpha';
const TEST_VEHICLE_NUMBER = 'TEST-AA-9999';

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;
  financeToken = (await loginAsFinance()).token;
});

afterAll(async () => {
  // Clean up rows we created (cascade through child tables first).
  const drivers = await prisma.driver.findMany({
    where: { driverName: TEST_DRIVER_NAME, distributorId: 'dist-001' },
    select: { id: true },
  });
  const vehicles = await prisma.vehicle.findMany({
    where: { vehicleNumber: TEST_VEHICLE_NUMBER, distributorId: 'dist-001' },
    select: { id: true },
  });

  if (drivers.length > 0) {
    const driverIds = drivers.map((d) => d.id);
    await prisma.driverVehicleAssignment.deleteMany({ where: { driverId: { in: driverIds } } });
    await prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
  }
  if (vehicles.length > 0) {
    const vehicleIds = vehicles.map((v) => v.id);
    await prisma.vehicleInventory.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
    await prisma.driverVehicleAssignment.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
    await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
  }
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('Drivers — Auth', () => {
  it('rejects unauthenticated GET / with 401', async () => {
    const res = await request(app).get('/api/drivers');
    expect(res.status).toBe(401);
  });

  it('rejects POST for non-admin role (403)', async () => {
    const res = await request(app)
      .post('/api/drivers')
      .set(auth(financeToken))
      .send({ driverName: 'X', phone: '9999999999' });
    expect(res.status).toBe(403);
  });
});

describe('Drivers — CRUD', () => {
  let driverId: string;

  it('creates a driver', async () => {
    const res = await request(app)
      .post('/api/drivers')
      .set(auth(adminToken))
      .send({
        driverName: TEST_DRIVER_NAME,
        phone: '9100000111',
        licenseNumber: 'TEST-LIC-001',
        employmentType: 'permanent',
      });
    if (res.status !== 201) console.log('create driver error:', res.body);
    expect(res.status).toBe(201);
    expect(res.body.data.driverName).toBe(TEST_DRIVER_NAME);
    expect(res.body.data.distributorId).toBe('dist-001');
    driverId = res.body.data.driverId;
  });

  it('rejects POST with missing required fields (400)', async () => {
    const res = await request(app)
      .post('/api/drivers')
      .set(auth(adminToken))
      .send({ /* missing driverName + phone */ });
    expect(res.status).toBe(400);
  });

  it('lists drivers scoped to caller distributor', async () => {
    const res = await request(app).get('/api/drivers').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.drivers)).toBe(true);
    for (const d of res.body.data.drivers) {
      expect(d.distributorId).toBe('dist-001');
    }
  });

  it('fetches a driver by id', async () => {
    const res = await request(app).get(`/api/drivers/${driverId}`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.driverId).toBe(driverId);
  });

  it('updates a driver', async () => {
    const res = await request(app)
      .put(`/api/drivers/${driverId}`)
      .set(auth(adminToken))
      .send({ availableToday: false });
    expect(res.status).toBe(200);
    expect(res.body.data.availableToday).toBe(false);
  });

  it('soft-deletes a driver', async () => {
    const res = await request(app).delete(`/api/drivers/${driverId}`).set(auth(adminToken));
    expect(res.status).toBe(200);

    // Should drop from list
    const list = await request(app).get('/api/drivers').set(auth(adminToken));
    const found = list.body.data.drivers.find((d: { driverId: string }) => d.driverId === driverId);
    expect(found).toBeUndefined();
  });
});

describe('Drivers — Tenant Isolation', () => {
  it('cannot fetch a driver from another distributor (404)', async () => {
    const dist2Driver = await prisma.driver.findFirst({
      where: { distributorId: 'dist-002', deletedAt: null },
    });
    if (!dist2Driver) throw new Error('Seed expected a dist-002 driver');

    const res = await request(app)
      .get(`/api/drivers/${dist2Driver.id}`)
      .set(auth(adminToken));
    expect(res.status).toBe(404);
  });

  it('cannot update a driver from another distributor', async () => {
    const dist2Driver = await prisma.driver.findFirst({
      where: { distributorId: 'dist-002', deletedAt: null },
    });
    if (!dist2Driver) throw new Error('Seed expected a dist-002 driver');

    const res = await request(app)
      .put(`/api/drivers/${dist2Driver.id}`)
      .set(auth(adminToken))
      .send({ availableToday: false });
    expect([403, 404]).toContain(res.status);
  });
});

describe('Vehicles — Auth & CRUD', () => {
  let vehicleId: string;

  it('rejects unauthenticated GET with 401', async () => {
    const res = await request(app).get('/api/vehicles');
    expect(res.status).toBe(401);
  });

  it('creates a vehicle', async () => {
    const res = await request(app)
      .post('/api/vehicles')
      .set(auth(adminToken))
      .send({
        vehicleNumber: TEST_VEHICLE_NUMBER,
        vehicleType: 'Truck',
        capacity: 75,
      });
    if (res.status !== 201) console.log('create vehicle error:', res.body);
    expect(res.status).toBe(201);
    expect(res.body.data.vehicleNumber).toBe(TEST_VEHICLE_NUMBER);
    expect(res.body.data.distributorId).toBe('dist-001');
    vehicleId = res.body.data.vehicleId;
  });

  it('rejects POST with missing vehicleNumber (400)', async () => {
    const res = await request(app)
      .post('/api/vehicles')
      .set(auth(adminToken))
      .send({ vehicleType: 'Truck' });
    expect(res.status).toBe(400);
  });

  it('rejects duplicate vehicleNumber (409)', async () => {
    const res = await request(app)
      .post('/api/vehicles')
      .set(auth(adminToken))
      .send({ vehicleNumber: TEST_VEHICLE_NUMBER, vehicleType: 'Tempo' });
    expect(res.status).toBe(409);
  });

  it('lists vehicles scoped to caller distributor', async () => {
    const res = await request(app).get('/api/vehicles').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.vehicles)).toBe(true);
    for (const v of res.body.data.vehicles) {
      expect(v.distributorId).toBe('dist-001');
    }
  });

  it('updates a vehicle', async () => {
    const res = await request(app)
      .put(`/api/vehicles/${vehicleId}`)
      .set(auth(adminToken))
      .send({ capacity: 100 });
    expect(res.status).toBe(200);
    expect(res.body.data.capacity).toBe(100);
  });

  it('soft-deletes a vehicle', async () => {
    const res = await request(app).delete(`/api/vehicles/${vehicleId}`).set(auth(adminToken));
    expect(res.status).toBe(200);
  });
});

describe('Vehicles — Tenant Isolation', () => {
  it('cannot fetch a vehicle from another distributor (404)', async () => {
    const dist2Vehicle = await prisma.vehicle.findFirst({
      where: { distributorId: 'dist-002', deletedAt: null },
    });
    if (!dist2Vehicle) throw new Error('Seed expected a dist-002 vehicle');

    const res = await request(app)
      .get(`/api/vehicles/${dist2Vehicle.id}`)
      .set(auth(adminToken));
    expect(res.status).toBe(404);
  });
});

describe('Driver-Vehicle Assignment — happy path', () => {
  it('assigns a vehicle to a driver and lists it back', async () => {
    // Pull the seeded driver + vehicle (Raju + TS09-AB-1234) — those are
    // dedicated to dist-001 in seed.ts.
    const seedDriver = await prisma.driver.findFirstOrThrow({
      where: { distributorId: 'dist-001', driverName: 'Suresh Babu', deletedAt: null },
    });
    const seedVehicle = await prisma.vehicle.findFirstOrThrow({
      where: { distributorId: 'dist-001', vehicleNumber: 'TS09-CD-5678', deletedAt: null },
    });

    // Pick a date a year in the future to avoid colliding with the seed
    // assignments which use today's date.
    const future = new Date();
    future.setFullYear(future.getFullYear() + 1);
    const futureStr = future.toISOString().split('T')[0];

    const res = await request(app)
      .post('/api/drivers/assignments')
      .set(auth(adminToken))
      .send({
        driverId: seedDriver.id,
        vehicleId: seedVehicle.id,
        assignmentDate: futureStr,
      });
    if (res.status !== 201) console.log('assignment create error:', res.body);
    expect(res.status).toBe(201);
    expect(res.body.data.driverId).toBe(seedDriver.id);
    expect(res.body.data.vehicleId).toBe(seedVehicle.id);

    // Cleanup
    await prisma.driverVehicleAssignment.deleteMany({
      where: { driverId: seedDriver.id, assignmentDate: future },
    });
  });

  // Note: today's used by helpers — kept as import so vitest doesn't warn
  it('today() helper yields a valid ISO date', () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
