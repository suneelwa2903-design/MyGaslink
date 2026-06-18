import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { generateToken, loginAsDistAdmin, today } from './helpers.js';
import { prisma } from '../lib/prisma.js';
import { UserRole } from '@gaslink/shared';
import type { Express } from 'express';
import type { $Enums } from '@prisma/client';

let app: Express;
let customerToken: string;
let customerId: string;
let distributorId: string;
let adminToken: string;

beforeAll(async () => {
  app = createApp();
  const admin = await loginAsDistAdmin();
  adminToken = admin.token;

  // Find a B2B customer from dist-001 and create a user account for it.
  // 2026-06-18: `deletedAt: null` is required because the dev DB has leftover
  // ZZTEST_CSU soft-deleted customers from customer-status-update test runs.
  // Without the filter findFirst would silently pick one, generate a token
  // for a deleted customer id, and every portal endpoint returns 404.
  // Adding `status: 'active'` as well so we never pick a stop-supply customer
  // whose dashboard short-circuits with `supplyStopped: true` and breaks
  // the wire-shape assertions further down.
  const customer = await prisma.customer.findFirst({
    where: {
      distributorId: 'dist-001',
      customerType: 'B2B',
      deletedAt: null,
      status: 'active',
    },
    orderBy: { createdAt: 'asc' },
  });
  if (!customer) throw new Error('No active B2B customer found in dist-001 seed');
  customerId = customer.id;
  distributorId = customer.distributorId;

  // Check if customer user exists, create if not
  let customerUser = await prisma.user.findFirst({
    where: { customerId: customer.id },
  });
  if (!customerUser) {
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.default.hash('Customer@123', 12);
    customerUser = await prisma.user.create({
      data: {
        email: `customer-test-${customer.id.slice(0, 8)}@test.com`,
        passwordHash: hash,
        firstName: customer.customerName,
        lastName: 'Portal',
        phone: customer.phone || '9999999990',
        role: UserRole.CUSTOMER,
        status: 'active',
        provisioningStatus: 'active',
        distributorId: customer.distributorId,
        customerId: customer.id,
        requiresPasswordReset: false,
      },
    });
  }

  customerToken = generateToken({
    userId: customerUser.id,
    email: customerUser.email,
    role: UserRole.CUSTOMER,
    distributorId: customer.distributorId,
    customerId: customer.id,
  });
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('Customer Portal - Dashboard', () => {
  it('should return customer dashboard', async () => {
    const res = await request(app)
      .get('/api/customer-portal/dashboard')
      .set(auth(customerToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
  });

  // WI-118 wire-shape guard (anti-pattern #9): the mobile dashboard reads
  // these exact field names/types. A mismatch silently renders zeros — the
  // bug this WI fixed. Assert the contract so it can't regress.
  it('dashboard response has the exact field names + types the mobile screen reads', async () => {
    const res = await request(app)
      .get('/api/customer-portal/dashboard')
      .set(auth(customerToken));

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(typeof d.outstandingAmount).toBe('number');
    expect(typeof d.overdueAmount).toBe('number');
    expect(typeof d.totalOrders).toBe('number');
    expect(typeof d.pendingOrders).toBe('number');
    expect(typeof d.emptyCylinders).toBe('number');
    expect(Array.isArray(d.recentOrders)).toBe(true);
    expect(Array.isArray(d.cylinderTypes)).toBe(true);
    // WI-123: per-type empties breakdown for the dashboard card.
    expect(Array.isArray(d.emptiesByType)).toBe(true);
    // Legacy field names must be gone (these caused the silent-zero bug).
    expect(d.amountOutstanding).toBeUndefined();
    expect(d.ordersPending).toBeUndefined();
    // cylinderTypes feed the New Order modal — shape { id, typeName, capacity, latestPrice }.
    if (d.cylinderTypes.length > 0) {
      const ct = d.cylinderTypes[0];
      expect(typeof ct.id).toBe('string');
      expect(typeof ct.typeName).toBe('string');
      expect(typeof ct.capacity).toBe('number');
      expect(typeof ct.latestPrice).toBe('number');
    }
    // recentOrders shape { orderId, orderNumber, status, deliveryDate, totalAmount }.
    if (d.recentOrders.length > 0) {
      const o = d.recentOrders[0];
      expect(typeof o.orderId).toBe('string');
      expect(typeof o.orderNumber).toBe('string');
      expect(typeof o.status).toBe('string');
      expect(typeof o.totalAmount).toBe('number');
    }
  });

  it('orders endpoint accepts a comma-separated status list (delivered,modified_delivered)', async () => {
    const res = await request(app)
      .get('/api/customer-portal/orders')
      .query({ status: 'delivered,modified_delivered' })
      .set(auth(customerToken));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.orders)).toBe(true);
    for (const o of res.body.data.orders) {
      expect(['delivered', 'modified_delivered']).toContain(o.status);
    }
  });
});

describe('Customer Portal - Orders', () => {
  it('should list customer orders', async () => {
    const res = await request(app)
      .get('/api/customer-portal/orders')
      .set(auth(customerToken));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.orders)).toBe(true);
  });

  it('should create an order through portal', async () => {
    const cylTypes = await prisma.cylinderType.findMany({
      where: { distributorId },
    });
    const cyl = cylTypes[0];

    const res = await request(app)
      .post('/api/customer-portal/orders')
      .set(auth(customerToken))
      .send({
        // TZ fix (2026-06-12): use the local-TZ helpers.today() instead of
        // UTC `new Date().toISOString().split('T')[0]`. The API validates
        // deliveryDate against local-TZ midnight (customerPortalService.ts
        // setHours(0,0,0,0)). Between 18:30 UTC and 23:59 UTC the UTC
        // calendar date lags one day behind IST, so the UTC string fails
        // the "today / tomorrow" guard with a 400 — deterministic, not a
        // flake. The same fix landed in helpers.ts and customer-portal-
        // order-modify.test.ts in commit 4300e07 but skipped this file.
        deliveryDate: today(),
        items: [{ cylinderTypeId: cyl.id, quantity: 2 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.orderId).toBeDefined();
  });

  it('should deny admin from accessing customer portal', async () => {
    const res = await request(app)
      .get('/api/customer-portal/dashboard')
      .set(auth(adminToken));

    expect(res.status).toBe(403);
  });
});

describe('Customer Portal - Dashboard date range (WI-121)', () => {
  it('no params → defaults to the current month and returns activity + balance fields', async () => {
    const res = await request(app)
      .get('/api/customer-portal/dashboard')
      .set(auth(customerToken));

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.range).toBeDefined();
    const firstOfMonth = new Date();
    firstOfMonth.setDate(1);
    expect(new Date(d.range.from).getMonth()).toBe(firstOfMonth.getMonth());
    expect(typeof d.totalOrders).toBe('number');
    expect(typeof d.ordersDelivered).toBe('number');
    expect(typeof d.amountDelivered).toBe('number');
    expect(typeof d.paymentsReceived).toBe('number');
  });

  it('a far-past range yields zero activity but unchanged balances', async () => {
    const dflt = (await request(app)
      .get('/api/customer-portal/dashboard')
      .set(auth(customerToken))).body.data;

    const past = (await request(app)
      .get('/api/customer-portal/dashboard')
      .query({ from: '1990-01-01', to: '1990-01-31' })
      .set(auth(customerToken))).body.data;

    // Activity metrics scoped to 1990 → zero.
    expect(past.totalOrders).toBe(0);
    expect(past.ordersDelivered).toBe(0);
    expect(past.amountDelivered).toBe(0);
    expect(past.paymentsReceived).toBe(0);

    // Balance/state metrics ignore the range — identical to the default call.
    expect(past.outstandingAmount).toBe(dflt.outstandingAmount);
    expect(past.overdueAmount).toBe(dflt.overdueAmount);
    expect(past.emptyCylinders).toBe(dflt.emptyCylinders);
    expect(past.pendingOrders).toBe(dflt.pendingOrders);
  });
});

describe('Customer Portal - Date filters (WI-124)', () => {
  it('orders: far-past range returns none; wide range keeps every row within deliveryDate bounds', async () => {
    const none = await request(app)
      .get('/api/customer-portal/orders').query({ from: '1990-01-01', to: '1990-12-31' })
      .set(auth(customerToken));
    expect(none.status).toBe(200);
    expect(none.body.data.orders.length).toBe(0);

    const wide = await request(app)
      .get('/api/customer-portal/orders').query({ from: '2000-01-01', to: '2100-01-01' })
      .set(auth(customerToken));
    expect(wide.status).toBe(200);
    for (const o of wide.body.data.orders) {
      const d = new Date(o.deliveryDate).getTime();
      expect(d).toBeGreaterThanOrEqual(new Date('2000-01-01').getTime());
      expect(d).toBeLessThanOrEqual(new Date('2100-01-01T23:59:59.999Z').getTime());
    }
  });

  it('invoices: far-past range returns none; wide range keeps every row within issueDate bounds', async () => {
    const none = await request(app)
      .get('/api/customer-portal/invoices').query({ from: '1990-01-01', to: '1990-12-31' })
      .set(auth(customerToken));
    expect(none.status).toBe(200);
    expect(none.body.data.invoices.length).toBe(0);

    const wide = await request(app)
      .get('/api/customer-portal/invoices').query({ from: '2000-01-01', to: '2100-01-01' })
      .set(auth(customerToken));
    expect(wide.status).toBe(200);
    for (const inv of wide.body.data.invoices) {
      const d = new Date(inv.issueDate).getTime();
      expect(d).toBeGreaterThanOrEqual(new Date('2000-01-01').getTime());
    }
  });

  it('payments: far-past range returns none', async () => {
    const none = await request(app)
      .get('/api/customer-portal/payments').query({ from: '1990-01-01', to: '1990-12-31' })
      .set(auth(customerToken));
    expect(none.status).toBe(200);
    expect(none.body.data.payments.length).toBe(0);
  });
});

describe('Customer Portal - Invoice PDF download (WI-126)', () => {
  let ctId: string;
  let deliveredInvoiceId: string;
  let cancelledInvoiceId: string;
  let pendingOrderInvoiceId: string;
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];

  async function makeOrder(status: $Enums.OrderStatus) {
    const far = new Date('2099-12-31');
    const o = await prisma.order.create({
      data: {
        orderNumber: `TEST-WI126-${status}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        distributorId, customerId, orderDate: far, deliveryDate: far,
        status, totalAmount: 1180,
      },
    });
    orderIds.push(o.id);
    return o;
  }
  async function makeInvoice(orderId: string, status: $Enums.InvoiceStatus) {
    const far = new Date('2099-12-31');
    const inv = await prisma.invoice.create({
      data: {
        invoiceNumber: `TEST-INV-WI126-${status}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        distributorId, customerId, orderId, issueDate: far, dueDate: far,
        status, totalAmount: 1180, outstandingAmount: status === 'cancelled' ? 0 : 1180,
        items: { create: [{ cylinderTypeId: ctId, description: 'Test cyl', quantity: 1, unitPrice: 1000, totalPrice: 1180 }] },
      },
    });
    invoiceIds.push(inv.id);
    return inv;
  }

  beforeAll(async () => {
    const ct = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId, isActive: true } });
    ctId = ct.id;
    const delivered = await makeOrder('delivered');
    deliveredInvoiceId = (await makeInvoice(delivered.id, 'issued')).id;
    const cancelledOrder = await makeOrder('delivered');
    cancelledInvoiceId = (await makeInvoice(cancelledOrder.id, 'cancelled')).id;
    const pendingOrder = await makeOrder('pending_dispatch');
    pendingOrderInvoiceId = (await makeInvoice(pendingOrder.id, 'issued')).id;
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  });

  it('invoice list response includes orderStatus', async () => {
    const res = await request(app)
      .get('/api/customer-portal/invoices').query({ from: '2099-01-01', to: '2099-12-31' })
      .set(auth(customerToken));
    expect(res.status).toBe(200);
    const row = res.body.data.invoices.find((i: { invoiceId: string }) => i.invoiceId === deliveredInvoiceId);
    expect(row).toBeDefined();
    expect(row.orderStatus).toBe('delivered');
  });

  it('serves a PDF for an issued invoice on a delivered order', async () => {
    const res = await request(app)
      .get(`/api/customer-portal/invoices/${deliveredInvoiceId}/pdf`)
      .set(auth(customerToken));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  it('refuses the PDF for a cancelled invoice (403)', async () => {
    const res = await request(app)
      .get(`/api/customer-portal/invoices/${cancelledInvoiceId}/pdf`)
      .set(auth(customerToken));
    expect(res.status).toBe(403);
  });

  // 2026-06-15: the order-status gate has been re-introduced, but now
  // carved correctly. OB invoices (orderId: null) and historical
  // delivered/cancelled invoices stay accessible; only in-flight
  // orders block the PDF. This invariant is also pinned by
  // customer-portal-invoice-visibility.test.ts. Was P0-2's "always
  // allow" — that allowed customers to download invoices that could
  // still change at delivery, contrary to the operator's stated rule
  // ("invoice subject to change until delivered").
  it('refuses the PDF when the linked order is still in-flight (pending_dispatch / pending_delivery)', async () => {
    const res = await request(app)
      .get(`/api/customer-portal/invoices/${pendingOrderInvoiceId}/pdf`)
      .set(auth(customerToken));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/will be available once your order is delivered/i);
  });
});

