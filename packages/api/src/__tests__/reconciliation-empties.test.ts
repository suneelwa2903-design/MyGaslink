import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { confirmVehicleReconciliation, getVehiclesPendingReconciliation } from '../services/deliveryWorkflowService.js';
import { startOfUtcDay } from '../utils/dateOnly.js';

/**
 * Feature 2 — Empties returned to depot, captured at reconciliation.
 *
 * confirmVehicleReconciliation now accepts emptiesReturned[]. Each non-zero
 * entry persists a reconciliation_empties_returned row, writes a positive
 * reconciliation_empties_return inventory event, and recomputes the daily
 * summary so closing empties reflect the verified return. Zero/empty input
 * writes nothing and does not block reconciliation.
 *
 * Isolated to a dedicated test cylinder type + vehicle + driver so the
 * today-dated summary recompute never touches live manual-test data.
 */
const DIST = 'dist-002';
let cylTypeId: string;
let vehicleId: string;
let vehicleNumber: string;
let driverId: string;
let dvaId: string;
let customerId: string;
let tripOrderId: string;

beforeAll(async () => {
  const cyl = await prisma.cylinderType.create({
    data: { distributorId: DIST, typeName: `TEST-EMPTIES-${Date.now()}`, capacity: 19, hsnCode: '27111900' },
  });
  cylTypeId = cyl.id;

  vehicleNumber = `TEST-RECON-${String(Date.now()).slice(-6)}`;
  const vehicle = await prisma.vehicle.create({
    data: { distributorId: DIST, vehicleNumber, vehicleType: 'truck', capacity: 100, status: 'returned' },
  });
  vehicleId = vehicle.id;

  const driver = await prisma.driver.create({
    data: { distributorId: DIST, driverName: `Test Recon Driver ${Date.now()}`, phone: `9${String(Date.now()).slice(-9)}` },
  });
  driverId = driver.id;

  const dva = await prisma.driverVehicleAssignment.create({
    data: { driverId, vehicleId, distributorId: DIST, assignmentDate: startOfUtcDay(), tripNumber: 1, status: 'loaded_and_dispatched' },
  });
  dvaId = dva.id;

  // A customer + order on this DVA's trip is required so the new trip-scoped
  // validation guard finds enough collected empties to allow the verify count
  // in the happy-path test. We seed 12 collected empties on this trip's order
  // — the existing test verifies exactly 12.
  const customer = await prisma.customer.create({
    data: { distributorId: DIST, customerName: `TEST-RECON-CUST-${Date.now()}`, phone: `8${String(Date.now()).slice(-9)}` },
  });
  customerId = customer.id;
  const order = await prisma.order.create({
    data: {
      orderNumber: `TEST-RECON-${Date.now()}`,
      distributorId: DIST, customerId, driverId, vehicleId,
      orderDate: startOfUtcDay(), deliveryDate: startOfUtcDay(),
      status: 'delivered',
      tripNumber: 1,
      items: { create: [{ cylinderTypeId: cylTypeId, quantity: 12, deliveredQuantity: 12, unitPrice: 100, discountPerUnit: 0, totalPrice: 1200 }] },
    },
  });
  tripOrderId = order.id;
  await prisma.inventoryEvent.create({
    data: {
      distributorId: DIST, cylinderTypeId: cylTypeId, eventType: 'collection',
      fullsChange: 0, emptiesChange: 12, eventDate: startOfUtcDay(),
      referenceId: tripOrderId, referenceType: 'order', createdBy: 'test',
    },
  });
});

