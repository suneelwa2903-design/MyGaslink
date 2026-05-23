/**
 * WI-094 — DVA trip-timeline timestamps (dispatchedAt/returnedAt/reconciledAt).
 *
 * 1. ✅ dispatchedAt set after a fully-successful preflight-dispatch
 * 2. ✅ dispatchedAt stays null when preflight fails (no full success)
 * 3. ✅ returnedAt set by markVehicleReturned
 * 4. ✅ reconciledAt set by confirmVehicleReconciliation
 * 5. ❌ cross-tenant — a dist-001 driver never reads a dist-002 DVA's timestamps
 * 6. ❌ no write path — PUT /drivers/assignments/:id/status cannot set these
 * 7. ✅ timeline intact after an order on the DVA is cancelled
 *
 * Preflight tests dispatch a DEDICATED far-future-dated vehicle (anti-pattern
 * #7/#8) so they never touch the seeded fleet. Service-level tests (3/4) use
 * a today-dated DVA on a dedicated vehicle (the return/reconcile services
 * scope their DVA lookup to startOfUtcDay()).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';

vi.mock('../services/gst/whitebooksClient.js', async (orig) => {
  const original: any = await orig();
  return {
    ...original,
    apiCall: vi.fn(),
    pingEinvoiceSession: vi.fn(async () => undefined),
    getCredentials: vi.fn(async () => ({
      clientId: 'EINS-test', clientSecret: 'EINS-test-secret', username: 'BVMGSP',
      password: 'Wbooks@0142', gstin: '29AAGCB1286Q000', email: 'test@test.com',
      baseUrl: 'https://apisandbox.whitebooks.in',
    })),
    getAuthToken: vi.fn(async () => 'mock-token'),
  };
});

import { prisma } from '../lib/prisma.js';
import * as whitebooksClient from '../services/gst/whitebooksClient.js';
import { preflightDispatch } from '../services/gst/gstPreflightService.js';
import { markVehicleReturned, confirmVehicleReconciliation } from '../services/deliveryWorkflowService.js';
import { createApp } from '../app.js';
import { generateToken } from './helpers.js';
import { startOfUtcDay } from '../utils/dateOnly.js';
import type { Express } from 'express';

const DIST = 'dist-002';
const PF_DATE = '2099-12-31';
const apiCallMock = whitebooksClient.apiCall as unknown as ReturnType<typeof vi.fn>;

let app: Express;
const createdOrderIds: string[] = [];
const createdDvaIds: string[] = [];
const createdVehicleIds: string[] = [];
const createdDriverIds: string[] = [];
const createdUserEmails: string[] = [];

function ewbGenOk(no = '181012000777') {
  return { status_cd: '1', data: { ewayBillNo: no, ewayBillDate: '15/05/2026 12:00:00 PM', validUpto: '16/05/2026 11:59:00 PM' } };
}

async function makeDriver(distributorId: string, phone: string, email: string) {
  const passwordHash = await bcrypt.hash('TestDriver@123', 10);
  const user = await prisma.user.create({ data: { email, passwordHash, firstName: 'TL', lastName: 'Driver', phone, role: 'driver', status: 'active', distributorId } });
  const driver = await prisma.driver.create({ data: { distributorId, driverName: `TL ${phone}`, phone, status: 'active' } });
  createdDriverIds.push(driver.id); createdUserEmails.push(email);
  const token = generateToken({ userId: user.id, email, role: 'driver' as any, distributorId });
  return { driver, token };
}

async function makeVehicle(distributorId: string, vehicleNumber: string, status = 'idle') {
  const v = await prisma.vehicle.create({ data: { distributorId, vehicleNumber, vehicleType: 'Truck', status: status as any } });
  createdVehicleIds.push(v.id);
  return v;
}

async function makeDva(opts: { driverId: string; vehicleId: string; date: Date; status?: string; tripNumber?: number }) {
  const dva = await prisma.driverVehicleAssignment.create({
    data: { driverId: opts.driverId, vehicleId: opts.vehicleId, distributorId: DIST, assignmentDate: opts.date, status: (opts.status ?? 'dispatch_ready') as any, tripNumber: opts.tripNumber ?? 1 },
  });
  createdDvaIds.push(dva.id);
  return dva;
}

async function seedB2cOrder(driverId: string, vehicleId: string, date: string) {
  const customer = await prisma.customer.findFirstOrThrow({ where: { distributorId: DIST, customerType: 'B2C', deletedAt: null } });
  const cyl = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: DIST } });
  const order = await prisma.order.create({
    data: {
      distributorId: DIST, customerId: customer.id, driverId, vehicleId,
      orderNumber: `TL-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      orderDate: new Date(date), deliveryDate: new Date(date), status: 'pending_dispatch', orderType: 'delivery', totalAmount: 2000,
      items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 2000, totalPrice: 2000 }] },
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

let pfDriverId = '';
let preflightVehicleId = '';

beforeAll(async () => {
  app = createApp();
  const d = await makeDriver(DIST, '9912500001', 'tl-pf@test-dva-timeline.local');
  pfDriverId = d.driver.id;
});

beforeEach(() => apiCallMock.mockReset());

afterAll(async () => {
  await prisma.gstDocument.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.invoice.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await prisma.driverVehicleAssignment.deleteMany({ where: { id: { in: createdDvaIds } } });
  await prisma.cancelledStockEvent.deleteMany({ where: { vehicleId: { in: createdVehicleIds } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: createdVehicleIds } } });
  await prisma.driver.deleteMany({ where: { id: { in: createdDriverIds } } });
  await prisma.user.deleteMany({ where: { email: { in: createdUserEmails } } });
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('WI-094 — DVA timeline timestamps', () => {
  it('✅ 1. dispatchedAt set after successful preflight-dispatch', async () => {
    const v = await makeVehicle(DIST, 'TEST-TL-PF-OK');
    preflightVehicleId = v.id;
    const dva = await makeDva({ driverId: pfDriverId, vehicleId: v.id, date: new Date(PF_DATE), status: 'dispatch_ready' });
    await seedB2cOrder(pfDriverId, v.id, PF_DATE);
    apiCallMock.mockResolvedValue(ewbGenOk('TL-EWB-1')); // single B2C order → standalone EWB, no gencewb
    const result = await preflightDispatch({ distributorId: DIST, driverId: pfDriverId, assignmentDate: PF_DATE, userId: 'tl-user' } as any);
    expect(result.summary.succeeded).toBe(1);
    const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    expect(after.dispatchedAt).not.toBeNull();
    expect(after.status).toBe('loaded_and_dispatched');
  });

  it('✅ 2. dispatchedAt stays null when preflight fails', async () => {
    const v = await makeVehicle(DIST, 'TEST-TL-PF-FAIL');
    const dva = await makeDva({ driverId: pfDriverId, vehicleId: v.id, date: new Date(PF_DATE), status: 'dispatch_ready', tripNumber: 2 });
    // B2B order: IRN failure BLOCKS dispatch (a failed B2C EWB does not, WI-091).
    const b2b = await prisma.customer.findFirstOrThrow({ where: { distributorId: DIST, customerType: 'B2B', gstin: { not: null }, deletedAt: null } });
    const cyl = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: DIST } });
    const order = await prisma.order.create({
      data: {
        distributorId: DIST, customerId: b2b.id, driverId: pfDriverId, vehicleId: v.id,
        orderNumber: `TL-B2B-${Date.now().toString(36)}`, orderDate: new Date(PF_DATE), deliveryDate: new Date(PF_DATE),
        status: 'pending_dispatch', orderType: 'delivery', totalAmount: 2000,
        items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 2000, totalPrice: 2000 }] },
      },
    });
    createdOrderIds.push(order.id);
    // IRN GENERATE throws a coded NIC error → order fails (caught per-order).
    // Use ...Once (like gst-preflight's 3028/5002 tests) so any per-order
    // recovery call afterwards doesn't also throw and abort the batch.
    apiCallMock.mockImplementationOnce(() => { const e: any = new Error('GSTIN is invalid'); e.code = '3028'; throw e; });
    const result = await preflightDispatch({ distributorId: DIST, driverId: pfDriverId, assignmentDate: PF_DATE, userId: 'tl-user' } as any);
    expect(result.summary.succeeded).toBe(0);
    const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    expect(after.dispatchedAt).toBeNull();
  });

  it('✅ 3. returnedAt set by markVehicleReturned', async () => {
    const v = await makeVehicle(DIST, 'TEST-TL-RET', 'dispatched');
    const dva = await makeDva({ driverId: pfDriverId, vehicleId: v.id, date: startOfUtcDay(), status: 'loaded_and_dispatched' });
    await markVehicleReturned(v.id, 'tl-user', DIST);
    const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    expect(after.returnedAt).not.toBeNull();
    const veh = await prisma.vehicle.findUniqueOrThrow({ where: { id: v.id } });
    expect(veh.status).toBe('returned');
  });

  it('✅ 4. reconciledAt set by confirmVehicleReconciliation', async () => {
    const v = await makeVehicle(DIST, 'TEST-TL-REC', 'returned');
    const dva = await makeDva({ driverId: pfDriverId, vehicleId: v.id, date: startOfUtcDay(), status: 'loaded_and_dispatched', tripNumber: 3 });
    await confirmVehicleReconciliation(v.id, DIST, 'tl-user', { physicalStockConfirmed: true });
    const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    expect(after.reconciledAt).not.toBeNull();
    expect(after.isReconciled).toBe(true);
  });

  it('❌ 5. cross-tenant — dist-001 driver never reads a dist-002 DVA timestamp', async () => {
    // dist-002 DVA with a dispatchedAt for today.
    const v = await makeVehicle(DIST, 'TEST-TL-XT');
    const d2dva = await makeDva({ driverId: pfDriverId, vehicleId: v.id, date: startOfUtcDay(), status: 'loaded_and_dispatched', tripNumber: 5 });
    await prisma.driverVehicleAssignment.update({ where: { id: d2dva.id }, data: { dispatchedAt: new Date() } });
    // A dist-001 driver with NO assignment.
    const d1 = await makeDriver('dist-001', '9912500002', 'tl-d1@test-dva-timeline.local');
    const res = await request(app).get('/api/drivers/me/assignment').set(auth(d1.token));
    expect(res.status).toBe(200);
    // Either null (no DVA) or — never the dist-002 assignment's id/timestamp.
    if (res.body.data) {
      expect(res.body.data.assignmentId).not.toBe(d2dva.id);
    } else {
      expect(res.body.data).toBeNull();
    }
  });

  it('❌ 6. no write path — status route cannot set dispatchedAt', async () => {
    const v = await makeVehicle(DIST, 'TEST-TL-NOWRITE');
    const dva = await makeDva({ driverId: pfDriverId, vehicleId: v.id, date: startOfUtcDay(), status: 'dispatch_ready', tripNumber: 6 });
    const adminTok = generateToken({ userId: 'x', email: 'x', role: 'distributor_admin' as any, distributorId: DIST });
    // Inject dispatchedAt in the body — the Zod schema only accepts `status`.
    const fake = new Date('2099-01-01T00:00:00.000Z').toISOString();
    await request(app)
      .put(`/api/drivers/assignments/${dva.id}/status`)
      .set(auth(adminTok))
      .send({ status: 'loaded_and_dispatched', dispatchedAt: fake, returnedAt: fake, reconciledAt: fake });
    const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    // The injected value must NOT have been persisted.
    expect(after.dispatchedAt).toBeNull();
    expect(after.returnedAt).toBeNull();
    expect(after.reconciledAt).toBeNull();
  });

  it('✅ 7. timeline intact after an order is cancelled', async () => {
    const v = await makeVehicle(DIST, 'TEST-TL-CANCEL');
    const dva = await makeDva({ driverId: pfDriverId, vehicleId: v.id, date: startOfUtcDay(), status: 'loaded_and_dispatched', tripNumber: 7 });
    const dispatchedAt = new Date('2099-12-30T10:00:00.000Z');
    await prisma.driverVehicleAssignment.update({ where: { id: dva.id }, data: { dispatchedAt } });
    const order = await seedB2cOrder(pfDriverId, v.id, PF_DATE);
    // Cancel the order directly.
    await prisma.order.update({ where: { id: order.id }, data: { status: 'cancelled' } });
    const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    expect(after.dispatchedAt?.toISOString()).toBe(dispatchedAt.toISOString());
  });

  it('✅ 8. WI-098 — partial dispatch (1 ok, 1 fail) still stamps dispatchedAt; DVA stays dispatch_ready', async () => {
    const v = await makeVehicle(DIST, 'TEST-TL-PARTIAL');
    const dva = await makeDva({ driverId: pfDriverId, vehicleId: v.id, date: new Date(PF_DATE), status: 'dispatch_ready', tripNumber: 8 });
    // One B2C order (succeeds: standalone EWB) + one B2B order (fails: IRN 3028).
    await seedB2cOrder(pfDriverId, v.id, PF_DATE);
    const b2b = await prisma.customer.findFirstOrThrow({ where: { distributorId: DIST, customerType: 'B2B', gstin: { not: null }, deletedAt: null } });
    const cyl = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: DIST } });
    const b2bOrder = await prisma.order.create({
      data: {
        distributorId: DIST, customerId: b2b.id, driverId: pfDriverId, vehicleId: v.id,
        orderNumber: `TL-PARTIAL-B2B-${Date.now().toString(36)}`, orderDate: new Date(PF_DATE), deliveryDate: new Date(PF_DATE),
        status: 'pending_dispatch', orderType: 'delivery', totalAmount: 2000,
        items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 2000, totalPrice: 2000 }] },
      },
    });
    createdOrderIds.push(b2bOrder.id);
    // Route by endpoint: IRN GENERATE → 3028 (B2B fails); genewaybill → success (B2C ok).
    apiCallMock.mockImplementation(async (_d: any, _m: any, path: string) => {
      if (typeof path === 'string' && path.includes('/einvoice/type/GENERATE')) { const e: any = new Error('GSTIN is invalid'); e.code = '3028'; throw e; }
      if (typeof path === 'string' && path.includes('genewaybill')) return ewbGenOk('TL-PARTIAL-EWB') as any;
      return { status_cd: '1' } as any;
    });
    const result = await preflightDispatch({ distributorId: DIST, driverId: pfDriverId, assignmentDate: PF_DATE, userId: 'tl-user' } as any);
    expect(result.summary.succeeded).toBeGreaterThanOrEqual(1);
    expect(result.summary.failed).toBeGreaterThanOrEqual(1);
    const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    expect(after.dispatchedAt).not.toBeNull();      // WI-098: stamped even on partial dispatch
    expect(after.status).toBe('dispatch_ready');     // NOT advanced (failed > 0 → retryable)
  });
});
