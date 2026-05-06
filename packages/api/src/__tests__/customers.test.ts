import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, loginAsFinance } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let financeToken: string;
const trackedIds: string[] = []; // customers we created — soft-delete in afterAll

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;
  financeToken = (await loginAsFinance()).token;
});

afterAll(async () => {
  // Hard-delete every customer this file created (including the one our
  // soft-delete test made). getSeedData() in helpers.ts does NOT filter
  // by deletedAt, so leftover rows would shift the alphabetical seed
  // order and break sibling test files (e.g. workflow.test.ts which
  // references seedData.customers[0]).
  await prisma.customerAuditTrail.deleteMany({
    where: { customer: { customerName: { in: ['Test Customer Alpha', 'Doomed Customer'] } } },
  });
  await prisma.customerModificationRequest.deleteMany({
    where: { customer: { customerName: { in: ['Test Customer Alpha', 'Doomed Customer'] } } },
  });
  await prisma.customer.deleteMany({
    where: {
      distributorId: 'dist-001',
      customerName: { in: ['Test Customer Alpha', 'Doomed Customer'] },
    },
  });
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('Customers — Auth', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/customers');
    expect(res.status).toBe(401);
  });

  it('rejects requests with no distributor context (super_admin without header)', async () => {
    // Super admin login has no JWT distributorId; without X-Distributor-Id
    // header requireDistributor must reject.
    const sa = await prisma.user.findUniqueOrThrow({
      where: { email: 'admin@mygaslink.com' },
    });
    const jwt = await import('jsonwebtoken');
    const { config } = await import('../config/index.js');
    const token = jwt.default.sign(
      { userId: sa.id, email: sa.email, role: sa.role, distributorId: null, customerId: null },
      config.jwt.accessSecret,
      { expiresIn: '15m' },
    );
    const res = await request(app).get('/api/customers').set(auth(token));
    expect([400, 403]).toContain(res.status);
  });
});

describe('Customers — CRUD', () => {
  it('creates a customer with required fields', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set(auth(adminToken))
      .send({
        customerName: 'Test Customer Alpha',
        phone: '9100000001',
        billingCity: 'Hyderabad',
        billingState: 'Telangana',
      });
    if (res.status !== 201) console.log('create error:', res.body);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.customerId).toBeDefined();
    expect(res.body.data.distributorId).toBe('dist-001');
    trackedIds.push(res.body.data.customerId);
  });

  it('rejects create with missing required fields (400)', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set(auth(adminToken))
      .send({ /* no customerName, no phone */ });
    expect(res.status).toBe(400);
  });

  it('lists customers scoped to caller distributor', async () => {
    const res = await request(app).get('/api/customers').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.customers)).toBe(true);
    for (const c of res.body.data.customers) {
      expect(c.distributorId).toBe('dist-001');
    }
  });

  it('searches customers by name', async () => {
    const res = await request(app)
      .get('/api/customers?search=Royal')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.customers.length).toBeGreaterThan(0);
    expect(res.body.data.customers[0].customerName.toLowerCase()).toContain('royal');
  });

  it('fetches a customer by id', async () => {
    const id = trackedIds[0];
    const res = await request(app).get(`/api/customers/${id}`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.customerId).toBe(id);
  });

  it('updates a customer', async () => {
    const id = trackedIds[0];
    const res = await request(app)
      .put(`/api/customers/${id}`)
      .set(auth(adminToken))
      .send({ phone: '9100000099' });
    expect(res.status).toBe(200);
    expect(res.body.data.phone).toBe('9100000099');
  });

  it('soft-deletes a customer', async () => {
    // Create a fresh one we'll delete (don't disturb the others).
    const created = await request(app)
      .post('/api/customers')
      .set(auth(adminToken))
      .send({ customerName: 'Doomed Customer', phone: '9100000777' });
    expect(created.status).toBe(201);
    const id = created.body.data.customerId;

    const res = await request(app).delete(`/api/customers/${id}`).set(auth(adminToken));
    expect(res.status).toBe(200);

    // Should now be soft-deleted (not findable in list)
    const list = await request(app).get('/api/customers').set(auth(adminToken));
    expect(list.body.data.customers.find((c: { customerId: string }) => c.customerId === id)).toBeUndefined();
  });
});

describe('Customers — Tenant Isolation', () => {
  it('cannot fetch a customer from another distributor (404)', async () => {
    // dist-002 customer (seeded as Sharma's tenant)
    const dist2Customer = await prisma.customer.findFirst({
      where: { distributorId: 'dist-002', deletedAt: null },
    });
    if (!dist2Customer) {
      throw new Error('Seed expected at least one dist-002 customer');
    }
    const res = await request(app)
      .get(`/api/customers/${dist2Customer.id}`)
      .set(auth(adminToken)); // dist-001 admin
    expect(res.status).toBe(404);
  });

  it('cannot update a customer from another distributor (404)', async () => {
    const dist2Customer = await prisma.customer.findFirst({
      where: { distributorId: 'dist-002', deletedAt: null },
    });
    if (!dist2Customer) {
      throw new Error('Seed expected at least one dist-002 customer');
    }
    const res = await request(app)
      .put(`/api/customers/${dist2Customer.id}`)
      .set(auth(adminToken))
      .send({ phone: '0000000000' });
    expect([403, 404]).toContain(res.status);
  });
});

describe('Customers — Modification Requests', () => {
  it('creates a modification request', async () => {
    const id = trackedIds[0];
    const res = await request(app)
      .post(`/api/customers/${id}/modification-requests`)
      .set(auth(financeToken))
      .send({
        modificationType: 'stop_supply',
        reason: 'Test reason — overdue invoices',
      });
    if (res.status !== 201) console.log('mod request error:', res.body);
    expect(res.status).toBe(201);
    expect(res.body.data).toBeDefined();
  });

  it('admin can approve a pending modification request', async () => {
    const id = trackedIds[0];
    const created = await request(app)
      .post(`/api/customers/${id}/modification-requests`)
      .set(auth(financeToken))
      .send({ modificationType: 'resume_supply', reason: 'Customer cleared dues' });
    expect(created.status).toBe(201);
    const requestId = created.body.data.id || created.body.data.requestId;
    if (!requestId) {
      throw new Error('Modification request id not returned in response');
    }

    const res = await request(app)
      .put(`/api/customers/modification-requests/${requestId}/approve`)
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('approved');
  });
});