afterAll(async () => {
  await prisma.inventoryEvent.deleteMany({ where: { distributorId: DIST, cylinderTypeId: cylTypeId } });
  await prisma.inventorySummary.deleteMany({ where: { distributorId: DIST, cylinderTypeId: cylTypeId } });
  await prisma.reconciliationEmptiesReturned.deleteMany({ where: { dvaId } });
  await prisma.orderItem.deleteMany({ where: { orderId: tripOrderId } });
  await prisma.order.deleteMany({ where: { id: tripOrderId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.driverVehicleAssignment.deleteMany({ where: { id: dvaId } });
  await prisma.cylinderType.deleteMany({ where: { id: cylTypeId } });
  await prisma.driver.deleteMany({ where: { id: driverId } });
  await prisma.vehicle.deleteMany({ where: { id: vehicleId } });
});

describe('Feature 2 — empties returned at reconciliation', () => {
  it('zero-input reconcile writes no empties events and still completes', async () => {
    const result = await confirmVehicleReconciliation(vehicleId, DIST, 'test-user', {
      physicalStockConfirmed: true,
      emptiesReturned: [{ cylinderTypeId: cylTypeId, quantity: 0 }],
    });
    expect(result.status).toBe('reconciled');
    expect(result.emptiesReturned).toBe(0);
    const events = await prisma.inventoryEvent.findMany({
      where: { distributorId: DIST, cylinderTypeId: cylTypeId, eventType: 'reconciliation_empties_return' },
    });
    expect(events).toHaveLength(0);
  });

  it('non-zero input writes a reconciliation_empties_return event + audit row and recomputes summary', async () => {
    // The prior zero-input test reconciled this DVA. Reset it to a live state
    // so the trip-scoped helper finds an active DVA (otherwise the validation
    // guard sees collected=0 because no active trip exists).
    await prisma.driverVehicleAssignment.update({
      where: { id: dvaId },
      data: { status: 'loaded_and_dispatched', isReconciled: false, reconciledAt: null },
    });
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: 'returned' } });
    const result = await confirmVehicleReconciliation(vehicleId, DIST, 'test-user', {
      physicalStockConfirmed: true,
      emptiesReturned: [{ cylinderTypeId: cylTypeId, quantity: 12 }],
    });
    expect(result.status).toBe('reconciled');
    expect(result.emptiesReturned).toBe(12);

    const events = await prisma.inventoryEvent.findMany({
      where: { distributorId: DIST, cylinderTypeId: cylTypeId, eventType: 'reconciliation_empties_return' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].emptiesChange).toBe(12);
    expect(events[0].referenceType).toBe('driver_vehicle_assignment');
    expect(events[0].referenceId).toBe(dvaId);
    expect(events[0].vehicleNumber).toBe(vehicleNumber);

    const auditRows = await prisma.reconciliationEmptiesReturned.findMany({ where: { dvaId } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].quantity).toBe(12);

    // Inventory model rework: closing empties is now driven by the new
    // `emptiesReturnedVerified` bucket (NOT `collectedEmpties` — that bucket
    // is reserved for delivery-time audit). Closing still goes up by the
    // verified amount; the assertion target just moved.
    const summary = await prisma.inventorySummary.findFirst({
      where: { distributorId: DIST, cylinderTypeId: cylTypeId },
      orderBy: { summaryDate: 'desc' },
    });
    expect(summary).toBeTruthy();
    expect(summary!.emptiesReturnedVerified).toBeGreaterThanOrEqual(12);
    expect(summary!.closingEmpties).toBeGreaterThanOrEqual(12);
  });

  it('pending-reconciliation list surfaces the empties types active on the trip', async () => {
    // Ensure the test vehicle is in the "returned" bucket the pending query reads.
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: 'returned' } });
    const pending = await getVehiclesPendingReconciliation(DIST);
    const row = pending.find((v) => v.vehicleId === vehicleId);
    expect(row).toBeTruthy();
    expect(Array.isArray(row!.emptiesTypes)).toBe(true);
    // The new field for the amber mismatch badge — should be a boolean.
    expect(typeof row!.mismatchReported).toBe('boolean');
  });

  it('rejects with statusCode 400 when verified quantity exceeds collected on the trip', async () => {
    // Reset the DVA to a state where we can attempt another reconcile (the
    // prior happy-path test reconciled it). We bring it back to a non-
    // reconciled state so the validation runs against a fresh trip 2.
    await prisma.driverVehicleAssignment.update({
      where: { id: dvaId },
      data: { status: 'loaded_and_dispatched', isReconciled: false, reconciledAt: null, tripNumber: 2 },
    });
    await prisma.order.update({ where: { id: tripOrderId }, data: { tripNumber: 2 } });
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: 'returned' } });
    // Attempt to verify 999 empties when only 12 were collected on the trip.
    let caught: { statusCode?: number; message?: string } | null = null;
    try {
      await confirmVehicleReconciliation(vehicleId, DIST, 'test-user', {
        physicalStockConfirmed: true,
        emptiesReturned: [{ cylinderTypeId: cylTypeId, quantity: 999 }],
      });
    } catch (e) {
      caught = e as { statusCode?: number; message?: string };
    }
    expect(caught).not.toBeNull();
    expect(caught!.statusCode).toBe(400);
    expect(caught!.message).toMatch(/cannot exceed empties collected/i);
  });
});
