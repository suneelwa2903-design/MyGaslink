import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { loginAsDistAdmin, loginAsSuperAdmin, loginAsInventory, today } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let inventoryToken: string;
let saToken: string;

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;
  inventoryToken = (await loginAsInventory()).token;
  saToken = (await loginAsSuperAdmin()).token;
});

function auth(token: string, distId?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (distId) headers['X-Distributor-Id'] = distId;
  return headers;
}

const dateFrom = '2026-01-01';
const dateTo = today();

// Each endpoint: required-roles → expected response shape (top-level keys we
// can confirm without asserting exact metric values).
const ENDPOINTS: Array<{
  path: string;
  expectedShape: 'object' | 'array';
  /** roles that MUST receive 200 */
  allowed: ('admin' | 'inventory')[];
  /** required query params (skip if absent) */
  query?: string;
}> = [
  { path: '/dashboard',                expectedShape: 'object', allowed: ['admin'] },
  { path: '/header-metrics',           expectedShape: 'object', allowed: ['admin'] },
  { path: '/empty-cylinders',          expectedShape: 'object', allowed: ['admin', 'inventory'] },
  { path: '/due-amounts',              expectedShape: 'object', allowed: ['admin'] },
  { path: `/top-sales?dateFrom=${dateFrom}&dateTo=${dateTo}`, expectedShape: 'object', allowed: ['admin'], query: 'top-sales' },
  { path: `/driver-performance?dateFrom=${dateFrom}&dateTo=${dateTo}`, expectedShape: 'object', allowed: ['admin'], query: 'driver-perf' },
  { path: '/revenue-trends',           expectedShape: 'object', allowed: ['admin'] },
  { path: '/customer-lifetime-value',  expectedShape: 'object', allowed: ['admin'] },
  { path: '/collections',              expectedShape: 'object', allowed: ['admin'] },
  { path: '/advanced-metrics',         expectedShape: 'object', allowed: ['admin'] },
];

describe('Analytics — Auth', () => {
  for (const ep of ENDPOINTS) {
    it(`rejects unauthenticated GET ${ep.path.split('?')[0]} with 401`, async () => {
      const res = await request(app).get(`/api/analytics${ep.path}`);
      expect(res.status).toBe(401);
    });
  }
});

describe('Analytics — Happy path (authenticated admin returns 200 + correct shape)', () => {
  for (const ep of ENDPOINTS) {
    it(`GET ${ep.path.split('?')[0]} returns 200 with ${ep.expectedShape} payload`, async () => {
      const res = await request(app)
        .get(`/api/analytics${ep.path}`)
        .set(auth(adminToken));
      if (res.status !== 200) console.log(`${ep.path} error:`, res.body);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      if (ep.expectedShape === 'array') {
        expect(Array.isArray(res.body.data)).toBe(true);
      } else {
        expect(res.body.data).toBeTypeOf('object');
        expect(res.body.data).not.toBeNull();
      }
    });
  }
});

describe('Analytics — Top-sales query validation', () => {
  it('rejects /top-sales without dateFrom/dateTo (400)', async () => {
    const res = await request(app)
      .get('/api/analytics/top-sales')
      .set(auth(adminToken));
    expect(res.status).toBe(400);
  });
});

describe('Analytics — Role gates', () => {
  it('inventory CAN access /empty-cylinders', async () => {
    const res = await request(app)
      .get('/api/analytics/empty-cylinders')
      .set(auth(inventoryToken));
    expect(res.status).toBe(200);
  });

  // WI-079: inventory was granted FULL analytics access (founder decision —
  // operational staff at this ERP are trusted with financial dashboards).
  // These guards previously asserted 403; they now assert 200.
  it('inventory CAN access /due-amounts (WI-079)', async () => {
    const res = await request(app)
      .get('/api/analytics/due-amounts')
      .set(auth(inventoryToken));
    expect(res.status).toBe(200);
  });

  it('inventory CAN access /dashboard (WI-079)', async () => {
    const res = await request(app)
      .get('/api/analytics/dashboard')
      .set(auth(inventoryToken));
    expect(res.status).toBe(200);
  });

  it('inventory CAN access /collections (WI-079)', async () => {
    const res = await request(app)
      .get('/api/analytics/collections')
      .set(auth(inventoryToken));
    expect(res.status).toBe(200);
  });
});

describe('Analytics — Tenant isolation via X-Distributor-Id', () => {
  it('super_admin with X-Distributor-Id: dist-001 sees dist-001 numbers, not dist-002', async () => {
    const r1 = await request(app)
      .get('/api/analytics/header-metrics')
      .set(auth(saToken, 'dist-001'));
    expect(r1.status).toBe(200);

    const r2 = await request(app)
      .get('/api/analytics/header-metrics')
      .set(auth(saToken, 'dist-002'));
    expect(r2.status).toBe(200);

    // The two payloads are based on different tenants and must not be
    // identical. We don't assert any specific number — just that scoping
    // discriminated the result.
    expect(JSON.stringify(r1.body.data)).not.toBe(JSON.stringify(r2.body.data));
  });

  it('super_admin without X-Distributor-Id is rejected on tenant-scoped endpoints', async () => {
    const res = await request(app)
      .get('/api/analytics/header-metrics')
      .set(auth(saToken));
    // requireDistributor middleware rejects with NO_DISTRIBUTOR_SELECTED
    expect([400, 500]).toContain(res.status);
    expect(res.body.success).toBe(false);
  });
});
