/**
 * Group L4 (2026-06-11) — onboarding-progress wire-shape guard.
 *
 * The web's PostResetRedirect (packages/web/src/routes/ProtectedRoute.tsx)
 * compares `progress.requiredDoneCount < progress.requiredTotal` to decide
 * whether to redirect a newly re-logged-in distributor_admin to the
 * Onboarding tab. If those field names or their numeric shape ever
 * drift, the frontend silently never redirects (we just see the empty
 * Analytics dashboard again). This test pins the contract.
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
