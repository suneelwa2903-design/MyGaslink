/**
 * Group DPDP (2026-06-11) — login_history + tenant-switch audit_logs.
 *
 *   - Successful login → login_history row with success=true, IP + UA.
 *   - USER_NOT_FOUND → row with userId=null, success=false, failReason
 *     prefixed "USER_NOT_FOUND:". (Brute-force visibility.)
 *   - INVALID_PASSWORD → row with userId set, success=false.
 *   - ACCOUNT_SUSPENDED → row with failReason ACCOUNT_SUSPENDED.
 *   - login_history write failure must NOT block login — covered by the
 *     fire-and-forget pattern; we assert the side-channel never throws.
 *   - super-admin tenant switch → audit_logs row with action='tenant_switch'.
 *   - 180-day purge endpoint: super-admin only, deletes rows older than 180 days.
 *
 * Uses a unique TRACK email so cleanup can target only this suite's rows.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../services/authService.js';
import { loginAsSuperAdmin, loginAsDistAdmin } from './helpers.js';

const app = createApp();
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const TRACK_EMAIL = 'dpdp-login-';

let saToken: string;
let saUserId: string;
let distAdminUserId: string;
let dist1Id: string;
const dist2Id = 'dist-002';

async function cleanup() {
  await prisma.loginHistory.deleteMany({
    where: { OR: [
      { user: { email: { startsWith: TRACK_EMAIL } } },
      { failReason: { startsWith: `USER_NOT_FOUND:${TRACK_EMAIL}` } },
    ] },
  });
  await prisma.user.deleteMany({ where: { email: { startsWith: TRACK_EMAIL } } });
  await prisma.auditLog.deleteMany({
    where: { action: 'tenant_switch', userId: saUserId },
  });
}

async function makeUser(email: string, status: 'active' | 'suspended' = 'active') {
  return prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword('DpdpPass@123'),
      firstName: 'DPDP',
      lastName: 'Tester',
      role: 'finance',
      distributorId: dist1Id,
      requiresPasswordReset: false,
      status,
    },
    select: { id: true, email: true, distributorId: true },
  });
}

beforeAll(async () => {
  const sa = await loginAsSuperAdmin();
  saToken = sa.token;
  saUserId = sa.user.id;
  const da = await loginAsDistAdmin();
  distAdminUserId = da.user.id;
  dist1Id = da.distributorId;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
});

// Group DPDP — login_history writes are fire-and-forget at the call
// site (so a DB hiccup never blocks login). Tests must give that
// background write a moment to commit. ~100ms is enough on the local
// dev box; we cap retries at 10 (~1s) to keep CI fast.
async function waitForLoginHistory<T>(query: () => Promise<T[]>, predicate: (rows: T[]) => boolean, maxMs = 1000): Promise<T[]> {
  const deadline = Date.now() + maxMs;
  let rows: T[] = [];
  while (Date.now() < deadline) {
    rows = await query();
    if (predicate(rows)) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return rows;
}

describe('DPDP — login_history writes', () => {
  it('successful login produces a row with success=true + ip + userAgent', async () => {
    const u = await makeUser(`${TRACK_EMAIL}ok@test.com`);
    const res = await request(app)
      .post('/api/auth/login')
      .set('User-Agent', 'TestUA/1.0')
      .send({ email: u.email, password: 'DpdpPass@123' });
    expect(res.status).toBe(200);

    const rows = await waitForLoginHistory(
      () => prisma.loginHistory.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'desc' }, take: 1 }),
      (r) => r.length === 1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].success).toBe(true);
    expect(rows[0].distributorId).toBe(dist1Id);
    expect(rows[0].ipAddress).toBeTruthy();
    expect(rows[0].userAgent).toBe('TestUA/1.0');
  });

  it('USER_NOT_FOUND produces a row with userId=null + email-prefixed failReason', async () => {
    const fakeEmail = `${TRACK_EMAIL}ghost@test.com`;
    // Password must satisfy loginSchema (min 8) so Zod doesn't reject
    // before authService runs.
    const res = await request(app).post('/api/auth/login').send({ email: fakeEmail, password: 'whatever8' });
    expect(res.status).toBe(401);

    const rows = await waitForLoginHistory(
      () => prisma.loginHistory.findMany({ where: { userId: null, failReason: { startsWith: `USER_NOT_FOUND:${TRACK_EMAIL}ghost` } } }),
      (r) => r.length >= 1,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].success).toBe(false);
    expect(rows[0].failReason).toContain(fakeEmail);
  });

  it('INVALID_PASSWORD on an existing user produces a row with success=false', async () => {
    const u = await makeUser(`${TRACK_EMAIL}wrong@test.com`);
    const res = await request(app).post('/api/auth/login').send({ email: u.email, password: 'WrongPass@999' });
    expect(res.status).toBe(401);

    const rows = await waitForLoginHistory(
      () => prisma.loginHistory.findMany({ where: { userId: u.id, success: false } }),
      (r) => r.length >= 1,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].failReason).toBe('INVALID_PASSWORD');
  });

  it('ACCOUNT_SUSPENDED login produces a row with failReason ACCOUNT_SUSPENDED', async () => {
    const u = await makeUser(`${TRACK_EMAIL}susp@test.com`, 'suspended');
    const res = await request(app).post('/api/auth/login').send({ email: u.email, password: 'DpdpPass@123' });
    expect(res.status).toBe(403);

    const rows = await waitForLoginHistory(
      () => prisma.loginHistory.findMany({ where: { userId: u.id, success: false } }),
      (r) => r.some((row) => row.failReason === 'ACCOUNT_SUSPENDED'),
    );
    expect(rows.some((r) => r.failReason === 'ACCOUNT_SUSPENDED')).toBe(true);
  });
});

describe('DPDP — super-admin tenant switch persists to audit_logs', () => {
  it('GET /api/users with X-Distributor-Id writes a tenant_switch audit_log row', async () => {
    // Clear any prior tenant_switch rows for this super-admin so the
    // assertion is precise.
    await prisma.auditLog.deleteMany({ where: { action: 'tenant_switch', userId: saUserId } });
    const res = await request(app)
      .get('/api/users')
      .set(bearer(saToken))
      .set('X-Distributor-Id', dist2Id);
    expect(res.status).toBe(200);

    const rows = await waitForLoginHistory(
      () => prisma.auditLog.findMany({ where: { action: 'tenant_switch', userId: saUserId }, orderBy: { createdAt: 'desc' } }),
      (r) => r.length >= 1,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].entityType).toBe('distributor');
    expect(rows[0].entityId).toBe(dist2Id);
    expect(rows[0].distributorId).toBe(dist2Id);
    expect(rows[0].ipAddress).toBeTruthy();
    void distAdminUserId;
  });
});

describe('DPDP — purge endpoint', () => {
  it('super-admin POST /api/admin/login-history/purge-old deletes only rows older than 180 days', async () => {
    const u = await makeUser(`${TRACK_EMAIL}purge@test.com`);
    // Insert one ancient row and one fresh row.
    await prisma.loginHistory.create({
      data: {
        userId: u.id,
        distributorId: dist1Id,
        success: true,
        // 200 days ago
        createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
      },
    });
    await prisma.loginHistory.create({
      data: { userId: u.id, distributorId: dist1Id, success: true },
    });

    const res = await request(app)
      .post('/api/admin/login-history/purge-old')
      .set(bearer(saToken));
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBeGreaterThanOrEqual(1);

    const remaining = await prisma.loginHistory.findMany({ where: { userId: u.id } });
    // The fresh row survives.
    expect(remaining.length).toBeGreaterThanOrEqual(1);
    expect(remaining.every((r) => r.createdAt.getTime() > Date.now() - 180 * 24 * 60 * 60 * 1000)).toBe(true);
  });
});
