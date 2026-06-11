import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, loginAsSuperAdmin, loginAsFinance } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let saToken: string;
let financeToken: string;

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;
  saToken = (await loginAsSuperAdmin()).token;
  financeToken = (await loginAsFinance()).token;
});

afterAll(async () => {
  // Clean up any pending seat requests we created
  await prisma.seatRequest.deleteMany({
    where: { distributorId: 'dist-001', reason: { startsWith: 'TEST-PRICING-' } },
  });
});

function auth(token: string, distId?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (distId) headers['X-Distributor-Id'] = distId;
  return headers;
}

describe('Pricing — Auth', () => {
  it('rejects unauthenticated GET /tiers with 401', async () => {
    const res = await request(app).get('/api/pricing/tiers');
    expect(res.status).toBe(401);
  });

  it('rejects /tiers for non-super_admin (403)', async () => {
    const res = await request(app).get('/api/pricing/tiers').set(auth(adminToken));
    expect(res.status).toBe(403);
  });

  it('rejects /gst-usage/all for non-super_admin (403)', async () => {
    const res = await request(app)
      .get('/api/pricing/gst-usage/all')
      .set(auth(adminToken));
    expect(res.status).toBe(403);
  });
});

describe('Pricing — Tiers (super_admin)', () => {
  it('GET /tiers returns the seeded pricing tiers', async () => {
    const res = await request(app).get('/api/pricing/tiers').set(auth(saToken));
    if (res.status !== 200) console.log('tiers error:', res.body);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.tiers)).toBe(true);
    const planNames = res.body.data.tiers.map((t: { plan: string }) => t.plan).sort();
    // Phase 4a (2026-06-12): Ultra tier added for distributors above 50k
    // cylinders/month. Spec lives in prisma/seed.ts and is regression-pinned
    // by phase4a-pricing-tiers.test.ts.
    expect(planNames).toEqual(['business', 'enterprise', 'growth', 'starter', 'ultra']);
  });
});

describe('Pricing — Seat limits & GST usage', () => {
  it('GET /seat-limits returns limits for caller distributor', async () => {
    const res = await request(app).get('/api/pricing/seat-limits').set(auth(adminToken));
    expect(res.status).toBe(200);
    // Either { limits: ... } or { limits: null, message: ... } per the route
    expect(res.body.data).toBeDefined();
  });

  it('GET /gst-usage returns 200 with usage payload', async () => {
    const res = await request(app).get('/api/pricing/gst-usage').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });

  it('GET /gst-usage/history returns 200 with history array', async () => {
    const res = await request(app)
      .get('/api/pricing/gst-usage/history')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data?.history)).toBe(true);
  });

  it('super_admin without X-Distributor-Id gets 400 on /seat-limits', async () => {
    const res = await request(app).get('/api/pricing/seat-limits').set(auth(saToken));
    expect(res.status).toBe(400);
  });
});

describe('Pricing — Seat requests', () => {
  let requestId: string;

  it('POST /seat-requests creates a request', async () => {
    const res = await request(app)
      .post('/api/pricing/seat-requests')
      .set(auth(adminToken))
      .send({ requestedRole: 'driver', reason: 'TEST-PRICING-need-extra-driver' });
    if (res.status !== 201) console.log('seat-request create error:', res.body);
    expect(res.status).toBe(201);
    expect(res.body.data.distributorId).toBe('dist-001');
    requestId = res.body.data.id;
  });

  it('rejects POST without requestedRole (400)', async () => {
    const res = await request(app)
      .post('/api/pricing/seat-requests')
      .set(auth(adminToken))
      .send({ reason: 'no role' });
    expect(res.status).toBe(400);
  });

  it('GET /seat-requests scoped to caller distributor', async () => {
    const res = await request(app)
      .get('/api/pricing/seat-requests')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.requests)).toBe(true);
    for (const r of res.body.data.requests) {
      expect(r.distributorId).toBe('dist-001');
    }
  });

  it('non-super_admin cannot approve a seat request (403)', async () => {
    const res = await request(app)
      .put(`/api/pricing/seat-requests/${requestId}/approve`)
      .set(auth(financeToken));
    expect(res.status).toBe(403);
  });

  it('super_admin can approve a seat request', async () => {
    const res = await request(app)
      .put(`/api/pricing/seat-requests/${requestId}/approve`)
      .set(auth(saToken, 'dist-001'));
    if (res.status !== 200) console.log('seat-request approve error:', res.body);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('approved_seat');
  });

  it('super_admin can reject a separate seat request', async () => {
    const created = await request(app)
      .post('/api/pricing/seat-requests')
      .set(auth(adminToken))
      .send({ requestedRole: 'finance', reason: 'TEST-PRICING-reject-me' });
    expect(created.status).toBe(201);

    const res = await request(app)
      .put(`/api/pricing/seat-requests/${created.body.data.id}/reject`)
      .set(auth(saToken, 'dist-001'));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('rejected_seat');
  });
});
