/**
 * tryAdvanceTripAfterRetry — Fix 3 (2026-05-30).
 *
 * Live IRN+EWB E2E (2026-05-29) found that a per-invoice retry via
 * `POST /api/invoices/:id/generate-gst` could resurrect a failed EWB, but the
 * DVA stayed at `dispatch_ready` forever because the advance gate only fires
 * inside `preflightDispatch` when the whole batch was clean. The driver app
 * showed "Trip Ready" while every order in the trip was actually ready to go.
 *
 * Tests use far-future date (`2099-12-31`, anti-pattern #7) so no manual-test
 * data on the shared dev DB is touched. Each test seeds its own DVA + 1-2
 * orders + invoices, calls the helper directly, and asserts the DVA outcome.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Mock the SSE manager so the helper's notifyDriver call is observable.
vi.mock('../../lib/sseManager.js', () => ({
  notifyDriver: vi.fn(),
  addConnection: vi.fn(),
  removeConnection: vi.fn(),
  _getConnectionCountForTests: vi.fn(() => 0),
}));

import { prisma } from '../../lib/prisma.js';
import * as sseManager from '../../lib/sseManager.js';
import { tryAdvanceTripAfterRetry } from '../../services/gst/gstPreflightService.js';

const DIST = 'dist-001';
const PF_DATE = '2099-12-31';
const FAR_FUTURE = new Date(PF_DATE);
const notifyDriverMock = vi.mocked(sseManager.notifyDriver);

const createdInvoiceIds: string[] = [];
const createdOrderIds: string[] = [];
const createdDvaIds: string[] = [];
const createdVehicleIds: string[] = [];
const createdDriverIds: string[] = [];

let customerId: string;
let cylinderTypeId: string;
let userId: string;

beforeAll(async () => {
  const customer = await prisma.customer.findFirstOrThrow({
    where: { distributorId: DIST, deletedAt: null },
    orderBy: { customerName: 'asc' },
  });
  customerId = customer.id;
  const cyl = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: DIST },
  });
  cylinderTypeId = cyl.id;
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'bhargava@gasagency.com' } });
  userId = admin.id;
});

afterAll(async () => {
  if (createdInvoiceIds.length > 0) {
    await prisma.paymentAllocation.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
    await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
    await prisma.gstDocument.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
    await prisma.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
  }
  if (createdOrderIds.length > 0) {
    await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await prisma.driverAssignment.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  }
  if (createdDvaIds.length > 0) {
    await prisma.reconciliationEmptiesReturned.deleteMany({ where: { dvaId: { in: createdDvaIds } } });
    await prisma.driverVehicleAssignment.deleteMany({ where: { id: { in: createdDvaIds } } });
  }
  if (createdVehicleIds.length > 0) {
    await prisma.vehicle.deleteMany({ where: { id: { in: createdVehicleIds } } });
  }
  if (createdDriverIds.length > 0) {
    await prisma.driver.deleteMany({ where: { id: { in: createdDriverIds } } });
  }
});

interface Scenario {
  driverId: string;
  vehicleId: string;
  dvaId: string;
  tripNumber: number;
  orders: { orderId: string; invoiceId: string }[];
}

let counter = 0;

/**
 * Spin up an isolated test trip — fresh driver + vehicle + DVA on the
 * far-future date, plus N orders each with their own invoice. Caller controls
 * each order's status and each invoice's irnStatus/ewbStatus.
 */
