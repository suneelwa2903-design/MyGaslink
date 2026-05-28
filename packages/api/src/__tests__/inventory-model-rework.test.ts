/**
 * Inventory model rework — closing-empties is now driven exclusively by
 * supervisor-verified empties returned at reconciliation (NOT by delivery-time
 * collection events). Derived UI fields `inFlightFulls` and `emptiesOnVehicle`
 * drain to 0 when all dispatched cylinders are accounted for. The locked-row
 * upsert guard in `recalculateSummariesFromDate` protects authoritative closes
 * from being silently overwritten by future events landing on locked dates.
 *
 * All fixtures use a dedicated TEST cylinder type on dist-001 (GST disabled)
 * with a far-future date (anti-pattern #7) so the shared dev DB and real
 * manual-test data are untouched. Cleanup is scoped to the test type.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Prisma, $Enums } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getInventorySummary, recalculateSummariesFromDate, createInventoryEvent } from '../services/inventoryService.js';

const DIST = 'dist-001';
const TEST_DATE_STR = '2099-12-25';
const TEST_DATE = new Date(TEST_DATE_STR);
const PREV_DATE = new Date('2099-12-24');
const OPENING_FULLS = 100;
const OPENING_EMPTIES = 50;

let cylTypeId: string;

beforeAll(async () => {
  process.env.INVENTORY_DISPATCH_DEBIT = 'true';
  const cyl = await prisma.cylinderType.create({
    data: { distributorId: DIST, typeName: `MODEL-REWORK-${Date.now()}`, capacity: 19, hsnCode: '27111900' },
  });
  cylTypeId = cyl.id;
  // Seed yesterday's locked close — gives today an opening balance.
  await prisma.inventorySummary.create({
    data: {
      distributorId: DIST, cylinderTypeId: cylTypeId, summaryDate: PREV_DATE,
      openingFulls: 0, openingEmpties: 0, closingFulls: OPENING_FULLS, closingEmpties: OPENING_EMPTIES,
      isLocked: true,
    },
  });
});

afterAll(async () => {
  await prisma.inventoryEvent.deleteMany({ where: { distributorId: DIST, cylinderTypeId: cylTypeId } });
  await prisma.inventorySummary.deleteMany({ where: { distributorId: DIST, cylinderTypeId: cylTypeId } });
  await prisma.cylinderType.deleteMany({ where: { id: cylTypeId } });
});

async function event(eventType: string, fulls: number, empties: number) {
  return prisma.$transaction((tx) =>
    createInventoryEvent(tx, {
      distributorId: DIST,
      cylinderTypeId: cylTypeId,
      eventType: eventType as $Enums.InventoryEventType,
      fullsChange: fulls,
      emptiesChange: empties,
      eventDate: TEST_DATE,
      createdBy: 'rework-test',
    } as Prisma.InventoryEventUncheckedCreateInput & Parameters<typeof createInventoryEvent>[1]),
  );
}

async function snapshot() {
  await recalculateSummariesFromDate(DIST, cylTypeId, TEST_DATE);
  const s = await prisma.inventorySummary.findUnique({
    where: { distributorId_cylinderTypeId_summaryDate: { distributorId: DIST, cylinderTypeId: cylTypeId, summaryDate: TEST_DATE } },
  });
  return s!;
}

describe('Inventory model rework — formula + derived fields', () => {
  it('collection event does NOT change closingEmpties (audit only under new model)', async () => {
    // Sanity: opening empties carries forward = 50. Write a collection event
    // crediting 8 empties at delivery time and confirm closing stays at 50.
    await event('collection', 0, 8);
    const s = await snapshot();
    expect(s.collectedEmpties).toBe(8);       // audit bucket still populated
    expect(s.emptiesReturnedVerified).toBe(0); // verified bucket untouched
    expect(s.closingEmpties).toBe(OPENING_EMPTIES); // depot balance UNCHANGED
  });

  it('reconciliation_empties_return event increments closingEmpties by exactly the verified qty', async () => {
    // Continuing from the previous state (collection: 8). Supervisor verifies
    // 8 empties returned at reconcile → closing goes up by exactly 8.
    await event('reconciliation_empties_return', 0, 8);
    const s = await snapshot();
    expect(s.emptiesReturnedVerified).toBe(8);
    expect(s.closingEmpties).toBe(OPENING_EMPTIES + 8); // +8, no double-count
  });

  it('inFlightFulls derives correctly: dispatched 5, delivered 3 → in-flight = 2', async () => {
    // Fresh slice: wipe events for this test only and reseed via dispatched 5,
    // delivered 3. cancelled_stock_qty stays 0.
    await prisma.inventoryEvent.deleteMany({ where: { distributorId: DIST, cylinderTypeId: cylTypeId } });
    await event('dispatch', -5, 0);
    await event('delivery', -3, 0);
    await snapshot();
    const summaries = await getInventorySummary(DIST, TEST_DATE_STR);
    const row = summaries.find((s) => s.cylinderTypeId === cylTypeId);
    expect(row).toBeTruthy();
    expect(row!.dispatchedQty).toBe(5);
    expect(row!.deliveredQty).toBe(3);
    expect(row!.cancelledStockQty).toBe(0);
    expect(row!.inFlightFulls).toBe(2);
  });

  it('inFlightFulls = 0 after every dispatched cylinder is delivered or returned', async () => {
    // Continuing: deliver the remaining 2 of 5. inFlightFulls drains to 0.
    await event('delivery', -2, 0);
    await snapshot();
    const summaries = await getInventorySummary(DIST, TEST_DATE_STR);
    const row = summaries.find((s) => s.cylinderTypeId === cylTypeId);
    expect(row!.deliveredQty).toBe(5);
    expect(row!.inFlightFulls).toBe(0);
  });

  it('emptiesOnVehicle = collected − verified (supervisor confirmed 4 of 5)', async () => {
    await prisma.inventoryEvent.deleteMany({ where: { distributorId: DIST, cylinderTypeId: cylTypeId } });
    await event('collection', 0, 5);                    // 5 collected at doorstep
    await event('reconciliation_empties_return', 0, 4); // supervisor verifies 4
    await snapshot();
    const summaries = await getInventorySummary(DIST, TEST_DATE_STR);
    const row = summaries.find((s) => s.cylinderTypeId === cylTypeId);
    expect(row!.collectedEmpties).toBe(5);
    expect(row!.emptiesReturnedVerified).toBe(4);
    expect(row!.emptiesOnVehicle).toBe(1); // 1 unaccounted-for (the meaningful gap)
    expect(row!.closingEmpties).toBe(OPENING_EMPTIES + 4); // only verified credits depot
  });
});

describe('Inventory model rework — recalculateSummariesFromDate lock-skip guard', () => {
  it('skips upsert when an existing summary row on that date is locked', async () => {
    // Lock the test date's summary, then add a new event on that date and
    // recompute. The locked snapshot must stay byte-for-byte unchanged.
    await prisma.inventoryEvent.deleteMany({ where: { distributorId: DIST, cylinderTypeId: cylTypeId } });
    await event('dispatch', -10, 0);
    await recalculateSummariesFromDate(DIST, cylTypeId, TEST_DATE);
    const before = await prisma.inventorySummary.findUnique({
      where: { distributorId_cylinderTypeId_summaryDate: { distributorId: DIST, cylinderTypeId: cylTypeId, summaryDate: TEST_DATE } },
    });
    expect(before).toBeTruthy();
    // Lock it.
    await prisma.inventorySummary.update({
      where: { distributorId_cylinderTypeId_summaryDate: { distributorId: DIST, cylinderTypeId: cylTypeId, summaryDate: TEST_DATE } },
      data: { isLocked: true, lockedAt: new Date(), lockedBy: 'rework-test' },
    });
    // New event on the same locked date.
    await event('dispatch', -7, 0);
    await recalculateSummariesFromDate(DIST, cylTypeId, TEST_DATE);
    const after = await prisma.inventorySummary.findUnique({
      where: { distributorId_cylinderTypeId_summaryDate: { distributorId: DIST, cylinderTypeId: cylTypeId, summaryDate: TEST_DATE } },
    });
    expect(after!.dispatchedQty).toBe(before!.dispatchedQty); // unchanged
    expect(after!.closingFulls).toBe(before!.closingFulls);   // unchanged
    expect(after!.isLocked).toBe(true);
  });
});
