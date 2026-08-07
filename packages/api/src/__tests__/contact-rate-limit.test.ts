/**
 * Guards for the two real findings from the 2026-08-07 codebase sweep.
 *
 * FINDING 2 — the public contact form had no dedicated rate limiter. It
 * writes a `contact_submissions` row and fires a notification email per
 * request, so it inherited only the global 1000-per-15-min app budget —
 * a usable inbox-flood / DB-growth vector. Every other sensitive public
 * route (login / refresh / forgot-password / verify-reset-otp) already
 * carried its own tighter limiter.
 *
 * FINDING 3 was investigated and REJECTED: `/api/admin/login-history` is
 * mounted in app.ts without `authenticate` at the mount point, but its
 * single route declares `authenticate` + `requireRole('super_admin')`
 * inline. The last test here pins that so nobody "fixes" it by removing
 * the inline guards, and so a future added route can't silently ship
 * unauthenticated.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { readFileSync } from 'node:fs';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin } from './helpers.js';

let app: Express;

// Unique marker so cleanup only removes THIS test's submission and never
// touches a real enquiry sitting in the same table.
const PROBE_AGENCY = `RateLimitGuard-${Date.now()}`;

beforeAll(async () => {
  app = createApp();
});

afterAll(async () => {
  await prisma.contactSubmission.deleteMany({ where: { agencyName: PROBE_AGENCY } });
});

describe('Contact form — rate limiting (2026-08-07 finding 2)', () => {
  it('POSITIVE — the route mounts a dedicated limiter ahead of validation', () => {
    const src = readFileSync(
      new URL('../routes/contact.ts', import.meta.url),
      'utf8',
    );
    expect(src).toContain('express-rate-limit');
    expect(src).toContain('contactLimiter');
    // Limiter must run BEFORE validate() so malformed floods are cheap too.
    const limiterPos = src.indexOf('contactLimiter,');
    const validatePos = src.indexOf('validate(contactFormSchema)');
    expect(limiterPos).toBeGreaterThan(-1);
    expect(validatePos).toBeGreaterThan(-1);
    expect(limiterPos).toBeLessThan(validatePos);
  });

  it('POSITIVE — production cap is far tighter than the global 1000/15min', () => {
    const src = readFileSync(
      new URL('../routes/contact.ts', import.meta.url),
      'utf8',
    );
    const match = /max:\s*process\.env\.NODE_ENV === 'production' \? (\d+)/.exec(src);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeLessThanOrEqual(10);
  });

  it('REGRESSION — the endpoint still accepts a valid submission', async () => {
    const res = await request(app)
      .post('/api/contact')
      .send({
        name: 'Rate Limit Guard',
        phone: '9876543210',
        email: 'contact-guard@example.invalid',
        agency: 'LPG Distributor',
        agencyName: PROBE_AGENCY,
        monthlySale: '500',
      });
    // 201 on success. Never 429 in test env (dev cap is 200).
    expect(res.status).not.toBe(429);
    expect([200, 201]).toContain(res.status);
  });
});

describe('login-history auth (2026-08-07 finding 3 — verified NOT a hole)', () => {
  it('NEGATIVE — unauthenticated request is rejected', async () => {
    const res = await request(app).post('/api/admin/login-history/purge-old').send({});
    expect([401, 403]).toContain(res.status);
  });

  it('NEGATIVE — non-super-admin is rejected', async () => {
    const { token } = await loginAsDistAdmin();
    const res = await request(app)
      .post('/api/admin/login-history/purge-old')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('STRUCTURAL — every route in the router declares authenticate', () => {
    const src = readFileSync(
      new URL('../routes/loginHistory.ts', import.meta.url),
      'utf8',
    );
    const routeCount = (src.match(/^router\.(get|post|put|patch|delete)\(/gm) ?? []).length;
    const authCount = (src.match(/^\s*authenticate,\s*$/gm) ?? []).length;
    expect(routeCount).toBeGreaterThan(0);
    // Mount point in app.ts has no authenticate — so every route MUST
    // carry it inline. If someone adds a route without it, this fails.
    expect(authCount).toBe(routeCount);
  });
});
