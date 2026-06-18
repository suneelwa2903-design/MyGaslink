/**
 * WI-100 — DVA terminal state + Mark-Vehicle-Returned loop guard.
 *
 * After WI-096b the DVA stayed at loaded_and_dispatched after a trip completed,
 * and reconcile reset the vehicle to idle without advancing the DVA — so the
 * driver app re-showed "Mark Vehicle Returned" forever. WI-100:
 *   A. confirmVehicleReconciliation now sets DVA.status = 'dispatch_ready'.
 *   B. preflightDispatch rolls on dispatch_ready+isReconciled (post-reconcile)
 *      AND still on loaded_and_dispatched + 0 in-flight (defence-in-depth).
 *   C. markVehicleReturned throws 409 when already idle/reconciled.
 *
 * 1 ✅ reconciled DVA → status dispatch_ready (+ isReconciled, vehicle idle)
 * 2 ❌ markVehicleReturned throws when DVA.isReconciled === true
 * 3 ✅ preflightDispatch rolls on a dispatch_ready + isReconciled DVA
 * 4 ✅ preflightDispatch still rolls on loaded_and_dispatched + 0 in-flight (regression)
 * 5 ❌ preflightDispatch does NOT roll a brand-new dispatch_ready + !isReconciled DVA
 *
 * dist-001 (GST disabled) → no WhiteBooks mock. Tests 1/2 use TODAY-dated DVAs
 * (those services look up by startOfUtcDay) on synthetic vehicles; tests 3-5 use
 * a far-future date (preflightDispatch looks up by the passed date).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { preflightDispatch } from '../services/gst/gstPreflightService.js';
import { markVehicleReturned, confirmVehicleReconciliation } from '../services/deliveryWorkflowService.js';
import { startOfUtcDay } from '../utils/dateOnly.js';

const D1 = 'dist-001';
const FF = '2099-12-31';
const ffDate = new Date(FF);
const today = startOfUtcDay();
const PHONES = ['9916000001', '9916000002', '9916000003', '9916000004', '9916000005'];

const oIds: string[] = [], dvaIds: string[] = [], vIds: string[] = [], drIds: string[] = [], emails: string[] = [];

async function mkDriver(phone: string, name: string, vehStatus: string) {
  const email = `dts-${name}@test-dva-terminal.local`;
  const passwordHash = await bcrypt.hash('TestDriver@123', 10);
  const user = await prisma.user.create({ data: { email, passwordHash, firstName: 'DTS', lastName: name, phone, role: 'driver', status: 'active', distributorId: D1 } });
  const driver = await prisma.driver.create({ data: { distributorId: D1, driverName: `DTS ${name}`, phone, status: 'active' } });
  const vehicle = await prisma.vehicle.create({ data: { distributorId: D1, vehicleNumber: `TEST-DTS-${name}`, vehicleType: 'Truck', status: vehStatus as Prisma.VehicleCreateInput['status'] } });
  drIds.push(driver.id); emails.push(email); vIds.push(vehicle.id);
  return { userId: user.id, driverId: driver.id, vehicleId: vehicle.id };
}

async function mkDva(driverId: string, vehicleId: string, opts: { status: string; tripNumber: number; isReconciled?: boolean; date: Date }) {
  const dva = await prisma.driverVehicleAssignment.create({
    data: { distributorId: D1, driverId, vehicleId, assignmentDate: opts.date, status: opts.status as Prisma.DriverVehicleAssignmentCreateInput['status'], tripNumber: opts.tripNumber, isReconciled: opts.isReconciled ?? false },
  });
  dvaIds.push(dva.id);
  return dva;
}

async function mkOrder(driverId: string, vehicleId: string, opts: { status: string; tripNumber: number | null; date: Date }) {
  const customer = await prisma.customer.findFirstOrThrow({ where: { distributorId: D1, deletedAt: null } });
  const cyl = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: D1 } });
  const order = await prisma.order.create({
    data: {
      distributorId: D1, customerId: customer.id, driverId, vehicleId,
      orderNumber: `TEST-DTS-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      orderDate: opts.date, deliveryDate: opts.date, status: opts.status as Prisma.OrderCreateInput['status'], orderType: 'delivery', totalAmount: 2000,
      tripNumber: opts.tripNumber,
      items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 2000, totalPrice: 2000 }] },
    },
  });
  oIds.push(order.id);
  return order;
}

async function cleanup() {
  await prisma.gstDocument.deleteMany({ where: { orderId: { in: oIds } } });
  await prisma.invoice.deleteMany({ where: { orderId: { in: oIds } } });
  await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: oIds } } });
  await prisma.inventoryEvent.deleteMany({ where: { referenceId: { in: oIds } } });
  await prisma.cancelledStockEvent.deleteMany({ where: { vehicleId: { in: vIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: oIds } } });
  await prisma.order.deleteMany({ where: { id: { in: oIds } } });
  await prisma.driverVehicleAssignment.deleteMany({ where: { id: { in: dvaIds } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: vIds } } });
  await prisma.driver.deleteMany({ where: { id: { in: drIds } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
}

beforeAll(cleanup);
afterAll(cleanup);

describe('WI-100 — DVA terminal state + return-loop guard', () => {
  it('✅ 1. confirmVehicleReconciliation sets DVA status=dispatch_ready (+ isReconciled, vehicle idle)', async () => {
    const d = await mkDriver(PHONES[0], 'Reconcile', 'returned');
    const dva = await mkDva(d.driverId, d.vehicleId, { status: 'loaded_and_dispatched', tripNumber: 1, date: today });

    await confirmVehicleReconciliation(d.vehicleId, D1, 'dts-user', { physicalStockConfirmed: true });

    const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    expect(after.status).toBe('dispatch_ready');
    expect(after.isReconciled).toBe(true);
    expect(after.reconciledAt).not.toBeNull();
    const veh = await prisma.vehicle.findUniqueOrThrow({ where: { id: d.vehicleId } });
    expect(veh.status).toBe('idle');
  });

  it('❌ 2. markVehicleReturned throws (409) when the DVA is already reconciled', async () => {
    const d = await mkDriver(PHONES[1], 'Guard', 'returned'); // vehicle 'returned' so we isolate the isReconciled clause
    await mkDva(d.driverId, d.vehicleId, { status: 'loaded_and_dispatched', tripNumber: 1, isReconciled: true, date: today });

    await expect(markVehicleReturned(d.vehicleId, 'dts-user', D1)).rejects.toThrow('Vehicle has already been reconciled');
  });

  it('✅ 3. preflightDispatch on dispatch_ready + isReconciled DVA clears flags but does NOT bump tripNumber (Bug #7 — reconcile already bumped)', async () => {
    // FLOAT-001 (2026-06-18 Bug #7): confirmVehicleReconciliation now bumps
    // tripNumber as part of its terminal state update. By the time
    // preflightDispatch sees a `dispatch_ready + isReconciled=true` DVA, the
    // tripNumber has ALREADY been incremented by reconcile to N+1 — so the
    // dispatch path must NOT re-increment (would double-bump and orphan the
    // newly-saved manifest at trip N+1 against orders stamped trip N+2).
    // It still clears the isReconciled flag and timeline stamps so the
    // upcoming trip's state is clean.
    //
    // Setup simulates the post-reconcile state: tripNumber=4 (already bumped
    // from 3 by reconcile), isReconciled=true, status=dispatch_ready.
    // The completed trip's order is stamped trip 3 (pre-bump value).
    const d = await mkDriver(PHONES[2], 'RollRec', 'idle');
    const dva = await mkDva(d.driverId, d.vehicleId, { status: 'dispatch_ready', tripNumber: 4, isReconciled: true, date: ffDate });
    await mkOrder(d.driverId, d.vehicleId, { status: 'delivered', tripNumber: 3, date: ffDate }); // prior trip — 0 in-flight
    const fresh = await mkOrder(d.driverId, d.vehicleId, { status: 'pending_dispatch', tripNumber: null, date: ffDate });

    const res = await preflightDispatch({ distributorId: D1, driverId: d.driverId, assignmentDate: FF, userId: 'dts-user' });
    expect(res.summary.succeeded).toBeGreaterThan(0);

    const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    expect(after.tripNumber).toBe(4);            // unchanged — reconcile already bumped
    expect(after.isReconciled).toBe(false);      // cleared by shouldRoll block
    expect(after.status).toBe('loaded_and_dispatched');
    const o = await prisma.order.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(o.tripNumber).toBe(4);                // stamped with current trip
    expect(o.status).toBe('pending_delivery');
  });

  it('✅ 4. preflightDispatch still rolls on loaded_and_dispatched + 0 in-flight (regression)', async () => {
    const d = await mkDriver(PHONES[3], 'RollLoaded', 'dispatched');
    const dva = await mkDva(d.driverId, d.vehicleId, { status: 'loaded_and_dispatched', tripNumber: 5, isReconciled: false, date: ffDate });
    await mkOrder(d.driverId, d.vehicleId, { status: 'delivered', tripNumber: 5, date: ffDate }); // 0 in-flight
    await mkOrder(d.driverId, d.vehicleId, { status: 'pending_dispatch', tripNumber: null, date: ffDate });

    await preflightDispatch({ distributorId: D1, driverId: d.driverId, assignmentDate: FF, userId: 'dts-user' });

    const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    expect(after.tripNumber).toBe(6); // rolled
  });

  it('❌ 5. preflightDispatch does NOT roll a brand-new dispatch_ready + !isReconciled DVA', async () => {
    const d = await mkDriver(PHONES[4], 'FirstTrip', 'idle');
    const dva = await mkDva(d.driverId, d.vehicleId, { status: 'dispatch_ready', tripNumber: 1, isReconciled: false, date: ffDate });
    const fresh = await mkOrder(d.driverId, d.vehicleId, { status: 'pending_dispatch', tripNumber: null, date: ffDate });

    await preflightDispatch({ distributorId: D1, driverId: d.driverId, assignmentDate: FF, userId: 'dts-user' });

    const after = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: dva.id } });
    expect(after.tripNumber).toBe(1);  // NOT rolled — first trip
    const o = await prisma.order.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(o.tripNumber).toBe(1);
  });
});
