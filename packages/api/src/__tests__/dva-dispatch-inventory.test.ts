/**
 * WI-106 — dispatch-debit inventory model.
 *
 * Verifies that with the flag OFF behaviour is byte-for-byte unchanged
 * (regression suite), and with the flag ON the new dispatch-based accounting
 * is mathematically correct.
 *
 * Uses dist-001 (Bhargava, GST DISABLED) so dispatch goes through the no-NIC
 * path. All data lives on far-future dates (anti-pattern #7) so it never
 * collides with real / manual-test data.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';

// N1 needs createInventoryEvent to throw on demand. Wrap the real impl; a
// global flag controls the throw. Everything else (computeSummaryForDate,
// recalculateSummariesFromDate) delegates to the actual module.
vi.mock('../services/inventoryService.js', async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    createInventoryEvent: vi.fn((...args: any[]) => {
      if ((globalThis as any).__wi106_failEvent) throw new Error('simulated DB error');
      return actual.createInventoryEvent(...args);
    }),
  };
});

import { prisma } from '../lib/prisma.js';
import { getSeedData, loginAsDistAdmin } from './helpers.js';
import { preflightDispatch } from '../services/gst/gstPreflightService.js';
import { cancelOrder } from '../services/orderService.js';
import { computeSummaryForDate, recalculateSummariesFromDate } from '../services/inventoryService.js';

const DIST = 'dist-001';
const TEST_DATE_STR = '2099-12-30';
const TEST_DATE = new Date(TEST_DATE_STR);
const PREV_DATE = new Date('2099-12-29');
const OPENING_FULLS = 100;
const OPENING_EMPTIES = 50;

let seed: Awaited<ReturnType<typeof getSeedData>>;
let adminUserId: string;
let driverId: string;
let vehicleId: string;
let cyl: { id: string }; // 19 KG-ish — just the first seeded type
let cyl2: { id: string };
let cyl3: { id: string };

function flagOn() { process.env.INVENTORY_DISPATCH_DEBIT = 'true'; }
function flagOff() { delete process.env.INVENTORY_DISPATCH_DEBIT; }

let orderSeq = 0;
function nextOrderNumber(tag: string) { return `WI106-${tag}-${Date.now()}-${orderSeq++}`; }

async function cleanup() {
  // Scoped to the far-future test dates + WI106 order numbers only.
  await prisma.inventoryEvent.deleteMany({ where: { distributorId: DIST, eventDate: { in: [TEST_DATE, PREV_DATE] } } });
  await prisma.inventorySummary.deleteMany({ where: { distributorId: DIST, summaryDate: { in: [TEST_DATE, PREV_DATE] } } });
  await prisma.cancelledStockEvent.deleteMany({ where: { distributorId: DIST, order: { orderNumber: { startsWith: 'WI106-' } } } });
  await prisma.cancelledStockEvent.deleteMany({ where: { distributorId: DIST, cancellationDate: { in: [TEST_DATE, PREV_DATE] } } });
  await prisma.orderStatusLog.deleteMany({ where: { order: { distributorId: DIST, orderNumber: { startsWith: 'WI106-' } } } });
  await prisma.driverAssignment.deleteMany({ where: { order: { distributorId: DIST, orderNumber: { startsWith: 'WI106-' } } } });
  await prisma.orderItem.deleteMany({ where: { order: { distributorId: DIST, orderNumber: { startsWith: 'WI106-' } } } });
  await prisma.order.deleteMany({ where: { distributorId: DIST, orderNumber: { startsWith: 'WI106-' } } });
  await prisma.driverVehicleAssignment.deleteMany({ where: { distributorId: DIST, assignmentDate: { in: [TEST_DATE, PREV_DATE] } } });
}

async function seedOpening(cylId: string, fulls = OPENING_FULLS, empties = OPENING_EMPTIES) {
  await prisma.inventorySummary.create({
    data: {
      distributorId: DIST, cylinderTypeId: cylId, summaryDate: PREV_DATE,
      openingFulls: 0, openingEmpties: 0, closingFulls: fulls, closingEmpties: empties,
      isLocked: true,
    },
  });
}

async function mkEvent(cylId: string, eventType: string, fulls: number, empties: number, date = TEST_DATE) {
  return prisma.inventoryEvent.create({
    data: {
      distributorId: DIST, cylinderTypeId: cylId, eventType: eventType as any,
      fullsChange: fulls, emptiesChange: empties, eventDate: date, createdBy: 'wi106-test',
    },
  });
}

// Seed a DVA (dispatch_ready) + a pending_dispatch order with driver+vehicle.
async function seedDispatchableOrder(cylId: string, qty: number, tag: string) {
  await prisma.driverVehicleAssignment.upsert({
    where: { driverId_assignmentDate_tripNumber: { driverId, assignmentDate: TEST_DATE, tripNumber: 1 } },
    create: { driverId, vehicleId, distributorId: DIST, assignmentDate: TEST_DATE, tripNumber: 1, status: 'dispatch_ready' },
    update: { status: 'dispatch_ready', vehicleId, isReconciled: false },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: nextOrderNumber(tag), distributorId: DIST, customerId: seed.customers[0].id,
      driverId, vehicleId, orderDate: new Date(), deliveryDate: TEST_DATE,
      status: 'pending_dispatch', totalAmount: 0,
      items: { create: [{ cylinderTypeId: cylId, quantity: qty, unitPrice: 0, discountPerUnit: 0, totalPrice: 0 }] },
    },
    include: { items: true },
  });
  return order;
}

async function eventsFor(orderId: string) {
  return prisma.inventoryEvent.findMany({ where: { distributorId: DIST, referenceId: orderId, referenceType: 'order' } });
}

beforeAll(async () => {
  seed = await getSeedData();
  const admin = await loginAsDistAdmin();
  adminUserId = admin.user.id;
  driverId = seed.drivers[0].id;
  vehicleId = seed.vehicles[0].id;
  cyl = { id: seed.cylinderTypes[0].id };
  cyl2 = { id: seed.cylinderTypes[1].id };
  cyl3 = { id: seed.cylinderTypes[2].id };
  await cleanup();
});

beforeEach(() => { flagOff(); (globalThis as any).__wi106_failEvent = false; });
afterEach(async () => { flagOff(); (globalThis as any).__wi106_failEvent = false; await cleanup(); });
afterAll(async () => { await cleanup(); });

// ─── REGRESSION (flag OFF) ─────────────────────────────────────────────────

describe('WI-106 regression — flag OFF', () => {
  it('R1: dispatch creates ZERO inventory events', async () => {
    const order = await seedDispatchableOrder(cyl.id, 5, 'R1');
    await preflightDispatch({ distributorId: DIST, driverId, assignmentDate: TEST_DATE_STR, userId: adminUserId });
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.status).toBe('pending_delivery');
    expect(await eventsFor(order.id)).toHaveLength(0);
  });

  it('R2: cancelOrder on pending_delivery: cancellation event + CSE created', async () => {
    const order = await seedDispatchableOrder(cyl.id, 2, 'R2');
    await prisma.order.update({ where: { id: order.id }, data: { status: 'pending_delivery' } });
    await cancelOrder(order.id, DIST, adminUserId, 'regression test');
    const evs = await eventsFor(order.id);
    expect(evs.filter((e) => e.eventType === 'cancellation')).toHaveLength(1);
    const cse = await prisma.cancelledStockEvent.findMany({ where: { orderId: order.id } });
    expect(cse).toHaveLength(1);
    expect(cse[0].status).toBe('on_vehicle');
  });

  it('R3: cancelOrder on pending_dispatch: cancellation event created', async () => {
    const order = await seedDispatchableOrder(cyl.id, 2, 'R3'); // stays pending_dispatch
    await cancelOrder(order.id, DIST, adminUserId, 'regression test');
    const evs = await eventsFor(order.id);
    expect(evs.filter((e) => e.eventType === 'cancellation')).toHaveLength(1);
  });

  it('R4: formula is delivered-based, not dispatch-based', async () => {
    await seedOpening(cyl.id);
    await mkEvent(cyl.id, 'dispatch', -2, 0);   // ignored by old formula
    await mkEvent(cyl.id, 'delivery', -1, 0);   // drives closing
    const s = await computeSummaryForDate(DIST, cyl.id, TEST_DATE);
    expect(s.closingFulls).toBe(OPENING_FULLS - 1); // delivery, NOT dispatch
  });

  it('R5: lifecycle closing equals delivered-based total', async () => {
    await seedOpening(cyl.id);
    await mkEvent(cyl.id, 'delivery', -2, 0);
    const s = await computeSummaryForDate(DIST, cyl.id, TEST_DATE);
    expect(s.closingFulls).toBe(OPENING_FULLS - 2);
  });
});

// ─── POSITIVE (flag ON) ────────────────────────────────────────────────────

describe('WI-106 positive — flag ON', () => {
  beforeEach(() => flagOn());

  it('P1: dispatch creates one dispatch event per item (fullsChange = -qty)', async () => {
    const order = await seedDispatchableOrder(cyl.id, 3, 'P1');
    await preflightDispatch({ distributorId: DIST, driverId, assignmentDate: TEST_DATE_STR, userId: adminUserId });
    const evs = await eventsFor(order.id);
    const dispatch = evs.filter((e) => e.eventType === 'dispatch');
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0].fullsChange).toBe(-3);
  });

  it('P2: partial dispatch — only successful orders get dispatch events', async () => {
    const ok = await seedDispatchableOrder(cyl.id, 2, 'P2ok');
    // A poisoned order: reference a non-existent driver so it is NOT picked up
    // by preflight (preflight only dispatches orders for `driverId`). Instead,
    // simulate "failed" by leaving a second order in pending_dispatch for a
    // DIFFERENT driver — it must not receive a dispatch event.
    const otherDriver = seed.drivers[1]?.id ?? driverId;
    const notDispatched = await prisma.order.create({
      data: {
        orderNumber: nextOrderNumber('P2no'), distributorId: DIST, customerId: seed.customers[0].id,
        driverId: otherDriver === driverId ? null : otherDriver, orderDate: new Date(), deliveryDate: TEST_DATE,
        status: 'pending_dispatch', totalAmount: 0,
        items: { create: [{ cylinderTypeId: cyl.id, quantity: 9, unitPrice: 0, discountPerUnit: 0, totalPrice: 0 }] },
      },
    });
    await preflightDispatch({ distributorId: DIST, driverId, assignmentDate: TEST_DATE_STR, userId: adminUserId });
    expect((await eventsFor(ok.id)).filter((e) => e.eventType === 'dispatch')).toHaveLength(1);
    expect((await eventsFor(notDispatched.id)).filter((e) => e.eventType === 'dispatch')).toHaveLength(0);
  });

  it('P3: cancelOrder on pending_delivery: NO cancellation event, CSE retained', async () => {
    const order = await seedDispatchableOrder(cyl.id, 2, 'P3');
    await prisma.order.update({ where: { id: order.id }, data: { status: 'pending_delivery' } });
    await cancelOrder(order.id, DIST, adminUserId, 'cancel on truck');
    const evs = await eventsFor(order.id);
    expect(evs.filter((e) => e.eventType === 'cancellation')).toHaveLength(0);
    const cse = await prisma.cancelledStockEvent.findMany({ where: { orderId: order.id } });
    expect(cse).toHaveLength(1);
    expect(cse[0].status).toBe('on_vehicle');
  });

  it('P4: cancelOrder on pending_dispatch: NO cancellation event, NO CSE', async () => {
    const order = await seedDispatchableOrder(cyl.id, 2, 'P4'); // stays pending_dispatch
    await cancelOrder(order.id, DIST, adminUserId, 'cancel before dispatch');
    const evs = await eventsFor(order.id);
    expect(evs.filter((e) => e.eventType === 'cancellation')).toHaveLength(0);
    expect(await prisma.cancelledStockEvent.findMany({ where: { orderId: order.id } })).toHaveLength(0);
  });

  it('P5: exact delivery — closing = opening - 2', async () => {
    await seedOpening(cyl.id);
    await mkEvent(cyl.id, 'dispatch', -2, 0);
    await mkEvent(cyl.id, 'delivery', -2, 0); // display only — excluded from closing
    const s = await computeSummaryForDate(DIST, cyl.id, TEST_DATE);
    expect(s.closingFulls).toBe(OPENING_FULLS - 2);
  });

  it('P6: modified short (2 ordered, 1 delivered) — closing = opening - 1', async () => {
    await seedOpening(cyl.id);
    await mkEvent(cyl.id, 'dispatch', -2, 0);
    await mkEvent(cyl.id, 'delivery', -1, 0);
    await mkEvent(cyl.id, 'cancellation_return', 1, 0);
    const s = await computeSummaryForDate(DIST, cyl.id, TEST_DATE);
    expect(s.closingFulls).toBe(OPENING_FULLS - 1);
  });

  it('P7: cancelled on truck — closing = opening (net 0)', async () => {
    await seedOpening(cyl.id);
    await mkEvent(cyl.id, 'dispatch', -2, 0);
    await mkEvent(cyl.id, 'cancellation_return', 2, 0); // no cancellation event under flag on
    const s = await computeSummaryForDate(DIST, cyl.id, TEST_DATE);
    expect(s.closingFulls).toBe(OPENING_FULLS);
  });

  it('P8: cancelled before dispatch — closing = opening (no events)', async () => {
    await seedOpening(cyl.id);
    const s = await computeSummaryForDate(DIST, cyl.id, TEST_DATE);
    expect(s.closingFulls).toBe(OPENING_FULLS);
  });
});

// ─── ROBUSTNESS (flag ON) ──────────────────────────────────────────────────

describe('WI-106 robustness — flag ON', () => {
  beforeEach(() => flagOn());

  it('RB1: 5-order mix nets to opening - (delivered to customers)', async () => {
    await seedOpening(cyl.id);
    // 2 normal (deliver 2 each): dispatch -2, delivery -2  (×2)
    await mkEvent(cyl.id, 'dispatch', -2, 0); await mkEvent(cyl.id, 'delivery', -2, 0);
    await mkEvent(cyl.id, 'dispatch', -2, 0); await mkEvent(cyl.id, 'delivery', -2, 0);
    // 1 short (deliver 1 of 2): dispatch -2, delivery -1, return +1
    await mkEvent(cyl.id, 'dispatch', -2, 0); await mkEvent(cyl.id, 'delivery', -1, 0); await mkEvent(cyl.id, 'cancellation_return', 1, 0);
    // 1 full cancel on truck: dispatch -2, return +2
    await mkEvent(cyl.id, 'dispatch', -2, 0); await mkEvent(cyl.id, 'cancellation_return', 2, 0);
    // 1 cancelled before dispatch: no events
    const s = await computeSummaryForDate(DIST, cyl.id, TEST_DATE);
    // dispatched = 8, returned = 3 -> closing = opening - 8 + 3 = opening - 5
    // delivered to customers = 2 + 2 + 1 = 5
    expect(s.dispatchedQty).toBe(8);
    expect(s.closingFulls).toBe(OPENING_FULLS - 5);
  });

  it('RB2: 3 cylinder types dispatched + delivered are independent', async () => {
    await seedOpening(cyl.id, 100); await seedOpening(cyl2.id, 60); await seedOpening(cyl3.id, 30);
    for (const c of [cyl.id, cyl2.id, cyl3.id]) {
      await mkEvent(c, 'dispatch', -2, 0); await mkEvent(c, 'delivery', -2, 0);
    }
    expect((await computeSummaryForDate(DIST, cyl.id, TEST_DATE)).closingFulls).toBe(98);
    expect((await computeSummaryForDate(DIST, cyl2.id, TEST_DATE)).closingFulls).toBe(58);
    expect((await computeSummaryForDate(DIST, cyl3.id, TEST_DATE)).closingFulls).toBe(28);
  });

  it('RB3: two trips same day net correctly', async () => {
    await seedOpening(cyl.id);
    // trip 1: dispatch -2, deliver -2  | trip 2: dispatch -3, deliver -3
    await mkEvent(cyl.id, 'dispatch', -2, 0); await mkEvent(cyl.id, 'delivery', -2, 0);
    await mkEvent(cyl.id, 'dispatch', -3, 0); await mkEvent(cyl.id, 'delivery', -3, 0);
    const s = await computeSummaryForDate(DIST, cyl.id, TEST_DATE);
    expect(s.dispatchedQty).toBe(5);
    expect(s.closingFulls).toBe(OPENING_FULLS - 5);
  });

  it('RB4: recompute persists dispatched_qty and closingFulls matches formula', async () => {
    await seedOpening(cyl.id);
    await mkEvent(cyl.id, 'incoming_fulls', 10, 0);
    await mkEvent(cyl.id, 'dispatch', -4, 0);
    await mkEvent(cyl.id, 'cancellation_return', 1, 0);
    await recalculateSummariesFromDate(DIST, cyl.id, TEST_DATE);
    const row = await prisma.inventorySummary.findUniqueOrThrow({
      where: { distributorId_cylinderTypeId_summaryDate: { distributorId: DIST, cylinderTypeId: cyl.id, summaryDate: TEST_DATE } },
    });
    expect(row.dispatchedQty).toBe(4);
    // opening 100 + incoming 10 - dispatched 4 + returned 1 = 107
    expect(row.closingFulls).toBe(107);
  });
});

// ─── NEGATIVE (flag ON) ────────────────────────────────────────────────────

describe('WI-106 negative — flag ON', () => {
  beforeEach(() => flagOn());

  it('N1: dispatch event failure rolls back the whole transition (no status change, no event)', async () => {
    const order = await seedDispatchableOrder(cyl.id, 2, 'N1');
    (globalThis as any).__wi106_failEvent = true;
    await preflightDispatch({ distributorId: DIST, driverId, assignmentDate: TEST_DATE_STR, userId: adminUserId });
    (globalThis as any).__wi106_failEvent = false;
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    // transitionToPendingDelivery rolled back; preflight catch reverts to pending_dispatch.
    expect(updated.status).toBe('pending_dispatch');
    expect((await eventsFor(order.id)).filter((e) => e.eventType === 'dispatch')).toHaveLength(0);
  });

  it('N2: cancelOrder twice is idempotent (no duplicate events)', async () => {
    const order = await seedDispatchableOrder(cyl.id, 2, 'N2');
    await prisma.order.update({ where: { id: order.id }, data: { status: 'pending_delivery' } });
    await cancelOrder(order.id, DIST, adminUserId, 'first cancel');
    await expect(cancelOrder(order.id, DIST, adminUserId, 'second cancel')).rejects.toThrow();
    // CSE count unchanged after the rejected second call.
    expect(await prisma.cancelledStockEvent.findMany({ where: { orderId: order.id } })).toHaveLength(1);
  });

  it('N3: date with no dispatch events still produces a valid result', async () => {
    await seedOpening(cyl.id);
    await mkEvent(cyl.id, 'incoming_fulls', 10, 0); // only old-style data
    const s = await computeSummaryForDate(DIST, cyl.id, TEST_DATE);
    expect(s.dispatchedQty).toBe(0);
    expect(s.closingFulls).toBe(OPENING_FULLS + 10);
  });
});
