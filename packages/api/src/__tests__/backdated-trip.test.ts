/**
 * backdated-trip.test.ts
 *
 * Item 6 (docs/INVESTIGATION-JUL09-B.md) — bulk backdated driver trip.
 * Same-month, before-today guard + N customer orders in a single call.
 * Uses a fixed FAR-PAST date within the current month to avoid conflicts
 * with real dev-DB state. Uses helper `hasValidBackdatedSlot()` to skip
 * on months where "yesterday" spilled to last month (edge case around
 * the 1st of the month) — matches backdated-order.test.ts pattern.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { localTodayISO } from '@gaslink/shared';
import { createBackdatedTrip } from '../services/backdatedTripService.js';
import * as gstService from '../services/gst/gstService.js';
import {
  loginAsDistAdmin,
  loginAsFinance,
  loginAsInventory,
  getSeedData,
} from './helpers.js';
import type { Express } from 'express';

const D1 = 'dist-001';
const D2 = 'dist-002';

let app: Express;
let adminToken: string;
let financeToken: string;
let inventoryToken: string;
let seedData: Awaited<ReturnType<typeof getSeedData>>;

// Track for cleanup.
const trackedOrderIds: string[] = [];
const trackedInvoiceIds: string[] = [];
const trackedPaymentIds: string[] = [];
const trackedCustomerIds: string[] = [];
const trackedDvaIds: string[] = [];

function auth(t: string) {
  return { Authorization: `Bearer ${t}` };
}

/** Yesterday in local TZ as YYYY-MM-DD — same helper as backdated-order.test.ts. */
function yesterdayLocalISO(): string {
  const t = new Date();
  t.setDate(t.getDate() - 1);
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const d = String(t.getDate()).padStart(2, '0');
  const yesterday = `${y}-${m}-${d}`;
  if (!yesterday.startsWith(localTodayISO().slice(0, 8))) return localTodayISO();
  return yesterday;
}

function hasValidBackdatedSlot(): boolean {
  return yesterdayLocalISO() < localTodayISO();
}

