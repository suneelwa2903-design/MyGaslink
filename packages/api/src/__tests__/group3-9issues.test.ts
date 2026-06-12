/**
 * 9-issues Group 3 — Razorpay Settings UI in distributor edit form
 * (Issue 5).
 *
 * The backend has been wired since Phase F. This group ships the
 * super-admin-only UI section in DistributorsPage.tsx. Tests:
 *   - Wire shape: PUT /api/distributors/:id accepts the 4 Razorpay
 *     fields, response NEVER includes the two secrets (already
 *     covered by Phase F vitest — we add one fresh assertion that
 *     toggling enabled + saving a new key id round-trips correctly).
 *   - Defense-in-depth: a non-super-admin token gets the fields
 *     stripped at the route layer (already covered by Phase F).
 *   - Source guards on DistributorsPage.tsx:
 *       - Section gated on isSuperAdmin (selectIsSuperAdmin)
 *       - Toggle (razorpayEnabled) wired to React state
 *       - Secret inputs are type="password"
 *       - Placeholder "•••••••• (set; leave blank to keep)" when
 *         hadExistingRazorpaySecrets
 *       - Empty secrets are NOT sent on submit
 *       - razorpayKeyId is sent as '' (not null) per Zod schema
 *     - Source guard on Distributor shared type: razorpayEnabled +
 *       razorpayKeyId are present; secrets are NOT.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../app.js';
import { loginAsSuperAdmin } from './helpers.js';
import { prisma } from '../lib/prisma.js';
import type { Express } from 'express';

let app: Express;
let saToken: string;

beforeAll(async () => {
  app = createApp();
  saToken = (await loginAsSuperAdmin()).token;
});

afterAll(async () => {
  // Reset dist-001 Razorpay state so subsequent test runs / sessions
  // don't see leaked test creds.
  await prisma.distributor.update({
    where: { id: 'dist-001' },
    data: {
      razorpayEnabled: false,
      razorpayKeyId: null,
      razorpayKeySecret: null,
      razorpayWebhookSecret: null,
    },
  });
});

describe('Issue 5 — PUT /api/distributors/:id wire shape', () => {
  it('super-admin can enable Razorpay + set key id + secrets; response omits secrets', async () => {
    const res = await request(app)
      .put('/api/distributors/dist-001')
      .set('Authorization', `Bearer ${saToken}`)
      .send({
        razorpayEnabled: true,
        razorpayKeyId: 'rzp_test_phase9_issue5',
        razorpayKeySecret: 'phase9_secret_xyz',
        razorpayWebhookSecret: 'phase9_wh_secret',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.razorpayEnabled).toBe(true);
    expect(res.body.data.razorpayKeyId).toBe('rzp_test_phase9_issue5');
    expect(res.body.data.razorpayKeySecret).toBeUndefined();
    expect(res.body.data.razorpayWebhookSecret).toBeUndefined();

    // Internal verification — secrets ARE stored.
    const dist = await prisma.distributor.findUniqueOrThrow({
      where: { id: 'dist-001' },
      select: { razorpayKeySecret: true, razorpayWebhookSecret: true },
    });
    expect(dist.razorpayKeySecret).toBe('phase9_secret_xyz');
    expect(dist.razorpayWebhookSecret).toBe('phase9_wh_secret');
  });

  it('omitting secret fields on update preserves the existing secret (don\'t-overwrite-with-empty)', async () => {
    const res = await request(app)
      .put('/api/distributors/dist-001')
      .set('Authorization', `Bearer ${saToken}`)
      .send({
        razorpayEnabled: true,
        razorpayKeyId: 'rzp_test_phase9_updated_key',
        // razorpayKeySecret + razorpayWebhookSecret intentionally omitted
      });
    expect(res.status).toBe(200);
    const dist = await prisma.distributor.findUniqueOrThrow({
      where: { id: 'dist-001' },
      select: { razorpayKeyId: true, razorpayKeySecret: true, razorpayWebhookSecret: true },
    });
    expect(dist.razorpayKeyId).toBe('rzp_test_phase9_updated_key');
    // Both secrets still set to the values from the previous test.
    expect(dist.razorpayKeySecret).toBe('phase9_secret_xyz');
    expect(dist.razorpayWebhookSecret).toBe('phase9_wh_secret');
  });
});

describe('Issue 5 — DistributorsPage.tsx source guards', () => {
  const src = readFileSync(
    resolve(__dirname, '..', '..', '..', 'web', 'src', 'pages', 'DistributorsPage.tsx'),
    'utf-8',
  );

  it('imports selectIsSuperAdmin (super-admin gate)', () => {
    expect(src).toMatch(/import\s*\{\s*[^}]*selectIsSuperAdmin[^}]*\}\s*from\s*['"]@\/stores\/authStore['"]/);
  });

  it('gates the Razorpay Settings section on isSuperAdmin', () => {
    expect(src).toMatch(/\{isSuperAdmin\s*&&\s*\(/);
    expect(src).toContain('Razorpay Settings');
  });

  it('toggle controls razorpayEnabled local state', () => {
    expect(src).toContain('setRazorpayEnabled');
    expect(src).toContain('checked={razorpayEnabled}');
  });

  it('renders the two secret fields as password inputs', () => {
    // 2× <input type="password" for razorpayKeySecret and razorpayWebhookSecret.
    const passwordInputCount = (src.match(/type=["']password["']/g) || []).length;
    expect(passwordInputCount).toBeGreaterThanOrEqual(2);
  });

  it('shows the "•••••••• (set; leave blank to keep)" placeholder when secrets already exist', () => {
    expect(src).toMatch(/hadExistingRazorpaySecrets[\s\S]{0,200}set;\s*leave blank to keep/);
  });

  it('does NOT send empty secret strings (don\'t-overwrite-with-empty)', () => {
    // Look for the `if (razorpayKeySecret.trim().length > 0)` guard.
    expect(src).toMatch(/razorpayKeySecret\.trim\(\)\.length\s*>\s*0/);
    expect(src).toMatch(/razorpayWebhookSecret\.trim\(\)\.length\s*>\s*0/);
  });

  it('sends razorpayKeyId as a string (empty when cleared, not null) per Zod schema', () => {
    expect(src).toMatch(/payload\.razorpayKeyId\s*=\s*razorpayKeyId\.trim\(\)/);
  });
});

describe('Issue 5 — Distributor shared type exposes the public Razorpay fields', () => {
  const src = readFileSync(
    resolve(__dirname, '..', '..', '..', 'shared', 'src', 'types', 'index.ts'),
    'utf-8',
  );

  it('declares razorpayEnabled + razorpayKeyId on Distributor', () => {
    expect(src).toMatch(/razorpayEnabled\?:\s*boolean/);
    expect(src).toMatch(/razorpayKeyId\?:\s*string\s*\|\s*null/);
  });

  it('does NOT expose razorpayKeySecret / razorpayWebhookSecret on Distributor', () => {
    // The shared Distributor wire-type is the binding contract for what
    // the API returns. If a future change adds the secret fields here,
    // the next consumer (admin web, mobile, customer portal) would
    // start seeing them — which would be a leak.
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // Extract just the Distributor interface body.
    const distMatch = codeOnly.match(/export\s+interface\s+Distributor\s*\{([\s\S]*?)^\}/m);
    expect(distMatch).not.toBeNull();
    const body = distMatch![1]!;
    expect(body).not.toMatch(/razorpayKeySecret/);
    expect(body).not.toMatch(/razorpayWebhookSecret/);
  });
});
