/**
 * 2026-06-15 — inventory mobile parity (re-export wave).
 *
 * Source-file guards proving every (inventory)/* screen is a thin
 * re-export of its (admin)/* counterpart (mirrors the Phase A
 * finance re-export tests). Also pins the absence of any
 * hardcoded `/(admin)/` paths in the three admin files swept by
 * the prerequisite commit — dashboard.tsx, customers.tsx,
 * more.tsx — so a future edit that re-introduces one trips this
 * guard.
 *
 * Pure file-content checks; no DB or HTTP. Runs in vitest alongside
 * the existing phaseA-finance-mobile-parity.test.ts and the earlier
 * phaseB-inventory-mobile-parity.test.ts (server-side B1 contract).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const MOBILE = resolve(__dirname, '../../../mobile/app');

function readMobile(rel: string): string {
  return readFileSync(resolve(MOBILE, rel), 'utf-8');
}

describe('Phase B re-export — (inventory)/* screens are re-exports of (admin)/*', () => {
  it('(inventory)/analytics.tsx re-exports (admin)/dashboard', () => {
    const src = readMobile('(inventory)/analytics.tsx');
    expect(src).toMatch(/export\s*\{\s*default\s*\}\s*from\s*['"]\.\.\/\(admin\)\/dashboard['"]/);
  });

  it('(inventory)/orders.tsx re-exports (admin)/orders', () => {
    const src = readMobile('(inventory)/orders.tsx');
    expect(src).toMatch(/export\s*\{\s*default\s*\}\s*from\s*['"]\.\.\/\(admin\)\/orders['"]/);
  });

  it('(inventory)/inventory.tsx re-exports (admin)/inventory', () => {
    const src = readMobile('(inventory)/inventory.tsx');
    expect(src).toMatch(/export\s*\{\s*default\s*\}\s*from\s*['"]\.\.\/\(admin\)\/inventory['"]/);
  });

  it('(inventory)/fleet.tsx re-exports (admin)/fleet', () => {
    const src = readMobile('(inventory)/fleet.tsx');
    expect(src).toMatch(/export\s*\{\s*default\s*\}\s*from\s*['"]\.\.\/\(admin\)\/fleet['"]/);
  });

  it('(inventory)/customers.tsx re-exports (admin)/customers', () => {
    const src = readMobile('(inventory)/customers.tsx');
    expect(src).toMatch(/export\s*\{\s*default\s*\}\s*from\s*['"]\.\.\/\(admin\)\/customers['"]/);
  });

  it('(inventory)/customer-detail.tsx re-exports (admin)/customer-detail', () => {
    const src = readMobile('(inventory)/customer-detail.tsx');
    expect(src).toMatch(/export\s*\{\s*default\s*\}\s*from\s*['"]\.\.\/\(admin\)\/customer-detail['"]/);
  });

  it('(inventory)/more.tsx re-exports (admin)/more', () => {
    const src = readMobile('(inventory)/more.tsx');
    expect(src).toMatch(/export\s*\{\s*default\s*\}\s*from\s*['"]\.\.\/\(admin\)\/more['"]/);
  });

  it('(inventory)/reports.tsx re-exports (admin)/reports with NO allowedKeys (full 7-report surface)', () => {
    const src = readMobile('(inventory)/reports.tsx');
    expect(src).toMatch(/export\s*\{\s*default\s*\}\s*from\s*['"]\.\.\/\(admin\)\/reports['"]/);
    expect(src).not.toMatch(/allowedKeys/);
    expect(src).not.toMatch(/INVENTORY_REPORT_KEYS/);
  });
});

describe('Phase B re-export — hidden routable screens registered for dashboard / FAB pushes', () => {
  it('(inventory)/finance.tsx exists and re-exports (admin)/finance (Overdue Invoices KPI target)', () => {
    const src = readMobile('(inventory)/finance.tsx');
    expect(src).toMatch(/export\s*\{\s*default\s*\}\s*from\s*['"]\.\.\/\(admin\)\/finance['"]/);
  });

  it('(inventory)/collections.tsx exists and re-exports (admin)/collections (Outstanding KPI target)', () => {
    const src = readMobile('(inventory)/collections.tsx');
    expect(src).toMatch(/export\s*\{\s*default\s*\}\s*from\s*['"]\.\.\/\(admin\)\/collections['"]/);
  });

  it('(inventory)/customer-create.tsx exists and re-exports (admin)/customer-create (FAB target)', () => {
    const src = readMobile('(inventory)/customer-create.tsx');
    expect(src).toMatch(/export\s*\{\s*default\s*\}\s*from\s*['"]\.\.\/\(admin\)\/customer-create['"]/);
  });

  it('(inventory)/pending-actions.tsx exists and re-exports (admin)/pending-actions', () => {
    const src = readMobile('(inventory)/pending-actions.tsx');
    expect(src).toMatch(/export\s*\{\s*default\s*\}\s*from\s*['"]\.\.\/\(admin\)\/pending-actions['"]/);
  });
});

describe('Phase B re-export — (inventory)/_layout.tsx mirrors admin layout shape', () => {
  const layout = readMobile('(inventory)/_layout.tsx');

  it('uses ScrollableTabBar like admin (not the default Tabs bar)', () => {
    expect(layout).toMatch(/ScrollableTabBar/);
  });

  it('declares 7 visible tabs: analytics, orders, inventory, reports, customers, fleet, more', () => {
    for (const name of ['analytics', 'orders', 'inventory', 'reports', 'customers', 'fleet', 'more']) {
      expect(layout).toMatch(new RegExp(`name=["']${name}["']`));
    }
  });

  it('hides Billing (finance), Collections, customer-detail, customer-create, profile, pending-actions with href: null', () => {
    for (const name of ['finance', 'collections', 'customer-detail', 'customer-create', 'profile', 'pending-actions']) {
      const re = new RegExp(`name=["']${name}["'][^/]*href:\\s*null`, 's');
      expect(layout).toMatch(re);
    }
  });

  it('analytics tab title displays as "Dashboard" (file named analytics but UX matches admin)', () => {
    expect(layout).toMatch(/name=["']analytics["'][\s\S]*?title:\s*['"]Dashboard['"]/);
  });
});

describe('Phase B re-export — old sub-pill files removed', () => {
  it.each(['summary', 'actions', 'reconciliation', 'alerts'])(
    '(inventory)/%s.tsx no longer exists',
    (name) => {
      expect(existsSync(resolve(MOBILE, `(inventory)/${name}.tsx`))).toBe(false);
    },
  );
});

describe('Phase B re-export — no hardcoded /(admin)/ paths left in shared admin screens', () => {
  it('(admin)/dashboard.tsx has zero /(admin)/ paths (KPI_CARDS swept)', () => {
    const src = readMobile('(admin)/dashboard.tsx');
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(noComments).not.toMatch(/['"]\/\(admin\)\//);
  });

  it('(admin)/customers.tsx has zero /(admin)/ paths', () => {
    const src = readMobile('(admin)/customers.tsx');
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(noComments).not.toMatch(/['"]\/\(admin\)\//);
  });

  it('(admin)/more.tsx has zero /(admin)/ paths (profile push swept)', () => {
    const src = readMobile('(admin)/more.tsx');
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(noComments).not.toMatch(/['"]\/\(admin\)\//);
  });
});
