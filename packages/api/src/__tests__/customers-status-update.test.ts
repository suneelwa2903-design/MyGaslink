import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import {
  loginAsDistAdmin,
  loginAsFinance,
  loginAsInventory,
  generateToken,
} from './helpers.js';
import type { UserRole } from '@gaslink/shared';

let app: Express;
let adminToken: string;
let financeToken: string;
let inventoryToken: string;
let otherDistAdminToken: string;
let distributorId: string;

const customerNames = [
  'ZZTEST_CSU Active Alpha',
  'ZZTEST_CSU Suspended Beta',
  'ZZTEST_CSU Inactive Gamma',
  'ZZTEST_CSU StopSupply Target',
  'ZZTEST_CSU StatusFilter A',
  'ZZTEST_CSU StatusFilter B',
];
const ids: Record<string, string> = {};

function auth(t: string) {
  return { Authorization: `Bearer ${t}` };
}

async function cleanup() {
  // Soft-delete any leftover ZZTEST_CSU customers from a prior crashed run AND from
  // this run's afterAll. Hard-delete is fragile here because the customer
  // table has restrict-mode FKs (orders, ledger, invoices, etc.) and a
  // prior test session could have left any of those behind. Soft-delete
  // sidesteps all FK constraints, and listCustomers filters by
  // `deletedAt: null` so the rows stop appearing in any test query.
  await prisma.customer.updateMany({
    where: { customerName: { in: customerNames }, deletedAt: null },
    data: { deletedAt: new Date() },
  });
}

beforeAll(async () => {
  app = createApp();
  const a = await loginAsDistAdmin();
  adminToken = a.token;
  distributorId = a.distributorId;
  financeToken = (await loginAsFinance()).token;
  inventoryToken = (await loginAsInventory()).token;

  // dist-002 admin for cross-tenant guard
  const otherUser = await prisma.user.findUniqueOrThrow({ where: { email: 'sharma@gasdist.com' } });
  otherDistAdminToken = generateToken({
    userId: otherUser.id,
    email: otherUser.email,
    role: otherUser.role as UserRole,
    distributorId: otherUser.distributorId,
  });

  // Defensive pre-clean — handle any leftover rows from a crashed prior run.
  await cleanup();

  // Seed test customers — one for each scenario
  const seed = await prisma.customer.createMany({
    data: [
      { distributorId, customerName: 'ZZTEST_CSU Active Alpha',     phone: '9100200001', customerType: 'B2B', gstin: '36AAACS0001A1Z5', status: 'active' },
      { distributorId, customerName: 'ZZTEST_CSU Suspended Beta',   phone: '9100200002', customerType: 'B2C', status: 'suspended', stopSupply: true },
      { distributorId, customerName: 'ZZTEST_CSU Inactive Gamma',   phone: '9100200003', customerType: 'B2C', status: 'inactive' },
      { distributorId, customerName: 'ZZTEST_CSU StopSupply Target',phone: '9100200004', customerType: 'B2C', status: 'active' },
      { distributorId, customerName: 'ZZTEST_CSU StatusFilter A',   phone: '9100200005', customerType: 'B2B', gstin: '36AAACS0002A1Z5', status: 'active' },
      { distributorId, customerName: 'ZZTEST_CSU StatusFilter B',   phone: '9100200006', customerType: 'B2B', gstin: '36AAACS0003A1Z5', status: 'active' },
    ],
  });
  expect(seed.count).toBe(6);

  // Capture each customer's id so we can address them by name in tests.
  // Important: filter on deletedAt: null so leftover soft-deleted rows from
  // a prior crashed run don't clobber the freshly-seeded id in the map.
  const rows = await prisma.customer.findMany({
    where: { distributorId, customerName: { in: customerNames }, deletedAt: null },
    select: { id: true, customerName: true },
  });
  for (const r of rows) ids[r.customerName] = r.id;
});

afterAll(async () => {
  await cleanup();
});

