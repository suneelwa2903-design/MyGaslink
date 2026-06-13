import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, generateToken } from './helpers.js';
import type { UserRole } from '@gaslink/shared';

let app: Express;
let adminToken: string;
let distributorId: string;
let otherDistAdminToken: string;
const trackedNames = [
  'CLFTest B2B Alpha',
  'CLFTest B2B Beta',
  'CLFTest B2C Gamma',
  'CLFTest B2C Delta',
  'CLFTest B2C Epsilon',
];

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  app = createApp();
  const a = await loginAsDistAdmin();
  adminToken = a.token;
  distributorId = a.distributorId;

  // Seed a known-shape population on dist-001: 2 B2B + 3 B2C, all flagged
  // with the CLFTest prefix so we can filter+count them deterministically.
  await prisma.customer.createMany({
    data: [
      { distributorId, customerName: 'CLFTest B2B Alpha', phone: '9100100001', customerType: 'B2B', gstin: '36AAACT0000A1Z5' },
      { distributorId, customerName: 'CLFTest B2B Beta',  phone: '9100100002', customerType: 'B2B', gstin: '36AAACT0000B1Z5' },
      { distributorId, customerName: 'CLFTest B2C Gamma', phone: '9100100003', customerType: 'B2C' },
      { distributorId, customerName: 'CLFTest B2C Delta', phone: '9100100004', customerType: 'B2C' },
      { distributorId, customerName: 'CLFTest B2C Epsilon', phone: '9100100005', customerType: 'B2C' },
    ],
  });

  // Build a token for a different distributor for the cross-tenant guard
  const otherUser = await prisma.user.findUniqueOrThrow({
    where: { email: 'sharma@gasdist.com' },
  });
  otherDistAdminToken = generateToken({
    userId: otherUser.id,
    email: otherUser.email,
    role: otherUser.role as UserRole,
    distributorId: otherUser.distributorId,
  });
});

afterAll(async () => {
  await prisma.customer.deleteMany({
    where: { distributorId, customerName: { in: trackedNames } },
  });
});

describe('GET /api/customers — pageSize cap (Change 1)', () => {
  it('accepts pageSize=500 (cap was 100, raised to 1000)', async () => {
    const res = await request(app)
      .get('/api/customers?pageSize=500')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.meta.pageSize).toBe(500);
  });

  it('still rejects pageSize=2000 (above new 1000 cap)', async () => {
    const res = await request(app)
      .get('/api/customers?pageSize=2000')
      .set(auth(adminToken));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/customers — customerType filter (Change 3)', () => {
  it('customerType=B2B returns only B2B rows', async () => {
    const res = await request(app)
      .get('/api/customers?pageSize=1000&search=CLFTest&customerType=B2B')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    const customers = res.body.data.customers as Array<{ customerName: string; customerType: string }>;
    const ours = customers.filter((c) => c.customerName.startsWith('CLFTest'));
    expect(ours).toHaveLength(2);
    expect(ours.every((c) => c.customerType === 'B2B')).toBe(true);
  });

  it('customerType=B2C returns only B2C rows', async () => {
    const res = await request(app)
      .get('/api/customers?pageSize=1000&search=CLFTest&customerType=B2C')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    const customers = res.body.data.customers as Array<{ customerName: string; customerType: string }>;
    const ours = customers.filter((c) => c.customerName.startsWith('CLFTest'));
    expect(ours).toHaveLength(3);
    expect(ours.every((c) => c.customerType === 'B2C')).toBe(true);
  });

  it('combines customerType=B2B with status=active', async () => {
    const res = await request(app)
      .get('/api/customers?pageSize=1000&search=CLFTest&customerType=B2B&status=active')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    const customers = res.body.data.customers as Array<{ customerName: string; customerType: string; status: string }>;
    const ours = customers.filter((c) => c.customerName.startsWith('CLFTest'));
    expect(ours).toHaveLength(2);
    expect(ours.every((c) => c.customerType === 'B2B' && c.status === 'active')).toBe(true);
  });

  it('rejects invalid customerType values', async () => {
    const res = await request(app)
      .get('/api/customers?customerType=commercial')
      .set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  it('cross-tenant: other distributor cannot see our CLFTest customers', async () => {
    const res = await request(app)
      .get('/api/customers?pageSize=1000&search=CLFTest&customerType=B2B')
      .set(auth(otherDistAdminToken));
    expect(res.status).toBe(200);
    const customers = res.body.data.customers as Array<{ customerName: string }>;
    const leaked = customers.filter((c) => c.customerName.startsWith('CLFTest'));
    expect(leaked).toHaveLength(0);
  });
});