async function makeScenario(specs: Array<{
  orderStatus: 'pending_dispatch' | 'preflight_in_progress' | 'pending_delivery' | 'delivered';
  irnStatus: 'success' | 'failed' | 'not_attempted' | 'pending';
  ewbStatus: 'active' | 'failed' | 'not_attempted' | 'pending' | 'cancelled';
}>): Promise<Scenario> {
  counter += 1;
  const tag = `TRIP-ADV-${Date.now().toString(36)}-${counter}`;
  const driver = await prisma.driver.create({
    data: {
      distributorId: DIST,
      driverName: `${tag}-driver`,
      phone: `9${counter.toString().padStart(11, '0')}`.slice(0, 12),
      status: 'active',
      availableToday: true,
    },
  });
  createdDriverIds.push(driver.id);
  const vehicle = await prisma.vehicle.create({
    data: {
      distributorId: DIST,
      // Unique per test via counter + the per-test tag — Vehicle has a
      // composite unique on (distributorId, vehicleNumber) which we'd
      // otherwise hit on rapid sequential creates within a ms.
      vehicleNumber: `TA-V-${counter}-${Math.random().toString(36).slice(2, 8)}`,
      vehicleType: 'truck',
      capacity: 100,
      status: 'idle',
    },
  });
  createdVehicleIds.push(vehicle.id);
  const dva = await prisma.driverVehicleAssignment.create({
    data: {
      distributorId: DIST,
      driverId: driver.id,
      vehicleId: vehicle.id,
      assignmentDate: FAR_FUTURE,
      tripNumber: 1,
      status: 'dispatch_ready',
    },
  });
  createdDvaIds.push(dva.id);

  const orders: { orderId: string; invoiceId: string }[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const order = await prisma.order.create({
      data: {
        orderNumber: `${tag}-O${i}`,
        distributorId: DIST,
        customerId,
        driverId: driver.id,
        vehicleId: vehicle.id,
        orderDate: FAR_FUTURE,
        deliveryDate: FAR_FUTURE,
        status: spec.orderStatus,
        tripNumber: 1,
        totalAmount: 1800,
        items: {
          create: [{ cylinderTypeId, quantity: 1, unitPrice: 1800, totalPrice: 1800 }],
        },
      },
    });
    createdOrderIds.push(order.id);
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `${tag}-I${i}`,
        distributorId: DIST,
        customerId,
        orderId: order.id,
        issueDate: FAR_FUTURE,
        dueDate: FAR_FUTURE,
        totalAmount: 1800,
        amountPaid: 0,
        outstandingAmount: 1800,
        status: 'issued',
        irnStatus: spec.irnStatus,
        ewbStatus: spec.ewbStatus,
      },
    });
    createdInvoiceIds.push(invoice.id);
    orders.push({ orderId: order.id, invoiceId: invoice.id });
  }

  return { driverId: driver.id, vehicleId: vehicle.id, dvaId: dva.id, tripNumber: 1, orders };
}

describe('tryAdvanceTripAfterRetry — positive cases', () => {
  it('1. all orders in trip have active EWB → DVA advances to loaded_and_dispatched', async () => {
    notifyDriverMock.mockClear();
    const s = await makeScenario([
      { orderStatus: 'pending_delivery', irnStatus: 'success', ewbStatus: 'active' },
      { orderStatus: 'pending_delivery', irnStatus: 'success', ewbStatus: 'active' },
    ]);
    const out = await tryAdvanceTripAfterRetry(s.orders[0].invoiceId, DIST, userId);
    expect(out.advanced).toBe(true);
    expect(out.dvaId).toBe(s.dvaId);
    const dva = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: s.dvaId } });
    expect(dva.status).toBe('loaded_and_dispatched');
    expect(dva.dispatchedAt).not.toBeNull();
  });

  it('2. vehicle status flips to dispatched', async () => {
    const s = await makeScenario([
      { orderStatus: 'pending_delivery', irnStatus: 'success', ewbStatus: 'active' },
    ]);
    await tryAdvanceTripAfterRetry(s.orders[0].invoiceId, DIST, userId);
    const veh = await prisma.vehicle.findUniqueOrThrow({ where: { id: s.vehicleId } });
    expect(veh.status).toBe('dispatched');
  });

  it('3. notifyDriver called with trip_updated event', async () => {
    notifyDriverMock.mockClear();
    const s = await makeScenario([
      { orderStatus: 'pending_delivery', irnStatus: 'success', ewbStatus: 'active' },
    ]);
    await tryAdvanceTripAfterRetry(s.orders[0].invoiceId, DIST, userId);
    expect(notifyDriverMock).toHaveBeenCalledTimes(1);
    expect(notifyDriverMock).toHaveBeenCalledWith(s.driverId, {
      type: 'trip_updated',
      payload: { dvaId: s.dvaId },
    });
  });

  it('4. B2C revert edge case — order at pending_dispatch transitions forward, then advances', async () => {
    const s = await makeScenario([
      // First order at pending_dispatch (would have been reverted by old B2C catch
      // before Fix 4); EWB now active after a successful retry.
      { orderStatus: 'pending_dispatch', irnStatus: 'success', ewbStatus: 'active' },
    ]);
    const out = await tryAdvanceTripAfterRetry(s.orders[0].invoiceId, DIST, userId);
    expect(out.advanced).toBe(true);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: s.orders[0].orderId } });
    expect(order.status).toBe('pending_delivery'); // transitioned by helper
    const dva = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: s.dvaId } });
    expect(dva.status).toBe('loaded_and_dispatched');
  });
});

