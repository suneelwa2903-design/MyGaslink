import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { generateToken, loginAsDistAdmin } from './helpers.js';
import { prisma } from '../lib/prisma.js';
import { computeCustomerOverdue } from '../services/paymentService.js';
import { UserRole } from '@gaslink/shared';
import type { Express } from 'express';

// WI-122 — payment commitment system.
// A dedicated customer is created with a single far-past delivered order and
// NO payments, so its overdue balance is deterministic (= the delivered
// amount) regardless of other data on the shared dev DB.
const DISTRIBUTOR_ID = 'dist-001';
const PAST = new Date('2000-01-01'); // older than any credit period
const OVERDUE_AMOUNT = 1000; // 10 units * ₹100

let app: Express;
let adminToken: string;
let customerToken: string;
let customerId: string;
let userId: string;
let cylinderTypeId: string;

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;

  const ct = await prisma.cylinderType.findFirst({ where: { distributorId: DISTRIBUTOR_ID, isActive: true } });
  if (!ct) throw new Error('No cylinder type for dist-001');
  cylinderTypeId = ct.id;

  const customer = await prisma.customer.create({
    data: {
      distributorId: DISTRIBUTOR_ID,
      customerName: 'WI122 Overdue Co',
      customerType: 'B2C',
      phone: '9000000122',
      creditPeriodDays: 1,
      stopSupply: false,
    },
  });
  customerId = customer.id;

  const user = await prisma.user.create({
    data: {
      email: `wi122-${customer.id.slice(0, 8)}@test.com`,
      passwordHash: 'x',
      firstName: 'WI122',
      lastName: 'Customer',
      phone: '9000000122',
      role: UserRole.CUSTOMER,
      status: 'active',
      provisioningStatus: 'active',
      distributorId: DISTRIBUTOR_ID,
      customerId: customer.id,
      requiresPasswordReset: false,
    },
  });
  userId = user.id;

  // One delivered order, far in the past, no payments → overdue = ₹1000.
  await prisma.order.create({
    data: {
      orderNumber: `TEST-WI122-OVERDUE-${Date.now()}`,
      distributorId: DISTRIBUTOR_ID,
      customerId: customer.id,
      orderDate: PAST,
      deliveryDate: PAST,
      status: 'delivered',
      deliveredAt: PAST,
      totalAmount: OVERDUE_AMOUNT,
      items: {
        create: [{
          cylinderTypeId,
          quantity: 10,
          deliveredQuantity: 10,
          unitPrice: 100,
          discountPerUnit: 0,
          totalPrice: OVERDUE_AMOUNT,
        }],
      },
    },
  });

  customerToken = generateToken({
    userId: user.id,
    email: user.email,
    role: UserRole.CUSTOMER,
    distributorId: DISTRIBUTOR_ID,
    customerId: customer.id,
  });
});

afterAll(async () => {
  await prisma.paymentCommitment.deleteMany({ where: { customerId } });
  await prisma.pendingAction.deleteMany({ where: { entityId: customerId, entityType: 'customer' } });
  await prisma.orderItem.deleteMany({ where: { order: { customerId } } });
  await prisma.order.deleteMany({ where: { customerId } });
  // audit_logs is a raw table (no Prisma model) with a user_id FK — clear our
  // user's rows before deleting the user.
  await prisma.$executeRawUnsafe('DELETE FROM audit_logs WHERE user_id = $1', userId);
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
});

function placeOrder(body: Record<string, unknown>) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return request(app)
    .post('/api/customer-portal/orders')
    .set(auth(customerToken))
    .send({
      deliveryDate: tomorrow.toISOString().split('T')[0],
      items: [{ cylinderTypeId, quantity: 1 }],
      ...body,
    });
}

