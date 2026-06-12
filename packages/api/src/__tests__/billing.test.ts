import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, loginAsSuperAdmin, getSeedData } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let saToken: string; // super admin
let adminToken: string; // dist-001 distributor admin

const createdCycleIds: string[] = [];

beforeAll(async () => {
  app = createApp();
  saToken = (await loginAsSuperAdmin()).token;
  adminToken = (await loginAsDistAdmin()).token;
  await getSeedData();

  // Make sure dist-001 has GasLink billing enabled (needed for /generate).
  await prisma.distributor.update({
    where: { id: 'dist-001' },
    data: {
      gaslinkBillingEnabled: true,
      subscriptionPlan: 'business',
      // 9-issues Issue 8 (2026-06-12): Business plan maps to tier_3, not
      // tier_2 (deriveBillingTierFromPlan in billingService). Was tier_2
      // here — stale carry-over from the pre-Phase-4a 4-tier table.
      billingTier: 'tier_3',
      billingSuspended: false,
    },
  });
});

afterAll(async () => {
  // Clean up any cycles + billing items we created
  if (createdCycleIds.length > 0) {
    await prisma.billingItem.deleteMany({ where: { billingCycleId: { in: createdCycleIds } } });
    await prisma.billingCycle.deleteMany({ where: { id: { in: createdCycleIds } } });
  }
  // Reset suspension state
  await prisma.distributor.update({
    where: { id: 'dist-001' },
    data: { billingSuspended: false },
  });
});

function auth(token: string, distId?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (distId) headers['X-Distributor-Id'] = distId;
  return headers;
}

describe('Billing — Auth', () => {
  it('rejects unauthenticated /cycles with 401', async () => {
    const res = await request(app).get('/api/billing/cycles');
    expect(res.status).toBe(401);
  });

  it('non-super_admin cannot trigger /generate (403)', async () => {
    const res = await request(app)
      .post('/api/billing/generate')
      .set(auth(adminToken))
      .send({
        distributorId: 'dist-001',
        periodType: 'monthly',
        periodStartDate: '2026-01-01',
        periodEndDate: '2026-01-31',
      });
    expect(res.status).toBe(403);
  });

  it('non-super_admin cannot trigger /suspend (403)', async () => {
    const res = await request(app)
      .post('/api/billing/suspend/dist-001')
      .set(auth(adminToken));
    expect(res.status).toBe(403);
  });
});

describe('Billing — Generate', () => {
  it('generates a billing cycle (super_admin)', async () => {
    const res = await request(app)
      .post('/api/billing/generate')
      .set(auth(saToken, 'dist-001'))
      .send({
        distributorId: 'dist-001',
        periodType: 'monthly',
        periodStartDate: '2026-01-01',
        periodEndDate: '2026-01-31',
      });
    if (res.status !== 201) console.log('generate error:', res.body);
    expect(res.status).toBe(201);
    expect(res.body.data.cycleId).toBeDefined();
    expect(res.body.data.distributorId).toBe('dist-001');
    createdCycleIds.push(res.body.data.cycleId);
  });

  it('rejects /generate with missing fields (400)', async () => {
    const res = await request(app)
      .post('/api/billing/generate')
      .set(auth(saToken, 'dist-001'))
      .send({ distributorId: 'dist-001' });
    expect(res.status).toBe(400);
  });

  it('rejects /generate when cycle for same period already exists (400)', async () => {
    const res = await request(app)
      .post('/api/billing/generate')
      .set(auth(saToken, 'dist-001'))
      .send({
        distributorId: 'dist-001',
        periodType: 'monthly',
        periodStartDate: '2026-01-01',
        periodEndDate: '2026-01-31',
      });
    expect(res.status).toBe(400);
  });
});

describe('Billing — List & detail', () => {
  it('lists billing cycles for caller distributor', async () => {
    const res = await request(app)
      .get('/api/billing/cycles')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.cycles)).toBe(true);
    for (const c of res.body.data.cycles) {
      expect(c.distributorId).toBe('dist-001');
    }
  });

  it('fetches a cycle by id', async () => {
    const cycleId = createdCycleIds[0];
    const res = await request(app)
      .get(`/api/billing/cycles/${cycleId}`)
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.cycleId).toBe(cycleId);
  });

  it('returns 404 when fetching another distributor\'s cycle', async () => {
    // Create a cycle on dist-002 first.
    await prisma.distributor.update({
      where: { id: 'dist-002' },
      // 9-issues Issue 8: Business plan → tier_3.
      data: { gaslinkBillingEnabled: true, subscriptionPlan: 'business', billingTier: 'tier_3' },
    });
    const dist2Cycle = await prisma.billingCycle.create({
      data: {
        distributorId: 'dist-002',
        periodType: 'monthly',
        periodStartDate: new Date('2026-02-01'),
        periodEndDate: new Date('2026-02-28'),
        // 9-issues Issue 8: matches the distributor's billingTier above.
        billingTier: 'tier_3',
        totalAmountExclGst: 0,
        totalGstAmount: 0,
        totalAmountInclGst: 0,
        billingStatus: 'invoice_generated',
      },
    });
    createdCycleIds.push(dist2Cycle.id);

    const res = await request(app)
      .get(`/api/billing/cycles/${dist2Cycle.id}`)
      .set(auth(adminToken)); // dist-001 admin
    expect(res.status).toBe(404);
  });
});

describe('Billing — Mark paid', () => {
  it('marks a cycle as paid (super_admin)', async () => {
    const cycleId = createdCycleIds[0];
    const res = await request(app)
      .put(`/api/billing/cycles/${cycleId}/mark-paid`)
      .set(auth(saToken, 'dist-001'));
    if (res.status !== 200) console.log('mark-paid error:', res.body);
    expect(res.status).toBe(200);
    expect(res.body.data.billingStatus).toBe('paid_billing');
  });
});

describe('Billing — Suspend / Unsuspend', () => {
  it('suspends a distributor (super_admin)', async () => {
    const res = await request(app)
      .post('/api/billing/suspend/dist-001')
      .set(auth(saToken, 'dist-001'));
    expect(res.status).toBe(200);

    const dist = await prisma.distributor.findUniqueOrThrow({ where: { id: 'dist-001' } });
    expect(dist.billingSuspended).toBe(true);
  });

  it('unsuspends a distributor (super_admin)', async () => {
    const res = await request(app)
      .post('/api/billing/unsuspend/dist-001')
      .set(auth(saToken, 'dist-001'));
    expect(res.status).toBe(200);

    const dist = await prisma.distributor.findUniqueOrThrow({ where: { id: 'dist-001' } });
    expect(dist.billingSuspended).toBe(false);
  });
});
