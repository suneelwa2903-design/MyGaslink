/**
 * Group L5 (2026-06-11) — isTestTenant toggle on distributor edit.
 *
 *   - super_admin can flip isTestTenant via PUT /api/distributors/:id.
 *   - distributor_admin can NOT flip it (the route is super-admin-only
 *     already so the call is rejected at the requireRole gate; we still
 *     verify the gate is effective).
 *   - Zod accepts the boolean field.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { updateDistributorSchema } from '@gaslink/shared';
import { loginAsSuperAdmin, loginAsDistAdmin } from './helpers.js';

const app = createApp();
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const TRACK = 'L5-Test-Tenant';

let saToken: string;
let distAdminToken: string;
let dist1Id: string;
let createdDistributorId: string;

async function cleanup() {
  await prisma.distributor.deleteMany({ where: { businessName: { startsWith: TRACK } } });
}

beforeAll(async () => {
  const sa = await loginAsSuperAdmin();
  saToken = sa.token;
  const da = await loginAsDistAdmin();
  distAdminToken = da.token;
  dist1Id = da.distributorId;
  await cleanup();
  // Create a throw-away distributor for the toggle tests.
  const res = await request(app)
    .post('/api/distributors')
    .set(bearer(saToken))
    .send({ businessName: `${TRACK}-A`, legalName: `${TRACK}-A Pvt Ltd` });
  createdDistributorId = res.body.data.distributorId;
});

afterAll(async () => {
  await cleanup();
});

describe('L5 — Zod', () => {
  it('accepts isTestTenant: true', () => {
    const r = updateDistributorSchema.safeParse({ isTestTenant: true });
    expect(r.success).toBe(true);
  });
  it('accepts isTestTenant: false', () => {
    const r = updateDistributorSchema.safeParse({ isTestTenant: false });
    expect(r.success).toBe(true);
  });
  it('rejects isTestTenant: "true" (string)', () => {
    const r = updateDistributorSchema.safeParse({ isTestTenant: 'true' });
    expect(r.success).toBe(false);
  });
});

describe('L5 — super-admin can set isTestTenant', () => {
  it('default after create is false', async () => {
    const row = await prisma.distributor.findUnique({ where: { id: createdDistributorId }, select: { isTestTenant: true } });
    expect(row?.isTestTenant).toBe(false);
  });

  it('PUT /api/distributors/:id { isTestTenant: true } updates the column', async () => {
    const res = await request(app)
      .put(`/api/distributors/${createdDistributorId}`)
      .set(bearer(saToken))
      .send({ isTestTenant: true });
    expect(res.status).toBe(200);
    const row = await prisma.distributor.findUnique({ where: { id: createdDistributorId }, select: { isTestTenant: true } });
    expect(row?.isTestTenant).toBe(true);
  });

  it('PUT { isTestTenant: false } flips it back', async () => {
    const res = await request(app)
      .put(`/api/distributors/${createdDistributorId}`)
      .set(bearer(saToken))
      .send({ isTestTenant: false });
    expect(res.status).toBe(200);
    const row = await prisma.distributor.findUnique({ where: { id: createdDistributorId }, select: { isTestTenant: true } });
    expect(row?.isTestTenant).toBe(false);
  });
});

describe('L5 — distributor_admin cannot escalate', () => {
  it('distributor_admin gets 403 on PUT /api/distributors/:id (route is super-admin only)', async () => {
    // Snapshot the column BEFORE the attempted write so we can assert
    // the failed request did not mutate it — regardless of what the
    // seed/contaminated value happens to be.
    const before = await prisma.distributor.findUnique({ where: { id: dist1Id }, select: { isTestTenant: true } });
    const res = await request(app)
      .put(`/api/distributors/${dist1Id}`)
      .set(bearer(distAdminToken))
      .send({ isTestTenant: !before?.isTestTenant });
    expect(res.status).toBe(403);
    const after = await prisma.distributor.findUnique({ where: { id: dist1Id }, select: { isTestTenant: true } });
    expect(after?.isTestTenant).toBe(before?.isTestTenant);
  });
});
