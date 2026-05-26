/**
 * WI-094 (Issue 8) — GET /api/drivers/me/cancelled-stock security + shape.
 *
 * The endpoint resolves the driver from the token's user (by phone), finds
 * the driver's active DVA for today, and returns cancelled-stock events for
 * THAT vehicle, scoped to the driver's distributor. We assert:
 *   1. ✅ a driver sees their own cancelled stock, with customerName present
 *   2. ❌ cross-tenant isolation — a dist-002 driver never sees dist-001 events
 *   3. ❌ same-tenant isolation — driver A never sees driver B's events
 *   4. ❌ a non-driver role (inventory) is rejected 403
 *
 * Endpoints are "today"-scoped by design, so fixtures are dated today
 * (anti-pattern #7's far-future trick does not apply here). Synthetic phones
 * (99123000*) / emails (@test-cancelled-stock.local) / order numbers
 * (TEST-CS-*) keep cleanup from touching real rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken, loginAsInventory } from './helpers.js';
import { startOfUtcDay } from '../utils/dateOnly.js';
import type { Express } from 'express';

const A_PHONE = '9912300001', B_PHONE = '9912300002', D_PHONE = '9912300003';
const A_EMAIL = 'cs-a@test-cancelled-stock.local';
const B_EMAIL = 'cs-b@test-cancelled-stock.local';
const D_EMAIL = 'cs-d@test-cancelled-stock.local';
const ORD = { A: 'TEST-CS-A1', B: 'TEST-CS-B1', D: 'TEST-CS-D1' };

let app: Express;
let aToken: string, dToken: string, inventoryToken: string;
let aCustomerName = '';

async function cleanup() {
  const orderNums = Object.values(ORD);
  await prisma.cancelledStockEvent.deleteMany({ where: { order: { orderNumber: { in: orderNums } } } });
  await prisma.orderItem.deleteMany({ where: { order: { orderNumber: { in: orderNums } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { in: orderNums } } });
  await prisma.driverVehicleAssignment.deleteMany({ where: { driver: { phone: { in: [A_PHONE, B_PHONE, D_PHONE] } } } });
  await prisma.vehicle.deleteMany({ where: { vehicleNumber: { in: ['TEST-CS-VEH-A', 'TEST-CS-VEH-B', 'TEST-CS-VEH-D'] } } });
  await prisma.driver.deleteMany({ where: { phone: { in: [A_PHONE, B_PHONE, D_PHONE] } } });
  await prisma.user.deleteMany({ where: { email: { in: [A_EMAIL, B_EMAIL, D_EMAIL] } } });
}

async function seedDriverWithCancelledStock(opts: {
  distributorId: string; phone: string; email: string; name: string;
  vehicleNumber: string; orderNumber: string;
}): Promise<{ token: string; customerName: string }> {
  const passwordHash = await bcrypt.hash('TestDriver@123', 10);
  const user = await prisma.user.create({
    data: { email: opts.email, passwordHash, firstName: 'CS', lastName: opts.name, phone: opts.phone, role: 'driver', status: 'active', distributorId: opts.distributorId },
  });
  const driver = await prisma.driver.create({
    data: { distributorId: opts.distributorId, driverName: `CS ${opts.name}`, phone: opts.phone, status: 'active' },
  });
  const vehicle = await prisma.vehicle.create({
    data: { distributorId: opts.distributorId, vehicleNumber: opts.vehicleNumber, vehicleType: 'Truck', status: 'returned' },
  });
  const today = startOfUtcDay();
  await prisma.driverVehicleAssignment.create({
    data: { driverId: driver.id, vehicleId: vehicle.id, distributorId: opts.distributorId, assignmentDate: today, status: 'loaded_and_dispatched', tripNumber: 1 },
  });
  const customer = await prisma.customer.findFirstOrThrow({ where: { distributorId: opts.distributorId, deletedAt: null } });
  const cyl = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: opts.distributorId } });
  const order = await prisma.order.create({
    data: {
      orderNumber: opts.orderNumber, distributorId: opts.distributorId, customerId: customer.id,
      driverId: driver.id, vehicleId: vehicle.id, orderDate: today, deliveryDate: today,
      status: 'cancelled', orderType: 'delivery', totalAmount: 1000,
      items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 1000, totalPrice: 1000 }] },
    },
  });
  await prisma.cancelledStockEvent.create({
    data: {
      orderId: order.id, vehicleId: vehicle.id, driverId: driver.id, cylinderTypeId: cyl.id,
      distributorId: opts.distributorId, quantity: 1, cancellationDate: today, status: 'on_vehicle',
    },
  });
  const token = generateToken({ userId: user.id, email: opts.email, role: 'driver' as any, distributorId: opts.distributorId });
  return { token, customerName: customer.customerName };
}

beforeAll(async () => {
  app = createApp();
  await cleanup();
  const a = await seedDriverWithCancelledStock({ distributorId: 'dist-001', phone: A_PHONE, email: A_EMAIL, name: 'DriverA', vehicleNumber: 'TEST-CS-VEH-A', orderNumber: ORD.A });
  await seedDriverWithCancelledStock({ distributorId: 'dist-001', phone: B_PHONE, email: B_EMAIL, name: 'DriverB', vehicleNumber: 'TEST-CS-VEH-B', orderNumber: ORD.B });
  const d = await seedDriverWithCancelledStock({ distributorId: 'dist-002', phone: D_PHONE, email: D_EMAIL, name: 'DriverD', vehicleNumber: 'TEST-CS-VEH-D', orderNumber: ORD.D });
  aToken = a.token; aCustomerName = a.customerName;
  dToken = d.token;
  const inv = await loginAsInventory();
  inventoryToken = inv.token;
});

afterAll(cleanup);

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('WI-094 — GET /drivers/me/cancelled-stock', () => {
  it('✅ driver sees own cancelled stock with customerName present', async () => {
    const res = await request(app).get('/api/drivers/me/cancelled-stock').set(auth(aToken));
    expect(res.status).toBe(200);
    const rows = res.body.data;
    expect(Array.isArray(rows)).toBe(true);
    const mine = rows.find((r: any) => r.order?.orderNumber === ORD.A);
    expect(mine).toBeTruthy();
    expect(mine.order?.customer?.customerName).toBe(aCustomerName);
  });

  it('❌ cross-tenant — dist-002 driver never sees dist-001 cancelled stock', async () => {
    const res = await request(app).get('/api/drivers/me/cancelled-stock').set(auth(dToken));
    expect(res.status).toBe(200);
    const rows = res.body.data;
    // Sees only its own dist-002 event...
    expect(rows.some((r: any) => r.order?.orderNumber === ORD.D)).toBe(true);
    // ...and NONE of dist-001's events.
    expect(rows.some((r: any) => r.order?.orderNumber === ORD.A)).toBe(false);
    expect(rows.some((r: any) => r.order?.orderNumber === ORD.B)).toBe(false);
  });

  it('❌ same-tenant — driver A never sees driver B cancelled stock', async () => {
    const res = await request(app).get('/api/drivers/me/cancelled-stock').set(auth(aToken));
    expect(res.status).toBe(200);
    expect(res.body.data.some((r: any) => r.order?.orderNumber === ORD.B)).toBe(false);
  });

  it('❌ non-driver role (inventory) is rejected 403', async () => {
    const res = await request(app).get('/api/drivers/me/cancelled-stock').set(auth(inventoryToken));
    expect(res.status).toBe(403);
  });
});
