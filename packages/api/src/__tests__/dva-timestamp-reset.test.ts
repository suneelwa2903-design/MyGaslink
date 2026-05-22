/**
 * WI-094c (Change 1) — DVA per-trip timestamps cleared on trip roll.
 *
 * The single DVA row per driver/day is reused across trips (tripNumber++ in
 * place). When the trip rolls, the previous trip's dispatchedAt/returnedAt/
 * reconciledAt must be cleared, or they leak onto the new trip's driver-app
 * timeline. The roll happens in confirmDelivery's auto-reset (orderService.ts)
 * and the legacy recovery branch (gstPreflightService.ts).
 *
 * 1 ✅ timestamps cleared + tripNumber++ when the last order is delivered
 * 2 ✅ a fresh dispatch after the roll sets dispatchedAt; returnedAt stays null
 * 3 ❌ partial delivery does NOT roll (timestamps + tripNumber unchanged)
 * 4 ❌ cross-tenant — a dist-001 caller cannot roll/clear a dist-002 DVA
 *
 * Uses dist-001 (GST disabled) so no WhiteBooks mock is needed. Far-future
 * TEST_DATE (anti-pattern #7) keeps the confirmDelivery auto-reset updateMany
 * — which matches by (distributorId, driverId, assignmentDate) — off real rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { confirmDelivery } from '../services/orderService.js';
import { preflightDispatch } from '../services/gst/gstPreflightService.js';

const D1 = 'dist-001', D2 = 'dist-002';
const TEST_DATE = '2099-12-31';
const date = new Date(TEST_DATE);
const PHONES = ['9914000001', '9914000002', '9914000003'];
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

// Shared across Test 1 → Test 2 (the fresh dispatch must run on the rolled DVA).
let rollDriverId = '', rollVehicleId = '', rollDvaId = '';

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

describe('WI-094c — DVA timestamp reset on trip roll', () => {
  it('✅ 1. clears dispatched/returned/reconciled + bumps tripNumber when last order delivered', async () => {
    const d = await mkDriver(D1, PHONES[0], 'Roll');
    rollDriverId = d.driverId; rollVehicleId = d.vehicleId;
    const dva = await mkDva(D1, d.driverId, d.vehicleId, { status: 'loaded_and_dispatched', tripNumber: 1, stamped: true });
    rollDvaId = dva.id;
    const order = await mkOrder(D1, d.driverId, d.vehicleId, { status: 'pending_delivery', tripNumber: 1 });

    await confirmDelivery(order.id, D1, 'tsr-user', {
      items: order.items.map((i) => ({ cylinderTypeId: i.cylinderTypeId, deliveredQuantity: 1, emptiesCollected: 1 })),
    });

    const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    expect(after.tripNumber).toBe(2);
    expect(after.status).toBe('dispatch_ready');
    expect(after.dispatchedAt).toBeNull();
    expect(after.returnedAt).toBeNull();
    expect(after.reconciledAt).toBeNull();
    expect(after.isReconciled).toBe(false);
  });

  it('✅ 2. fresh dispatch after the roll sets dispatchedAt; returnedAt stays null', async () => {
    // Reuses the rolled DVA from Test 1 (now dispatch_ready, tripNumber=2, all
    // timestamps cleared). A new pending_dispatch order + preflight should
    // stamp dispatchedAt only — returnedAt must remain null (dispatch never
    // sets it, and the roll already cleared it).
    await mkOrder(D1, rollDriverId, rollVehicleId, { status: 'pending_dispatch', tripNumber: null });
    const result = await preflightDispatch({ distributorId: D1, driverId: rollDriverId, assignmentDate: TEST_DATE, userId: 'tsr-user' } as any);
    expect(result.summary.succeeded).toBeGreaterThan(0);

    const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: rollDvaId } });
    expect(after.status).toBe('loaded_and_dispatched');
    expect(after.dispatchedAt).not.toBeNull();
    expect(after.returnedAt).toBeNull();
    expect(after.reconciledAt).toBeNull();
  });

  it('❌ 3. partial delivery does NOT roll — timestamps + tripNumber unchanged', async () => {
    const d = await mkDriver(D1, PHONES[1], 'Partial');
    const dva = await mkDva(D1, d.driverId, d.vehicleId, { status: 'loaded_and_dispatched', tripNumber: 1, stamped: true });
    const o1 = await mkOrder(D1, d.driverId, d.vehicleId, { status: 'pending_delivery', tripNumber: 1 });
    await mkOrder(D1, d.driverId, d.vehicleId, { status: 'pending_delivery', tripNumber: 1 }); // 2nd stays in-flight

    await confirmDelivery(o1.id, D1, 'tsr-user', {
      items: o1.items.map((i) => ({ cylinderTypeId: i.cylinderTypeId, deliveredQuantity: 1, emptiesCollected: 1 })),
    });

    const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    expect(after.tripNumber).toBe(1);                       // NOT rolled
    expect(after.status).toBe('loaded_and_dispatched');     // unchanged
    expect(after.dispatchedAt?.toISOString()).toBe(STAMP.toISOString());
    expect(after.returnedAt?.toISOString()).toBe(STAMP.toISOString());
    expect(after.reconciledAt?.toISOString()).toBe(STAMP.toISOString());
    expect(after.isReconciled).toBe(true);
  });

  it('❌ 4. cross-tenant — a dist-001 caller cannot roll/clear a dist-002 DVA', async () => {
    const d = await mkDriver(D2, PHONES[2], 'XTenant');
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
    expect(after.returnedAt?.toISOString()).toBe(STAMP.toISOString());
    expect(after.reconciledAt?.toISOString()).toBe(STAMP.toISOString());
  });
});
