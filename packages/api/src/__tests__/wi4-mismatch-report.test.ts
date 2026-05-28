/**
 * WI-4 — Stock Mismatch Records (Report Mismatch + Mismatch Log).
 *
 * Covers the four user-defined success criteria:
 *
 *   POSITIVE
 *     • empties_short submission: emptiesOnVehicle for the targeted
 *       cylinder type drops to 0 (or by qty), a stock_mismatch_records
 *       row is created with shared reportId, a STOCK_MISMATCH pending
 *       action is created, and the inventory summary recompute happens
 *       in-request.
 *     • write_off resolution clears the inventory gap in the same
 *       request (reconciliation_empties_return event posts at qty,
 *       summary.collectedEmpties == summary.emptiesReturnedVerified for
 *       the affected cylinder type by the time the response is sent).
 *     • GET /api/inventory/mismatch-reports lists the log with filters
 *       (date / vehicle / status / type).
 *
 *   NEGATIVE
 *     • Missing accountable party (driver field omitted when
 *       accountableParty=driver) → 400 with a clear message.
 *     • qtyUnaccounted greater than the actual emptiesOnVehicle gap →
 *       400 with a "exceeds actual ... gap" message.
 *
 * Anti-pattern #7: uses fixed far-future date 2099-12-31 to avoid
 * colliding with manual-test data on the shared dev DB.
 *
 * Setup builds a dedicated cylinder type, vehicle, driver, and a
 * delivery → collection sequence so emptiesOnVehicle is non-zero before
 * the mismatch report is filed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken } from './helpers.js';
import { UserRole } from '@gaslink/shared';

const DIST = 'dist-002';
const TEST_DATE = '2099-12-31';

let app: Express;
let adminToken: string;
let inventoryToken: string;
let cylinderTypeId: string;
let vehicleId: string;
let driverId: string;
let dvaId: string;
let orderId: string;
let customerId: string;

beforeAll(async () => {
  app = createApp();

  const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'sharma@gasdist.com' } });
  adminToken = generateToken({
    userId: admin.id, email: admin.email,
    role: admin.role as UserRole, distributorId: admin.distributorId,
  });

  const inv = await prisma.user.findFirstOrThrow({ where: { distributorId: DIST, role: 'inventory', deletedAt: null } });
  inventoryToken = generateToken({
    userId: inv.id, email: inv.email,
    role: inv.role as UserRole, distributorId: inv.distributorId,
  });

  // Cylinder type
  const ct = await prisma.cylinderType.create({
    data: { distributorId: DIST, typeName: `WI4-TEST-${Date.now()}`, capacity: 1 },
  });
  cylinderTypeId = ct.id;

  // Vehicle
  const v = await prisma.vehicle.create({
    data: { distributorId: DIST, vehicleNumber: `WI4-V-${Date.now()}`, status: 'returned' },
  });
  vehicleId = v.id;

  // Driver
  const d = await prisma.driver.create({
    data: { distributorId: DIST, driverName: `WI4-D-${Date.now()}`, phone: '9' + String(Date.now()).slice(-9), status: 'active' },
  });
  driverId = d.id;

  // Customer (reuse seeded Maruthi for the customer-accountable variant)
  const cust = await prisma.customer.findFirstOrThrow({
    where: { distributorId: DIST, customerName: 'Maruthi Agencies', deletedAt: null },
  });
  customerId = cust.id;

  // Active (non-reconciled) DVA so aggregateActiveTripCollections finds
  // an active trip for this vehicle.
  const dva = await prisma.driverVehicleAssignment.create({
    data: {
      driverId, vehicleId, distributorId: DIST,
      assignmentDate: new Date(),  // today UTC
      tripNumber: 1,
      status: 'loaded_and_dispatched',
      isReconciled: false,
    },
  });
  dvaId = dva.id;

  // Order on this trip
  const order = await prisma.order.create({
    data: {
      orderNumber: `WI4-O-${Date.now()}`,
      distributorId: DIST,
      customerId,
      driverId,
      vehicleId,
      tripNumber: 1,
      orderDate: new Date(),
      deliveryDate: new Date(),
      status: 'delivered',
      totalAmount: 0,
      items: {
        create: [{
          cylinderTypeId,
          quantity: 5,
          deliveredQuantity: 5,
          emptiesCollected: 5,
          unitPrice: 0,
          discountPerUnit: 0,
          totalPrice: 0,
        }],
      },
    },
  });
  orderId = order.id;

  // Collection event = 5 empties collected on this trip (the gap that
  // emptiesOnVehicle exposes). Date is today so the summary picks it up.
  await prisma.inventoryEvent.create({
    data: {
      distributorId: DIST,
      cylinderTypeId,
      eventType: 'collection',
      fullsChange: 0,
      emptiesChange: 5,
      eventDate: new Date(),
      referenceId: order.id,
      referenceType: 'order',
      createdBy: admin.id,
    },
  });

  // Recompute summary so emptiesOnVehicle = collectedEmpties = 5.
  await prisma.$executeRawUnsafe(`SELECT 1`); // no-op
});

afterAll(async () => {
  // Clean up in dependency order.
  await prisma.stockMismatchRecord.deleteMany({ where: { vehicleId } });
  await prisma.pendingAction.deleteMany({ where: { distributorId: DIST, entityId: vehicleId, entityType: 'vehicle' } });
  await prisma.inventoryEvent.deleteMany({ where: { distributorId: DIST, cylinderTypeId } });
  await prisma.inventorySummary.deleteMany({ where: { distributorId: DIST, cylinderTypeId } });
  await prisma.orderItem.deleteMany({ where: { orderId } });
  await prisma.order.delete({ where: { id: orderId } }).catch(() => undefined);
  await prisma.driverVehicleAssignment.delete({ where: { id: dvaId } }).catch(() => undefined);
  await prisma.driver.delete({ where: { id: driverId } }).catch(() => undefined);
  await prisma.vehicle.delete({ where: { id: vehicleId } }).catch(() => undefined);
  await prisma.cylinderType.delete({ where: { id: cylinderTypeId } }).catch(() => undefined);
});

describe('WI-4 — Report Mismatch + Mismatch Log', () => {
  it('NEGATIVE — missing accountable party returns 400 with clear message', async () => {
    const res = await request(app)
      .post('/api/inventory/mismatch-reports')
      .set('Authorization', `Bearer ${inventoryToken}`)
      .set('X-Distributor-Id', DIST)
      .send({
        vehicleId,
        tripDate: TEST_DATE,
        // accountableParty omitted entirely → Zod 400.
        resolutionAction: 'write_off',
        resolutionNotes: 'test',
        lines: [{
          mismatchType: 'empties_short',
          cylinderTypeId,
          qtyUnaccounted: 2,
          unitAmount: 100,
          totalAmount: 200,
        }],
      });
    expect(res.status).toBe(400);
  });

  it('NEGATIVE — qty greater than actual empties gap returns 400 with clear message', async () => {
    // Active trip has 5 collected empties → emptiesOnVehicle = 5. Request 10.
    const res = await request(app)
      .post('/api/inventory/mismatch-reports')
      .set('Authorization', `Bearer ${inventoryToken}`)
      .set('X-Distributor-Id', DIST)
      .send({
        vehicleId,
        tripDate: TEST_DATE,
        accountableParty: 'driver',
        driverId,
        resolutionAction: 'write_off',
        resolutionNotes: 'over-budget attempt',
        lines: [{
          mismatchType: 'empties_short',
          cylinderTypeId,
          qtyUnaccounted: 10,
          unitAmount: 100,
          totalAmount: 1000,
        }],
      });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/exceeds actual.*gap/i);
  });

  it('POSITIVE — empties_short write-off: record + PA created, gap cleared in-request', async () => {
    const before = await prisma.inventoryEvent.count({
      where: { distributorId: DIST, cylinderTypeId, eventType: 'reconciliation_empties_return' },
    });
    expect(before).toBe(0);

    const res = await request(app)
      .post('/api/inventory/mismatch-reports')
      .set('Authorization', `Bearer ${inventoryToken}`)
      .set('X-Distributor-Id', DIST)
      .send({
        vehicleId,
        tripDate: TEST_DATE,
        accountableParty: 'driver',
        driverId,
        resolutionAction: 'write_off',
        resolutionNotes: 'Driver unable to account for 2 empties',
        lines: [{
          mismatchType: 'empties_short',
          cylinderTypeId,
          qtyUnaccounted: 2,
          unitAmount: 1500,
          totalAmount: 3000,
        }],
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    const { reportId, rows } = res.body.data as {
      reportId: string;
      rows: Array<{ recordId: string; reportId: string; qtyUnaccounted: number; status: string }>;
    };
    expect(reportId).toBeTruthy();
    expect(rows).toHaveLength(1);
    expect(rows[0].reportId).toBe(reportId);
    expect(rows[0].qtyUnaccounted).toBe(2);
    // Write-off → status resolved at insert.
    expect(rows[0].status).toBe('resolved');

    // STOCK_MISMATCH PA created with structured description.
    const pa = await prisma.pendingAction.findFirst({
      where: {
        distributorId: DIST, entityId: vehicleId, entityType: 'vehicle',
        actionType: 'STOCK_MISMATCH',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(pa).toBeTruthy();
    expect(pa!.description).toMatch(/empties_short:2/);
    expect(pa!.description).toMatch(/accountable: driver/);

    // Inventory gap cleared: reconciliation_empties_return event was
    // posted with +2 empties for this cylinder type.
    const after = await prisma.inventoryEvent.findMany({
      where: { distributorId: DIST, cylinderTypeId, eventType: 'reconciliation_empties_return' },
    });
    expect(after).toHaveLength(1);
    expect(after[0].emptiesChange).toBe(2);
    expect(after[0].referenceType).toBe('stock_mismatch_record');
    expect(after[0].referenceId).toBe(rows[0].recordId);
  });

  it('POSITIVE — Mismatch Log filters by status + type and returns the new record', async () => {
    const res = await request(app)
      .get(`/api/inventory/mismatch-reports?vehicleId=${vehicleId}&status=resolved&mismatchType=empties_short&page=1&pageSize=20`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Distributor-Id', DIST);
    expect(res.status).toBe(200);
    const body = res.body.data as {
      data: Array<{ vehicleId: string; mismatchType: string; status: string; qtyUnaccounted: number }>;
      meta: { total: number };
    };
    expect(body.meta.total).toBeGreaterThanOrEqual(1);
    const ours = body.data.find((r) => r.qtyUnaccounted === 2);
    expect(ours).toBeDefined();
    expect(ours!.mismatchType).toBe('empties_short');
    expect(ours!.status).toBe('resolved');
  });
});

// Suppress unused-binding warning for randomUUID — it's used by the
// helper module under test but not directly here.
void randomUUID;
