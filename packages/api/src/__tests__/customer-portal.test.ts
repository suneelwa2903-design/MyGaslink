import { describe, it, expect, beforeAll } from 'vitest';
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
});
