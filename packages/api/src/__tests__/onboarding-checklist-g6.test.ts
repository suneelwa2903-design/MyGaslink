/**
 * Group 6 (2026-06-11) — Onboarding checklist fixes.
 *
 * Pins the new shape of the checklist returned by getOnboardingProgress:
 *   - cylinder_types is GREEN only when types AND prices both exist
 *   - drivers is GREEN only when at least one driver has a User login
 *   - new required steps: opening_empties, doc_code, godown_address
 *   - new optional steps: go_live_date, test_order
 *   - all the old steps still present
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { getOnboardingProgress } from '../services/customerService.js';
import { loginAsDistAdmin } from './helpers.js';

let distributorId: string;

beforeAll(async () => {
  const admin = await loginAsDistAdmin();
  distributorId = admin.distributorId;
});

describe('G6 — onboarding checklist new shape', () => {
  it('positive: every expected step key is present', async () => {
    const r = await getOnboardingProgress(distributorId);
    const keys = r.steps.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining([
      'cylinder_types', 'drivers', 'customers',
      'opening_stock', 'opening_balances', 'opening_empties',
      'doc_code', 'godown_address', 'go_live_date', 'test_order', 'gst',
    ]));
  });

  it('positive: required steps include the new ones (opening_empties, doc_code, godown_address) but NOT optional ones (go_live_date, test_order, gst)', async () => {
    const r = await getOnboardingProgress(distributorId);
    const requiredKeys = r.steps.filter((s) => !s.optional).map((s) => s.key);
    expect(requiredKeys).toContain('opening_empties');
    expect(requiredKeys).toContain('doc_code');
    expect(requiredKeys).toContain('godown_address');
    expect(requiredKeys).not.toContain('go_live_date');
    expect(requiredKeys).not.toContain('test_order');
    expect(requiredKeys).not.toContain('gst');
  });

  it('regression: optional steps still carry the optional flag', async () => {
    const r = await getOnboardingProgress(distributorId);
    const goLive = r.steps.find((s) => s.key === 'go_live_date');
    expect(goLive?.optional).toBe(true);
    const testOrder = r.steps.find((s) => s.key === 'test_order');
    expect(testOrder?.optional).toBe(true);
    const gst = r.steps.find((s) => s.key === 'gst');
    expect(gst?.optional).toBe(true);
  });

  it('positive: cylinder_types is done only when types AND prices both exist (dist-001 seed has both → done)', async () => {
    const r = await getOnboardingProgress(distributorId);
    const step = r.steps.find((s) => s.key === 'cylinder_types');
    expect(step?.done).toBe(true);
  });

  it('positive: drivers step pins on driver-with-login (seed has raju@gasagency.com)', async () => {
    const r = await getOnboardingProgress(distributorId);
    const step = r.steps.find((s) => s.key === 'drivers');
    expect(step?.done).toBe(true);
  });
});
