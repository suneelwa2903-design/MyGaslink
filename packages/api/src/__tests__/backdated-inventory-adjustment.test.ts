/**
 * Backdated Inventory Adjustment.
 *
 * Covers the current design (Suneel Option A, 2026-07-10 — flipped from
 * the original "today-only" design in docs/BACKDATED-INVESTIGATION-GAPS.md §5):
 *   - One manual_adjustment event per item with delivered > 0 (fulls,
 *     dated on the ORDER'S DELIVERY DATE — retro-dated so the stock
 *     movement lands on the summary the operator expects)
 *   - One reconciliation_empties_return event per item with empties > 0
 *   - NO empties event when emptiesCollected = 0
 *   - Order.inventoryAdjustedAt stamped with NOW (audit — WHEN the
 *     operator ran the adjustment; NOT the delivery date)
 *   - Gates: non-backdated 400, cancelled 400, double-apply 409,
 *     cross-tenant 404
 *   - Pending list excludes already-adjusted; history filters by
 *     referenceType='backdated_inventory_adjustment'
 *   - Event notes carry order number + backdated delivery date
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import {
  applyBackdatedInventoryAdjustment,
  getPendingBackdatedAdjustments,
  getBackdatedAdjustmentHistory,
  BackdatedAdjustmentError,
} from '../services/backdatedAdjustmentService.js';
import { loginAsFinance, loginAsInventory, loginAsCustomer } from './helpers.js';

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
  deliveryDate?: Date;
}) {
  const distId = opts.distributorId ?? D1;
  // Use far-future deliveryDate to avoid colliding with the gst-preflight
  // dev-DB-anchored test set. Individual tests can override via
  // opts.deliveryDate when they need summary-level isolation (Option A
  // cascade test writes to a unique date so the daily summary aggregate
  // isn't polluted by sibling tests).
  //
  // Anti-pattern #7 / CI failure 2026-07-10: 2099-12-15 collided with
  // float-stock/float-dispatch.test.ts's TEST_DATE. Its openingFulls=100
  // fixture read the summary aggregate for dist-001/2099-12-15 and saw
  // the -2 fulls this file's tests had written (Option A retro-dates
  // manual_adjustment events to the delivery day). Locally the ordering
  // hid the collision; CI's parallel/interleaved execution surfaced it
  // (openingFulls got 98, expected 100). Moved here to 2099-08-15,
  // which no other test touches. Verified with:
  //   grep -rE "2099-08-15" packages/api/src/__tests__/ → 1 file (this one)
  // If a future test wants 08-15, THIS file must move again — never
  // share a shared-DB anchor date between two aggregate-sensitive suites.
  const deliveryDate = opts.deliveryDate ?? new Date('2099-08-15');
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

  it('writes a manual_adjustment event dated ON THE DELIVERY DATE (Option A, 2026-07-10)', async () => {
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
    // Option A — event lands on the ORDER'S delivery date (2099-08-15),
    // not on today. If this ever flips back to today, the stock
    // movement disappears from the day the operator expects it on and
    // silently drifts to the entry day.
    expect(ev.eventDate.toISOString().slice(0, 10)).toBe('2099-08-15');
  });

  it('writes PAIRED collection + reconciliation_empties_return events when emptiesCollected > 0 (F1)', async () => {
    // F1 (2026-07-10): the backdated writer emits a `collection` event
    // ALONGSIDE the `reconciliation_empties_return` event so the daily
    // summary derivation `emptiesOnVehicle = collected − verified`
    // stays at 0 (matching a normal delivery+reconcile round-trip),
    // and the "Collected Empties" display column reflects the
    // backdated returns. Total = 3 events per item with empties: 1
    // manual_adjustment for fulls + 1 collection + 1 verified.
    const cust = await makeCustomer('bia-empties');
    const o = await makeBackdatedOrder({ customerId: cust.id, cylinderTypeId: ctId, deliveredQty: 2, emptiesCollected: 2 });
    const result = await applyBackdatedInventoryAdjustment(D1, 'test-user', o.id);
    expect(result.eventsWritten).toBe(3);
    const events = await prisma.inventoryEvent.findMany({
      where: { referenceId: o.id, referenceType: 'backdated_inventory_adjustment' },
      orderBy: { eventType: 'asc' },
    });
    const fulls = events.find((e) => e.eventType === 'manual_adjustment');
    const collection = events.find((e) => e.eventType === 'collection');
    const verified = events.find((e) => e.eventType === 'reconciliation_empties_return');
    expect(fulls?.fullsChange).toBe(-2);
    expect(fulls?.eventDate.toISOString().slice(0, 10)).toBe('2099-08-15');
    expect(collection?.emptiesChange).toBe(2);
    expect(collection?.eventDate.toISOString().slice(0, 10)).toBe('2099-08-15');
    expect(verified?.emptiesChange).toBe(2);
    expect(verified?.eventDate.toISOString().slice(0, 10)).toBe('2099-08-15');
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
    expect(ev.notes).toContain('2099-08-15');
  });

  it('cascades summaries — the DELIVERY-DAY inventory_summary carries the movement (Option A pin)', async () => {
    // Option A guard: applying the adjustment must touch the summary
    // for the delivery date, not a today-dated one. If the service
    // ever silently reverts to today-dated events, this test catches
    // it because the delivery-day row would show `manual_adjustment=0`.
    // Uses a UNIQUE deliveryDate so the summary aggregate isn't polluted
    // by the other tests in this describe() block that all target
    // 2099-08-15.
    const cust = await makeCustomer('bia-cascade');
    const cascadeDate = new Date('2099-11-11');
    const o = await makeBackdatedOrder({
      customerId: cust.id,
      cylinderTypeId: ctId,
      deliveredQty: 5,
      emptiesCollected: 3,
      deliveryDate: cascadeDate,
    });
    await applyBackdatedInventoryAdjustment(D1, 'test-user', o.id);
    const summary = await prisma.inventorySummary.findFirstOrThrow({
      where: {
        distributorId: D1,
        cylinderTypeId: ctId,
        summaryDate: cascadeDate,
      },
    });
    expect(summary.manualAdjustment).toBe(-5);
    expect(summary.emptiesReturnedVerified).toBe(3);
    // F1 — the paired collection event feeds `collectedEmpties`, so the
    // derived `emptiesOnVehicle = collectedEmpties − emptiesReturnedVerified`
    // stays at 0 (matches a normal delivery+reconcile round-trip; no
    // phantom "-3 on vehicle" like the pre-F1 backdated writer produced).
    expect(summary.collectedEmpties).toBe(3);
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
    // F1 (2026-07-10) — three possible event types now: manual_adjustment
    // (fulls), collection + reconciliation_empties_return (both for empties).
    expect(history.every((h) => h.eventType === 'manual_adjustment' || h.eventType === 'reconciliation_empties_return' || h.eventType === 'collection')).toBe(true);
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

describe('POST /api/orders/:id/apply-inventory-adjustment — role gate', () => {
  let app: Express;
  let financeToken: string;
  let inventoryToken: string;
  let customerToken: string;
  let ctId: string;

  beforeAll(async () => {
    app = createApp();
    financeToken = (await loginAsFinance()).token;
    inventoryToken = (await loginAsInventory()).token;
    customerToken = (await loginAsCustomer()).token;
    const ct = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: D1, isActive: true } });
    ctId = ct.id;
  });

  async function freshOrder() {
    const cust = await prisma.customer.create({
      data: {
        distributorId: D1,
        customerName: `RoleGateCust-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
        customerType: 'B2B', phone: '+919999999999', gstin: '29ABCDE1234F1Z5',
        billingAddressLine1: 'Test', billingState: 'Karnataka', billingPincode: '560001', billingCity: 'Bengaluru',
        status: 'active', creditPeriodDays: 30,
      },
      select: { id: true },
    });
    trackedCustomerIds.push(cust.id);
    const o = await prisma.order.create({
      data: {
        distributorId: D1, customerId: cust.id,
        orderNumber: `OBKROLE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
        orderDate: new Date('2099-08-15'),
        deliveryDate: new Date('2099-08-15'),
        deliveredAt: new Date('2099-08-15'),
        status: 'delivered', isBackdated: true, totalAmount: 1000,
        items: { create: [{ cylinderTypeId: ctId, quantity: 1, deliveredQuantity: 1, emptiesCollected: 0, unitPrice: 1000, totalPrice: 1000 }] },
      },
      select: { id: true },
    });
    trackedOrderIds.push(o.id);
    return o.id;
  }

  it('finance can close the billing loop — POST returns 200', async () => {
    const orderId = await freshOrder();
    const res = await request(app)
      .post(`/api/orders/${orderId}/apply-inventory-adjustment`)
      .set('Authorization', `Bearer ${financeToken}`)
      .send({});
    expect(res.status).toBe(200);
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { inventoryAdjustedAt: true } });
    expect(updated.inventoryAdjustedAt).not.toBeNull();
  });

  it('inventory role still allowed (regression) — POST returns 200', async () => {
    const orderId = await freshOrder();
    const res = await request(app)
      .post(`/api/orders/${orderId}/apply-inventory-adjustment`)
      .set('Authorization', `Bearer ${inventoryToken}`)
      .send({});
    expect(res.status).toBe(200);
  });

  it('customer role rejected with 403', async () => {
    const orderId = await freshOrder();
    const res = await request(app)
      .post(`/api/orders/${orderId}/apply-inventory-adjustment`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({});
    expect(res.status).toBe(403);
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