describe('WI-122 — computeCustomerOverdue (ledger formula)', () => {
  it('returns the unpaid delivered amount past the credit period', async () => {
    const overdue = await computeCustomerOverdue(DISTRIBUTOR_ID, customerId);
    expect(overdue).toBe(OVERDUE_AMOUNT);
  });
});

describe('WI-122 — order placement gate escalation', () => {
  it('Level 1: first overdue order returns 409 requiresCommitment', async () => {
    const res = await placeOrder({});
    expect(res.status).toBe(409);
    const payload = JSON.parse(res.body.error);
    expect(payload.requiresCommitment).toBe(true);
    expect(payload.escalationLevel).toBe(1);
    expect(payload.overdueAmount).toBe(OVERDUE_AMOUNT);
  });

  it('Level 1: with a promised date the order is created and a commitment is saved', async () => {
    const res = await placeOrder({ promisedDate: '2099-12-31' });
    expect(res.status).toBe(201);
    const commitments = await prisma.paymentCommitment.findMany({ where: { customerId, status: 'open' } });
    expect(commitments.length).toBe(1);
    expect(commitments[0].escalationLevel).toBe(1);
  });

  it('Level 2: second overdue order returns 409 requiresAcknowledgment', async () => {
    const res = await placeOrder({ promisedDate: '2099-12-31' });
    expect(res.status).toBe(409);
    const payload = JSON.parse(res.body.error);
    expect(payload.requiresAcknowledgment).toBe(true);
    expect(payload.escalationLevel).toBe(2);
  });

  it('Level 2: with acknowledgment the order is created', async () => {
    const res = await placeOrder({ acknowledged: true, promisedDate: '2099-12-31' });
    expect(res.status).toBe(201);
    const open = await prisma.paymentCommitment.count({ where: { customerId, status: 'open' } });
    expect(open).toBe(2);
  });

  it('Level 3: third overdue order is blocked and raises an override pending-action', async () => {
    const res = await placeOrder({ acknowledged: true, promisedDate: '2099-12-31' });
    expect(res.status).toBe(409);
    const payload = JSON.parse(res.body.error);
    expect(payload.blocked).toBe(true);
    expect(payload.escalationLevel).toBe(3);

    const override = await prisma.pendingAction.findFirst({
      where: { entityId: customerId, entityType: 'customer', actionType: 'OVERDUE_ORDER_OVERRIDE', status: 'open' },
    });
    expect(override).not.toBeNull();
  });

  it('Level 3: once an admin approves the override, the next order goes through', async () => {
    const override = await prisma.pendingAction.findFirst({
      where: { entityId: customerId, entityType: 'customer', actionType: 'OVERDUE_ORDER_OVERRIDE', status: 'open' },
    });
    expect(override).not.toBeNull();

    const approve = await request(app)
      .put(`/api/pending-actions/${override!.id}/approve`)
      .set(auth(adminToken))
      .send({});
    expect(approve.status).toBe(200);

    const res = await placeOrder({});
    expect(res.status).toBe(201);

    // The grant is one-shot: it was consumed (resolved) by the order.
    const stillOpen = await prisma.pendingAction.findFirst({
      where: { id: override!.id, status: 'in_progress' },
    });
    expect(stillOpen).toBeNull();
  });
});

describe('WI-122 — collections dashboard', () => {
  it('includes latestCommitment and computes overdueDue from the ledger formula', async () => {
    const res = await request(app)
      .get('/api/analytics/collections')
      .set(auth(adminToken));
    expect(res.status).toBe(200);

    const row = res.body.data.find((c: { customerId: string }) => c.customerId === customerId);
    expect(row).toBeDefined();
    // Ledger overdue, not the status flag (no invoice is status='overdue').
    expect(row.overdueDue).toBe(OVERDUE_AMOUNT);
    // latestCommitment surfaced (an open commitment exists from the gate tests).
    expect(row.latestCommitment).not.toBeNull();
    expect(row.latestCommitment.escalationLevel).toBeGreaterThanOrEqual(1);
  });
});
