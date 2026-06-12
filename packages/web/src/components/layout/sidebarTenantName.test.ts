/**
 * Source-file guards for the tenant-name surface.
 *
 * Phase 2 originally rendered the distributor name as a third line in
 * the Sidebar brand block. 9-issues Issue 1 (2026-06-12) moved it to
 * the top header (DashboardLayout) because the sidebar is hidden /
 * collapsed often and the header is universally visible. These guards
 * pin BOTH halves:
 *   1. Sidebar.tsx does NOT render `user.distributorName` anymore
 *      (regression catch for a slip back to the duplicated render).
 *   2. DashboardLayout.tsx DOES render `user.distributorName` in the
 *      header, with truncation + the `!showDistributorSelector` gate
 *      so super-admin (who already has the DistributorSelector) doesn't
 *      double-show.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sidebarSource = readFileSync(resolve(__dirname, './Sidebar.tsx'), 'utf-8');
const layoutSource = readFileSync(resolve(__dirname, './DashboardLayout.tsx'), 'utf-8');

describe('Tenant name surface — sidebar removal (9-issues Issue 1)', () => {
  it('Sidebar no longer reads user.distributorName for rendering', () => {
    // The guard catches a slip-back to the Phase 2 third-line render.
    // It allows the field to be MENTIONED in comments (we want the
    // history note about WHY it was removed to stay).
    const codeOnly = sidebarSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toContain('user?.distributorName');
    expect(codeOnly).not.toContain('user.distributorName');
  });
});

describe('Tenant name surface — top header (9-issues Issue 1)', () => {
  it('DashboardLayout reads user.distributorName', () => {
    expect(layoutSource).toMatch(/user\?\.distributorName/);
  });

  it('renders only when DistributorSelector is NOT already there (super-admin gate)', () => {
    // `!showDistributorSelector` keeps super-admin from double-rendering.
    expect(layoutSource).toMatch(/!showDistributorSelector/);
  });

  it('truncates long tenant names so the header does not overflow', () => {
    expect(layoutSource).toMatch(/truncate/);
  });

  it('is desktop-only (hidden lg:block) so the mobile header stays tight', () => {
    expect(layoutSource).toMatch(/hidden\s+lg:block/);
  });
});
