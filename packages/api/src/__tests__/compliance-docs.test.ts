/**
 * WI-094c (Change 4) — GET /drivers/me/trip-ewbs (Compliance Docs) rework.
 *
 * The endpoint now: (a) scopes to the current DVA tripNumber, (b) includes the
 * just-completed trip's EWBs (delivered/modified_delivered, not pending only),
 * (c) excludes docs without a real NIC EWB (ewbStatus not in active/cancelled),
 * and (d) returns tripSheetNo/tripSheetNo2 so the mobile knows whether to offer
 * a trip-sheet PDF download.
 *
 * 1 ✅ active-trip EWBs (pending_delivery) returned
 * 2 ✅ last-completed-trip EWBs (all delivered) returned (not empty)
 * 3 ✅ tripSheetNo surfaced in the response when set on the DVA
 * 4 ❌ failed-EWB order excluded (no real NIC number)
 * 5 ❌ cross-tenant — a different tenant never sees these EWBs
 * 6 ❌ cross-driver — driver A never sees driver B's EWBs
 *
 * GST-enabled tenant required → dist-002 (sandbox). Today-scoped by design.
 * Synthetic phones (99142*) / emails / order+invoice numbers (TEST-CD-*) /
 * EWB numbers (EWB-CD-*) / vehicles keep cleanup off real rows.
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
const PHONES = ['9914200001', '9914200002', '9914200003', '9914200004', '9914200005'];

let app: Express;
let aToken = '', bToken = '', cToken = '', eToken = '', fToken = '';

async function cleanup() {
  await prisma.gstDocument.deleteMany({ where: { order: { orderNumber: { startsWith: 'TEST-CD-' } } } });
  await prisma.invoice.deleteMany({ where: { order: { orderNumber: { startsWith: 'TEST-CD-' } } } });
  await prisma.orderItem.deleteMany({ where: { order: { orderNumber: { startsWith: 'TEST-CD-' } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: 'TEST-CD-' } } });
  await prisma.driverVehicleAssignment.deleteMany({ where: { driver: { phone: { in: PHONES } } } });
  await prisma.vehicle.deleteMany({ where: { vehicleNumber: { startsWith: 'TEST-CD-VEH-' } } });
  await prisma.driver.deleteMany({ where: { phone: { in: PHONES } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: '@test-cd.local' } } });
}

async function mkDriver(distributorId: string, phone: string, name: string, tripSheetNo: string | null = null) {
  const email = `cd-${name}@test-cd.local`;
  const passwordHash = await bcrypt.hash('TestDriver@123', 10);
  const user = await prisma.user.create({ data: { email, passwordHash, firstName: 'CD', lastName: name, phone, role: 'driver', status: 'active', distributorId } });
  const driver = await prisma.driver.create({ data: { distributorId, driverName: `CD ${name}`, phone, status: 'active' } });
  const vehicle = await prisma.vehicle.create({ data: { distributorId, vehicleNumber: `TEST-CD-VEH-${name}`, vehicleType: 'Truck', status: 'dispatched' } });
  await prisma.driverVehicleAssignment.create({ data: { distributorId, driverId: driver.id, vehicleId: vehicle.id, assignmentDate: today, status: 'loaded_and_dispatched', tripNumber: 1, ...(tripSheetNo ? { tripSheetNo } : {}) } });
  const token = generateToken({ userId: user.id, email, role: 'driver' as any, distributorId });
  return { driverId: driver.id, vehicleId: vehicle.id, token };
}

async function mkOrderWithEwb(distributorId: string, driverId: string, vehicleId: string, opts: {
  orderNumber: string; status: string; ewbStatus: string; ewbNo: string | null;
}) {
  const customer = await prisma.customer.findFirstOrThrow({ where: { distributorId, deletedAt: null } });
  const cyl = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId } });
  const order = await prisma.order.create({
    data: {
      orderNumber: opts.orderNumber, distributorId, customerId: customer.id, driverId, vehicleId,
      orderDate: today, deliveryDate: today, status: opts.status as any, orderType: 'delivery', totalAmount: 1800, tripNumber: 1,
      items: { create: [{ cylinderTypeId: cyl.id, quantity: 2, unitPrice: 900, totalPrice: 1800 }] },
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-${opts.orderNumber}`, distributorId, customerId: customer.id, orderId: order.id,
      issueDate: today, dueDate: today, totalAmount: 1800, outstandingAmount: 1800, status: 'issued',
      irnStatus: 'success', ewbStatus: opts.ewbStatus as any,
    },
  });
  await prisma.gstDocument.create({
    data: {
      invoiceId: invoice.id, orderId: order.id, distributorId, docType: 'INV', irnStatus: 'success',
      ewbStatus: opts.ewbStatus as any, ewbNo: opts.ewbNo, ewbDate: today, ewbValidTill: validTill, isLatest: true,
    },
  });
}

beforeAll(async () => {
  app = createApp();
  await cleanup();

  // A (dist-002): 2 pending_delivery, active EWBs
  const a = await mkDriver(D2, PHONES[0], 'A');
  aToken = a.token;
  await mkOrderWithEwb(D2, a.driverId, a.vehicleId, { orderNumber: 'TEST-CD-A1', status: 'pending_delivery', ewbStatus: 'active', ewbNo: 'EWB-CD-A1' });
  await mkOrderWithEwb(D2, a.driverId, a.vehicleId, { orderNumber: 'TEST-CD-A2', status: 'pending_delivery', ewbStatus: 'active', ewbNo: 'EWB-CD-A2' });

  // B (dist-002): all delivered, active EWBs
  const b = await mkDriver(D2, PHONES[1], 'B');
  bToken = b.token;
  await mkOrderWithEwb(D2, b.driverId, b.vehicleId, { orderNumber: 'TEST-CD-B1', status: 'delivered', ewbStatus: 'active', ewbNo: 'EWB-CD-B1' });
  await mkOrderWithEwb(D2, b.driverId, b.vehicleId, { orderNumber: 'TEST-CD-B2', status: 'modified_delivered', ewbStatus: 'active', ewbNo: 'EWB-CD-B2' });

  // C (dist-002): DVA has a consolidated tripSheetNo
  const c = await mkDriver(D2, PHONES[2], 'C', 'TS-CD-C');
  cToken = c.token;
  await mkOrderWithEwb(D2, c.driverId, c.vehicleId, { orderNumber: 'TEST-CD-C1', status: 'pending_delivery', ewbStatus: 'active', ewbNo: 'EWB-CD-C1' });

  // E (dist-002): only a failed-EWB order (no real NIC number)
  const e = await mkDriver(D2, PHONES[3], 'E');
  eToken = e.token;
  await mkOrderWithEwb(D2, e.driverId, e.vehicleId, { orderNumber: 'TEST-CD-E1', status: 'pending_delivery', ewbStatus: 'failed', ewbNo: null });

  // F (dist-001): GST disabled → cross-tenant isolation baseline
  const f = await mkDriver(D1, PHONES[4], 'F');
  fToken = f.token;
});

afterAll(cleanup);

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const ewbNos = (items: any[]) => items.map((i) => i.ewbNo);

describe('WI-094c — GET /drivers/me/trip-ewbs (Compliance Docs)', () => {
  it('✅ 1. active-trip EWBs returned with cylinder type + quantity', async () => {
    const res = await request(app).get('/api/drivers/me/trip-ewbs').set(auth(aToken));
    expect(res.status).toBe(200);
    expect(res.body.data.tripNumber).toBe(1);
    expect(ewbNos(res.body.data.items)).toEqual(expect.arrayContaining(['EWB-CD-A1', 'EWB-CD-A2']));
    const first = res.body.data.items[0];
    expect(first.cylinderType).toBeTruthy();
    expect(first.quantity).toBe(2);
  });

  it('✅ 2. last-completed-trip EWBs (all delivered) returned, not empty', async () => {
    const res = await request(app).get('/api/drivers/me/trip-ewbs').set(auth(bToken));
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBe(2);
    expect(ewbNos(res.body.data.items)).toEqual(expect.arrayContaining(['EWB-CD-B1', 'EWB-CD-B2']));
  });

  it('✅ 3. tripSheetNo surfaced when set on the DVA', async () => {
    const res = await request(app).get('/api/drivers/me/trip-ewbs').set(auth(cToken));
    expect(res.status).toBe(200);
    expect(res.body.data.tripSheetNo).toBe('TS-CD-C');
  });

  it('❌ 4. failed-EWB order excluded (no real NIC number)', async () => {
    const res = await request(app).get('/api/drivers/me/trip-ewbs').set(auth(eToken));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  it('❌ 5. cross-tenant — a different tenant never sees these EWBs', async () => {
    const res = await request(app).get('/api/drivers/me/trip-ewbs').set(auth(fToken));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect(ewbNos(res.body.data.items)).not.toContain('EWB-CD-A1');
  });

  it('❌ 6. cross-driver — driver A never sees driver B\'s EWBs (and vice versa)', async () => {
    const resA = await request(app).get('/api/drivers/me/trip-ewbs').set(auth(aToken));
    const resB = await request(app).get('/api/drivers/me/trip-ewbs').set(auth(bToken));
    expect(ewbNos(resA.body.data.items)).not.toEqual(expect.arrayContaining(['EWB-CD-B1', 'EWB-CD-B2']));
    expect(ewbNos(resB.body.data.items)).not.toEqual(expect.arrayContaining(['EWB-CD-A1', 'EWB-CD-A2']));
  });
});
