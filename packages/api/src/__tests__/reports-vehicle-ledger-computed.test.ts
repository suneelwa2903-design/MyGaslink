// 2026-08-05 F9 — Computed fields in reportsService.vehicleLedger().
//
// Two derived columns added for Suneel's Vehicle Ledger rewrite:
//   returnedFulls    = max(0, fullsDispatched − fullsDelivered)
//   outstandingEmpties = max(0, fullsDelivered − emptiesCollected)
//
// This file pins the math end-to-end:
//   - Positive: normal trip → correct arithmetic
//   - Positive: fully-balanced trip → both zero
//   - Positive: empties-only row → both zero (no fulls in the mix)
//   - Negative: over-return (more empties than fulls) → outstanding CLAMPS at 0
//   - Negative: over-return (more fulls delivered than dispatched — data bug) → returned CLAMPS at 0
//   - Regression: existing `emptiesGap` still correct (not clobbered)
//
// Also folds in F3 corporation-exclusion:
//   - Positive: an `incoming_fulls` event MUST NOT appear in `rows`
//   - Positive: response has no `secondary` field
//
// Uses TEST_DATE=2099-12-29 per anti-pattern #7 to isolate from live data.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { vehicleLedger } from '../services/reportsService.js';
import { getSeedData } from './helpers.js';

const TEST_DATE = new Date('2099-12-29T00:00:00.000Z');
const TEST_DATE_STR = '2099-12-29';

let ctx: {
  distributorId: string;
  cylinderTypeId: string;
  vehicleId: string;
  driverId: string;
};

const orderIds: string[] = [];

beforeAll(async () => {
  const seed = await getSeedData();
  ctx = {
    distributorId: seed.distributor.id,
    cylinderTypeId: seed.cylinderTypes[0].id,
    vehicleId: seed.vehicles[0].id,
    driverId: seed.drivers[0].id,
  };
});

afterAll(async () => {
  await prisma.inventoryEvent.deleteMany({
    where: { distributorId: ctx.distributorId, eventDate: TEST_DATE },
  });
  if (orderIds.length) {
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }
});

/** Seed a delivered order and its inventory events with the given numbers.
 * Returns the order id. */
async function seedTrip(opts: {
  suffix: string;
  tripNumber: number;
  dispatched: number;
  delivered: number;
  collected: number;
}): Promise<string> {
  const customer = await prisma.customer.findFirstOrThrow({
    where: { distributorId: ctx.distributorId, deletedAt: null },
  });
  const order = await prisma.order.create({
    data: {
      distributorId: ctx.distributorId,
      customerId: customer.id,
      orderNumber: `TEST-COMPUTED-${opts.suffix}`,
      orderDate: TEST_DATE,
      deliveryDate: TEST_DATE,
      status: 'delivered',
      totalAmount: 0,
      driverId: ctx.driverId,
      vehicleId: ctx.vehicleId,
      tripNumber: opts.tripNumber,
    },
  });
  orderIds.push(order.id);

  const commonEvent = {
    distributorId: ctx.distributorId,
    cylinderTypeId: ctx.cylinderTypeId,
    eventDate: TEST_DATE,
    referenceId: order.id,
    referenceType: 'order',
    createdBy: 'test-computed',
  };

  const events = [];
  if (opts.dispatched > 0) {
    events.push({ ...commonEvent, eventType: 'dispatch' as const, fullsChange: opts.dispatched, emptiesChange: 0 });
  }
  if (opts.delivered > 0) {
    events.push({ ...commonEvent, eventType: 'delivery' as const, fullsChange: opts.delivered, emptiesChange: 0 });
  }
  if (opts.collected > 0) {
    events.push({ ...commonEvent, eventType: 'collection' as const, fullsChange: 0, emptiesChange: opts.collected });
  }
  if (events.length) await prisma.inventoryEvent.createMany({ data: events });

  return order.id;
}

async function fetchLedger() {
  return vehicleLedger(ctx.distributorId, {
    dateFrom: TEST_DATE_STR,
    dateTo: TEST_DATE_STR,
    groupBy: 'trip',
  });
}