describe('PUT /api/customers/:id — status updates', () => {
  it('admin can set status=suspended (also mirrors stopSupply=true)', async () => {
    const id = ids['ZZTEST_CSU Active Alpha'];
    const res = await request(app).put(`/api/customers/${id}`).set(auth(adminToken)).send({ status: 'suspended' });
    expect(res.status).toBe(200);
    const row = await prisma.customer.findUnique({ where: { id } });
    expect(row?.status).toBe('suspended');
    expect(row?.stopSupply).toBe(true);
  });

  it('admin can set status=inactive', async () => {
    const id = ids['ZZTEST_CSU Active Alpha'];
    const res = await request(app).put(`/api/customers/${id}`).set(auth(adminToken)).send({ status: 'inactive' });
    expect(res.status).toBe(200);
    const row = await prisma.customer.findUnique({ where: { id } });
    expect(row?.status).toBe('inactive');
    // stopSupply only mirrors the suspended state; inactive should leave it false
    expect(row?.stopSupply).toBe(false);
  });

  it('admin can set status=active', async () => {
    const id = ids['ZZTEST_CSU Suspended Beta'];
    const res = await request(app).put(`/api/customers/${id}`).set(auth(adminToken)).send({ status: 'active' });
    expect(res.status).toBe(200);
    const row = await prisma.customer.findUnique({ where: { id } });
    expect(row?.status).toBe('active');
    expect(row?.stopSupply).toBe(false);
  });

  it('rejects invalid status values with 400', async () => {
    const id = ids['ZZTEST_CSU StatusFilter A'];
    const res = await request(app).put(`/api/customers/${id}`).set(auth(adminToken)).send({ status: 'commercial' });
    expect(res.status).toBe(400);
  });

  it('finance can change status (route role + per-field guard both pass)', async () => {
    const id = ids['ZZTEST_CSU StatusFilter B'];
    const res = await request(app).put(`/api/customers/${id}`).set(auth(financeToken)).send({ status: 'suspended' });
    expect(res.status).toBe(200);
    const row = await prisma.customer.findUnique({ where: { id } });
    expect(row?.status).toBe('suspended');
  });

  it('inventory CAN edit address but CANNOT change status (per-field guard returns 403)', async () => {
    const id = ids['ZZTEST_CSU StatusFilter B'];

    // Allowed: inventory updates a non-status field
    const ok = await request(app).put(`/api/customers/${id}`).set(auth(inventoryToken)).send({ billingCity: 'NewCity' });
    expect(ok.status).toBe(200);

    // Denied: inventory tries to change status
    const denied = await request(app).put(`/api/customers/${id}`).set(auth(inventoryToken)).send({ status: 'inactive' });
    expect(denied.status).toBe(403);
    const row = await prisma.customer.findUnique({ where: { id } });
    expect(row?.status).toBe('suspended');  // unchanged from the prior finance test
  });

  it('emits an audit-trail row when status changes', async () => {
    const id = ids['ZZTEST_CSU StatusFilter A'];
    await request(app).put(`/api/customers/${id}`).set(auth(adminToken)).send({ status: 'inactive' });
    const trail = await prisma.customerAuditTrail.findFirst({
      where: { customerId: id, fieldName: 'status' },
      orderBy: { createdAt: 'desc' },
    });
    expect(trail).toBeTruthy();
    expect(trail?.newValue).toBe('inactive');
  });
});

describe('Stop / Resume supply — status mirror', () => {
  it('POST /:id/stop-supply sets status=suspended (in addition to stopSupply=true)', async () => {
    const id = ids['ZZTEST_CSU StopSupply Target'];
    const res = await request(app).post(`/api/customers/${id}/stop-supply`).set(auth(adminToken));
    expect(res.status).toBe(200);
    const row = await prisma.customer.findUnique({ where: { id } });
    expect(row?.status).toBe('suspended');
    expect(row?.stopSupply).toBe(true);
  });

  it('POST /:id/resume-supply sets status=active (in addition to stopSupply=false)', async () => {
    const id = ids['ZZTEST_CSU StopSupply Target'];
    const res = await request(app).post(`/api/customers/${id}/resume-supply`).set(auth(adminToken));
    expect(res.status).toBe(200);
    const row = await prisma.customer.findUnique({ where: { id } });
    expect(row?.status).toBe('active');
    expect(row?.stopSupply).toBe(false);
  });
});

describe('GET /api/customers — status filter (combined with type)', () => {
  it('status=active returns only active rows from our seed', async () => {
    const res = await request(app)
      .get('/api/customers?pageSize=1000&search=ZZTEST_CSU&status=active')
      .set(auth(adminToken));
    const ours = (res.body.data.customers as Array<{ customerName: string; status: string }>)
      .filter((c) => c.customerName.startsWith('ZZTEST_CSU'));
    expect(ours.length).toBeGreaterThan(0);
    expect(ours.every((c) => c.status === 'active')).toBe(true);
  });

  it('status=suspended returns only suspended', async () => {
    const res = await request(app)
      .get('/api/customers?pageSize=1000&search=ZZTEST_CSU&status=suspended')
      .set(auth(adminToken));
    const ours = (res.body.data.customers as Array<{ customerName: string; status: string }>)
      .filter((c) => c.customerName.startsWith('ZZTEST_CSU'));
    expect(ours.every((c) => c.status === 'suspended')).toBe(true);
  });

  it('status=inactive returns only inactive', async () => {
    const res = await request(app)
      .get('/api/customers?pageSize=1000&search=ZZTEST_CSU&status=inactive')
      .set(auth(adminToken));
    const ours = (res.body.data.customers as Array<{ customerName: string; status: string }>)
      .filter((c) => c.customerName.startsWith('ZZTEST_CSU'));
    expect(ours.every((c) => c.status === 'inactive')).toBe(true);
  });

  it('combines status=active with customerType=B2B', async () => {
    const res = await request(app)
      .get('/api/customers?pageSize=1000&search=ZZTEST_CSU&status=active&customerType=B2B')
      .set(auth(adminToken));
    const ours = (res.body.data.customers as Array<{ customerName: string; status: string; customerType: string }>)
      .filter((c) => c.customerName.startsWith('ZZTEST_CSU'));
    expect(ours.every((c) => c.status === 'active' && c.customerType === 'B2B')).toBe(true);
  });

  it('cross-tenant: another distributor cannot see our ZZTEST_CSU customers via status filter', async () => {
    const res = await request(app)
      .get('/api/customers?pageSize=1000&search=ZZTEST_CSU&status=active')
      .set(auth(otherDistAdminToken));
    const leaked = (res.body.data.customers as Array<{ customerName: string }>)
      .filter((c) => c.customerName.startsWith('ZZTEST_CSU'));
    expect(leaked).toHaveLength(0);
  });
});
