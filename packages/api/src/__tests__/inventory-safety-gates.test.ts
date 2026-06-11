/**
 * Group 2 (2026-06-11) — Inventory Safety Gates.
 *
 * Pins the three behaviours added:
 *   1. preflightDispatch blocks any order whose required cylinders exceed
 *      the latest closingFulls per cylinder type — INSUFFICIENT_STOCK
 *      surfaces in the per-order PreflightResult envelope.
 *   2. recordInitialBalance throws InitialBalanceConflictError when an
 *      `initial_balance` event already exists for the cylinder type and
 *      `replaceExisting` is omitted/false.
 *   3. With `replaceExisting=true`, the prior event is hard-deleted and
 *      the new entry takes its place; the summary recalc covers the
 *      earliest affected date.
 *
 * All run against the dev DB. Far-future test date (2099) anti-pattern #7
 * so we don't contaminate today's bucket.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma.js';
import {
  recordInitialBalance,
  InitialBalanceConflictError,
} from '../services/inventoryService.js';
import { preflightDispatch } from '../services/gst/gstPreflightService.js';
import { loginAsDistAdmin } from './helpers.js';

const TRACK_CUSTOMER_NAME = 'G2-Stock Gate Customer';
const TRACK_DRIVER_NAME = 'G2-Stock Gate Driver';
const TRACK_VEHICLE = 'G2-STOCK-VEH';
const DELIVERY_DATE = new Date('2099-12-31'); // anti-pattern #7

let distributorId: string;
let customerId: string;
let driverId: string;
let userId: string;
let cylType19: { id: string; typeName: string };
let cylType5: { id: string; typeName: string };

async function cleanup() {
  await prisma.orderStatusLog.deleteMany({
    where: { order: { customer: { customerName: TRACK_CUSTOMER_NAME } } },
  });
  await prisma.order.deleteMany({
    where: { distributorId, customer: { customerName: TRACK_CUSTOMER_NAME } },
  });
  await prisma.customer.deleteMany({
    where: { distributorId, customerName: TRACK_CUSTOMER_NAME },
  });
  // Test-introduced initial_balance events on dist-001 for the two test
  // cylinder types — only those touched by this file.
  await prisma.inventoryEvent.deleteMany({
    where: {
      distributorId,
      eventType: 'initial_balance',
      cylinderTypeId: { in: [cylType19?.id, cylType5?.id].filter(Boolean) as string[] },
    },
  });
  // Sweep the summary rows we rewrote so other suites aren't affected.
  if (cylType19?.id || cylType5?.id) {
    await prisma.inventorySummary.deleteMany({
      where: {
        distributorId,
        cylinderTypeId: { in: [cylType19?.id, cylType5?.id].filter(Boolean) as string[] },
      },
    });
  }
  await prisma.driverVehicleAssignment.deleteMany({
    where: { distributorId, driver: { driverName: TRACK_DRIVER_NAME } },
  });
  await prisma.driver.deleteMany({ where: { distributorId, driverName: TRACK_DRIVER_NAME } });
  await prisma.vehicle.deleteMany({ where: { distributorId, vehicleNumber: TRACK_VEHICLE } });
}

beforeAll(async () => {
  // Group 2: this file explicitly tests the stock gate, so override the
  // setup.ts global bypass and let the gate enforce normally.
  delete process.env.INVENTORY_STOCK_GATE_BYPASS;
  const admin = await loginAsDistAdmin();
  distributorId = admin.distributorId;
  userId = admin.user.id;
  const t19 = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId, typeName: '19 KG' },
    select: { id: true, typeName: true },
  });
  const t5 = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId, typeName: '5 KG' },
    select: { id: true, typeName: true },
  });
  cylType19 = t19;
  cylType5 = t5;
  await cleanup();

  const c = await prisma.customer.create({
    data: {
      distributorId,
      customerName: TRACK_CUSTOMER_NAME,
      phone: '9100000200',
      customerType: 'B2C',
      creditPeriodDays: 30,
    },
  });
  customerId = c.id;

  const d = await prisma.driver.create({
    data: { distributorId, driverName: TRACK_DRIVER_NAME, phone: '9100000201', status: 'active' },
  });
  driverId = d.id;
  const v = await prisma.vehicle.create({
    data: { distributorId, vehicleNumber: TRACK_VEHICLE, status: 'idle' },
  });
  await prisma.driverVehicleAssignment.create({
    data: { distributorId, driverId: d.id, vehicleId: v.id, assignmentDate: DELIVERY_DATE },
  });
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  // setup.ts beforeEach runs FIRST and sets the bypass — unset it again
  // here so this file's tests exercise the real gate.
  delete process.env.INVENTORY_STOCK_GATE_BYPASS;

  // Reset orders + summaries between scenarios. Use the same cleanup
  // signal as cleanup() but scoped to per-test.
  await prisma.orderStatusLog.deleteMany({
    where: { order: { customer: { customerName: TRACK_CUSTOMER_NAME } } },
  });
  await prisma.order.deleteMany({
    where: { distributorId, customerId },
  });
  await prisma.inventoryEvent.deleteMany({
    where: {
      distributorId,
      eventType: 'initial_balance',
      cylinderTypeId: { in: [cylType19.id, cylType5.id] },
    },
  });
  await prisma.inventorySummary.deleteMany({
    where: { distributorId, cylinderTypeId: { in: [cylType19.id, cylType5.id] } },
  });
});

// ─── 2a — Stock gate ──────────────────────────────────────────────────────

async function seedOrder(items: { cylinderTypeId: string; quantity: number; unitPrice?: number }[]) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `G2-${Math.random().toString(36).slice(2, 8)}`,
      distributorId, customerId, driverId,
      status: 'pending_dispatch',
      orderDate: DELIVERY_DATE,
      deliveryDate: DELIVERY_DATE,
      items: {
        create: items.map((i) => ({
          cylinderTypeId: i.cylinderTypeId,
          quantity: i.quantity,
          deliveredQuantity: 0,
          emptiesCollected: 0,
          unitPrice: i.unitPrice ?? 1000,
          discountPerUnit: 0,
          totalPrice: (i.unitPrice ?? 1000) * i.quantity,
        })),
      },
    } as never,
  });
  return order;
}

describe('G2.2a — stock gate', () => {
  it('positive: dispatch with sufficient stock succeeds', async () => {
    await recordInitialBalance(distributorId, userId, {
      entries: [{ cylinderTypeId: cylType19.id, openingFulls: 50, openingEmpties: 0 }],
      eventDate: DELIVERY_DATE.toISOString().split('T')[0],
    });
    await seedOrder([{ cylinderTypeId: cylType19.id, quantity: 5 }]);
    const result = await preflightDispatch({
      distributorId,
      driverId,
      assignmentDate: DELIVERY_DATE.toISOString().split('T')[0],
      userId,
    });
    const failed = result.results.filter((o) => !o.success);
    expect(failed).toHaveLength(0);
  });

  it('negative: dispatch with zero stock returns INSUFFICIENT_STOCK', async () => {
    await seedOrder([{ cylinderTypeId: cylType19.id, quantity: 5 }]);
    const result = await preflightDispatch({
      distributorId,
      driverId,
      assignmentDate: DELIVERY_DATE.toISOString().split('T')[0],
      userId,
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].errorCode).toBe('INSUFFICIENT_STOCK');
    expect(result.results[0].errorMessage).toMatch(/Insufficient stock/);
    // The order must be reverted to pending_dispatch so it can be retried.
    const ord = await prisma.order.findFirstOrThrow({
      where: { distributorId, customerId },
      select: { status: true },
    });
    expect(ord.status).toBe('pending_dispatch');
  });

  it('negative: partial stock (need 5, have 3) is blocked with the exact numbers in the message', async () => {
    await recordInitialBalance(distributorId, userId, {
      entries: [{ cylinderTypeId: cylType19.id, openingFulls: 3, openingEmpties: 0 }],
      eventDate: DELIVERY_DATE.toISOString().split('T')[0],
    });
    await seedOrder([{ cylinderTypeId: cylType19.id, quantity: 5 }]);
    const result = await preflightDispatch({
      distributorId,
      driverId,
      assignmentDate: DELIVERY_DATE.toISOString().split('T')[0],
      userId,
    });
    expect(result.results[0].errorCode).toBe('INSUFFICIENT_STOCK');
    expect(result.results[0].errorMessage).toMatch(/need 5, available 3/);
  });

  it('regression: multi-line order (2× 19KG + 1× 5KG) checks both types', async () => {
    // 19KG has 5 (enough for 2 needed), 5KG has 0 (NOT enough for 1)
    await recordInitialBalance(distributorId, userId, {
      entries: [{ cylinderTypeId: cylType19.id, openingFulls: 5, openingEmpties: 0 }],
      eventDate: DELIVERY_DATE.toISOString().split('T')[0],
    });
    await seedOrder([
      { cylinderTypeId: cylType19.id, quantity: 2 },
      { cylinderTypeId: cylType5.id, quantity: 1 },
    ]);
    const result = await preflightDispatch({
      distributorId,
      driverId,
      assignmentDate: DELIVERY_DATE.toISOString().split('T')[0],
      userId,
    });
    expect(result.results[0].errorCode).toBe('INSUFFICIENT_STOCK');
    expect(result.results[0].errorMessage).toMatch(/5 KG/);
  });
});

// ─── 2b — Opening-stock duplicate guard ──────────────────────────────────

describe('G2.2b — recordInitialBalance duplicate guard', () => {
  it('positive: first call succeeds', async () => {
    const r = await recordInitialBalance(distributorId, userId, {
      entries: [{ cylinderTypeId: cylType19.id, openingFulls: 50, openingEmpties: 10 }],
      eventDate: DELIVERY_DATE.toISOString().split('T')[0],
    });
    expect(r.created).toBe(1);
    expect(r.replaced).toBe(0);
  });

  it('negative: second call without replaceExisting throws InitialBalanceConflictError', async () => {
    await recordInitialBalance(distributorId, userId, {
      entries: [{ cylinderTypeId: cylType19.id, openingFulls: 50, openingEmpties: 10 }],
      eventDate: DELIVERY_DATE.toISOString().split('T')[0],
    });
    await expect(
      recordInitialBalance(distributorId, userId, {
        entries: [{ cylinderTypeId: cylType19.id, openingFulls: 100, openingEmpties: 20 }],
        eventDate: DELIVERY_DATE.toISOString().split('T')[0],
      }),
    ).rejects.toMatchObject({
      name: 'InitialBalanceConflictError',
      conflicts: [
        expect.objectContaining({ cylinderTypeId: cylType19.id, fulls: 50, empties: 10 }),
      ],
    });
  });

  it('positive: replaceExisting=true deletes the prior event and writes the new one', async () => {
    await recordInitialBalance(distributorId, userId, {
      entries: [{ cylinderTypeId: cylType19.id, openingFulls: 50, openingEmpties: 10 }],
      eventDate: DELIVERY_DATE.toISOString().split('T')[0],
    });
    const r = await recordInitialBalance(distributorId, userId, {
      entries: [{ cylinderTypeId: cylType19.id, openingFulls: 200, openingEmpties: 0 }],
      eventDate: DELIVERY_DATE.toISOString().split('T')[0],
      replaceExisting: true,
    });
    expect(r.created).toBe(1);
    expect(r.replaced).toBe(1);

    const events = await prisma.inventoryEvent.findMany({
      where: { distributorId, cylinderTypeId: cylType19.id, eventType: 'initial_balance' },
      select: { fullsChange: true, emptiesChange: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0].fullsChange).toBe(200);
    expect(events[0].emptiesChange).toBe(0);
  });

  it('negative: the InitialBalanceConflictError carries the event date so the UI can show "as of X"', async () => {
    await recordInitialBalance(distributorId, userId, {
      entries: [{ cylinderTypeId: cylType19.id, openingFulls: 10, openingEmpties: 0 }],
      eventDate: '2099-06-01',
    });
    try {
      await recordInitialBalance(distributorId, userId, {
        entries: [{ cylinderTypeId: cylType19.id, openingFulls: 20, openingEmpties: 0 }],
        eventDate: '2099-12-31',
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(InitialBalanceConflictError);
      const err = e as InitialBalanceConflictError;
      expect(err.conflicts[0].eventDate).toBe('2099-06-01');
    }
  });
});

// ─── 2c — As-of-date plumbing ─────────────────────────────────────────────

describe('G2.2c — as-of-date plumbing', () => {
  it('positive: eventDate from the request lands on the inventory_event row', async () => {
    await recordInitialBalance(distributorId, userId, {
      entries: [{ cylinderTypeId: cylType19.id, openingFulls: 30, openingEmpties: 0 }],
      eventDate: '2099-03-15',
    });
    const ev = await prisma.inventoryEvent.findFirstOrThrow({
      where: { distributorId, cylinderTypeId: cylType19.id, eventType: 'initial_balance' },
      select: { eventDate: true },
    });
    expect(ev.eventDate.toISOString().split('T')[0]).toBe('2099-03-15');
  });
});