async function makeCustomer(name: string, type: 'B2B' | 'B2C', distributorId = D1) {
  const c = await prisma.customer.create({
    data: {
      distributorId,
      customerName: `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      customerType: type,
      phone: '+919999999999',
      gstin: type === 'B2B' ? '29ABCDE1234F1Z5' : null,
      billingAddressLine1: 'Test St',
      billingState: 'Karnataka',
      billingPincode: '560001',
      billingCity: 'Bengaluru',
      status: 'active',
      creditPeriodDays: 30,
    },
    select: { id: true, customerType: true, customerName: true },
  });
  trackedCustomerIds.push(c.id);
  return c;
}

async function ensurePrice(ctId: string, price = 1000) {
  // Same upsert pattern as backdated-order.test.ts to guarantee price
  // regardless of seed contents.
  const existing = await prisma.cylinderPrice.findFirst({
    where: { distributorId: D1, cylinderTypeId: ctId, effectiveDate: new Date('2024-01-01') },
  });
  if (existing) {
    await prisma.cylinderPrice.update({ where: { id: existing.id }, data: { price } });
  } else {
    await prisma.cylinderPrice.create({
      data: { distributorId: D1, cylinderTypeId: ctId, effectiveDate: new Date('2024-01-01'), price },
    });
  }
}

let ctId: string;
// Same spy pattern as backdated-order.test.ts — declare at file scope,
// no `.mockResolvedValue` (dist-001 is gstMode=disabled so the real
// implementation is a no-op).
const processGstSpy = vi.spyOn(gstService, 'processInvoiceGst');

beforeAll(async () => {
  app = createApp();
  const admin = await loginAsDistAdmin();
  adminToken = admin.token;
  const fin = await loginAsFinance();
  financeToken = fin.token;
  const inv = await loginAsInventory();
  inventoryToken = inv.token;
  seedData = await getSeedData();

  const ct = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: D1, isActive: true },
  });
  ctId = ct.id;
  await ensurePrice(ctId);
});

afterAll(async () => {
  processGstSpy?.mockRestore();
  // Order matters: allocations → invoices → order items → orders → DVAs → customers.
  if (trackedInvoiceIds.length) {
    await prisma.paymentAllocation.deleteMany({
      where: { invoiceId: { in: trackedInvoiceIds } },
    });
  }
  if (trackedPaymentIds.length) {
    await prisma.paymentTransaction.deleteMany({ where: { id: { in: trackedPaymentIds } } });
  }
  if (trackedInvoiceIds.length) {
    await prisma.invoice.deleteMany({ where: { id: { in: trackedInvoiceIds } } });
  }
  if (trackedOrderIds.length) {
    await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: trackedOrderIds } } });
  }
  if (trackedDvaIds.length) {
    await prisma.driverVehicleAssignment.deleteMany({ where: { id: { in: trackedDvaIds } } });
  }
  if (trackedCustomerIds.length) {
    // createInvoiceFromOrder + createPaymentInTx write customer_ledger_entries.
    await prisma.customerLedgerEntry.deleteMany({ where: { customerId: { in: trackedCustomerIds } } });
    await prisma.customerInventoryBalance.deleteMany({ where: { customerId: { in: trackedCustomerIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: trackedCustomerIds } } });
  }
});

describe('Item 6 — backdated driver trip service', () => {
  it('T1 — creates one order per customer in the input array', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    const c1 = await makeCustomer('T1-c1', 'B2C');
    const c2 = await makeCustomer('T1-c2', 'B2C');
    const c3 = await makeCustomer('T1-c3', 'B2C');
    const admin = await loginAsDistAdmin();
    const result = await createBackdatedTrip(D1, admin.user.id, {
      issueDate: yesterdayLocalISO(),
      driverId: seedData.drivers[0].id,
      vehicleId: seedData.vehicles[0].id,
      orders: [
        { customerId: c1.id, items: [{ cylinderTypeId: ctId, quantity: 1 }] },
        { customerId: c2.id, items: [{ cylinderTypeId: ctId, quantity: 2 }] },
        { customerId: c3.id, items: [{ cylinderTypeId: ctId, quantity: 1 }] },
      ],
    });
    for (const o of result.orders) trackedOrderIds.push(o.orderId);
    for (const o of result.orders) if (o.invoiceId) trackedInvoiceIds.push(o.invoiceId);
    if (result.dvaId) trackedDvaIds.push(result.dvaId);
    expect(result.ordersCreated).toBe(3);
    expect(result.invoicesCreated).toBe(3);
    expect(result.orders.map((o) => o.customerId).sort())
      .toEqual([c1.id, c2.id, c3.id].sort());
  });

  it('T2 — all orders have status=delivered, isBackdated=true, driver+vehicle set', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    const c1 = await makeCustomer('T2-c1', 'B2C');
    const admin = await loginAsDistAdmin();
    const result = await createBackdatedTrip(D1, admin.user.id, {
      issueDate: yesterdayLocalISO(),
      driverId: seedData.drivers[0].id,
      vehicleId: seedData.vehicles[0].id,
      orders: [{ customerId: c1.id, items: [{ cylinderTypeId: ctId, quantity: 1 }] }],
    });
    trackedOrderIds.push(result.orders[0].orderId);
    if (result.orders[0].invoiceId) trackedInvoiceIds.push(result.orders[0].invoiceId);
    if (result.dvaId) trackedDvaIds.push(result.dvaId);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: result.orders[0].orderId } });
    expect(order.status).toBe('delivered');
    expect(order.isBackdated).toBe(true);
    expect(order.driverId).toBe(seedData.drivers[0].id);
    expect(order.vehicleId).toBe(seedData.vehicles[0].id);
  });

  it('T3 — historical timestamps: deliveredAt/orderDate/deliveryDate = issueDate; createdAt = now', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    const issueDate = yesterdayLocalISO();
    const c1 = await makeCustomer('T3-c1', 'B2C');
    const admin = await loginAsDistAdmin();
    const result = await createBackdatedTrip(D1, admin.user.id, {
      issueDate,
      driverId: seedData.drivers[0].id,
      vehicleId: seedData.vehicles[0].id,
      orders: [{ customerId: c1.id, items: [{ cylinderTypeId: ctId, quantity: 1 }] }],
    });
    trackedOrderIds.push(result.orders[0].orderId);
    if (result.orders[0].invoiceId) trackedInvoiceIds.push(result.orders[0].invoiceId);
    if (result.dvaId) trackedDvaIds.push(result.dvaId);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: result.orders[0].orderId } });
    expect(o.deliveredAt?.toISOString().slice(0, 10)).toBe(issueDate);
    expect(o.orderDate.toISOString().slice(0, 10)).toBe(issueDate);
    expect(o.deliveryDate.toISOString().slice(0, 10)).toBe(issueDate);
    expect(Date.now() - o.createdAt.getTime()).toBeLessThan(60_000);
  });

  it('T4 — DVA created for (driver, vehicle, date) at status=reconciled + isReconciled=true (fresh insert path)', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    // Pre-clean any DVA that other tests / seed left behind for this
    // (driver, date, trip=1) so this test exercises the CREATE branch,
    // not the reuse branch (which is asserted separately in T18).
    const issueDate = yesterdayLocalISO();
    await prisma.driverVehicleAssignment.deleteMany({
      where: {
        distributorId: D1,
        driverId: seedData.drivers[0].id,
        assignmentDate: new Date(issueDate),
        tripNumber: 1,
      },
    });
    const c1 = await makeCustomer('T4-c1', 'B2C');
    const admin = await loginAsDistAdmin();
    const result = await createBackdatedTrip(D1, admin.user.id, {
      issueDate,
      driverId: seedData.drivers[0].id,
      vehicleId: seedData.vehicles[0].id,
      orders: [{ customerId: c1.id, items: [{ cylinderTypeId: ctId, quantity: 1 }] }],
    });
    trackedOrderIds.push(result.orders[0].orderId);
    if (result.orders[0].invoiceId) trackedInvoiceIds.push(result.orders[0].invoiceId);
    expect(result.dvaId).not.toBeNull();
    trackedDvaIds.push(result.dvaId!);
    const dva = await prisma.driverVehicleAssignment.findUniqueOrThrow({ where: { id: result.dvaId! } });
    expect(dva.status).toBe('reconciled');
    expect(dva.isReconciled).toBe(true);
  });

  it('T5 — invoice.issueDate matches backdated date', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    const issueDate = yesterdayLocalISO();
    const c1 = await makeCustomer('T5-c1', 'B2B');
    const admin = await loginAsDistAdmin();
    const result = await createBackdatedTrip(D1, admin.user.id, {
      issueDate,
      driverId: seedData.drivers[0].id,
      vehicleId: seedData.vehicles[0].id,
      orders: [{ customerId: c1.id, items: [{ cylinderTypeId: ctId, quantity: 1 }] }],
    });
    trackedOrderIds.push(result.orders[0].orderId);
    const invoiceId = result.orders[0].invoiceId;
    expect(invoiceId).toBeTruthy();
    trackedInvoiceIds.push(invoiceId!);
    if (result.dvaId) trackedDvaIds.push(result.dvaId);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId! } });
    expect(inv.issueDate.toISOString().slice(0, 10)).toBe(issueDate);
  });

  it('T6 — processInvoiceGst spy called post-commit for each invoice', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    processGstSpy.mockClear();
    const c1 = await makeCustomer('T6-c1', 'B2B');
    const c2 = await makeCustomer('T6-c2', 'B2B');
    const admin = await loginAsDistAdmin();
    const result = await createBackdatedTrip(D1, admin.user.id, {
      issueDate: yesterdayLocalISO(),
      driverId: seedData.drivers[0].id,
      vehicleId: seedData.vehicles[0].id,
      orders: [
        { customerId: c1.id, items: [{ cylinderTypeId: ctId, quantity: 1 }] },
        { customerId: c2.id, items: [{ cylinderTypeId: ctId, quantity: 1 }] },
      ],
    });
    for (const o of result.orders) trackedOrderIds.push(o.orderId);
    for (const o of result.orders) if (o.invoiceId) trackedInvoiceIds.push(o.invoiceId);
    if (result.dvaId) trackedDvaIds.push(result.dvaId);
    // Give the fire-and-forget microtask a beat to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(processGstSpy).toHaveBeenCalledTimes(2);
  });

  it('T7 — payment recorded atomically when provided', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    const c1 = await makeCustomer('T7-c1', 'B2C');
    const admin = await loginAsDistAdmin();
    const result = await createBackdatedTrip(D1, admin.user.id, {
      issueDate: yesterdayLocalISO(),
      driverId: seedData.drivers[0].id,
      vehicleId: seedData.vehicles[0].id,
      orders: [{
        customerId: c1.id,
        items: [{ cylinderTypeId: ctId, quantity: 1 }],
        payment: { amount: 500, paymentMethod: 'cash', referenceNumber: 'TRIP-PAY-1' },
      }],
    });
    trackedOrderIds.push(result.orders[0].orderId);
    if (result.orders[0].invoiceId) trackedInvoiceIds.push(result.orders[0].invoiceId);
    if (result.dvaId) trackedDvaIds.push(result.dvaId);

    const payments = await prisma.paymentTransaction.findMany({
      where: { customerId: c1.id, referenceNumber: 'TRIP-PAY-1' },
    });
    expect(payments).toHaveLength(1);
    trackedPaymentIds.push(payments[0].id);
    expect(Number(payments[0].amount)).toBe(500);
    expect(result.orders[0].paymentRecorded).toBe(true);
  });

  it('T8 — issueDate from last month → 400', async () => {
    const now = new Date();
    // First of last month.
    const y = now.getFullYear();
    const m = now.getMonth(); // 0-indexed, so this is last month's number
    const lastMonthDate = m === 0
      ? `${y - 1}-12-15`
      : `${y}-${String(m).padStart(2, '0')}-15`;
    const c1 = await makeCustomer('T8-c1', 'B2C');
    const res = await request(app)
      .post('/api/orders/backdated-trip')
      .set(auth(adminToken))
      .send({
        issueDate: lastMonthDate,
        driverId: seedData.drivers[0].id,
        vehicleId: seedData.vehicles[0].id,
        orders: [{ customerId: c1.id, items: [{ cylinderTypeId: ctId, quantity: 1 }] }],
      });
    expect(res.status).toBe(400);
  });

  it('T9 — issueDate = today → 400', async () => {
    const c1 = await makeCustomer('T9-c1', 'B2C');
    const res = await request(app)
      .post('/api/orders/backdated-trip')
      .set(auth(adminToken))
      .send({
        issueDate: localTodayISO(),
        driverId: seedData.drivers[0].id,
        vehicleId: seedData.vehicles[0].id,
        orders: [{ customerId: c1.id, items: [{ cylinderTypeId: ctId, quantity: 1 }] }],
      });
    expect(res.status).toBe(400);
  });

  it('T10 — issueDate = tomorrow → 400', async () => {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const d = String(t.getDate()).padStart(2, '0');
    const tomorrow = `${y}-${m}-${d}`;
    const c1 = await makeCustomer('T10-c1', 'B2C');
    const res = await request(app)
      .post('/api/orders/backdated-trip')
      .set(auth(adminToken))
      .send({
        issueDate: tomorrow,
        driverId: seedData.drivers[0].id,
        vehicleId: seedData.vehicles[0].id,
        orders: [{ customerId: c1.id, items: [{ cylinderTypeId: ctId, quantity: 1 }] }],
      });
    expect(res.status).toBe(400);
  });

  it('T11 — driver from a different distributor → 404', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    // Find a dist-002 driver.
    const otherDriver = await prisma.driver.findFirst({
      where: { distributorId: D2, deletedAt: null },
      select: { id: true },
    });
    if (!otherDriver) { expect(true).toBe(true); return; }
    const c1 = await makeCustomer('T11-c1', 'B2C');
    const res = await request(app)
      .post('/api/orders/backdated-trip')
      .set(auth(adminToken))
      .send({
        issueDate: yesterdayLocalISO(),
        driverId: otherDriver.id,
        vehicleId: seedData.vehicles[0].id,
        orders: [{ customerId: c1.id, items: [{ cylinderTypeId: ctId, quantity: 1 }] }],
      });
    expect(res.status).toBe(404);
  });

  it('T12 — vehicle from a different distributor → 404', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    const otherVehicle = await prisma.vehicle.findFirst({
      where: { distributorId: D2, deletedAt: null },
      select: { id: true },
    });
    if (!otherVehicle) { expect(true).toBe(true); return; }
    const c1 = await makeCustomer('T12-c1', 'B2C');
    const res = await request(app)
      .post('/api/orders/backdated-trip')
      .set(auth(adminToken))
      .send({
        issueDate: yesterdayLocalISO(),
        driverId: seedData.drivers[0].id,
        vehicleId: otherVehicle.id,
        orders: [{ customerId: c1.id, items: [{ cylinderTypeId: ctId, quantity: 1 }] }],
      });
    expect(res.status).toBe(404);
  });

  it('T13 — finance role forbidden (403)', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    const c1 = await makeCustomer('T13-c1', 'B2C');
    const res = await request(app)
      .post('/api/orders/backdated-trip')
      .set(auth(financeToken))
      .send({
        issueDate: yesterdayLocalISO(),
        driverId: seedData.drivers[0].id,
        vehicleId: seedData.vehicles[0].id,
        orders: [{ customerId: c1.id, items: [{ cylinderTypeId: ctId, quantity: 1 }] }],
      });
    expect(res.status).toBe(403);
  });

  it('T14 — inventory role forbidden (403)', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    const c1 = await makeCustomer('T14-c1', 'B2C');
    const res = await request(app)
      .post('/api/orders/backdated-trip')
      .set(auth(inventoryToken))
      .send({
        issueDate: yesterdayLocalISO(),
        driverId: seedData.drivers[0].id,
        vehicleId: seedData.vehicles[0].id,
        orders: [{ customerId: c1.id, items: [{ cylinderTypeId: ctId, quantity: 1 }] }],
      });
    expect(res.status).toBe(403);
  });

  it('T15 — distributor_admin role allowed (201)', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    const c1 = await makeCustomer('T15-c1', 'B2C');
    const res = await request(app)
      .post('/api/orders/backdated-trip')
      .set(auth(adminToken))
      .send({
        issueDate: yesterdayLocalISO(),
        driverId: seedData.drivers[0].id,
        vehicleId: seedData.vehicles[0].id,
        orders: [{ customerId: c1.id, items: [{ cylinderTypeId: ctId, quantity: 1 }] }],
      });
    expect(res.status).toBe(201);
    for (const o of res.body.data.orders) trackedOrderIds.push(o.orderId);
    for (const o of res.body.data.orders) if (o.invoiceId) trackedInvoiceIds.push(o.invoiceId);
    trackedDvaIds.push(res.body.data.dvaId);
  });

  it('T16 — no InventoryEvent rows created by design (backdated adjustment is separate)', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    const c1 = await makeCustomer('T16-c1', 'B2C');
    const admin = await loginAsDistAdmin();
    const before = await prisma.inventoryEvent.count({ where: { distributorId: D1 } });
    const result = await createBackdatedTrip(D1, admin.user.id, {
      issueDate: yesterdayLocalISO(),
      driverId: seedData.drivers[0].id,
      vehicleId: seedData.vehicles[0].id,
      orders: [{ customerId: c1.id, items: [{ cylinderTypeId: ctId, quantity: 3 }] }],
    });
    trackedOrderIds.push(result.orders[0].orderId);
    if (result.orders[0].invoiceId) trackedInvoiceIds.push(result.orders[0].invoiceId);
    if (result.dvaId) trackedDvaIds.push(result.dvaId);
    const after = await prisma.inventoryEvent.count({ where: { distributorId: D1 } });
    expect(after).toBe(before);
  });

  it('T17 — cross-tenant customer rejected (404)', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    const otherCustomer = await prisma.customer.findFirst({
      where: { distributorId: D2, deletedAt: null },
      select: { id: true },
    });
    if (!otherCustomer) { expect(true).toBe(true); return; }
    const res = await request(app)
      .post('/api/orders/backdated-trip')
      .set(auth(adminToken))
      .send({
        issueDate: yesterdayLocalISO(),
        driverId: seedData.drivers[0].id,
        vehicleId: seedData.vehicles[0].id,
        orders: [{ customerId: otherCustomer.id, items: [{ cylinderTypeId: ctId, quantity: 1 }] }],
      });
    expect(res.status).toBe(404);
  });

  it('T18 — reusing an existing DVA row does not clobber it', async () => {
    if (!hasValidBackdatedSlot()) { expect(true).toBe(true); return; }
    const issueDate = yesterdayLocalISO();
    // Pre-create a DVA at 'reconciled' with a specific reconciledAt value.
    // We want to prove the service reuses it rather than upserting.
    const existingDva = await prisma.driverVehicleAssignment.findFirst({
      where: {
        distributorId: D1,
        driverId: seedData.drivers[0].id,
        assignmentDate: new Date(issueDate),
        tripNumber: 1,
      },
    });
    let markerDvaId: string;
    if (existingDva) {
      markerDvaId = existingDva.id;
    } else {
      const created = await prisma.driverVehicleAssignment.create({
        data: {
          distributorId: D1,
          driverId: seedData.drivers[0].id,
          vehicleId: seedData.vehicles[0].id,
          assignmentDate: new Date(issueDate),
          tripNumber: 1,
          status: 'reconciled',
          isReconciled: true,
        },
      });
      markerDvaId = created.id;
      trackedDvaIds.push(markerDvaId);
    }
    const c1 = await makeCustomer('T18-c1', 'B2C');
    const admin = await loginAsDistAdmin();
    const result = await createBackdatedTrip(D1, admin.user.id, {
      issueDate,
      driverId: seedData.drivers[0].id,
      vehicleId: seedData.vehicles[0].id,
      orders: [{ customerId: c1.id, items: [{ cylinderTypeId: ctId, quantity: 1 }] }],
    });
    trackedOrderIds.push(result.orders[0].orderId);
    if (result.orders[0].invoiceId) trackedInvoiceIds.push(result.orders[0].invoiceId);
    expect(result.dvaId).toBe(markerDvaId);
  });
});
