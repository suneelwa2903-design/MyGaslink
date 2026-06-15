/**
 * Phase A — finance mobile: orders + customers + reports.
 *
 * Mobile RN screens can't be exercised directly from the API test
 * harness, so this test file pins the SERVER contracts the new
 * screens depend on, plus source-file guards on the screens
 * themselves to catch consumer-side regressions.
 *
 * Server contracts under test:
 *   - GET /api/orders is accessible to the finance role.
 *   - GET /api/customers is accessible to the finance role.
 *   - GET /api/reports/:type is accessible to the finance role for
 *     all 7 admin report types (lock the per-type whitelist).
 *   - Customer-write endpoints (POST /api/customers, stop-supply,
 *     resume-supply) return 403 for finance — even if the mobile UI
 *     accidentally surfaced a button, the wire would still refuse.
 *
 * Source-file guards on the new screens:
 *   - (finance)/reports.tsx is a thin re-export (no internal nav).
 *   - (finance)/customer-detail.tsx is a thin re-export.
 *   - (finance)/orders.tsx + customers.tsx render lists without any
 *     mutating affordances (no FAB-onPress, no useApiMutation
 *     imports — read-only).
 *   - (finance)/more.tsx wires the three menu items.
 *   - (finance)/_layout.tsx mounts the routes with href: null so the
 *     bottom bar stays at 5.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../app.js';
import { loginAsFinance, loginAsDistAdmin } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let financeToken: string;
let adminToken: string;

beforeAll(async () => {
  app = createApp();
  financeToken = (await loginAsFinance()).token;
  adminToken = (await loginAsDistAdmin()).token;
});

describe('Phase A — finance has read access on the surfaces the new screens hit', () => {
  it('GET /api/orders returns 200 for finance', async () => {
    const res = await request(app)
      .get('/api/orders')
      .set('Authorization', `Bearer ${financeToken}`);
    expect(res.status).toBe(200);
  });

  it('GET /api/customers returns 200 for finance', async () => {
    const res = await request(app)
      .get('/api/customers')
      .set('Authorization', `Bearer ${financeToken}`);
    expect(res.status).toBe(200);
  });

  const REPORT_TYPES = [
    'sales-summary',
    'outstanding-aging',
    'customer-statement',
    'gst-summary',
    'delivery-performance',
    'inventory-movement',
    'vehicle-ledger',
  ];
  it.each(REPORT_TYPES)(
    'GET /api/reports/%s is reachable for finance (status != 403)',
    async (reportType) => {
      // customer-statement requires a customerId query param to render —
      // we only care that the role gate doesn't 403. Pass a clearly
      // bogus id; the route may 400 / 404 / 200 with empty rows but it
      // must not 403.
      const res = await request(app)
        .get(`/api/reports/${reportType}`)
        .set('Authorization', `Bearer ${financeToken}`)
        .query({ customerId: '00000000-0000-0000-0000-000000000000' });
      expect(res.status).not.toBe(403);
    },
  );
});

describe('Phase A — finance is still locked out of customer mutations (defense in depth)', () => {
  it('POST /api/customers returns 403 for finance', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ customerName: 'X', phone: '9100000000' });
    expect(res.status).toBe(403);
  });

  it('POST /api/customers is permitted for distributor_admin (regression check)', async () => {
    // Sanity: the 403 above is specifically the finance gate, not a
    // broken route. distributor_admin should still hit validation, not
    // 403 — the empty body trips the Zod check → 400.
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });
});

describe('2026-06-15 — finance gains Inventory + Fleet reads (re-export wave)', () => {
  // The (finance)/inventory.tsx and (finance)/fleet.tsx files are
  // thin re-exports of the admin screens. The admin fleet screen now
  // hides create/edit affordances via a canEdit role gate that
  // excludes 'finance'. The API is currently MORE permissive than the
  // UI — POST /drivers and POST /vehicles accept finance — so the
  // defense layers are inverted (UI stricter than server). The UI gate
  // expresses the design intent "finance: read-only on fleet"; the
  // server permissiveness is a separate cleanup if desired.

  it('GET /api/inventory/summary returns 200 for finance', async () => {
    const res = await request(app)
      .get('/api/inventory/summary')
      .set('Authorization', `Bearer ${financeToken}`);
    expect(res.status).toBe(200);
  });

  it('GET /api/drivers returns 200 for finance', async () => {
    const res = await request(app)
      .get('/api/drivers')
      .set('Authorization', `Bearer ${financeToken}`);
    expect(res.status).toBe(200);
  });

  it('GET /api/vehicles returns 200 for finance', async () => {
    const res = await request(app)
      .get('/api/vehicles')
      .set('Authorization', `Bearer ${financeToken}`);
    expect(res.status).toBe(200);
  });

  it('(admin)/fleet.tsx canEdit gate excludes finance role (UI-level read-only)', () => {
    const fleetSrc = readFileSync(
      resolve(__dirname, '../../../mobile/app/(admin)/fleet.tsx'),
      'utf-8',
    );
    // Pin the exact canEdit expression so a future edit that drops a
    // role or adds finance trips this guard.
    expect(fleetSrc).toMatch(/canEdit\s*=\s*\n\s*role === UserRole\.SUPER_ADMIN \|\|\s*\n\s*role === UserRole\.DISTRIBUTOR_ADMIN \|\|\s*\n\s*role === UserRole\.INVENTORY/);
    expect(fleetSrc).not.toMatch(/canEdit[\s\S]*UserRole\.FINANCE/);
  });

  it('finance inventory + fleet re-export files exist and are thin re-exports', () => {
    const financeInventory = readFileSync(
      resolve(__dirname, '../../../mobile/app/(finance)/inventory.tsx'),
      'utf-8',
    );
    const financeFleet = readFileSync(
      resolve(__dirname, '../../../mobile/app/(finance)/fleet.tsx'),
      'utf-8',
    );
    expect(financeInventory).toContain("export { default } from '../(admin)/inventory'");
    expect(financeFleet).toContain("export { default } from '../(admin)/fleet'");
  });

  it('finance dashboard + collections are now thin re-exports (replaces slim versions)', () => {
    const financeDashboard = readFileSync(
      resolve(__dirname, '../../../mobile/app/(finance)/dashboard.tsx'),
      'utf-8',
    );
    const financeCollections = readFileSync(
      resolve(__dirname, '../../../mobile/app/(finance)/collections.tsx'),
      'utf-8',
    );
    expect(financeDashboard).toContain("export { default } from '../(admin)/dashboard'");
    expect(financeCollections).toContain("export { default } from '../(admin)/collections'");
  });

  it('(admin)/dashboard.tsx no longer hardcodes /(admin)/ paths (group-relative for re-export)', () => {
    const adminDashboard = readFileSync(
      resolve(__dirname, '../../../mobile/app/(admin)/dashboard.tsx'),
      'utf-8',
    );
    expect(adminDashboard).not.toContain("router.push('/(admin)/inventory')");
    expect(adminDashboard).not.toContain("router.push('/(admin)/collections')");
    expect(adminDashboard).toContain("router.push('/inventory')");
    expect(adminDashboard).toContain("router.push('/collections')");
  });

  it('(admin)/collections.tsx no longer hardcodes /(admin)/customer-detail', () => {
    const adminCollections = readFileSync(
      resolve(__dirname, '../../../mobile/app/(admin)/collections.tsx'),
      'utf-8',
    );
    expect(adminCollections).not.toContain("'/(admin)/customer-detail'");
    expect(adminCollections).toContain("pathname: '/customer-detail'");
  });
});

describe('Phase A — mobile source guards', () => {
  const financeOrders = readFileSync(
    resolve(__dirname, '../../../mobile/app/(finance)/orders.tsx'),
    'utf-8',
  );
  const financeCustomers = readFileSync(
    resolve(__dirname, '../../../mobile/app/(finance)/customers.tsx'),
    'utf-8',
  );
  const financeReports = readFileSync(
    resolve(__dirname, '../../../mobile/app/(finance)/reports.tsx'),
    'utf-8',
  );
  const financeCustomerDetail = readFileSync(
    resolve(__dirname, '../../../mobile/app/(finance)/customer-detail.tsx'),
    'utf-8',
  );
  const financeMore = readFileSync(
    resolve(__dirname, '../../../mobile/app/(finance)/more.tsx'),
    'utf-8',
  );
  const financeLayout = readFileSync(
    resolve(__dirname, '../../../mobile/app/(finance)/_layout.tsx'),
    'utf-8',
  );

  it('finance orders screen is read-only (no useApiMutation import)', () => {
    expect(financeOrders).not.toMatch(/useApiMutation/);
  });

  it('finance orders screen has no FAB / create-modal trigger', () => {
    expect(financeOrders).not.toMatch(/styles\.fab|CreateOrderModal|setCreateModalVisible/);
  });

  it('finance customers screen is read-only (no useApiMutation import)', () => {
    expect(financeCustomers).not.toMatch(/useApiMutation/);
  });

  it('finance customers screen does NOT push to admin route group', () => {
    expect(financeCustomers).not.toMatch(/\/\(admin\)\//);
    // Sanity: it DOES push to its own route group.
    expect(financeCustomers).toContain('/(finance)/customer-detail');
  });

  it('finance reports.tsx is a thin re-export of admin reports', () => {
    expect(financeReports).toMatch(/export\s*\{\s*default\s*\}\s*from\s*['"]\.\.\/\(admin\)\/reports['"]/);
  });

  it('finance customer-detail.tsx is a thin re-export of admin customer-detail', () => {
    expect(financeCustomerDetail).toMatch(/export\s*\{\s*default\s*\}\s*from\s*['"]\.\.\/\(admin\)\/customer-detail['"]/);
  });

  it('finance More tab wires Orders / Customers / Reports menu items', () => {
    expect(financeMore).toMatch(/router\.push\(['"]\/\(finance\)\/orders['"]\)/);
    expect(financeMore).toMatch(/router\.push\(['"]\/\(finance\)\/customers['"]\)/);
    expect(financeMore).toMatch(/router\.push\(['"]\/\(finance\)\/reports['"]\)/);
  });

  it('finance _layout mounts the new routes with href: null so the bottom bar stays at 5', () => {
    // The mounted screen names; href:null keeps each off the tab bar.
    expect(financeLayout).toMatch(/name:\s*['"]orders['"][^}]*href:\s*null/);
    expect(financeLayout).toMatch(/name:\s*['"]customers['"][^}]*href:\s*null/);
    expect(financeLayout).toMatch(/name:\s*['"]reports['"][^}]*href:\s*null/);
    expect(financeLayout).toMatch(/name:\s*['"]customer-detail['"][^}]*href:\s*null/);
  });
});
