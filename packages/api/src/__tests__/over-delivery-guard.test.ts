/**
 * over-delivery-guard.test.ts
 *
 * Pins the upper-bound validation on confirmDelivery added 2026-06-01.
 *
 * Before the guard: the deliveryConfirmationSchema Zod schema enforced
 * only `min(0)` on deliveredQuantity. A driver (or buggy modal) could
 * submit deliveredQuantity > orderedQuantity, producing physically
 * impossible inventory math (on_vehicle = negative) and corrupting the
 * inventory_summaries row for that date. Live incident: OSHD2627000403
 * on dist-002 / 425KG / 2026-06-01 ended up with delivered_quantity=2
 * against ordered quantity=1, dropping Daily Summary "On Vehicle Fulls"
 * to -1.
 *
 * After the guard (orderService.confirmDelivery): the per-item bounds
 * check throws 400 for over-delivery, unknown items, or negative
 * empties — BEFORE any inventory/invoice writes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import {
  loginAsDistAdmin,
  getSeedData,
  cleanupTestOrders,
  ensureDriverVehicleMapping,
  today,
} from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let seedData: Awaited<ReturnType<typeof getSeedData>>;

beforeAll(async () => {
  app = createApp();
  const admin = await loginAsDistAdmin();
  adminToken = admin.token;
  seedData = await getSeedData();
  await cleanupTestOrders('dist-001');
  await ensureDriverVehicleMapping({
    distributorId: 'dist-001',
    driverId: seedData.drivers[0].id,
    vehicleId: seedData.vehicles[0].id,
    date: today(),
  });
});

afterAll(async () => {
  await cleanupTestOrders('dist-001');
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function makePendingDeliveryOrder(qty: number) {
  const customer = seedData.customers.find((c) => c.customerType === 'B2B')!;
  const cyl = seedData.cylinderTypes.find((ct) => ct.typeName === '19 KG')!;
  const driver = seedData.drivers[0];
  const vehicle = seedData.vehicles[0];

  const orderRes = await request(app)
    .post('/api/orders')
    .set(auth(adminToken))
    .send({ customerId: customer.id, deliveryDate: today(), items: [{ cylinderTypeId: cyl.id, quantity: qty }] });
  const orderId = orderRes.body.data.orderId;

  await request(app)
    .post(`/api/orders/${orderId}/assign-driver`)
    .set(auth(adminToken))
    .send({ driverId: driver.id, vehicleId: vehicle.id });

  await request(app)
    .put(`/api/orders/${orderId}/status`)
    .set(auth(adminToken))
    .send({ status: 'pending_delivery' });

  return { orderId, cylinderTypeId: cyl.id };
}

describe('confirmDelivery — over-delivery upper-bound guard', () => {
  it('happy path — delivered = ordered is accepted', async () => {
    const { orderId, cylinderTypeId } = await makePendingDeliveryOrder(2);
    const res = await request(app)
      .post(`/api/orders/${orderId}/confirm-delivery`)
      .set(auth(adminToken))
      .send({ items: [{ cylinderTypeId, deliveredQuantity: 2, emptiesCollected: 0 }] });
    expect(res.status).toBe(200);
  });

  it('happy path — partial delivery (delivered < ordered) is accepted as modified_delivered', async () => {
    const { orderId, cylinderTypeId } = await makePendingDeliveryOrder(2);
    const res = await request(app)
      .post(`/api/orders/${orderId}/confirm-delivery`)
      .set(auth(adminToken))
      .send({ items: [{ cylinderTypeId, deliveredQuantity: 1, emptiesCollected: 0 }] });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('modified_delivered');
  });

  it('rejects delivered > ordered with 400', async () => {
    const { orderId, cylinderTypeId } = await makePendingDeliveryOrder(1);
    const res = await request(app)
      .post(`/api/orders/${orderId}/confirm-delivery`)
      .set(auth(adminToken))
      .send({ items: [{ cylinderTypeId, deliveredQuantity: 2, emptiesCollected: 0 }] });
    if (res.status !== 400) {
      console.error('Unexpected response:', res.status, JSON.stringify(res.body));
    }
    expect(res.status).toBe(400);
    // sendError puts the message in `error` (string), not `error.message`.
    const msg: string = res.body.error ?? res.body.message ?? '';
    expect(msg.toLowerCase()).toContain('cannot exceed ordered');
  });

  it('rejects an item that is not on the order with 400', async () => {
    const { orderId } = await makePendingDeliveryOrder(2);
    const otherCyl = seedData.cylinderTypes.find((ct) => ct.typeName === '5 KG');
    if (!otherCyl) return;
    const res = await request(app)
      .post(`/api/orders/${orderId}/confirm-delivery`)
      .set(auth(adminToken))
      .send({ items: [{ cylinderTypeId: otherCyl.id, deliveredQuantity: 1, emptiesCollected: 0 }] });
    if (res.status !== 400) {
      console.error('Unexpected response (not-on-order):', res.status, JSON.stringify(res.body));
    }
    expect(res.status).toBe(400);
    const msg: string = res.body.error ?? res.body.message ?? '';
    expect(msg.toLowerCase()).toContain('not on this order');
  });

  it('order with over-delivery REJECTED — items table stays at original ordered qty (write-blocked)', async () => {
    // Confirms the throw fires BEFORE the prisma.$transaction in
    // confirmDelivery — the DB must not show a half-applied write.
    const { orderId, cylinderTypeId } = await makePendingDeliveryOrder(1);
    await request(app)
      .post(`/api/orders/${orderId}/confirm-delivery`)
      .set(auth(adminToken))
      .send({ items: [{ cylinderTypeId, deliveredQuantity: 2, emptiesCollected: 0 }] });

    const checkRes = await request(app)
      .get(`/api/orders/${orderId}`)
      .set(auth(adminToken));
    expect(checkRes.status).toBe(200);
    const item = checkRes.body.data.items?.find((i: { cylinderTypeId: string }) => i.cylinderTypeId === cylinderTypeId);
    expect(item).toBeDefined();
    // deliveredQuantity should still be null/unset (write blocked).
    expect(item.deliveredQuantity ?? null).toBeNull();
    expect(checkRes.body.data.status).toBe('pending_delivery');
  });
});
