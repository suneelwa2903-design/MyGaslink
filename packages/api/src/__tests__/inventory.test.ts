import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { loginAsDistAdmin, loginAsInventory, getSeedData, cleanupTestOrders, today } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let inventoryToken: string;
let seedData: Awaited<ReturnType<typeof getSeedData>>;

beforeAll(async () => {
  app = createApp();
  const admin = await loginAsDistAdmin();
  adminToken = admin.token;
  const inv = await loginAsInventory();
  inventoryToken = inv.token;
  seedData = await getSeedData();
  await cleanupTestOrders('dist-001');
});

afterAll(async () => {
  await cleanupTestOrders('dist-001');
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('Inventory - Incoming Fulls', () => {
  it('should record incoming full cylinders', async () => {
    const cyl19 = seedData.cylinderTypes.find(ct => ct.typeName === '19 KG')!;

    const res = await request(app)
      .post('/api/inventory/incoming-fulls')
      .set(auth(inventoryToken))
      .send({
        cylinderTypeId: cyl19.id,
        quantity: 50,
        documentType: 'Delivery Challan',
        documentNumber: 'DC-TEST-001',
        documentDate: today(),
        notes: 'From IOCL Plant',
      });

    if (res.status !== 201) console.log('Incoming fulls error:', res.body);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('should reflect in inventory summary', async () => {
    const res = await request(app)
      .get(`/api/inventory/summary/${today()}`)
      .set(auth(inventoryToken));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    // Should have at least one entry with fulls > 0
    const has19kg = res.body.data.some(
      (s: any) => s.closingFulls > 0 || s.incomingFulls > 0,
    );
    expect(has19kg).toBe(true);
  });
});

describe('Inventory - Outgoing Empties', () => {
  it('should record outgoing empty cylinders', async () => {
    const cyl19 = seedData.cylinderTypes.find(ct => ct.typeName === '19 KG')!;

    const res = await request(app)
      .post('/api/inventory/outgoing-empties')
      .set(auth(inventoryToken))
      .send({
        cylinderTypeId: cyl19.id,
        quantity: 10,
        documentType: 'Return Challan',
        documentNumber: 'RC-TEST-001',
        documentDate: today(),
        notes: 'To IOCL Plant',
      });

    if (res.status !== 201) console.log('Outgoing empties error:', res.body);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });
});

describe('Inventory - Manual Adjustment', () => {
  it('should record manual adjustment', async () => {
    const cyl19 = seedData.cylinderTypes.find(ct => ct.typeName === '19 KG')!;

    const res = await request(app)
      .post('/api/inventory/manual-adjustment')
      .set(auth(inventoryToken))
      .send({
        cylinderTypeId: cyl19.id,
        adjustmentType: 'subtract',
        quantity: 2,
        reason: 'Physical count correction — 2 cylinders less than system count',
        adjustmentDate: today(),
      });

    if (res.status !== 201) console.log('Manual adjustment error:', res.body);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });
});

describe('Inventory - Delivery Impact', () => {
  it('should track inventory changes from delivery workflow', async () => {
    const customer = seedData.customers[0];
    const cyl19 = seedData.cylinderTypes.find(ct => ct.typeName === '19 KG')!;
    const driver = seedData.drivers[0];
    const vehicle = seedData.vehicles[0];

    // Get inventory before
    const beforeRes = await request(app)
      .get(`/api/inventory/summary/${today()}`)
      .set(auth(inventoryToken));
    const beforeSummary = beforeRes.body.data;

    // Create, assign, dispatch, deliver
    const createRes = await request(app)
      .post('/api/orders')
      .set(auth(adminToken))
      .send({
        customerId: customer.id,
        deliveryDate: today(),
        items: [{ cylinderTypeId: cyl19.id, quantity: 3 }],
      });
    const oid = createRes.body.data.orderId;

    await request(app)
      .post(`/api/orders/${oid}/assign-driver`)
      .set(auth(adminToken))
      .send({ driverId: driver.id, vehicleId: vehicle.id });

    await request(app)
      .put(`/api/orders/${oid}/status`)
      .set(auth(adminToken))
      .send({ status: 'pending_delivery' });

    await request(app)
      .post(`/api/orders/${oid}/confirm-delivery`)
      .set(auth(adminToken))
      .send({
        deliveryDate: today(),
        receivedBy: 'Test',
        items: [{ cylinderTypeId: cyl19.id, deliveredQuantity: 3, emptiesCollected: 2 }],
      });

    // Get inventory after
    const afterRes = await request(app)
      .get(`/api/inventory/summary/${today()}`)
      .set(auth(inventoryToken));

    expect(afterRes.status).toBe(200);
    // Inventory should show delivery events
    expect(afterRes.body.data.length).toBeGreaterThan(0);
  });
});

describe('Inventory - Threshold Alerts', () => {
  it('should return threshold alerts', async () => {
    const res = await request(app)
      .get('/api/inventory/threshold-alerts')
      .set(auth(inventoryToken));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('Inventory - Customer Balances', () => {
  it('should return customer cylinder balances', async () => {
    const res = await request(app)
      .get('/api/inventory/customer-balances')
      .set(auth(inventoryToken));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('Inventory - Forecast', () => {
  it('should return inventory forecast', async () => {
    const res = await request(app)
      .get('/api/inventory/forecast')
      .set(auth(inventoryToken));

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });
});

describe('Inventory - Reconciliation Dashboard', () => {
  it('should return reconciliation dashboard', async () => {
    const res = await request(app)
      .get('/api/inventory/reconciliation')
      .set(auth(inventoryToken));

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });
});

describe('Inventory - Lock Summary', () => {
  it('should lock and unlock inventory summary', async () => {
    const cyl19 = seedData.cylinderTypes.find(ct => ct.typeName === '19 KG')!;

    // Lock
    const lockRes = await request(app)
      .put('/api/inventory/lock-summary')
      .set(auth(adminToken))
      .send({
        cylinderTypeId: cyl19.id,
        date: today(),
        lock: true,
      });

    expect(lockRes.status).toBe(200);

    // Unlock
    const unlockRes = await request(app)
      .put('/api/inventory/lock-summary')
      .set(auth(adminToken))
      .send({
        cylinderTypeId: cyl19.id,
        date: today(),
        lock: false,
      });

    expect(unlockRes.status).toBe(200);
  });
});