describe('tryAdvanceTripAfterRetry — negative cases', () => {
  it('5. one other order still has ewbStatus=failed → no advance', async () => {
    notifyDriverMock.mockClear();
    const s = await makeScenario([
      { orderStatus: 'pending_delivery', irnStatus: 'success', ewbStatus: 'active' },
      { orderStatus: 'pending_delivery', irnStatus: 'success', ewbStatus: 'failed' },
    ]);
    const out = await tryAdvanceTripAfterRetry(s.orders[0].invoiceId, DIST, userId);
    expect(out.advanced).toBe(false);
    const dva = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: s.dvaId } });
    expect(dva.status).toBe('dispatch_ready'); // untouched
    expect(notifyDriverMock).not.toHaveBeenCalled();
  });

  it('6. DVA already at loaded_and_dispatched → no-op, returns {advanced:false}', async () => {
    const s = await makeScenario([
      { orderStatus: 'pending_delivery', irnStatus: 'success', ewbStatus: 'active' },
    ]);
    await prisma.driverVehicleAssignment.update({
      where: { id: s.dvaId },
      data: { status: 'loaded_and_dispatched' },
    });
    const out = await tryAdvanceTripAfterRetry(s.orders[0].invoiceId, DIST, userId);
    expect(out.advanced).toBe(false);
  });

  it('7. one order has irnStatus=failed (not just EWB) → no advance', async () => {
    const s = await makeScenario([
      { orderStatus: 'pending_delivery', irnStatus: 'success', ewbStatus: 'active' },
      { orderStatus: 'pending_delivery', irnStatus: 'failed', ewbStatus: 'failed' },
    ]);
    const out = await tryAdvanceTripAfterRetry(s.orders[0].invoiceId, DIST, userId);
    expect(out.advanced).toBe(false);
  });

  it('8. invoice not found / different distributor → no advance, no throw', async () => {
    const s = await makeScenario([
      { orderStatus: 'pending_delivery', irnStatus: 'success', ewbStatus: 'active' },
    ]);
    await expect(
      tryAdvanceTripAfterRetry(s.orders[0].invoiceId, 'dist-002', userId),
    ).resolves.toEqual({ advanced: false });
  });

  it('9. no DVA exists for the (driver, date) coordinate → no advance', async () => {
    const s = await makeScenario([
      { orderStatus: 'pending_delivery', irnStatus: 'success', ewbStatus: 'active' },
    ]);
    // Cancel the DVA — helper should not find it as dispatch_ready.
    await prisma.driverVehicleAssignment.update({
      where: { id: s.dvaId },
      data: { status: 'cancelled' },
    });
    const out = await tryAdvanceTripAfterRetry(s.orders[0].invoiceId, DIST, userId);
    expect(out.advanced).toBe(false);
  });

  it('10. invoice ewbStatus is not active → no advance even if everything else looks ready', async () => {
    const s = await makeScenario([
      { orderStatus: 'pending_delivery', irnStatus: 'success', ewbStatus: 'failed' },
    ]);
    const out = await tryAdvanceTripAfterRetry(s.orders[0].invoiceId, DIST, userId);
    expect(out.advanced).toBe(false);
  });
});
