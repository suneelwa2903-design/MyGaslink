/**
 * Group L4 (2026-06-11) — onboarding-progress wire-shape guard.
 *
 * Originally written to pin the contract consumed by the now-removed
 * web `PostResetRedirect` (deleted 2026-06-12 — CLAUDE.md anti-pattern
 * #22). The endpoint is still consumed by the OnboardingCard on the
 * Settings page and by the dashboard onboarding banner, both of which
 * read `progress.requiredDoneCount / requiredTotal` and `progress.show`.
 * If those field names or their numeric shape drift, those consumers
 * silently render empty. This test pins the contract.
 *
 * Anti-pattern #9 ref: "API response type-annotated as one shape but
 * route returns another."
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { loginAsDistAdmin } from './helpers.js';

const app = createApp();
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

let distAdminToken: string;

beforeAll(async () => {
  const da = await loginAsDistAdmin();
  distAdminToken = da.token;
});

describe('L4 — /customers/onboarding/progress wire shape', () => {
  it('returns requiredTotal + requiredDoneCount as integers', async () => {
    const res = await request(app)
      .get('/api/customers/onboarding/progress')
      .set(bearer(distAdminToken));
    expect(res.status).toBe(200);
    const body = res.body.data as { requiredTotal: unknown; requiredDoneCount: unknown; show: unknown };
    expect(typeof body.requiredTotal).toBe('number');
    expect(typeof body.requiredDoneCount).toBe('number');
    expect(typeof body.show).toBe('boolean');
    expect(Number.isInteger(body.requiredTotal)).toBe(true);
    expect(Number.isInteger(body.requiredDoneCount)).toBe(true);
    expect(body.requiredTotal).toBeGreaterThan(0);
    expect(body.requiredDoneCount).toBeGreaterThanOrEqual(0);
  });

  it('requiredDoneCount is never greater than requiredTotal', async () => {
    const res = await request(app)
      .get('/api/customers/onboarding/progress')
      .set(bearer(distAdminToken));
    expect(res.body.data.requiredDoneCount).toBeLessThanOrEqual(res.body.data.requiredTotal);
  });
});
