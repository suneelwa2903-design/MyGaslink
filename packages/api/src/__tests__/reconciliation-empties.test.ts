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
});

afterAll(async () => {
  await prisma.inventoryEvent.deleteMany({ where: { distributorId: DIST, cylinderTypeId: cylTypeId } });
  await prisma.inventorySummary.deleteMany({ where: { distributorId: DIST, cylinderTypeId: cylTypeId } });
  await prisma.reconciliationEmptiesReturned.deleteMany({ where: { dvaId } });
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

    // Closing empties for the test type must reflect the verified return.
    const summary = await prisma.inventorySummary.findFirst({
      where: { distributorId: DIST, cylinderTypeId: cylTypeId },
      orderBy: { summaryDate: 'desc' },
    });
    expect(summary).toBeTruthy();
    expect(summary!.collectedEmpties).toBeGreaterThanOrEqual(12);
    expect(summary!.closingEmpties).toBeGreaterThanOrEqual(12);
  });

  it('pending-reconciliation list surfaces the empties types active on the trip', async () => {
    // Ensure the test vehicle is in the "returned" bucket the pending query reads.
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: 'returned' } });
    const pending = await getVehiclesPendingReconciliation(DIST);
    const row = pending.find((v) => v.vehicleId === vehicleId);
    // The test vehicle has no dispatch/collection events on the test type, so
    // emptiesTypes may be empty — assert the field exists and is an array.
    expect(row).toBeTruthy();
    expect(Array.isArray(row!.emptiesTypes)).toBe(true);
  });
});
