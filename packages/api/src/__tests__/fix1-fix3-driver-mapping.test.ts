/**
 * Fix 1 + Fix 3 — driver↔vehicle mapping integrity after reconciliation.
 *
 * Fix 1: GET /api/drivers must surface the day's vehicle even after the
 * driver's DVA has reconciled. Previously `listDrivers` filtered the
 * vehicleAssignments include by `isReconciled: false`, so a driver whose
 * trip had completed lost their vehicleNumber in the assign-driver dropdown
 * even though Fleet → Vehicle Mapping still showed them as Confirmed.
 *
 * Fix 3: POST /api/assignments/vehicle-mappings/confirm must not crash when
 * the day's DVAs already have child rows in reconciliation_empties_returned.
 * The previous deleteMany on DVAs FK-violated; the fix wraps the replace in
 * a transaction that deletes children first.
 *
 * Anti-pattern #7 — time-sensitive test data goes on a far-future date so it
 * never collides with manual testing or other suites on the shared dev DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin } from './helpers.js';

const DIST = 'dist-001';
const TEST_DATE = '2099-12-31';

let app: Express;
let adminToken: string;
let driverId: string;
let vehicleId: string;
let cylinderTypeId: string;

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;

  const driver = await prisma.driver.findFirstOrThrow({
    where: { distributorId: DIST, status: 'active', deletedAt: null },
    orderBy: { driverName: 'asc' },
  });
  driverId = driver.id;

  const vehicle = await prisma.vehicle.findFirstOrThrow({
    where: { distributorId: DIST, deletedAt: null },
    orderBy: { vehicleNumber: 'asc' },
  });
  vehicleId = vehicle.id;

  const cyl = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: DIST },
  });
  cylinderTypeId = cyl.id;

  // Start clean.
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

async function cleanup() {
  const dvas = await prisma.driverVehicleAssignment.findMany({
    where: { distributorId: DIST, assignmentDate: new Date(TEST_DATE) },
    select: { id: true },
  });
  if (dvas.length > 0) {
    const ids = dvas.map((d) => d.id);
    await prisma.reconciliationEmptiesReturned.deleteMany({
      where: { dvaId: { in: ids } },
    });
    await prisma.driverVehicleAssignment.deleteMany({
      where: { id: { in: ids } },
    });
  }
}

describe('Fix 1 — GET /api/drivers surfaces vehicle even after DVA reconciles', () => {
  it('reconciled DVA still flows vehicleNumber through to the assign-driver dropdown', async () => {
    // Seed a DVA for the test date and mark it reconciled — simulating a
    // driver who has already completed today's trip.
    const dva = await prisma.driverVehicleAssignment.create({
      data: {
        distributorId: DIST,
        driverId,
        vehicleId,
        assignmentDate: new Date(TEST_DATE),
        tripNumber: 1,
        status: 'dispatch_ready',
        isReconciled: true,
      },
    });

    // Pin "today" to TEST_DATE by stubbing the prisma query through the
    // route is not feasible — instead, assert the underlying service:
    // listDrivers picks the latest DVA in the date range. Drop a *second*
    // DVA on the actual current day, reconciled too, so the API route
    // exercises the production date logic and proves the include doesn't
    // filter out reconciled rows.
    const todayDate = new Date();
    todayDate.setUTCHours(0, 0, 0, 0);

    // Park-then-reconcile a DVA on the live "today" date (the route's
    // utcDayRange). Use upsert-style: if one already exists for this driver,
    // flip it to reconciled, otherwise create. Either way we end the
    // arrangement with one reconciled DVA on today.
    const existingToday = await prisma.driverVehicleAssignment.findFirst({
      where: { distributorId: DIST, driverId, assignmentDate: todayDate },
      orderBy: { tripNumber: 'desc' },
    });
    let createdTodayDvaId: string | null = null;
    if (existingToday) {
      await prisma.driverVehicleAssignment.update({
        where: { id: existingToday.id },
        data: { isReconciled: true, vehicleId, status: 'dispatch_ready' },
      });
    } else {
      const created = await prisma.driverVehicleAssignment.create({
        data: {
          distributorId: DIST,
          driverId,
          vehicleId,
          assignmentDate: todayDate,
          tripNumber: 1,
          status: 'dispatch_ready',
          isReconciled: true,
        },
      });
      createdTodayDvaId = created.id;
    }

    try {
      const res = await request(app)
        .get('/api/drivers?status=active')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const drivers = res.body.data.drivers as Array<{
        driverId: string;
        driverName: string;
        vehicleNumber: string | null;
      }>;
      const me = drivers.find((d) => d.driverId === driverId);
      expect(me).toBeDefined();
      // The bug: vehicleNumber came back null because the include filtered
      // out reconciled DVAs. The fix surfaces it.
      expect(me!.vehicleNumber).toBeTruthy();
    } finally {
      // Tear down only what this test created. Don't touch a pre-existing
      // today DVA so we leave manual testing state alone.
      await prisma.driverVehicleAssignment.delete({ where: { id: dva.id } });
      if (createdTodayDvaId) {
        await prisma.driverVehicleAssignment.delete({
          where: { id: createdTodayDvaId },
        });
      }
    }
  });
});

describe('Fix 3 — vehicle-mappings/confirm survives existing reconciliation children', () => {
  it('re-confirms cleanly when the day already has DVAs with reconciliation_empties_returned rows', async () => {
    // Arrange: a DVA for TEST_DATE that has a reconciliation child. Before
    // the fix, deleteMany on the DVA would FK-violate.
    const dva = await prisma.driverVehicleAssignment.create({
      data: {
        distributorId: DIST,
        driverId,
        vehicleId,
        assignmentDate: new Date(TEST_DATE),
        tripNumber: 1,
        status: 'dispatch_ready',
        isReconciled: true,
      },
    });
    await prisma.reconciliationEmptiesReturned.create({
      data: {
        distributorId: DIST,
        dvaId: dva.id,
        cylinderTypeId,
        quantity: 3,
      },
    });

    // Act: re-confirm with the SAME driver/vehicle on the same date.
    const res = await request(app)
      .post('/api/assignments/vehicle-mappings/confirm')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        date: TEST_DATE,
        mappings: [{ driverId, vehicleId }],
      });

    // Assert: 200 and exactly one DVA exists for the date.
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.confirmed).toBe(1);

    const after = await prisma.driverVehicleAssignment.findMany({
      where: { distributorId: DIST, assignmentDate: new Date(TEST_DATE) },
      select: { id: true, driverId: true, vehicleId: true, isReconciled: true },
    });
    expect(after).toHaveLength(1);
    expect(after[0].driverId).toBe(driverId);
    expect(after[0].vehicleId).toBe(vehicleId);
    // The replaced DVA is a fresh row — old reconciliation children deleted
    // as part of the transactional replace.
    expect(after[0].id).not.toBe(dva.id);
    expect(after[0].isReconciled).toBe(false);

    const orphanedChildren = await prisma.reconciliationEmptiesReturned.count({
      where: { dvaId: dva.id },
    });
    expect(orphanedChildren).toBe(0);
  });
});
