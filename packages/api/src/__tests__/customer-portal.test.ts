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
        status: 'pending_dispatch', totalAmount: 5000,
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
