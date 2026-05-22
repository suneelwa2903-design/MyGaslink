/**
 * WI-094c (Change 3) — GET /drivers/me/cancelled-stock date + status filter.
 *
 * getCancelledStockByVehicle now returns only TODAY's still-on-vehicle events
 * (status NOT in returned_to_depot/reconciled). CancelledStockEvent has no
 * tripNumber, so date+status is the closest "current" approximation. Before
 * this, the driver saw stale events from earlier days/trips long since handed
 * back to the depot.
 *
 * 1 ✅ today's active (on_vehicle) events shown with customer + cylinder type
 * 2 ❌ yesterday's event excluded (date filter)
 * 3 ❌ today's returned_to_depot event excluded (status filter)
 * 4 ❌ cross-tenant — a dist-002 driver never sees dist-001 events
 *
 * Today-scoped by design. Synthetic phones (99141*) / emails / order numbers
 * (TEST-CSF-*) / vehicles keep cleanup off real rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken } from './helpers.js';
import { startOfUtcDay } from '../utils/dateOnly.js';
import type { Express } from 'express';

const PHONES = ['9914100001', '9914100002'];
const today = startOfUtcDay();
const yesterday = new Date(today.getTime() - 86_400_000);
const ORD = { A1: 'TEST-CSF-A1', A2: 'TEST-CSF-A2', AY: 'TEST-CSF-AYDAY', AR: 'TEST-CSF-ARET', D1: 'TEST-CSF-D1' };

let app: Express;
let aToken = '', dToken = '', aCustomerName = '';

async function cleanup() {
  const nums = Object.values(ORD);
  await prisma.cancelledStockEvent.deleteMany({ where: { order: { orderNumber: { in: nums } } } });
  await prisma.orderItem.deleteMany({ where: { order: { orderNumber: { in: nums } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { in: nums } } });
  await prisma.driverVehicleAssignment.deleteMany({ where: { driver: { phone: { in: PHONES } } } });
  await prisma.vehicle.deleteMany({ where: { vehicleNumber: { startsWith: 'TEST-CSF-VEH-' } } });
  await prisma.driver.deleteMany({ where: { phone: { in: PHONES } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: '@test-csf.local' } } });
}

async function mkDriver(distributorId: string, phone: string, name: string, vehNum: string) {
  const email = `csf-${name}@test-csf.local`;
  const passwordHash = await bcrypt.hash('TestDriver@123', 10);
  const user = await prisma.user.create({ data: { email, passwordHash, firstName: 'CSF', lastName: name, phone, role: 'driver', status: 'active', distributorId } });
  const driver = await prisma.driver.create({ data: { distributorId, driverName: `CSF ${name}`, phone, status: 'active' } });
  const vehicle = await prisma.vehicle.create({ data: { distributorId, vehicleNumber: vehNum, vehicleType: 'Truck', status: 'returned' } });
  await prisma.driverVehicleAssignment.create({ data: { distributorId, driverId: driver.id, vehicleId: vehicle.id, assignmentDate: today, status: 'loaded_and_dispatched', tripNumber: 1 } });
  const token = generateToken({ userId: user.id, email, role: 'driver' as any, distributorId });
  return { driverId: driver.id, vehicleId: vehicle.id, token };
}

async function mkEvent(distributorId: string, driverId: string, vehicleId: string, orderNumber: string, status: string, when: Date) {
  const customer = await prisma.customer.findFirstOrThrow({ where: { distributorId, deletedAt: null } });
  const cyl = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId } });
  const order = await prisma.order.create({
    data: {
      orderNumber, distributorId, customerId: customer.id, driverId, vehicleId,
      orderDate: when, deliveryDate: when, status: 'cancelled', orderType: 'delivery', totalAmount: 1000,
      items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 1000, totalPrice: 1000 }] },
    },
  });
  await prisma.cancelledStockEvent.create({
    data: { orderId: order.id, vehicleId, driverId, cylinderTypeId: cyl.id, distributorId, quantity: 1, cancellationDate: when, status: status as any },
  });
  return customer.customerName;
}

beforeAll(async () => {
  app = createApp();
  await cleanup();
  const a = await mkDriver('dist-002', PHONES[0], 'A', 'TEST-CSF-VEH-A');
  aToken = a.token;
  aCustomerName = await mkEvent('dist-002', a.driverId, a.vehicleId, ORD.A1, 'on_vehicle', today);
  await mkEvent('dist-002', a.driverId, a.vehicleId, ORD.A2, 'on_vehicle', today);
  await mkEvent('dist-002', a.driverId, a.vehicleId, ORD.AY, 'on_vehicle', yesterday);
  await mkEvent('dist-002', a.driverId, a.vehicleId, ORD.AR, 'returned_to_depot', today);

  const d = await mkDriver('dist-001', PHONES[1], 'D', 'TEST-CSF-VEH-D');
  dToken = d.token;
  await mkEvent('dist-001', d.driverId, d.vehicleId, ORD.D1, 'on_vehicle', today);
});

afterAll(cleanup);

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const nums = (rows: any[]) => rows.map((r) => r.order?.orderNumber);

describe('WI-094c — GET /drivers/me/cancelled-stock filter', () => {
  it('✅ 1. today\'s active events shown with customer + cylinder type', async () => {
    const res = await request(app).get('/api/drivers/me/cancelled-stock').set(auth(aToken));
    expect(res.status).toBe(200);
    const rows = res.body.data;
    expect(nums(rows)).toEqual(expect.arrayContaining([ORD.A1, ORD.A2]));
    const a1 = rows.find((r: any) => r.order?.orderNumber === ORD.A1);
    expect(a1.order?.customer?.customerName).toBe(aCustomerName);
    expect(a1.cylinderType?.typeName).toBeTruthy();
  });

  it('❌ 2. yesterday\'s event excluded (date filter)', async () => {
    const res = await request(app).get('/api/drivers/me/cancelled-stock').set(auth(aToken));
    expect(nums(res.body.data)).not.toContain(ORD.AY);
  });

  it('❌ 3. today\'s returned_to_depot event excluded (status filter)', async () => {
    const res = await request(app).get('/api/drivers/me/cancelled-stock').set(auth(aToken));
    expect(nums(res.body.data)).not.toContain(ORD.AR);
  });

  it('❌ 4. cross-tenant — dist-002 driver never sees dist-001 events', async () => {
    const res = await request(app).get('/api/drivers/me/cancelled-stock').set(auth(aToken));
    expect(nums(res.body.data)).not.toContain(ORD.D1);
    // And dist-001 driver sees its own but not dist-002's.
    const resD = await request(app).get('/api/drivers/me/cancelled-stock').set(auth(dToken));
    expect(nums(resD.body.data)).toContain(ORD.D1);
    expect(nums(resD.body.data)).not.toContain(ORD.A1);
  });
});
