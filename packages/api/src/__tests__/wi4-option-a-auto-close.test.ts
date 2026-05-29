/**
 * WI-4 Option A — Report Mismatch auto-closes the trip on full-gap write-off.
 *
 * Covers three scenarios on dist-002 with isolated fixtures:
 *
 *   POSITIVE — full-gap write-off → vehicle.status='idle',
 *     DVA.isReconciled=true, vehicle drops out of pending-reconciliation
 *     list, autoClose.closed === true, emptiesOnVehicle === 0.
 *
 *   POSITIVE — partial-gap write-off → vehicle stays 'returned',
 *     autoClose.closed === false with reason 'gap_remaining',
 *     remainingByType lists the still-open type.
 *
 *   NEGATIVE — confirmVehicleReconciliation after a mismatch already
 *     credited empties → 400 with a clear "allowed" message and
 *     "already credited by mismatch" detail. Prevents the bug we shipped
 *     against on 2026-05-29 (double-credit producing emptiesOnVehicle=-1).
 *
 * Each test owns its own cylinder type / vehicle / driver / DVA / order so
 * runs are independent and cleanup is local. The vehicle starts at status=
 * 'returned' so the mismatch is filed against the trip-return state real
 * users hit. Today's UTC date is used (matches existing wi4 test pattern
 * because the active-trip lookup is keyed by today).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken } from './helpers.js';
import { UserRole } from '@gaslink/shared';
import { startOfUtcDay } from '../utils/dateOnly.js';
import { recalculateSummariesFromDate } from '../services/inventoryService.js';

const DIST = 'dist-002';

let app: Express;
let inventoryToken: string;
let inventoryUserId: string;

// Track fixtures by test so afterAll can clean up.
type Fixture = {
  cylinderTypeId: string;
  cylinderTypeId2?: string;
  vehicleId: string;
  driverId: string;
  dvaId: string;
  orderId: string;
};
const fixtures: Fixture[] = [];

async function seedFixture(opts: {
  collectedQty: number;
  secondTypeCollectedQty?: number;
}): Promise<Fixture> {
  const today = startOfUtcDay();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

  const ct = await prisma.cylinderType.create({
    data: { distributorId: DIST, typeName: `WI4-A-${suffix}`, capacity: 1 },
  });
  let ct2Id: string | undefined;
  if (opts.secondTypeCollectedQty !== undefined) {
    const ct2 = await prisma.cylinderType.create({
      data: { distributorId: DIST, typeName: `WI4-A2-${suffix}`, capacity: 1 },
    });
    ct2Id = ct2.id;
  }

  const v = await prisma.vehicle.create({
    data: { distributorId: DIST, vehicleNumber: `WI4-V-${suffix}`, status: 'returned' },
  });
  const d = await prisma.driver.create({
    data: {
      distributorId: DIST,
      driverName: `WI4-D-${suffix}`,
      phone: '9' + String(Date.now()).slice(-9) + Math.floor(Math.random() * 10),
      status: 'active',
    },
  });
  const dva = await prisma.driverVehicleAssignment.create({
    data: {
      driverId: d.id,
      vehicleId: v.id,
      distributorId: DIST,
      assignmentDate: today,
      tripNumber: 1,
      status: 'loaded_and_dispatched',
      isReconciled: false,
    },
  });

  const cust = await prisma.customer.findFirstOrThrow({
    where: { distributorId: DIST, customerName: 'Maruthi Agencies', deletedAt: null },
  });

  const orderItems = [
    {
      cylinderTypeId: ct.id,
      quantity: opts.collectedQty,
      deliveredQuantity: opts.collectedQty,
      emptiesCollected: opts.collectedQty,
      unitPrice: 0,
      discountPerUnit: 0,
      totalPrice: 0,
    },
  ];
  if (ct2Id && opts.secondTypeCollectedQty !== undefined) {
    orderItems.push({
      cylinderTypeId: ct2Id,
      quantity: opts.secondTypeCollectedQty,
      deliveredQuantity: opts.secondTypeCollectedQty,
      emptiesCollected: opts.secondTypeCollectedQty,
      unitPrice: 0,
      discountPerUnit: 0,
      totalPrice: 0,
    });
  }

  const order = await prisma.order.create({
    data: {
      orderNumber: `WI4-A-O-${suffix}`,
      distributorId: DIST,
      customerId: cust.id,
      driverId: d.id,
      vehicleId: v.id,
      tripNumber: 1,
      orderDate: today,
      deliveryDate: today,
      status: 'delivered',
      totalAmount: 0,
      items: { create: orderItems },
    },
  });

  // Post collection events so emptiesOnVehicle = collected on each type.
  await prisma.inventoryEvent.create({
    data: {
      distributorId: DIST,
      cylinderTypeId: ct.id,
      eventType: 'collection',
      fullsChange: 0,
      emptiesChange: opts.collectedQty,
      eventDate: today,
      referenceId: order.id,
      referenceType: 'order',
      createdBy: inventoryUserId,
    },
  });
  if (ct2Id && opts.secondTypeCollectedQty) {
    await prisma.inventoryEvent.create({
      data: {
        distributorId: DIST,
        cylinderTypeId: ct2Id,
        eventType: 'collection',
        fullsChange: 0,
        emptiesChange: opts.secondTypeCollectedQty,
        eventDate: today,
        referenceId: order.id,
        referenceType: 'order',
        createdBy: inventoryUserId,
      },
    });
  }
  // Force the summary forward so the auto-close gap check sees them.
  await recalculateSummariesFromDate(DIST, ct.id, today);
  if (ct2Id) await recalculateSummariesFromDate(DIST, ct2Id, today);

  const fx: Fixture = {
    cylinderTypeId: ct.id,
    cylinderTypeId2: ct2Id,
    vehicleId: v.id,
    driverId: d.id,
    dvaId: dva.id,
    orderId: order.id,
  };
  fixtures.push(fx);
  return fx;
}

beforeAll(async () => {
  app = createApp();
  const inv = await prisma.user.findFirstOrThrow({
    where: { distributorId: DIST, role: 'inventory', deletedAt: null },
  });
  inventoryUserId = inv.id;
  inventoryToken = generateToken({
    userId: inv.id, email: inv.email,
    role: inv.role as UserRole, distributorId: inv.distributorId,
  });
});

afterAll(async () => {
  for (const fx of fixtures) {
    const ctIds = [fx.cylinderTypeId, ...(fx.cylinderTypeId2 ? [fx.cylinderTypeId2] : [])];
    await prisma.stockMismatchRecord.deleteMany({ where: { vehicleId: fx.vehicleId } });
    await prisma.pendingAction.deleteMany({
      where: { distributorId: DIST, entityId: fx.vehicleId, entityType: 'vehicle' },
    });
    await prisma.inventoryEvent.deleteMany({
      where: { distributorId: DIST, cylinderTypeId: { in: ctIds } },
    });
    await prisma.inventorySummary.deleteMany({
      where: { distributorId: DIST, cylinderTypeId: { in: ctIds } },
    });
    await prisma.reconciliationEmptiesReturned.deleteMany({ where: { dvaId: fx.dvaId } });
    await prisma.orderItem.deleteMany({ where: { orderId: fx.orderId } });
    await prisma.order.delete({ where: { id: fx.orderId } }).catch(() => undefined);
    await prisma.driverVehicleAssignment
      .delete({ where: { id: fx.dvaId } })
      .catch(() => undefined);
    await prisma.driver.delete({ where: { id: fx.driverId } }).catch(() => undefined);
    await prisma.vehicle.delete({ where: { id: fx.vehicleId } }).catch(() => undefined);
    for (const ctId of ctIds) {
      await prisma.cylinderType.delete({ where: { id: ctId } }).catch(() => undefined);
    }
  }
});

describe('WI-4 Option A — auto-close on full-gap mismatch write-off', () => {
  it('POSITIVE — full-gap write-off closes the trip and drops the vehicle from pending list', async () => {
    const fx = await seedFixture({ collectedQty: 3 });
    const today = startOfUtcDay();

    const res = await request(app)
      .post('/api/inventory/mismatch-reports')
      .set('Authorization', `Bearer ${inventoryToken}`)
      .set('X-Distributor-Id', DIST)
      .send({
        vehicleId: fx.vehicleId,
        tripDate: today.toISOString().slice(0, 10),
        accountableParty: 'driver',
        driverId: fx.driverId,
        resolutionAction: 'write_off',
        resolutionNotes: 'full gap',
        lines: [{
          mismatchType: 'empties_short',
          cylinderTypeId: fx.cylinderTypeId,
          qtyUnaccounted: 3,
          unitAmount: 100,
          totalAmount: 300,
        }],
      });

    expect(res.status).toBe(201);
    const body = res.body.data as {
      autoClose: { closed: boolean; reason?: string };
    };
    expect(body.autoClose.closed).toBe(true);

    // Vehicle flipped idle.
    const vehicleAfter = await prisma.vehicle.findUniqueOrThrow({ where: { id: fx.vehicleId } });
    expect(vehicleAfter.status).toBe('idle');

    // DVA stamped reconciled.
    const dvaAfter = await prisma.driverVehicleAssignment.findUniqueOrThrow({
      where: { id: fx.dvaId },
    });
    expect(dvaAfter.isReconciled).toBe(true);
    expect(dvaAfter.reconciledAt).toBeTruthy();

    // emptiesOnVehicle on the affected type = 0 (1 collection event + 1
    // reconciliation event of equal magnitude). NOTE: confirmVehicleReconciliation
    // was invoked with emptiesReturned=[], so it should NOT post a second
    // credit — that's the bug Option A is designed to prevent.
    const summary = await prisma.inventorySummary.findFirstOrThrow({
      where: { distributorId: DIST, cylinderTypeId: fx.cylinderTypeId, summaryDate: today },
    });
    expect(summary.collectedEmpties).toBe(3);
    expect(summary.emptiesReturnedVerified).toBe(3); // single +3 from mismatch event
    expect(summary.collectedEmpties - summary.emptiesReturnedVerified).toBe(0);

    // Vehicle no longer in the pending-reconciliation list.
    const pendingRes = await request(app)
      .get('/api/delivery/reconciliation/pending')
      .set('Authorization', `Bearer ${inventoryToken}`)
      .set('X-Distributor-Id', DIST);
    expect(pendingRes.status).toBe(200);
    const pendingVehicles = pendingRes.body.data as Array<{ vehicleId: string }>;
    expect(pendingVehicles.find((v) => v.vehicleId === fx.vehicleId)).toBeUndefined();
  });

  it('POSITIVE — partial-gap write-off leaves the vehicle pending reconciliation', async () => {
    // Two cylinder types collected on this trip; mismatch covers ONE of them.
    // The other still has a positive emptiesOnVehicle → auto-close skipped.
    const fx = await seedFixture({ collectedQty: 2, secondTypeCollectedQty: 4 });
    const today = startOfUtcDay();

    const res = await request(app)
      .post('/api/inventory/mismatch-reports')
      .set('Authorization', `Bearer ${inventoryToken}`)
      .set('X-Distributor-Id', DIST)
      .send({
        vehicleId: fx.vehicleId,
        tripDate: today.toISOString().slice(0, 10),
        accountableParty: 'driver',
        driverId: fx.driverId,
        resolutionAction: 'write_off',
        resolutionNotes: 'partial only',
        lines: [{
          mismatchType: 'empties_short',
          cylinderTypeId: fx.cylinderTypeId,
          qtyUnaccounted: 2,
          unitAmount: 100,
          totalAmount: 200,
        }],
      });

    expect(res.status).toBe(201);
    const body = res.body.data as {
      autoClose: {
        closed: boolean;
        reason?: string;
        remainingByType?: Array<{ cylinderTypeId: string; emptiesOnVehicle: number }>;
      };
    };
    expect(body.autoClose.closed).toBe(false);
    expect(body.autoClose.reason).toBe('gap_remaining');
    expect(body.autoClose.remainingByType).toBeDefined();
    const stillOpen = body.autoClose.remainingByType!.find(
      (r) => r.cylinderTypeId === fx.cylinderTypeId2,
    );
    expect(stillOpen).toBeDefined();
    expect(stillOpen!.emptiesOnVehicle).toBe(4);

    // Vehicle status untouched.
    const v = await prisma.vehicle.findUniqueOrThrow({ where: { id: fx.vehicleId } });
    expect(v.status).toBe('returned');

    // DVA still active.
    const dva = await prisma.driverVehicleAssignment.findUniqueOrThrow({
      where: { id: fx.dvaId },
    });
    expect(dva.isReconciled).toBe(false);

    // Vehicle still in the pending-reconciliation list.
    const pendingRes = await request(app)
      .get('/api/delivery/reconciliation/pending')
      .set('Authorization', `Bearer ${inventoryToken}`)
      .set('X-Distributor-Id', DIST);
    expect(pendingRes.status).toBe(200);
    const pendingVehicles = pendingRes.body.data as Array<{ vehicleId: string }>;
    expect(pendingVehicles.find((v2) => v2.vehicleId === fx.vehicleId)).toBeDefined();
  });

  it('NEGATIVE — confirmVehicleReconciliation rejects over-verification after mismatch already credited empties', async () => {
    // Collect 2, mismatch full 2 (so emptiesReturnedVerified = 2). Then try
    // to reconcile with emptiesReturned[qty=2] AGAIN — that would credit
    // verified to 4 against collected=2 → emptiesOnVehicle=-2 (the original bug).
    //
    // Auto-close already fires on the mismatch and flips the vehicle to
    // idle. We re-open it ('returned') and reset the DVA so the
    // confirmVehicleReconciliation entry path runs and the guard fires.
    const fx = await seedFixture({ collectedQty: 2 });
    const today = startOfUtcDay();

    // File the full mismatch first.
    const mres = await request(app)
      .post('/api/inventory/mismatch-reports')
      .set('Authorization', `Bearer ${inventoryToken}`)
      .set('X-Distributor-Id', DIST)
      .send({
        vehicleId: fx.vehicleId,
        tripDate: today.toISOString().slice(0, 10),
        accountableParty: 'driver',
        driverId: fx.driverId,
        resolutionAction: 'write_off',
        resolutionNotes: 'full',
        lines: [{
          mismatchType: 'empties_short',
          cylinderTypeId: fx.cylinderTypeId,
          qtyUnaccounted: 2,
          unitAmount: 100,
          totalAmount: 200,
        }],
      });
    expect(mres.status).toBe(201);
    // Sanity: auto-close ran. Reset state so we can probe the guard.
    await prisma.vehicle.update({
      where: { id: fx.vehicleId },
      data: { status: 'returned' },
    });
    await prisma.driverVehicleAssignment.update({
      where: { id: fx.dvaId },
      data: { isReconciled: false, reconciledAt: null, status: 'loaded_and_dispatched' },
    });

    // Now manually call the reconcile endpoint with the same qty — should 400.
    const recRes = await request(app)
      .post(`/api/delivery/reconciliation/confirm/${fx.vehicleId}`)
      .set('Authorization', `Bearer ${inventoryToken}`)
      .set('X-Distributor-Id', DIST)
      .send({
        physicalStockConfirmed: true,
        emptiesReturned: [{ cylinderTypeId: fx.cylinderTypeId, quantity: 2 }],
      });

    expect(recRes.status).toBe(400);
    expect(String(recRes.body.error)).toMatch(/allowed/i);
    expect(String(recRes.body.error)).toMatch(/already credited by mismatch/i);

    // emptiesOnVehicle should still be 0 — no second credit landed.
    const summary = await prisma.inventorySummary.findFirstOrThrow({
      where: { distributorId: DIST, cylinderTypeId: fx.cylinderTypeId, summaryDate: today },
    });
    expect(summary.collectedEmpties - summary.emptiesReturnedVerified).toBe(0);
  });
});
