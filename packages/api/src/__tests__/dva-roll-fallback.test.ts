/**
 * WI-096 — driver screens fall back to the last trip WITH orders when the DVA
 * has rolled to a new empty trip.
 *
 * The single DVA row rolls tripNumber++ the instant the last order is
 * delivered. Before WI-096, assignment / trip-stock / trip-ewbs scoped blindly
 * to the latest tripNumber and snapped to that empty trip → Compliance Docs
 * empty (A), Trip tab jumped to next trip (B), Vehicle Stock reset to 0 (C).
 *
 * 1 ✅ assignment: rolled DVA → previous trip's orders + tripNumber
 * 2 ✅ trip-stock: rolled DVA → previous trip's empties (not 0)
 * 3 ✅ trip-ewbs: rolled DVA → previous trip's EWB (not empty)
 * 4 ✅ active trip (latest has orders) → no fallback, shows current
 * 5 ✅ brand-new driver, empty trip 1 → empty + tripNumber 1 (no crash/fallback)
 * 6 ❌ cross-driver: a driver's fallback never pulls another driver's orders
 * 7 ❌ cross-tenant: a dist-001 rolled trip never surfaces for a dist-002 driver
 *
 * dist-002 (GST sandbox) so trip-ewbs is exercised. Today-scoped by design.
 * Synthetic phones (99150000*) / emails / order+EWB numbers keep cleanup safe.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken } from './helpers.js';
import { startOfUtcDay } from '../utils/dateOnly.js';
import type { Express } from 'express';

const D2 = 'dist-002', D1 = 'dist-001';
const today = startOfUtcDay();
const validTill = new Date(today.getTime() + 86_400_000);
const PHONES = ['9915000001', '9915000002', '9915000003', '9915000004'];

let app: Express;
let rollTok = '', activeTok = '', newTok = '', d1Tok = '';

async function cleanup() {
  await prisma.gstDocument.deleteMany({ where: { order: { orderNumber: { startsWith: 'TEST-ROLL-' } } } });
  await prisma.invoice.deleteMany({ where: { order: { orderNumber: { startsWith: 'TEST-ROLL-' } } } });
  await prisma.orderItem.deleteMany({ where: { order: { orderNumber: { startsWith: 'TEST-ROLL-' } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: 'TEST-ROLL-' } } });
  await prisma.driverVehicleAssignment.deleteMany({ where: { driver: { phone: { in: PHONES } } } });
  await prisma.vehicle.deleteMany({ where: { vehicleNumber: { startsWith: 'TEST-ROLL-VEH-' } } });
  await prisma.driver.deleteMany({ where: { phone: { in: PHONES } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: '@test-dva-roll.local' } } });
}

async function mkDriver(distributorId: string, phone: string, name: string, latestTrip: number, latestStatus: string) {
  const email = `roll-${name}@test-dva-roll.local`;
  const passwordHash = await bcrypt.hash('TestDriver@123', 10);
  const user = await prisma.user.create({ data: { email, passwordHash, firstName: 'ROLL', lastName: name, phone, role: 'driver', status: 'active', distributorId } });
  const driver = await prisma.driver.create({ data: { distributorId, driverName: `ROLL ${name}`, phone, status: 'active' } });
  const vehicle = await prisma.vehicle.create({ data: { distributorId, vehicleNumber: `TEST-ROLL-VEH-${name}`, vehicleType: 'Truck', status: 'idle' } });
  // ONE DVA row (the realistic post-roll state): latest tripNumber.
  await prisma.driverVehicleAssignment.create({ data: { distributorId, driverId: driver.id, vehicleId: vehicle.id, assignmentDate: today, status: latestStatus as any, tripNumber: latestTrip } });
  const token = generateToken({ userId: user.id, email, role: 'driver' as any, distributorId });
  return { driverId: driver.id, vehicleId: vehicle.id, token };
}

async function mkOrder(distributorId: string, driverId: string, vehicleId: string, opts: {
  orderNumber: string; status: string; tripNumber: number | null; qty: number; delivered?: number; empties?: number; withEwb?: string;
}) {
  const customer = await prisma.customer.findFirstOrThrow({ where: { distributorId, deletedAt: null } });
  const cyl = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId } });
  const order = await prisma.order.create({
    data: {
      orderNumber: opts.orderNumber, distributorId, customerId: customer.id, driverId, vehicleId,
      orderDate: today, deliveryDate: today, status: opts.status as any, orderType: 'delivery', totalAmount: 1800, tripNumber: opts.tripNumber,
      items: { create: [{ cylinderTypeId: cyl.id, quantity: opts.qty, unitPrice: 900, totalPrice: 900 * opts.qty, deliveredQuantity: opts.delivered ?? null, emptiesCollected: opts.empties ?? null }] },
    },
  });
  if (opts.withEwb) {
    const inv = await prisma.invoice.create({ data: { invoiceNumber: `INV-${opts.orderNumber}`, distributorId, customerId: customer.id, orderId: order.id, issueDate: today, dueDate: today, totalAmount: 1800, outstandingAmount: 1800, status: 'issued', irnStatus: 'not_attempted', ewbStatus: 'active' } });
    await prisma.gstDocument.create({ data: { invoiceId: inv.id, orderId: order.id, distributorId, docType: 'INV', irnStatus: 'not_attempted', ewbStatus: 'active', ewbNo: opts.withEwb, ewbDate: today, ewbValidTill: validTill, isLatest: true } });
  }
  return order;
}

beforeAll(async () => {
  app = createApp();
  await cleanup();

  // Roll: latest DVA trip 2 (dispatch_ready, EMPTY) + trip 1 delivered order w/ EWB
  const roll = await mkDriver(D2, PHONES[0], 'Roll', 2, 'dispatch_ready');
  rollTok = roll.token;
  await mkOrder(D2, roll.driverId, roll.vehicleId, { orderNumber: 'TEST-ROLL-R-T1', status: 'delivered', tripNumber: 1, qty: 3, delivered: 3, empties: 2, withEwb: 'EWB-ROLL-R1' });

  // Active: latest DVA trip 1 (loaded_and_dispatched) with a pending order → no fallback
  const active = await mkDriver(D2, PHONES[1], 'Active', 1, 'loaded_and_dispatched');
  activeTok = active.token;
  await mkOrder(D2, active.driverId, active.vehicleId, { orderNumber: 'TEST-ROLL-A-T1', status: 'pending_delivery', tripNumber: 1, qty: 5 });

  // New: latest DVA trip 1 (dispatch_ready), NO orders → genuine empty state
  const fresh = await mkDriver(D2, PHONES[2], 'New', 1, 'dispatch_ready');
  newTok = fresh.token;

  // dist-001 rolled driver (cross-tenant)
  const d1 = await mkDriver(D1, PHONES[3], 'D1', 2, 'dispatch_ready');
  d1Tok = d1.token;
  await mkOrder(D1, d1.driverId, d1.vehicleId, { orderNumber: 'TEST-ROLL-D1-T1', status: 'delivered', tripNumber: 1, qty: 4, delivered: 4, empties: 1 });
});

afterAll(cleanup);

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const assignment = (t: string) => request(app).get('/api/drivers/me/assignment').set(auth(t));
const stock = (t: string) => request(app).get('/api/drivers/me/trip-stock').set(auth(t));
const ewbs = (t: string) => request(app).get('/api/drivers/me/trip-ewbs').set(auth(t));
const sum = (rows: any[], k: string) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);

describe('WI-096 — DVA-roll fallback to last trip with orders', () => {
  it('✅ 1 assignment: rolled DVA falls back to previous trip orders + tripNumber', async () => {
    const res = await assignment(rollTok);
    expect(res.status).toBe(200);
    expect(res.body.data).not.toBeNull();
    expect(res.body.data.tripNumber).toBe(1);
    expect(res.body.data.orders.map((o: any) => o.orderNumber)).toContain('TEST-ROLL-R-T1');
  });

  it('✅ 2 trip-stock: rolled DVA reports previous trip empties (not 0)', async () => {
    const res = await stock(rollTok);
    expect(res.status).toBe(200);
    expect(sum(res.body.data.items, 'emptyQuantity')).toBe(2);
  });

  it('✅ 3 trip-ewbs: rolled DVA shows previous trip EWB (not empty)', async () => {
    const res = await ewbs(rollTok);
    expect(res.status).toBe(200);
    expect(res.body.data.tripNumber).toBe(1);
    expect(res.body.data.items.map((i: any) => i.ewbNo)).toContain('EWB-ROLL-R1');
  });

  it('✅ 4 active trip (latest has orders) → no fallback', async () => {
    const res = await assignment(activeTok);
    expect(res.status).toBe(200);
    expect(res.body.data.tripNumber).toBe(1);
    expect(res.body.data.orders.map((o: any) => o.orderNumber)).toContain('TEST-ROLL-A-T1');
  });

  it('✅ 5 brand-new driver, empty trip 1 → empty, tripNumber 1, no fallback/crash', async () => {
    const res = await assignment(newTok);
    expect(res.status).toBe(200);
    expect(res.body.data).not.toBeNull();
    expect(res.body.data.tripNumber).toBe(1);
    expect(res.body.data.orders).toEqual([]);
    const s = await stock(newTok);
    expect(sum(s.body.data.items, 'emptyQuantity')).toBe(0);
    expect(sum(s.body.data.items, 'fullQuantity')).toBe(0);
  });

  it('❌ 6 cross-driver: Roll never sees Active driver\'s orders', async () => {
    const res = await assignment(rollTok);
    expect(res.body.data.orders.map((o: any) => o.orderNumber)).not.toContain('TEST-ROLL-A-T1');
  });

  it('❌ 7 cross-tenant: dist-002 driver never sees dist-001 rolled trip', async () => {
    const res = await assignment(rollTok);
    const nums = res.body.data.orders.map((o: any) => o.orderNumber);
    expect(nums).not.toContain('TEST-ROLL-D1-T1');
    // ...and the dist-001 driver's own fallback works within its tenant.
    const d1 = await assignment(d1Tok);
    expect(d1.body.data.tripNumber).toBe(1);
    expect(d1.body.data.orders.map((o: any) => o.orderNumber)).toContain('TEST-ROLL-D1-T1');
  });
});
