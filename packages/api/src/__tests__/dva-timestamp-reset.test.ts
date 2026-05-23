/**
 * WI-096b — the DVA trip roll moved from confirmDelivery (last delivery) to
 * preflightDispatch (start of the next dispatch).
 *
 * Previously confirmDelivery rolled the DVA the instant the last order was
 * delivered (WI-068/070): tripNumber++, status → dispatch_ready, and the
 * per-trip timestamps (dispatchedAt/returnedAt/reconciledAt) were cleared. That
 * rolled too early — it hid the Mark-Vehicle-Returned button, cleared
 * dispatchedAt, and mis-scoped the driver app. Now:
 *   - confirmDelivery does NOT touch the DVA — after the last delivery the DVA
 *     STAYS loaded_and_dispatched at the same tripNumber, timestamps intact.
 *   - preflightDispatch performs the roll (tripNumber++, clear timestamps/sheet)
 *     when it starts a new batch on a loaded_and_dispatched DVA with 0 in-flight.
 *
 * 1 ✅ confirmDelivery on the last order does NOT roll (DVA + timestamps intact)
 * 2 ✅ next preflightDispatch rolls: tripNumber++, OLD timestamps cleared, new dispatchedAt set
 * 3 ❌ partial delivery does NOT roll (unchanged)
 * 4 ❌ cross-tenant — a dist-001 caller cannot mutate a dist-002 DVA
 *
 * Uses dist-001 (GST disabled) so no WhiteBooks mock is needed. Far-future
 * TEST_DATE (anti-pattern #7) keeps the date-scoped service queries off real rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { confirmDelivery } from '../services/orderService.js';
import { preflightDispatch } from '../services/gst/gstPreflightService.js';

const D1 = 'dist-001', D2 = 'dist-002';
const TEST_DATE = '2099-12-31';
const date = new Date(TEST_DATE);
const PHONES = ['9914000001', '9914000002', '9914000003', '9914000004'];
const STAMP = new Date('2099-12-30T08:00:00.000Z');

const createdOrderIds: string[] = [];
const createdDvaIds: string[] = [];
const createdVehicleIds: string[] = [];
const createdDriverIds: string[] = [];
const createdUserEmails: string[] = [];

async function mkDriver(distributorId: string, phone: string, name: string) {
  const email = `tsr-${name}@test-ts-reset.local`;
  const passwordHash = await bcrypt.hash('TestDriver@123', 10);
  const user = await prisma.user.create({ data: { email, passwordHash, firstName: 'TSR', lastName: name, phone, role: 'driver', status: 'active', distributorId } });
  const driver = await prisma.driver.create({ data: { distributorId, driverName: `TSR ${name}`, phone, status: 'active' } });
  const vehicle = await prisma.vehicle.create({ data: { distributorId, vehicleNumber: `TEST-TSR-${name}`, vehicleType: 'Truck', status: 'dispatched' } });
  createdDriverIds.push(driver.id); createdUserEmails.push(email); createdVehicleIds.push(vehicle.id);
  return { userId: user.id, driverId: driver.id, vehicleId: vehicle.id };
}

async function mkDva(distributorId: string, driverId: string, vehicleId: string, opts: { status: string; tripNumber: number; stamped: boolean }) {
  const dva = await prisma.driverVehicleAssignment.create({
    data: {
      distributorId, driverId, vehicleId, assignmentDate: date,
      status: opts.status as any, tripNumber: opts.tripNumber,
      ...(opts.stamped ? { dispatchedAt: STAMP, returnedAt: STAMP, reconciledAt: STAMP, isReconciled: true } : {}),
    },
  });
  createdDvaIds.push(dva.id);
  return dva;
}

async function mkOrder(distributorId: string, driverId: string, vehicleId: string, opts: { status: string; tripNumber: number | null }) {
  const customer = await prisma.customer.findFirstOrThrow({ where: { distributorId, deletedAt: null } });
  const cyl = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId } });
  const order = await prisma.order.create({
    data: {
      distributorId, customerId: customer.id, driverId, vehicleId,
      orderNumber: `TEST-TSR-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      orderDate: date, deliveryDate: date, status: opts.status as any, orderType: 'delivery', totalAmount: 2000,
      tripNumber: opts.tripNumber,
      items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 2000, totalPrice: 2000 }] },
    },
    include: { items: true },
  });
  createdOrderIds.push(order.id);
  return order;
}

beforeAll(async () => {
  await cleanup();
});

async function cleanup() {
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
}

afterAll(cleanup);

describe('WI-096b — DVA roll deferred to dispatch (not delivery)', () => {
  it('✅ 1. confirmDelivery on the last order does NOT roll the DVA', async () => {
    const d = await mkDriver(D1, PHONES[0], 'NoRoll');
    const dva = await mkDva(D1, d.driverId, d.vehicleId, { status: 'loaded_and_dispatched', tripNumber: 1, stamped: true });
    const order = await mkOrder(D1, d.driverId, d.vehicleId, { status: 'pending_delivery', tripNumber: 1 });

    await confirmDelivery(order.id, D1, 'tsr-user', {
      items: order.items.map((i) => ({ cylinderTypeId: i.cylinderTypeId, deliveredQuantity: 1, emptiesCollected: 1 })),
    });

    const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    expect(after.tripNumber).toBe(1);                       // NOT rolled
    expect(after.status).toBe('loaded_and_dispatched');     // stays — Mark Returned still available
    expect(after.dispatchedAt?.toISOString()).toBe(STAMP.toISOString()); // timestamp preserved
  });

  it('✅ 2. next preflightDispatch rolls: tripNumber++, OLD timestamps cleared, new dispatchedAt set', async () => {
    const d = await mkDriver(D1, PHONES[1], 'Roll');
    // Simulate a completed + reconciled trip 1: DVA still loaded_and_dispatched
    // (confirmDelivery no longer rolls), with stale stamps from trip 1.
    const dva = await mkDva(D1, d.driverId, d.vehicleId, { status: 'loaded_and_dispatched', tripNumber: 1, stamped: true });
    await mkOrder(D1, d.driverId, d.vehicleId, { status: 'delivered', tripNumber: 1 }); // 0 in-flight
    // New batch ready for the next trip.
    await mkOrder(D1, d.driverId, d.vehicleId, { status: 'pending_dispatch', tripNumber: null });

    const result = await preflightDispatch({ distributorId: D1, driverId: d.driverId, assignmentDate: TEST_DATE, userId: 'tsr-user' } as any);
    expect(result.summary.succeeded).toBeGreaterThan(0);

    const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    expect(after.tripNumber).toBe(2);                       // rolled at dispatch
    expect(after.status).toBe('loaded_and_dispatched');     // dispatched the new batch
    expect(after.dispatchedAt).not.toBeNull();
    expect(after.dispatchedAt?.toISOString()).not.toBe(STAMP.toISOString()); // fresh stamp, not the old one
    expect(after.returnedAt).toBeNull();                    // OLD trip stamps cleared
    expect(after.reconciledAt).toBeNull();
    expect(after.isReconciled).toBe(false);
  });

  it('❌ 3. partial delivery does NOT roll — timestamps + tripNumber unchanged', async () => {
    const d = await mkDriver(D1, PHONES[2], 'Partial');
    const dva = await mkDva(D1, d.driverId, d.vehicleId, { status: 'loaded_and_dispatched', tripNumber: 1, stamped: true });
    const o1 = await mkOrder(D1, d.driverId, d.vehicleId, { status: 'pending_delivery', tripNumber: 1 });
    await mkOrder(D1, d.driverId, d.vehicleId, { status: 'pending_delivery', tripNumber: 1 }); // 2nd stays in-flight

    await confirmDelivery(o1.id, D1, 'tsr-user', {
      items: o1.items.map((i) => ({ cylinderTypeId: i.cylinderTypeId, deliveredQuantity: 1, emptiesCollected: 1 })),
    });

    const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    expect(after.tripNumber).toBe(1);
    expect(after.status).toBe('loaded_and_dispatched');
    expect(after.dispatchedAt?.toISOString()).toBe(STAMP.toISOString());
  });

  it('❌ 4. cross-tenant — a dist-001 caller cannot mutate a dist-002 DVA', async () => {
    const d = await mkDriver(D2, PHONES[3], 'XTenant');
    const dva = await mkDva(D2, d.driverId, d.vehicleId, { status: 'loaded_and_dispatched', tripNumber: 1, stamped: true });
    const order = await mkOrder(D2, d.driverId, d.vehicleId, { status: 'pending_delivery', tripNumber: 1 });

    // confirmDelivery scopes the order lookup to the caller's distributorId;
    // a dist-001 caller can't find the dist-002 order → throws, no side effects.
    await expect(
      confirmDelivery(order.id, D1, 'tsr-user', {
        items: order.items.map((i) => ({ cylinderTypeId: i.cylinderTypeId, deliveredQuantity: 1, emptiesCollected: 1 })),
      }),
    ).rejects.toThrow();

    const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    expect(after.tripNumber).toBe(1);
    expect(after.dispatchedAt?.toISOString()).toBe(STAMP.toISOString());
  });
});
