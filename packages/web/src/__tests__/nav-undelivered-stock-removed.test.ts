/**
 * Navigation guards for the Vehicle Return / Undelivered Stock merge.
 * These are source-file assertions (not component renders) — cheaper and
 * sufficient to lock in the removal of the deprecated surfaces.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const inventoryPage = readFileSync(resolve(__dirname, '../pages/InventoryPage.tsx'), 'utf-8');
const routes = readFileSync(resolve(__dirname, '../routes/index.tsx'), 'utf-8');

describe('Vehicle Return / Undelivered Stock merge — nav guards', () => {
  it('InventoryPage does NOT register an Undelivered Stock tab', () => {
    expect(inventoryPage).not.toMatch(/label: ?['"]Undelivered Stock['"]/);
    expect(inventoryPage).not.toMatch(/key: ?['"]cancelled['"] as const/);
  });

  it('InventoryPage does NOT reference the deleted CancelledStockStatus shared enum', () => {
    expect(inventoryPage).not.toContain('CancelledStockStatus');
  });

  it('routes/index.tsx does NOT define the standalone /reconciliation route', () => {
    // The redirect route was a temporary forwarding entry — once the orphaned
    // ReconciliationPage was deleted, the route entry was removed too.
    expect(routes).not.toMatch(/path=['"]reconciliation['"]/);
  });
});
