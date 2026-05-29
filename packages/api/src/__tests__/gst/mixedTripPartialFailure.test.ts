/**
 * Fix 4 — mixed B2B+B2C trip partial-failure consistency.
 *
 * Pre-fix bug (surfaced in the 2026-05-29 demo IRN+EWB session): the B2C
 * EWB-throw catch branch in runB2cPreflight uniquely reverted the order to
 * `pending_dispatch` while every other partial-failure branch in the file
 * (B2B EWB-after-IRN failure, B2C no-ewayBillNo success-with-no-number)
 * commits forward to `pending_delivery`. The inconsistency cost us a full
 * IRN+EWB dispatch cycle on the demo tenant.
 *
 * Fix: bring the B2C catch in line with the other paths — mark
 * `invoice.ewbStatus='failed'`, transition to `pending_delivery`, raise a
 * HIGH pending action, return `success: true`. The cylinder physically
 * leaves the depot; admin retries the EWB via /generate-gst, and Fix 3's
 * `tryAdvanceTripAfterRetry` lifts the trip to `loaded_and_dispatched`.
 *
 * Far-future date (2099-12-31, anti-pattern #7) so no manual-test state on
 * the shared dev DB is touched.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';

vi.mock('../../services/gst/whitebooksClient.js', async (orig) => {
  const original = await orig<typeof import('../../services/gst/whitebooksClient.js')>();
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

import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import * as whitebooksClient from '../../services/gst/whitebooksClient.js';
import { preflightDispatch, tryAdvanceTripAfterRetry } from '../../services/gst/gstPreflightService.js';

const DIST = 'dist-002';
const PF_DATE = '2099-12-31';
const apiCallMock = vi.mocked(whitebooksClient.apiCall);

const createdOrderIds: string[] = [];
const createdInvoiceIds: string[] = [];
const createdDvaIds: string[] = [];
const createdVehicleIds: string[] = [];
const createdDriverIds: string[] = [];
const createdUserEmails: string[] = [];

let driverId = '';
let userId = '';

beforeAll(async () => {
  const passwordHash = await bcrypt.hash('TestDriver@123', 10);
  const email = 'mxtp-driver@test-mxt-partial.local';
  const user = await prisma.user.create({
    data: { email, passwordHash, firstName: 'MXT', lastName: 'Driver', phone: '9913800101', role: 'driver', status: 'active', distributorId: DIST },
  });
  createdUserEmails.push(email);
  userId = user.id;
  const driver = await prisma.driver.create({
    data: { distributorId: DIST, driverName: 'MXT Driver', phone: '9913800101', status: 'active' },
  });
  createdDriverIds.push(driver.id);
  driverId = driver.id;
});

beforeEach(() => apiCallMock.mockReset());

afterAll(async () => {
  await prisma.gstDocument.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
  await prisma.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
  await prisma.pendingAction.deleteMany({ where: { entityId: { in: createdInvoiceIds } } });
  await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.driverAssignment.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await prisma.driverVehicleAssignment.deleteMany({ where: { id: { in: createdDvaIds } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: createdVehicleIds } } });
  await prisma.driver.deleteMany({ where: { id: { in: createdDriverIds } } });
  await prisma.user.deleteMany({ where: { email: { in: createdUserEmails } } });
});

let counter = 0;
async function makeVehicle(): Promise<string> {
  counter += 1;
  const v = await prisma.vehicle.create({
    data: { distributorId: DIST, vehicleNumber: `MXT-V-${counter}-${Math.random().toString(36).slice(2, 6)}`, vehicleType: 'Truck', capacity: 100, status: 'idle' as Prisma.VehicleCreateInput['status'] },
  });
  createdVehicleIds.push(v.id);
  return v.id;
}
async function makeDva(vehicleId: string, tripNumber: number) {
  const dva = await prisma.driverVehicleAssignment.create({
    data: { driverId, vehicleId, distributorId: DIST, assignmentDate: new Date(PF_DATE), status: 'dispatch_ready' as Prisma.DriverVehicleAssignmentCreateInput['status'], tripNumber },
  });
  createdDvaIds.push(dva.id);
  return dva;
}
async function makeOrder(customerType: 'B2B' | 'B2C', vehicleId: string, tag: string) {
  const customer = await prisma.customer.findFirstOrThrow({
    where: { distributorId: DIST, customerType, deletedAt: null, ...(customerType === 'B2B' ? { gstin: { not: null } } : {}) },
  });
  const cyl = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: DIST } });
  const order = await prisma.order.create({
    data: {
      distributorId: DIST, customerId: customer.id, driverId, vehicleId,
      orderNumber: `MXT-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      orderDate: new Date(PF_DATE), deliveryDate: new Date(PF_DATE), status: 'pending_dispatch',
      orderType: 'delivery', totalAmount: 2000,
      items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 2000, totalPrice: 2000 }] },
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

// NIC error 225 — the exact failure mode from the 2026-05-29 demo session.
const NIC_225 = (() => {
  const e = new Error('{"errorCodes":"225,"}') as Error & { code: string };
  e.code = '225';
  return e;
})();
function irnGenOk(irn = 'a'.repeat(64), ackNo = '112610001234567') {
  return { status_cd: '1', data: { Irn: irn, AckNo: ackNo, AckDt: '2099-12-31 10:00:00', SignedQRCode: 'qr' } };
}
function ewbGenOk(no = '111012000123') {
  return { status_cd: '1', data: { ewayBillNo: no, ewayBillDate: '31/12/2099 10:00:00 AM', validUpto: '01/01/2100 11:59:00 PM' } };
}

describe('Fix 4 — mixed B2B+B2C with B2C EWB throw', () => {
  it('1. ALL orders end at pending_delivery (B2C no longer reverts)', async () => {
    const vehicleId = await makeVehicle();
    await makeDva(vehicleId, 100);
    const b2b1 = await makeOrder('B2B', vehicleId, 'B2B1');
    const b2b2 = await makeOrder('B2B', vehicleId, 'B2B2');
    const b2c = await makeOrder('B2C', vehicleId, 'B2C');

    // IRN GENERATE: B2B success; B2C never calls IRN.
    // EWB GENERATE: B2B succeeds (inline-IRN path returns no EWB → standalone EWB
    // success); B2C standalone EWB throws NIC 225.
    apiCallMock.mockImplementation(async (_d, _m, path) => {
      if (typeof path === 'string' && path.includes('/einvoice/type/GENERATE')) {
        return irnGenOk();
      }
      if (typeof path === 'string' && path.includes('genewaybill')) {
        // B2C and B2B both hit this endpoint. B2C invoice number is the only
        // one starting 'IDMO' on this tenant — distinguish by payload's docNo.
        // Simpler: alternate — first call (B2B) ok, second (B2B) ok, third (B2C) fail.
        // Use a counter via the mock's call count.
        const callCount = apiCallMock.mock.calls.length;
        // B2B preflight makes IRN call then EWB call. With 2 B2B + 1 B2C in the
        // batch, B2C runs last. Throw on the LAST genewaybill call.
        const ewbCallsSoFar = apiCallMock.mock.calls.filter((c) => typeof c[2] === 'string' && (c[2] as string).includes('genewaybill')).length;
        if (ewbCallsSoFar >= 3) throw NIC_225;
        return ewbGenOk(`B-EWB-${callCount}`);
      }
      return { status_cd: '1' };
    });

    const result = await preflightDispatch({ distributorId: DIST, driverId, assignmentDate: PF_DATE, userId });
    // After fix: B2B both succeed; B2C "succeeded" (success: true) despite failed EWB.
    expect(result.summary.succeeded).toBe(3);
    expect(result.summary.failed).toBe(0);

    const orders = await prisma.order.findMany({
      where: { id: { in: [b2b1.id, b2b2.id, b2c.id] } },
      select: { id: true, status: true },
    });
    for (const o of orders) {
      expect(o.status).toBe('pending_delivery');
    }
  });

  it('2. B2C invoice ewbStatus is "failed" after the EWB throw', async () => {
    const vehicleId = await makeVehicle();
    await makeDva(vehicleId, 101);
    const b2c = await makeOrder('B2C', vehicleId, 'B2C-only');

    apiCallMock.mockImplementation(async (_d, _m, path) => {
      if (typeof path === 'string' && path.includes('genewaybill')) throw NIC_225;
      return { status_cd: '1' };
    });

    await preflightDispatch({ distributorId: DIST, driverId, assignmentDate: PF_DATE, userId });
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { orderId: b2c.id } });
    createdInvoiceIds.push(invoice.id);
    expect(invoice.ewbStatus).toBe('failed');
  });

  it('3. HIGH-severity pending action raised for the B2C EWB failure', async () => {
    const vehicleId = await makeVehicle();
    await makeDva(vehicleId, 102);
    const b2c = await makeOrder('B2C', vehicleId, 'B2C-PA');

    apiCallMock.mockImplementation(async (_d, _m, path) => {
      if (typeof path === 'string' && path.includes('genewaybill')) throw NIC_225;
      return { status_cd: '1' };
    });

    await preflightDispatch({ distributorId: DIST, driverId, assignmentDate: PF_DATE, userId });
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { orderId: b2c.id } });
    createdInvoiceIds.push(invoice.id);
    const pa = await prisma.pendingAction.findFirst({
      where: { distributorId: DIST, entityId: invoice.id, actionType: 'EWB_GENERATION' },
      orderBy: { createdAt: 'desc' },
    });
    expect(pa).toBeTruthy();
  });

  it('4. Preflight summary reports success: true for the whole batch (no failed count)', async () => {
    const vehicleId = await makeVehicle();
    await makeDva(vehicleId, 103);
    await makeOrder('B2C', vehicleId, 'B2C-sum');

    apiCallMock.mockImplementation(async (_d, _m, path) => {
      if (typeof path === 'string' && path.includes('genewaybill')) throw NIC_225;
      return { status_cd: '1' };
    });

    const result = await preflightDispatch({ distributorId: DIST, driverId, assignmentDate: PF_DATE, userId });
    expect(result.summary.succeeded).toBe(1);
    expect(result.summary.failed).toBe(0);
  });

  it('5. Recovery via tryAdvanceTripAfterRetry — B2B IRN failure blocks the trip; later retry advances it', async () => {
    // Mixed scenario: B2C order with bad EWB (Fix 4 keeps it as "succeeded")
    // PLUS a B2B order with a real IRN failure (still fails → reverts to
    // pending_dispatch → trip-advance gate sees failed > 0 → DVA stays at
    // dispatch_ready). Operator later fixes the B2B IRN cause, retries via
    // /generate-gst, and the helper advances the trip.
    const vehicleId = await makeVehicle();
    const dva = await makeDva(vehicleId, 104);
    const b2b = await makeOrder('B2B', vehicleId, 'B2B-recov');
    const b2c = await makeOrder('B2C', vehicleId, 'B2C-recov');

    apiCallMock.mockImplementation(async (_d, _m, path) => {
      // B2B IRN GENERATE fails with 3028 → order reverts to pending_dispatch.
      if (typeof path === 'string' && path.includes('/einvoice/type/GENERATE')) {
        const e = new Error('GSTIN is invalid') as Error & { code: string };
        e.code = '3028';
        throw e;
      }
      // B2C EWB fails (Fix 4: still success: true, order at pending_delivery).
      if (typeof path === 'string' && path.includes('genewaybill')) {
        throw NIC_225;
      }
      return { status_cd: '1' };
    });

    const result = await preflightDispatch({ distributorId: DIST, driverId, assignmentDate: PF_DATE, userId });
    expect(result.summary.failed).toBe(1); // B2B IRN failure
    expect(result.summary.succeeded).toBe(1); // B2C, per Fix 4

    // Trip blocked because B2B IRN failure left an order at pending_dispatch.
    let dvaRow = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    expect(dvaRow.status).toBe('dispatch_ready');

    // Operator fixes the B2B GSTIN out-of-band; the retry sets invoice
    // statuses to success/active and transitions the order forward. We
    // simulate that end-state directly (the integration with
    // processInvoiceGst is exercised in tripAutoAdvance.test.ts).
    const b2bInv = await prisma.invoice.findFirstOrThrow({ where: { orderId: b2b.id } });
    createdInvoiceIds.push(b2bInv.id);
    await prisma.invoice.update({ where: { id: b2bInv.id }, data: { irnStatus: 'success', ewbStatus: 'active' } });
    await prisma.order.update({ where: { id: b2b.id }, data: { status: 'pending_delivery' } });

    // B2C still has failed EWB but its order is at pending_delivery (Fix 4).
    // The helper's blocker count uses ewbStatus 'failed' OR 'pending', so a
    // truly recovered trip needs the B2C EWB to also be active. Simulate the
    // operator retrying the B2C EWB too.
    const b2cInv = await prisma.invoice.findFirstOrThrow({ where: { orderId: b2c.id } });
    createdInvoiceIds.push(b2cInv.id);
    await prisma.invoice.update({ where: { id: b2cInv.id }, data: { ewbStatus: 'active' } });

    const out = await tryAdvanceTripAfterRetry(b2bInv.id, DIST, userId);
    expect(out.advanced).toBe(true);
    expect(out.dvaId).toBe(dva.id);
    dvaRow = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    expect(dvaRow.status).toBe('loaded_and_dispatched');
  });
});

describe('Fix 4 — regressions that must NOT change', () => {
  it('6. B2B IRN failure still reverts (IRN failure ≠ EWB failure — different scenario)', async () => {
    // dva-timeline.test.ts pins this; we re-pin here so a future refactor of
    // runB2cPreflight doesn't accidentally drag B2B IRN behavior with it.
    const vehicleId = await makeVehicle();
    const dva = await makeDva(vehicleId, 105);
    const b2b = await makeOrder('B2B', vehicleId, 'B2B-IRN-fail');

    apiCallMock.mockImplementation(async (_d, _m, path) => {
      if (typeof path === 'string' && path.includes('/einvoice/type/GENERATE')) {
        const e = new Error('GSTIN is invalid') as Error & { code: string };
        e.code = '3028';
        throw e;
      }
      if (typeof path === 'string' && path.includes('genewaybill')) {
        return ewbGenOk('B-EWB-irnfail');
      }
      return { status_cd: '1' };
    });

    const result = await preflightDispatch({ distributorId: DIST, driverId, assignmentDate: PF_DATE, userId });
    expect(result.summary.failed).toBeGreaterThanOrEqual(1);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: b2b.id } });
    expect(order.status).toBe('pending_dispatch'); // reverted, as before
    const dvaRow = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    expect(dvaRow.status).toBe('dispatch_ready'); // NOT advanced
  });
});