describe('reportsService.vehicleLedger — computed fields (F9)', () => {
  it('POSITIVE — normal trip: dispatched=45, delivered=40, collected=38 → returned=5, outstanding=2', async () => {
    await seedTrip({ suffix: 'POS-1', tripNumber: 1, dispatched: 45, delivered: 40, collected: 38 });

    const res = await fetchLedger();
    const row = res.rows.find((r) => r.tripNumber === 1);
    expect(row).toBeDefined();
    expect(row!.fullsDispatched).toBe(45);
    expect(row!.fullsDelivered).toBe(40);
    expect(row!.returnedFulls).toBe(5);
    expect(row!.emptiesCollected).toBe(38);
    expect(row!.outstandingEmpties).toBe(2);
  });

  it('POSITIVE — fully balanced: dispatched=10, delivered=10, collected=10 → returned=0, outstanding=0', async () => {
    await seedTrip({ suffix: 'POS-2', tripNumber: 2, dispatched: 10, delivered: 10, collected: 10 });

    const res = await fetchLedger();
    const row = res.rows.find((r) => r.tripNumber === 2);
    expect(row).toBeDefined();
    expect(row!.returnedFulls).toBe(0);
    expect(row!.outstandingEmpties).toBe(0);
  });

  it('POSITIVE — empties-only row (no fulls in the mix): returned=0, outstanding=0', async () => {
    await seedTrip({ suffix: 'POS-3', tripNumber: 3, dispatched: 0, delivered: 0, collected: 15 });

    const res = await fetchLedger();
    const row = res.rows.find((r) => r.tripNumber === 3);
    expect(row).toBeDefined();
    expect(row!.fullsDispatched).toBe(0);
    expect(row!.fullsDelivered).toBe(0);
    expect(row!.returnedFulls).toBe(0);
    expect(row!.emptiesCollected).toBe(15);
    expect(row!.outstandingEmpties).toBe(0);
  });

  it('NEGATIVE — customer over-returns empties (delivered=5, collected=8): outstanding clamps to 0 (not −3)', async () => {
    await seedTrip({ suffix: 'NEG-1', tripNumber: 4, dispatched: 5, delivered: 5, collected: 8 });

    const res = await fetchLedger();
    const row = res.rows.find((r) => r.tripNumber === 4);
    expect(row).toBeDefined();
    expect(row!.outstandingEmpties).toBe(0);
  });

  it('NEGATIVE — data bug where delivered > dispatched: returned clamps to 0 (not negative)', async () => {
    // Should not happen in prod, but math guard means UI never shows -N.
    await seedTrip({ suffix: 'NEG-2', tripNumber: 5, dispatched: 3, delivered: 10, collected: 0 });

    const res = await fetchLedger();
    const row = res.rows.find((r) => r.tripNumber === 5);
    expect(row).toBeDefined();
    expect(row!.returnedFulls).toBe(0);
  });

  it('REGRESSION — emptiesGap still computed correctly (not clobbered by the derived-field pass)', async () => {
    // Add a reconciliation event on top of trip 1 (dispatched=45/delivered=40/collected=38).
    // 30 verified back at depot → gap = 38 − 30 = 8.
    const order = await prisma.order.findFirst({
      where: { orderNumber: 'TEST-COMPUTED-POS-1' },
    });
    if (!order) throw new Error('trip 1 fixture missing');

    await prisma.inventoryEvent.create({
      data: {
        distributorId: ctx.distributorId,
        cylinderTypeId: ctx.cylinderTypeId,
        eventType: 'reconciliation_empties_return',
        fullsChange: 0,
        emptiesChange: 30,
        eventDate: TEST_DATE,
        referenceId: order.id,
        referenceType: 'order',
        createdBy: 'test-computed',
      },
    });

    const res = await fetchLedger();
    const row = res.rows.find((r) => r.tripNumber === 1);
    expect(row).toBeDefined();
    expect(row!.emptiesGap).toBe(8); // 38 collected − 30 verified
    // But the display-facing outstanding column is unaffected by the reconciliation:
    expect(row!.outstandingEmpties).toBe(2); // still 40 delivered − 38 collected
  });
});

describe('reportsService.vehicleLedger — F3 corporation exclusion', () => {
  it('POSITIVE — an incoming_fulls event does NOT appear in rows and does NOT emit a secondary table', async () => {
    // Create a corp-inbound event directly (no order — just a depot receipt).
    await prisma.inventoryEvent.create({
      data: {
        distributorId: ctx.distributorId,
        cylinderTypeId: ctx.cylinderTypeId,
        eventType: 'incoming_fulls',
        fullsChange: 200,
        emptiesChange: 0,
        eventDate: TEST_DATE,
        documentNumber: 'CORP-DOC-F3-TEST',
        createdBy: 'test-computed',
      },
    });

    const res = await fetchLedger();
    // secondary must be absent — F3 dropped the corporation table.
    expect(res.secondary).toBeUndefined();
    // The corp doc number must never appear on a trip row either.
    for (const row of res.rows) {
      const rowStr = JSON.stringify(row);
      expect(rowStr).not.toContain('CORP-DOC-F3-TEST');
    }
  });

  it('REGRESSION — trip rows still surface alongside the excluded corp event', async () => {
    const res = await fetchLedger();
    // We seeded 5 trips above (POS-1 to POS-3, NEG-1, NEG-2). Trip 1 has
    // a reconciliation event that doesn't add a new row. Expect ≥ 5 rows.
    expect(res.rows.length).toBeGreaterThanOrEqual(5);
  });
});
