/**
 * Backdated Inventory Adjustment.
 *
 * Covers the locked design from docs/BACKDATED-INVESTIGATION-GAPS.md §5:
 *   - One manual_adjustment event per item with delivered > 0 (fulls,
 *     dated TODAY — NOT the backdated delivery date)
 *   - One reconciliation_empties_return event per item with empties > 0
 *   - NO empties event when emptiesCollected = 0
 *   - Order.inventoryAdjustedAt stamped to block double-apply
 *   - Gates: non-backdated 400, cancelled 400, double-apply 409,
 *     cross-tenant 404
 *   - Pending list excludes already-adjusted; history filters by
 *     referenceType='backdated_inventory_adjustment'
 *   - Event notes carry order number + backdated delivery date
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { localTodayISO } from '@gaslink/shared';
import {
  applyBackdatedInventoryAdjustment,
  getPendingBackdatedAdjustments,
  getBackdatedAdjustmentHistory,
  BackdatedAdjustmentError,
} from '../services/backdatedAdjustmentService.js';

const D1 = 'dist-001';
const D2 = 'dist-002';

const trackedOrderIds: string[] = [];
const trackedCustomerIds: string[] = [];

async function makeCustomer(name: string) {
  const c = await prisma.customer.create({
    data: {
      distributorId: D1,
      customerName: `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      customerType: 'B2B',
      phone: '+919999999999',
      gstin: '29ABCDE1234F1Z5',
      billingAddressLine1: 'Test St',
      billingState: 'Karnataka',
      billingPincode: '560001',
      billingCity: 'Bengaluru',
      status: 'active',
      creditPeriodDays: 30,
    },
    select: { id: true },
  });
  trackedCustomerIds.push(c.id);
  return c;
}

async function makeBackdatedOrder(opts: {
  customerId: string;
  cylinderTypeId: string;
  deliveredQty: number;
  emptiesCollected: number;
  isBackdated?: boolean;
  status?: 'delivered' | 'pending_delivery';
  deletedAt?: Date | null;
  inventoryAdjustedAt?: Date | null;
  distributorId?: string;
}) {
  const distId = opts.distributorId ?? D1;
  // Use far-future deliveryDate to avoid colliding with the gst-preflight
  // dev-DB-anchored test set.
  const deliveryDate = new Date('2099-12-15');
  const o = await prisma.order.create({
    data: {
      distributorId: distId,
      customerId: opts.customerId,
      orderNumber: `OBKTEST-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      orderDate: deliveryDate,
      deliveryDate,
      deliveredAt: deliveryDate,
      status: opts.status ?? 'delivered',
      isBackdated: opts.isBackdated ?? true,
      totalAmount: 1000,
      deletedAt: opts.deletedAt ?? null,
      inventoryAdjustedAt: opts.inventoryAdjustedAt ?? null,
      items: {
        create: [
          {
            cylinderTypeId: opts.cylinderTypeId,
            quantity: opts.deliveredQty,
            deliveredQuantity: opts.deliveredQty,
            emptiesCollected: opts.emptiesCollected,
            unitPrice: 1000,
            totalPrice: 1000 * opts.deliveredQty,
          },
        ],
      },
    },
    select: { id: true, orderNumber: true, deliveryDate: true },
  });
  trackedOrderIds.push(o.id);
  return o;
}

describe('applyBackdatedInventoryAdjustment — events', () => {
  let ctId: string;
  beforeAll(async () => {
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D1, isActive: true },
    });
    ctId = ct.id;
  });

  it('writes a manual_adjustment event dated today (NOT the backdated delivery date)', async () => {
    const cust = await makeCustomer('bia-fulls');
    const o = await makeBackdatedOrder({ customerId: cust.id, cylinderTypeId: ctId, deliveredQty: 3, emptiesCollected: 0 });
    const result = await applyBackdatedInventoryAdjustment(D1, 'test-user', o.id);
    expect(result.eventsWritten).toBe(1);
    const events = await prisma.inventoryEvent.findMany({
      where: { referenceId: o.id, referenceType: 'backdated_inventory_adjustment' },
    });
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.eventType).toBe('manual_adjustment');
    expect(ev.fullsChange).toBe(-3);
    expect(ev.emptiesChange).toBe(0);
    // Today, NOT the 2099-12-15 deliveryDate.
    expect(ev.eventDate.toISOString().slice(0, 10)).toBe(localTodayISO());
  });

  it('writes a reconciliation_empties_return event when emptiesCollected > 0', async () => {
    const cust = await makeCustomer('bia-empties');
    const o = await makeBackdatedOrder({ customerId: cust.id, cylinderTypeId: ctId, deliveredQty: 2, emptiesCollected: 2 });
    const result = await applyBackdatedInventoryAdjustment(D1, 'test-user', o.id);
    expect(result.eventsWritten).toBe(2);
    const events = await prisma.inventoryEvent.findMany({
      where: { referenceId: o.id, referenceType: 'backdated_inventory_adjustment' },
      orderBy: { eventType: 'asc' },
    });
    const fulls = events.find((e) => e.eventType === 'manual_adjustment');
    const empties = events.find((e) => e.eventType === 'reconciliation_empties_return');
    expect(fulls?.fullsChange).toBe(-2);
    expect(empties?.emptiesChange).toBe(2);
    expect(empties?.eventDate.toISOString().slice(0, 10)).toBe(localTodayISO());
  });

  it('does NOT write an empties event when emptiesCollected = 0', async () => {
    const cust = await makeCustomer('bia-no-empties');
    const o = await makeBackdatedOrder({ customerId: cust.id, cylinderTypeId: ctId, deliveredQty: 1, emptiesCollected: 0 });
    await applyBackdatedInventoryAdjustment(D1, 'test-user', o.id);
    const empties = await prisma.inventoryEvent.findFirst({
      where: { referenceId: o.id, eventType: 'reconciliation_empties_return' },
    });
    expect(empties).toBeNull();
  });

  it('stamps Order.inventoryAdjustedAt', async () => {
    const cust = await makeCustomer('bia-stamp');
    const o = await makeBackdatedOrder({ customerId: cust.id, cylinderTypeId: ctId, deliveredQty: 1, emptiesCollected: 0 });
    await applyBackdatedInventoryAdjustment(D1, 'test-user', o.id);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.inventoryAdjustedAt).not.toBeNull();
    expect(Date.now() - (after.inventoryAdjustedAt as Date).getTime()).toBeLessThan(60_000);
  });

  it('rejects a second apply with 409', async () => {
    const cust = await makeCustomer('bia-double');
    const o = await makeBackdatedOrder({ customerId: cust.id, cylinderTypeId: ctId, deliveredQty: 1, emptiesCollected: 0 });
    await applyBackdatedInventoryAdjustment(D1, 'test-user', o.id);
    await expect(
      applyBackdatedInventoryAdjustment(D1, 'test-user', o.id),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/already adjusted/i) });
  });

  it('rejects a non-backdated order with 400', async () => {
    const cust = await makeCustomer('bia-not-backdated');
    const o = await makeBackdatedOrder({ customerId: cust.id, cylinderTypeId: ctId, deliveredQty: 1, emptiesCollected: 0, isBackdated: false });
    await expect(
      applyBackdatedInventoryAdjustment(D1, 'test-user', o.id),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a cancelled (deletedAt) order with 400', async () => {
    const cust = await makeCustomer('bia-cancelled');
    const o = await makeBackdatedOrder({ customerId: cust.id, cylinderTypeId: ctId, deliveredQty: 1, emptiesCollected: 0, deletedAt: new Date() });
    await expect(
      applyBackdatedInventoryAdjustment(D1, 'test-user', o.id),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/cancelled/i) });
  });

  it('multi-tenant: dist-001 cannot adjust dist-002 order', async () => {
    // Reuse an existing dist-002 customer (avoid cross-tenant create that
    // would pollute the other distributor's test pool).
    const otherCust = await prisma.customer.findFirstOrThrow({
      where: { distributorId: D2, deletedAt: null },
      select: { id: true },
    });
    const otherCt = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: D2, isActive: true },
      select: { id: true },
    });
    const o = await makeBackdatedOrder({
      customerId: otherCust.id, cylinderTypeId: otherCt.id,
      deliveredQty: 1, emptiesCollected: 0, distributorId: D2,
    });
    await expect(
      applyBackdatedInventoryAdjustment(D1, 'test-user', o.id),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('event notes contain orderNumber + backdated deliveryDate', async () => {
    const cust = await makeCustomer('bia-notes');
    const o = await makeBackdatedOrder({ customerId: cust.id, cylinderTypeId: ctId, deliveredQty: 1, emptiesCollected: 0 });
    await applyBackdatedInventoryAdjustment(D1, 'test-user', o.id);
    const ev = await prisma.inventoryEvent.findFirstOrThrow({ where: { referenceId: o.id } });
    expect(ev.notes).toContain(o.orderNumber);
    expect(ev.notes).toContain('2099-12-15');
  });
});

describe('getPendingBackdatedAdjustments + getBackdatedAdjustmentHistory', () => {
  let ctId: string;
  beforeAll(async () => {
    const ct = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: D1, isActive: true } });
    ctId = ct.id;
  });

  it('pending list includes a fresh backdated delivered order', async () => {
    const cust = await makeCustomer('bia-pending-list');
    const o = await makeBackdatedOrder({ customerId: cust.id, cylinderTypeId: ctId, deliveredQty: 2, emptiesCollected: 1 });
    const pending = await getPendingBackdatedAdjustments(D1);
    const row = pending.find((p) => p.orderId === o.id);
    expect(row).toBeTruthy();
    expect(row?.orderNumber).toBe(o.orderNumber);
    expect(row?.items[0].deliveredQty).toBe(2);
    expect(row?.items[0].emptiesCollected).toBe(1);
  });

  it('pending list excludes orders already adjusted', async () => {
    const cust = await makeCustomer('bia-pending-excluded');
    const o = await makeBackdatedOrder({ customerId: cust.id, cylinderTypeId: ctId, deliveredQty: 1, emptiesCollected: 0 });
    await applyBackdatedInventoryAdjustment(D1, 'test-user', o.id);
    const pending = await getPendingBackdatedAdjustments(D1);
    expect(pending.find((p) => p.orderId === o.id)).toBeUndefined();
  });

  it('history returns only backdated_inventory_adjustment events', async () => {
    const cust = await makeCustomer('bia-history');
    const o = await makeBackdatedOrder({ customerId: cust.id, cylinderTypeId: ctId, deliveredQty: 1, emptiesCollected: 0 });
    await applyBackdatedInventoryAdjustment(D1, 'test-user', o.id);
    const history = await getBackdatedAdjustmentHistory(D1);
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((h) => h.eventType === 'manual_adjustment' || h.eventType === 'reconciliation_empties_return')).toBe(true);
    const myRow = history.find((h) => h.orderId === o.id);
    expect(myRow?.orderNumber).toBe(o.orderNumber);
  });
});

describe('BackdatedAdjustmentError shape', () => {
  it('exposes statusCode for the route layer', () => {
    const e = new BackdatedAdjustmentError('test', 409);
    expect(e.statusCode).toBe(409);
    expect(e).toBeInstanceOf(Error);
  });
});

afterAll(async () => {
  if (trackedOrderIds.length) {
    await prisma.inventoryEvent.deleteMany({ where: { referenceId: { in: trackedOrderIds } } });
    await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: trackedOrderIds } } });
  }
  if (trackedCustomerIds.length) {
    await prisma.customer.updateMany({
      where: { id: { in: trackedCustomerIds } },
      data: { deletedAt: new Date() },
    });
  }
});