describe('Customer Portal - Dispute lifecycle (WI-127)', () => {
  const far = new Date('2099-12-31');
  let lifecycleOrderId: string;
  let pendingOrderId: string;
  let creditOrderId: string;
  let creditInvoiceId: string;
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];

  beforeAll(async () => {
    const mk = async (status: $Enums.OrderStatus) => {
      const o = await prisma.order.create({
        data: {
          orderNumber: `TEST-WI127-${status}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          distributorId, customerId, orderDate: far, deliveryDate: far, deliveredAt: far,
          status, totalAmount: 1180,
        },
      });
      orderIds.push(o.id);
      return o.id;
    };
    lifecycleOrderId = await mk('delivered');
    pendingOrderId = await mk('pending_dispatch');
    creditOrderId = await mk('delivered');
    const inv = await prisma.invoice.create({
      data: {
        invoiceNumber: `TEST-INV-WI127-${Date.now()}`,
        distributorId, customerId, orderId: creditOrderId, issueDate: far, dueDate: far,
        status: 'issued', totalAmount: 1180, outstandingAmount: 1180,
      },
    });
    creditInvoiceId = inv.id;
    invoiceIds.push(inv.id);
  });

  afterAll(async () => {
    await prisma.creditNote.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.pendingAction.deleteMany({ where: { entityType: 'order', entityId: { in: orderIds } } });
    await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  });

  it('raises a dispute on a delivered order + creates a CUSTOMER_DISPUTE action', async () => {
    const res = await request(app)
      .post(`/api/customer-portal/orders/${lifecycleOrderId}/dispute`)
      .set(auth(customerToken)).send({ reason: 'Short by 2 cylinders' });
    expect(res.status).toBe(200);
    expect(res.body.data.disputeRaisedAt).toBeTruthy();

    const action = await prisma.pendingAction.findFirst({
      where: { entityType: 'order', entityId: lifecycleOrderId, actionType: 'CUSTOMER_DISPUTE', status: 'open' },
    });
    expect(action).not.toBeNull();
  });

  it('409 when a dispute is already open', async () => {
    const res = await request(app)
      .post(`/api/customer-portal/orders/${lifecycleOrderId}/dispute`)
      .set(auth(customerToken)).send({ reason: 'again' });
    expect(res.status).toBe(409);
  });

  it('400 on a non-delivered order', async () => {
    const res = await request(app)
      .post(`/api/customer-portal/orders/${pendingOrderId}/dispute`)
      .set(auth(customerToken)).send({ reason: 'too early' });
    expect(res.status).toBe(400);
  });

  it('404 on an order that is not this customer’s', async () => {
    const res = await request(app)
      .post(`/api/customer-portal/orders/00000000-0000-0000-0000-000000000000/dispute`)
      .set(auth(customerToken)).send({ reason: 'nope' });
    expect(res.status).toBe(404);
  });

  it('admin resolves with a note → disputeResolvedAt + action resolved', async () => {
    const res = await request(app)
      .post(`/api/orders/${lifecycleOrderId}/resolve-dispute`)
      .set(auth(adminToken)).send({ resolutionNote: 'Verified delivery, no shortage.' });
    expect(res.status).toBe(200);
    expect(res.body.data.resolvedAt).toBeTruthy();

    const order = await prisma.order.findUnique({ where: { id: lifecycleOrderId } });
    expect(order?.disputeResolvedAt).not.toBeNull();
    expect(order?.disputeResolutionNote).toContain('Verified');
    const action = await prisma.pendingAction.findFirst({
      where: { entityType: 'order', entityId: lifecycleOrderId, actionType: 'CUSTOMER_DISPUTE' },
    });
    expect(action?.status).toBe('resolved');
  });

  it('customer can reopen once after resolution', async () => {
    const res = await request(app)
      .post(`/api/customer-portal/orders/${lifecycleOrderId}/dispute`)
      .set(auth(customerToken)).send({ reason: 'Still disagree' });
    expect(res.status).toBe(200);
    const order = await prisma.order.findUnique({ where: { id: lifecycleOrderId } });
    expect(order?.disputeReopenedAt).not.toBeNull();
    expect(order?.disputeResolvedAt).toBeNull();
  });

  it('blocks a second reopen (409)', async () => {
    // resolve the reopened dispute first
    await request(app)
      .post(`/api/orders/${lifecycleOrderId}/resolve-dispute`)
      .set(auth(adminToken)).send({ resolutionNote: 'Final: closed.' });
    const res = await request(app)
      .post(`/api/customer-portal/orders/${lifecycleOrderId}/dispute`)
      .set(auth(customerToken)).send({ reason: 'third time' });
    expect(res.status).toBe(409);
  });

  it('admin resolves with a credit note → CN created/approved + outstanding reduced', async () => {
    await request(app)
      .post(`/api/customer-portal/orders/${creditOrderId}/dispute`)
      .set(auth(customerToken)).send({ reason: 'Overcharged' });
    const res = await request(app)
      .post(`/api/orders/${creditOrderId}/resolve-dispute`)
      .set(auth(adminToken))
      .send({ resolutionNote: 'Agreed — partial credit.', issueCreditNote: true, creditNoteAmount: 500, creditNoteReason: 'Dispute settlement' });
    expect(res.status).toBe(200);
    expect(res.body.data.creditNoteId).toBeTruthy();

    const inv = await prisma.invoice.findUnique({ where: { id: creditInvoiceId } });
    expect(Number(inv?.outstandingAmount)).toBe(680);
    const order = await prisma.order.findUnique({ where: { id: creditOrderId } });
    expect(order?.disputeResolutionNote).toContain('Credit note of ₹500 issued');
  });
});

describe('Customer Portal - Cancelled invoice outstanding (WI-123)', () => {
  let orderId: string;
  let invoiceId: string;

  beforeAll(async () => {
    const far = new Date('2099-12-31');
    const order = await prisma.order.create({
      data: {
        orderNumber: `TEST-WI123-${Date.now()}`,
        distributorId, customerId,
        orderDate: far, deliveryDate: far,
        status: 'pending_driver_assignment', totalAmount: 5000,
      },
    });
    orderId = order.id;
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `TEST-INV-WI123-${Date.now()}`,
        distributorId, customerId, orderId: order.id,
        issueDate: far, dueDate: far,
        status: 'issued', totalAmount: 5000, outstandingAmount: 5000,
      },
    });
    invoiceId = invoice.id;
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { id: invoiceId } });
    await prisma.order.deleteMany({ where: { id: orderId } });
  });

  it('zeroes the invoice outstanding when the order is cancelled', async () => {
    const cancel = await request(app)
      .patch(`/api/customer-portal/orders/${orderId}/cancel`)
      .set(auth(customerToken));
    expect(cancel.status).toBe(200);

    const res = await request(app)
      .get(`/api/customer-portal/invoices/${invoiceId}`)
      .set(auth(customerToken));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
    expect(res.body.data.outstandingAmount).toBe(0);
  });
});

describe('Customer Portal dashboard - empties unfiltered (FIX 3)', () => {
  it('emptiesByType returns ALL balances and emptyCylinders = their full sum (incl. negatives)', async () => {
    const res = await request(app).get('/api/customer-portal/dashboard').set(auth(customerToken));
    expect(res.status).toBe(200);
    const allBalances = await prisma.customerInventoryBalance.findMany({ where: { customerId } });
    // emptiesByType must not be positive-filtered: one entry per balance row.
    expect(res.body.data.emptiesByType.length).toBe(allBalances.length);
    // headline total must equal the sum of ALL balances, including any negatives.
    const sum = allBalances.reduce((s, b) => s + b.withCustomerQty, 0);
    expect(res.body.data.emptyCylinders).toBe(sum);
  });
});

describe('Customer Portal - cancel gate tightened to pre-driver-assignment', () => {
  const far = new Date('2099-12-31');
  let preAssignId: string;
  let dispatchedId: string;

  beforeAll(async () => {
    const a = await prisma.order.create({ data: { orderNumber: `TEST-CG-A-${Date.now()}`, distributorId, customerId, orderDate: far, deliveryDate: far, status: 'pending_driver_assignment', totalAmount: 1000 } });
    const b = await prisma.order.create({ data: { orderNumber: `TEST-CG-B-${Date.now()}`, distributorId, customerId, orderDate: far, deliveryDate: far, status: 'pending_dispatch', totalAmount: 1000 } });
    preAssignId = a.id; dispatchedId = b.id;
  });
  afterAll(async () => {
    await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: [preAssignId, dispatchedId] } } });
    await prisma.order.deleteMany({ where: { id: { in: [preAssignId, dispatchedId] } } });
  });

  it('allows cancel while pending_driver_assignment (200)', async () => {
    const res = await request(app).patch(`/api/customer-portal/orders/${preAssignId}/cancel`).set(auth(customerToken));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
  });

  it('rejects cancel once a driver is assigned / pending_dispatch (400)', async () => {
    const res = await request(app).patch(`/api/customer-portal/orders/${dispatchedId}/cancel`).set(auth(customerToken));
    expect(res.status).toBe(400);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: dispatchedId } });
    expect(after.status).toBe('pending_dispatch'); // unchanged
  });
});

describe('Customer Portal - Driver disclosure on order card (WI-119)', () => {
  let pendingOrderId: string;
  let deliveredOrderId: string;
  let driverName: string;
  let driverPhone: string | null;

  beforeAll(async () => {
    const driver = await prisma.driver.findFirst({
      where: { distributorId, deletedAt: null },
      select: { id: true, driverName: true, phone: true },
    });
    if (!driver) throw new Error('No driver found for distributor');
    driverName = driver.driverName;
    driverPhone = driver.phone;

    // Far-future deliveryDate so date-scoped services never sweep these
    // fixtures (anti-pattern #7).
    const farFuture = new Date('2099-12-31');
    const pending = await prisma.order.create({
      data: {
        orderNumber: `TEST-WI119-PEND-${Date.now()}`,
        distributorId, customerId, driverId: driver.id,
        orderDate: farFuture, deliveryDate: farFuture,
        status: 'pending_delivery', totalAmount: 0,
      },
    });
    const delivered = await prisma.order.create({
      data: {
        orderNumber: `TEST-WI119-DELV-${Date.now()}`,
        distributorId, customerId, driverId: driver.id,
        orderDate: farFuture, deliveryDate: farFuture,
        status: 'delivered', totalAmount: 0, deliveredAt: new Date(),
      },
    });
    pendingOrderId = pending.id;
    deliveredOrderId = delivered.id;
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { id: { in: [pendingOrderId, deliveredOrderId] } } });
  });

  it('includes driver name + phone on a pending_delivery order, with no sensitive fields', async () => {
    const res = await request(app)
      .get(`/api/customer-portal/orders/${pendingOrderId}`)
      .set(auth(customerToken));

    expect(res.status).toBe(200);
    const o = res.body.data;
    expect(o.driverName).toBe(driverName);
    expect(o.driverPhone).toBe(driverPhone);
    // No sensitive driver fields leak through the nested relation.
    if (o.driver) {
      expect(o.driver.email).toBeUndefined();
      expect(o.driver.passwordHash).toBeUndefined();
    }
  });

  it('returns driver = null on a delivered order', async () => {
    const res = await request(app)
      .get(`/api/customer-portal/orders/${deliveredOrderId}`)
      .set(auth(customerToken));

    expect(res.status).toBe(200);
    const o = res.body.data;
    expect(o.driver).toBeNull();
    expect(o.driverName).toBeNull();
    expect(o.driverPhone == null).toBe(true);
  });
});

describe('Customer Portal - Invoices', () => {
  it('should list customer invoices', async () => {
    const res = await request(app)
      .get('/api/customer-portal/invoices')
      .set(auth(customerToken));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.invoices)).toBe(true);
  });
});

describe('Customer Portal - Payments', () => {
  it('should list customer payments', async () => {
    const res = await request(app)
      .get('/api/customer-portal/payments')
      .set(auth(customerToken));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.payments)).toBe(true);
  });
});

describe('Customer Portal - Balance', () => {
  it('should return customer balance', async () => {
    const res = await request(app)
      .get('/api/customer-portal/balance')
      .set(auth(customerToken));

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });
});

describe('Customer Portal - Account', () => {
  it('should return customer account details', async () => {
    const res = await request(app)
      .get('/api/customer-portal/account')
      .set(auth(customerToken));

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });

  it('should update customer profile', async () => {
    const res = await request(app)
      .put('/api/customer-portal/account')
      .set(auth(customerToken))
      .send({
        phone: '9876543211',
      });

    expect(res.status).toBe(200);
  });

  it('should return distributor info', async () => {
    const res = await request(app)
      .get('/api/customer-portal/distributor')
      .set(auth(customerToken));

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });

  // WI-120 — account full profile
  it('account returns cylinderDiscounts as an array (never null) and currentPrices', async () => {
    const res = await request(app)
      .get('/api/customer-portal/account')
      .set(auth(customerToken));

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(Array.isArray(d.cylinderDiscounts)).toBe(true);
    expect(Array.isArray(d.currentPrices)).toBe(true);
  });

  it('currentPrices uses the distributor catalog price and applies any customer discount', async () => {
    // Seed a known price + a discount for one cylinder type, then assert the
    // customerPrice = basePrice - discountPerUnit.
    const ct = await prisma.cylinderType.findFirst({ where: { distributorId, isActive: true } });
    if (!ct) throw new Error('No cylinder type for distributor');

    await prisma.cylinderPrice.create({
      data: { distributorId, cylinderTypeId: ct.id, price: 2000, effectiveDate: new Date() },
    });
    await prisma.customerCylinderDiscount.upsert({
      where: { customerId_cylinderTypeId: { customerId, cylinderTypeId: ct.id } },
      create: { customerId, cylinderTypeId: ct.id, discountPerUnit: 150 },
      update: { discountPerUnit: 150 },
    });

    const res = await request(app)
      .get('/api/customer-portal/account')
      .set(auth(customerToken));
    expect(res.status).toBe(200);

    // basePrice must equal whatever the shared price resolver returns from the
    // distributor catalog (deterministic regardless of same-day price ties);
    // customerPrice must be basePrice net of the customer discount.
    const { getEffectivePrice } = await import('../services/cylinderTypeService.js');
    const expectedBase = await getEffectivePrice(distributorId, ct.id, new Date());
    const row = res.body.data.currentPrices.find((p: { cylinderTypeId: string }) => p.cylinderTypeId === ct.id);
    expect(row).toBeDefined();
    expect(row.basePrice).toBe(expectedBase);
    expect(row.discountPerUnit).toBe(150);
    expect(row.customerPrice).toBe(Math.max(expectedBase - 150, 0));

    // The discount also surfaces in the cylinderDiscounts list.
    const disc = res.body.data.cylinderDiscounts.find((d: { cylinderTypeName: string; discountPerUnit: number }) => d.cylinderTypeName === ct.typeName);
    expect(disc?.discountPerUnit).toBe(150);
  });
});

// ─── P0-1 — invoice detail mapper wire-shape guard ──────────────────────────
//
// Pins the customer-portal invoice detail response shape against the customer
// mobile UI's local InvoiceDetail interface in
// packages/mobile/app/(customer)/invoices.tsx:23-55. Pre-P0-1, the response
// was missing every customer-friendly field (subtotal, cgstAmount,
// customerName, lineTotal, payments[]) because the route used the
// schema-native mapInvoice and the Prisma query didn't include `customer`.
// All four invoices below are seeded on the existing dist-001 B2B customer
// (the same one used by the rest of this file); cleanup happens in afterAll.
//
// Each test asserts ONE narrow reconciliation contract:
//   (i)   mixed-rate GST invoice — subtotal + cgst + sgst + igst === totalAmount
//   (ii)  GST-disabled invoice — subtotal === totalAmount and all GST = 0
//   (iii) URP/B2C — customerGstin is null (mobile UI hides the GSTIN row)
//   (iv)  line with discount > 0 — qty × shown unitPrice === lineTotal exactly
//         (the variant a' guarantee that motivated the totalPrice/quantity
//         math in mapCustomerInvoiceDetail)

describe('P0-1 — GET /customer-portal/invoices/:id mapper shape', () => {
  const createdInvoiceIds: string[] = [];
  const createdItemIds: string[] = [];
  let cylinderTypeId: string;
  let originalGstin: string | null = null;
  let invoiceCounter = 0;

  beforeAll(async () => {
    const ct = await prisma.cylinderType.findFirst({ where: { distributorId } });
    if (!ct) throw new Error('No cylinder type in dist-001 to seed invoice items');
    cylinderTypeId = ct.id;

    // Remember the customer's GSTIN so we can restore it. We mutate it for
    // test (iii) and don't want to leak the change into subsequent tests
    // or manual runs.
    const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { gstin: true } });
    originalGstin = c?.gstin ?? null;
  });

  afterAll(async () => {
    // Strict cleanup: delete only the rows this block created. Use the ID
    // arrays accumulated during the tests rather than a broader query, to
    // avoid the anti-pattern #8 trap of catching unrelated rows.
    if (createdItemIds.length) {
      await prisma.invoiceItem.deleteMany({ where: { id: { in: createdItemIds } } });
    }
    if (createdInvoiceIds.length) {
      await prisma.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
    }
    // Restore the customer's GSTIN to its original value (test iii nulls it).
    await prisma.customer.update({ where: { id: customerId }, data: { gstin: originalGstin } });
  });

  /** Helper: seed one invoice + N items inline. Returns the invoice id. */
  async function seedInvoice(opts: {
    cgstValue: number;
    sgstValue: number;
    igstValue: number;
    items: Array<{ quantity: number; unitPrice: number; discountPerUnit?: number; gstRate: number; totalPrice: number }>;
  }) {
    invoiceCounter += 1;
    const totalAmount = opts.items.reduce((s, i) => s + i.totalPrice, 0);
    const inv = await prisma.invoice.create({
      data: {
        invoiceNumber: `TEST-P01-${Date.now().toString(36)}-${invoiceCounter}`,
        distributorId,
        customerId,
        issueDate: new Date('2099-12-31'),
        dueDate: new Date('2099-12-31'),
        status: 'issued',
        totalAmount,
        amountPaid: 0,
        outstandingAmount: totalAmount,
        cgstValue: opts.cgstValue,
        sgstValue: opts.sgstValue,
        igstValue: opts.igstValue,
      },
    });
    createdInvoiceIds.push(inv.id);
    for (const it of opts.items) {
      const row = await prisma.invoiceItem.create({
        data: {
          invoiceId: inv.id,
          cylinderTypeId,
          description: 'P0-1 test item',
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          discountPerUnit: it.discountPerUnit ?? 0,
          gstRate: it.gstRate,
          totalPrice: it.totalPrice,
        },
      });
      createdItemIds.push(row.id);
    }
    return inv.id;
  }

  it('(i) mixed-rate GST invoice: subtotal + cgst + sgst + igst === totalAmount', async () => {
    // 2 × 1050 (5% incl) + 1 × 1180 (18% incl) = 2100 + 1180 = 3280 total.
    // Tax extracted: 2100 − 2100/1.05 = 100; 1180 − 1180/1.18 = 180; sum 280.
    // Intra-state → cgst = sgst = 140; igst = 0. Subtotal = 3280 − 280 = 3000.
    const invoiceId = await seedInvoice({
      cgstValue: 140,
      sgstValue: 140,
      igstValue: 0,
      items: [
        { quantity: 2, unitPrice: 1050, gstRate: 5, totalPrice: 2100 },
        { quantity: 1, unitPrice: 1180, gstRate: 18, totalPrice: 1180 },
      ],
    });

    const res = await request(app)
      .get(`/api/customer-portal/invoices/${invoiceId}`)
      .set(auth(customerToken));
    expect(res.status).toBe(200);

    const d = res.body.data;
    // Locked shape: customer-friendly names present.
    expect(d.invoiceId).toBe(invoiceId);
    expect(typeof d.customerName).toBe('string');
    expect(typeof d.subtotal).toBe('number');
    expect(typeof d.cgstAmount).toBe('number');
    expect(typeof d.sgstAmount).toBe('number');
    expect(typeof d.igstAmount).toBe('number');
    expect(typeof d.totalAmount).toBe('number');
    expect(Array.isArray(d.items)).toBe(true);
    expect(Array.isArray(d.payments)).toBe(true);

    // Numeric reconciliation: subtotal + cgst + sgst + igst === totalAmount.
    expect(d.totalAmount).toBe(3280);
    expect(d.cgstAmount).toBe(140);
    expect(d.sgstAmount).toBe(140);
    expect(d.igstAmount).toBe(0);
    expect(d.subtotal).toBe(3000);
    expect(d.subtotal + d.cgstAmount + d.sgstAmount + d.igstAmount).toBe(d.totalAmount);

    // Per-item: lineTotal = totalPrice; displayed unitPrice = totalPrice / qty.
    const item5pct = d.items.find((i: { gstRate: number }) => i.gstRate === 5);
    expect(item5pct.lineTotal).toBe(2100);
    expect(item5pct.unitPrice).toBe(1050);
    expect(item5pct.quantity).toBe(2);

    const item18pct = d.items.find((i: { gstRate: number }) => i.gstRate === 18);
    expect(item18pct.lineTotal).toBe(1180);
    expect(item18pct.unitPrice).toBe(1180);
    expect(item18pct.quantity).toBe(1);

    // Schema-internal field names must NOT leak through to the customer
    // surface (the bug that motivated P0-1).
    expect(d.cgstValue).toBeUndefined();
    expect(d.sgstValue).toBeUndefined();
    expect(d.igstValue).toBeUndefined();
    expect(d.paymentAllocations).toBeUndefined();
  });

  it('(ii) GST-disabled invoice: subtotal === totalAmount and all GST = 0', async () => {
    // qty 2 × ₹500 (no GST). Total 1000. cgst/sgst/igst all zero.
    const invoiceId = await seedInvoice({
      cgstValue: 0,
      sgstValue: 0,
      igstValue: 0,
      items: [{ quantity: 2, unitPrice: 500, gstRate: 0, totalPrice: 1000 }],
    });

    const res = await request(app)
      .get(`/api/customer-portal/invoices/${invoiceId}`)
      .set(auth(customerToken));
    expect(res.status).toBe(200);

    const d = res.body.data;
    expect(d.totalAmount).toBe(1000);
    expect(d.cgstAmount).toBe(0);
    expect(d.sgstAmount).toBe(0);
    expect(d.igstAmount).toBe(0);
    expect(d.subtotal).toBe(1000); // pure deduction with all-zero GST = totalAmount

    expect(d.items[0].lineTotal).toBe(1000);
    expect(d.items[0].unitPrice).toBe(500);
    expect(d.items[0].gstRate).toBe(0);
  });

  it('(iii) URP/B2C customer (no GSTIN): customerGstin is null', async () => {
    // Mutate THIS customer to have no GSTIN, then check the response. The
    // mobile UI ((customer)/invoices.tsx:267) renders the GSTIN row only when
    // truthy, so null = row hidden = correct for a URP customer viewing their
    // own invoice.
    await prisma.customer.update({ where: { id: customerId }, data: { gstin: null } });

    const invoiceId = await seedInvoice({
      cgstValue: 0,
      sgstValue: 0,
      igstValue: 0,
      items: [{ quantity: 1, unitPrice: 500, gstRate: 0, totalPrice: 500 }],
    });

    const res = await request(app)
      .get(`/api/customer-portal/invoices/${invoiceId}`)
      .set(auth(customerToken));
    expect(res.status).toBe(200);
    expect(res.body.data.customerGstin).toBeNull();
    expect(res.body.data.customerName).toBeTruthy(); // name still populated
  });

  it('(iv) line with discount > 0: qty × shown unitPrice === lineTotal exactly', async () => {
    // unitPrice (pre-discount inclusive) ₹1180, discount ₹80, qty 2.
    // totalPrice = (1180 − 80) × 2 = 2200. cgst = 2200 × 18/(118×2) = ~167.80.
    // The mapper's displayed unitPrice = totalPrice / qty = 1100 (post-discount
    // inclusive). qty × 1100 = 2200 reconciles to lineTotal exactly — this is
    // the (a') variant guarantee.
    const invoiceId = await seedInvoice({
      cgstValue: 167.80,
      sgstValue: 167.80,
      igstValue: 0,
      items: [
        { quantity: 2, unitPrice: 1180, discountPerUnit: 80, gstRate: 18, totalPrice: 2200 },
      ],
    });

    const res = await request(app)
      .get(`/api/customer-portal/invoices/${invoiceId}`)
      .set(auth(customerToken));
    expect(res.status).toBe(200);

    const item = res.body.data.items[0];
    expect(item.quantity).toBe(2);
    expect(item.lineTotal).toBe(2200);
    expect(item.unitPrice).toBe(1100); // 2200 / 2, post-discount inclusive
    // The (a') reconciliation: qty × shown unit price exactly equals lineTotal.
    expect(item.quantity * item.unitPrice).toBe(item.lineTotal);

    // Schema-internal fields stay hidden even with discount present.
    expect(item.discountPerUnit).toBeUndefined();
    expect(item.totalPrice).toBeUndefined();
  });
});

// ─── P0-2 — invoice PDF download gate ──────────────────────────────────────
//
// Suneel reported the download button missing on "historical" invoices.
// Root cause: the gate at /customer-portal/invoices/:id/pdf required
// `order.status IN [delivered, modified_delivered]` AND the order must
// exist. That hid downloads for (a) opening-balance invoices (no linked
// order — created via WI-076 customer-balance import or manual invoices
// without an order) and (b) any historical invoice whose order status
// had drifted out of the narrow allowed set.
//
// Indian GST law (CGST Rule 56) requires customers to retain every tax
// invoice for 8 years. The customer-facing app must let them retrieve
// any invoice they ever received. New gate: status IN
// [issued, partially_paid, paid] only. Draft / cancelled stay blocked
// — they aren't statutory artefacts.

describe('P0-2 — GET /customer-portal/invoices/:id/pdf gate (8-year retention)', () => {
  const createdInvoiceIds: string[] = [];
  const createdItemIds: string[] = [];
  let cylinderTypeId: string;
  let invoiceCounter = 0;

  beforeAll(async () => {
    const ct = await prisma.cylinderType.findFirst({ where: { distributorId } });
    if (!ct) throw new Error('No cylinder type in dist-001 to seed PDF-gate invoices');
    cylinderTypeId = ct.id;
  });

  afterAll(async () => {
    if (createdItemIds.length) {
      await prisma.invoiceItem.deleteMany({ where: { id: { in: createdItemIds } } });
    }
    if (createdInvoiceIds.length) {
      await prisma.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
    }
  });

  /**
   * Helper: seed a no-order invoice (mimics WI-076 opening-balance imports
   * and manually-created invoices). Status is configurable so the same
   * helper drives the positive (issued) and negative (cancelled) cases.
   */
  async function seedNoOrderInvoice(status: $Enums.InvoiceStatus) {
    invoiceCounter += 1;
    const inv = await prisma.invoice.create({
      data: {
        invoiceNumber: `TEST-P02-${Date.now().toString(36)}-${invoiceCounter}`,
        distributorId,
        customerId,
        issueDate: new Date('2099-12-31'),
        dueDate: new Date('2099-12-31'),
        status,
        totalAmount: 500,
        amountPaid: 0,
        outstandingAmount: 500,
        cgstValue: 0,
        sgstValue: 0,
        igstValue: 0,
        isOpeningBalance: true,
      },
    });
    createdInvoiceIds.push(inv.id);
    const item = await prisma.invoiceItem.create({
      data: {
        invoiceId: inv.id,
        cylinderTypeId,
        description: 'Opening balance line',
        quantity: 1,
        unitPrice: 500,
        discountPerUnit: 0,
        gstRate: 0,
        totalPrice: 500,
      },
    });
    createdItemIds.push(item.id);
    return inv.id;
  }

  it('returns 200 + PDF buffer for an issued invoice with NO linked order (opening balance)', async () => {
    const invoiceId = await seedNoOrderInvoice('issued');

    const res = await request(app)
      .get(`/api/customer-portal/invoices/${invoiceId}/pdf`)
      .set(auth(customerToken));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    // Body is a Buffer in supertest; non-empty means the PDF rendered.
    expect(res.body).toBeInstanceOf(Buffer);
    expect(res.body.length).toBeGreaterThan(100);
  });

  it('returns 403 for a cancelled invoice (not a statutory artefact)', async () => {
    const invoiceId = await seedNoOrderInvoice('cancelled');

    const res = await request(app)
      .get(`/api/customer-portal/invoices/${invoiceId}/pdf`)
      .set(auth(customerToken));

    expect(res.status).toBe(403);
    expect(res.body.error || res.body.message).toBeDefined();
  });

  it('returns 403 for a draft invoice (not yet issued)', async () => {
    const invoiceId = await seedNoOrderInvoice('draft');

    const res = await request(app)
      .get(`/api/customer-portal/invoices/${invoiceId}/pdf`)
      .set(auth(customerToken));

    expect(res.status).toBe(403);
  });

  it('blocks cross-tenant access (customer cannot fetch another distributor\'s invoice PDF)', async () => {
    // Seed an invoice on dist-002 for THIS customer's id reused — Prisma
    // will create it under dist-002, the token customer belongs to dist-001
    // so the lookup must scope to distributorId and return 404. This guards
    // against the IDOR class flagged by anti-pattern #13.
    invoiceCounter += 1;
    const otherDistInvoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `TEST-P02-XT-${Date.now().toString(36)}-${invoiceCounter}`,
        distributorId: 'dist-002',
        customerId,
        issueDate: new Date('2099-12-31'),
        dueDate: new Date('2099-12-31'),
        status: 'issued',
        totalAmount: 500,
        amountPaid: 0,
        outstandingAmount: 500,
        cgstValue: 0,
        sgstValue: 0,
        igstValue: 0,
        isOpeningBalance: true,
      },
    });
    createdInvoiceIds.push(otherDistInvoice.id);

    const res = await request(app)
      .get(`/api/customer-portal/invoices/${otherDistInvoice.id}/pdf`)
      .set(auth(customerToken));

    expect(res.status).toBe(404);
  });
});
