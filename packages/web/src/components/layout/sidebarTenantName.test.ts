/**
 * Source-file guard for the Phase 2 distributor-name surface in the
 * web sidebar.
 *
 * Anti-pattern #9 (response shape) protects the wire side; this guard
 * protects the consumer side. If Sidebar.tsx stops reading
 * user.distributorName — or the truthy guard around it is removed
 * (which would crash super-admin sessions with `null.toString()` on
 * some renderers) — every distributor_admin sees a blank brand block.
 *
 * Pure source-file regex assertions, matching nav-undelivered-stock-removed.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sidebarSource = readFileSync(
  resolve(__dirname, './Sidebar.tsx'),
  'utf-8',
);

describe('Sidebar — Phase 2 tenant name surface', () => {
  it('reads user.distributorName from the auth store', () => {
    expect(sidebarSource).toMatch(/user\?\.distributorName/);
  });

  it('renders the tenant name conditionally (skip on null — super-admin path)', () => {
    // Truthy guard before the JSX expression. `user?.distributorName && (`
    // is the canonical shape; this regex tolerates whitespace.
    expect(sidebarSource).toMatch(/user\?\.distributorName\s*&&\s*\(/);
  });

  it('truncates long tenant names so the brand block does not blow out the sidebar width', () => {
    expect(sidebarSource).toMatch(/truncate/);
  });
});
