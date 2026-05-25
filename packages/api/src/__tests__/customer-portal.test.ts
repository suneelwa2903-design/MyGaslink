import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { generateToken, loginAsDistAdmin } from './helpers.js';
import { prisma } from '../lib/prisma.js';
import { UserRole } from '@gaslink/shared';
import type { Express } from 'express';

let app: Express;
let customerToken: string;
let customerId: string;
let distributorId: string;
let adminToken: string;

beforeAll(async () => {
  app = createApp();
  const admin = await loginAsDistAdmin();
  adminToken = admin.token;

  // Find a B2B customer from dist-001 and create a user account for it
  const customer = await prisma.customer.findFirst({
    where: { distributorId: 'dist-001', customerType: 'B2B' },
  });
  if (!customer) throw new Error('No B2B customer found');
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
        deliveryDate: new Date().toISOString().split('T')[0],
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
  let deliveredOrderId: string;
  let deliveredInvoiceId: string;
  let cancelledInvoiceId: string;
  let pendingOrderInvoiceId: string;
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];

  async function makeOrder(status: string) {
    const far = new Date('2099-12-31');
    const o = await prisma.order.create({
      data: {
        orderNumber: `TEST-WI126-${status}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        distributorId, customerId, orderDate: far, deliveryDate: far,
        status: status as any, totalAmount: 1180,
      },
    });
    orderIds.push(o.id);
    return o;
  }
  async function makeInvoice(orderId: string, status: string) {
    const far = new Date('2099-12-31');
    const inv = await prisma.invoice.create({
      data: {
        invoiceNumber: `TEST-INV-WI126-${status}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        distributorId, customerId, orderId, issueDate: far, dueDate: far,
        status: status as any, totalAmount: 1180, outstandingAmount: status === 'cancelled' ? 0 : 1180,
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
    deliveredOrderId = delivered.id;
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
    const row = res.body.data.invoices.find((i: any) => i.invoiceId === deliveredInvoiceId);
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

  it('refuses the PDF when the linked order is not delivered (403)', async () => {
    const res = await request(app)
      .get(`/api/customer-portal/invoices/${pendingOrderInvoiceId}/pdf`)
      .set(auth(customerToken));
    expect(res.status).toBe(403);
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
    const mk = async (status: string) => {
      const o = await prisma.order.create({
        data: {
          orderNumber: `TEST-WI127-${status}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          distributorId, customerId, orderDate: far, deliveryDate: far, deliveredAt: far,
          status: status as any, totalAmount: 1180,
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
    const row = res.body.data.currentPrices.find((p: any) => p.cylinderTypeId === ct.id);
    expect(row).toBeDefined();
    expect(row.basePrice).toBe(expectedBase);
    expect(row.discountPerUnit).toBe(150);
    expect(row.customerPrice).toBe(Math.max(expectedBase - 150, 0));

    // The discount also surfaces in the cylinderDiscounts list.
    const disc = res.body.data.cylinderDiscounts.find((d: any) => d.cylinderTypeName === ct.typeName);
    expect(disc?.discountPerUnit).toBe(150);
  });
});
