import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, loginAsSuperAdmin, loginAsFinance } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let saToken: string;
let financeToken: string;

const TEST_EMAIL = 'test-pricing-user@example.com';
const TEST_EMAIL_2 = 'test-pricing-user-2@example.com';

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;
  saToken = (await loginAsSuperAdmin()).token;
  financeToken = (await loginAsFinance()).token;

  // Clean up any leftover users from prior runs
  await prisma.user.deleteMany({
    where: { email: { in: [TEST_EMAIL, TEST_EMAIL_2] } },
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({
    where: { email: { in: [TEST_EMAIL, TEST_EMAIL_2] } },
  });
});

function auth(token: string, distId?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (distId) headers['X-Distributor-Id'] = distId;
  return headers;
}

describe('Users — Auth', () => {
  it('rejects unauthenticated GET / with 401', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(401);
  });

  it('rejects POST for finance role (403)', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(auth(financeToken))
      .send({ email: TEST_EMAIL, password: 'Test@123', firstName: 'X', lastName: 'Y', role: 'finance' });
    expect(res.status).toBe(403);
  });
});

describe('Users — GET /profile', () => {
  it('returns the caller\'s own profile', async () => {
    const res = await request(app).get('/api/users/profile').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('bhargava@gasagency.com');
  });
});

describe('Users — Distributor admin scope', () => {
  it('lists ONLY users from caller\'s distributor', async () => {
    const res = await request(app).get('/api/users').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.users)).toBe(true);
    for (const u of res.body.data.users) {
      // Super admins (distributorId null) shouldn't appear in dist-001 admin's list
      expect(u.distributorId).toBe('dist-001');
    }
  });
});

describe('Users — Super admin scope', () => {
  it('lists users across distributors when no header is set', async () => {
    const res = await request(app).get('/api/users').set(auth(saToken));
    expect(res.status).toBe(200);
    const distIds = new Set<string | null>();
    for (const u of res.body.data.users) {
      distIds.add(u.distributorId);
    }
    // Should include dist-001 + dist-002 + nulls (super admin)
    expect(distIds.size).toBeGreaterThanOrEqual(2);
  });
});

describe('Users — Create / update / delete (CRUD with ownership)', () => {
  let createdId: string;

  it('distributor_admin creates a user — distributorId forced from JWT', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(auth(adminToken))
      .send({
        email: TEST_EMAIL,
        password: 'Test@1234',
        firstName: 'Test',
        lastName: 'User',
        phone: '9100000333',
        role: 'finance',
        // No distributorId in body; routes/users.ts forces req.user.distributorId
        // for non-super_admin callers regardless of what's sent.
      });
    if (res.status !== 201) console.log('create user error:', res.body);
    expect(res.status).toBe(201);
    // Group B Part 2 — POST /api/users now returns `{ user, tempPassword }`.
    // tempPassword is the plaintext the caller submitted, echoed back so the
    // Add User modal can render a copyable banner. Every other endpoint
    // omits this field.
    expect(res.body.data.user.distributorId).toBe('dist-001');
    expect(res.body.data.user.email).toBe(TEST_EMAIL);
    expect(res.body.data.tempPassword).toBe('Test@1234');
    expect(res.body.data.user.requiresPasswordReset).toBe(true);
    createdId = res.body.data.user.userId;
  });

  it('rejects POST with missing required fields (400)', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(auth(adminToken))
      .send({ email: 'incomplete@example.com' });
    expect(res.status).toBe(400);
  });

  it('returns 409 on duplicate email', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(auth(adminToken))
      .send({
        email: TEST_EMAIL,
        password: 'Test@1234',
        firstName: 'Dup',
        lastName: 'User',
        phone: '9100000334',
        role: 'finance',
      });
    expect(res.status).toBe(409);
  });

  it('admin updates a user', async () => {
    const res = await request(app)
      .put(`/api/users/${createdId}`)
      .set(auth(adminToken))
      .send({ firstName: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.data.firstName).toBe('Updated');
  });

  it('soft-deletes a user', async () => {
    const res = await request(app)
      .delete(`/api/users/${createdId}`)
      .set(auth(adminToken));
    expect(res.status).toBe(200);
  });

  it('cannot self-delete', async () => {
    // Find the dist-001 admin ID (the caller).
    const me = await prisma.user.findUniqueOrThrow({
      where: { email: 'bhargava@gasagency.com' },
    });
    const res = await request(app)
      .delete(`/api/users/${me.id}`)
      .set(auth(adminToken));
    expect(res.status).toBe(400);
  });
});

// Group B Part 2 — POST /api/users wires a fire-and-forget welcome email
// and writes an `email_logs` row regardless of outcome. The dev DB has no
// SMTP_HOST configured, so the welcome path takes the 'skipped' branch.
// Test asserts:
//   1. response shape carries `{ user, tempPassword }`
//   2. an `email_logs` row exists with type=welcome, status=skipped, userId set
//   3. SMTP failures (would-be 'failed' status) NEVER block user creation
// The third assertion is implicit — every prior CRUD test creating a user
// already proved POST /api/users returns 201 with SMTP unconfigured.
describe('Users — Welcome email + audit log (Group B Part 2)', () => {
  const TEST_EMAIL_3 = 'welcome-test@example.com';

  afterAll(async () => {
    // emailLog rows cascade away when we drop the user, but the FK is
    // nullable + best-effort, so clean them explicitly to keep the table
    // tidy across test runs.
    await prisma.emailLog.deleteMany({
      where: { toEmail: TEST_EMAIL_3 },
    });
    await prisma.user.deleteMany({
      where: { email: TEST_EMAIL_3 },
    });
  });

  it('POST /api/users writes an email_logs row (type=welcome, status=skipped when SMTP unconfigured)', async () => {
    const before = await prisma.emailLog.count({
      where: { toEmail: TEST_EMAIL_3, type: 'welcome' },
    });
    expect(before).toBe(0);

    const res = await request(app)
      .post('/api/users')
      .set(auth(adminToken))
      .send({
        email: TEST_EMAIL_3,
        password: 'Welcome@1234',
        firstName: 'Welcome',
        lastName: 'Tester',
        phone: '9100000444',
        role: 'inventory',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.tempPassword).toBe('Welcome@1234');
    const newUserId: string = res.body.data.user.userId;

    // The route schedules sendWelcomeEmail via `void` — give the microtask
    // a couple of ticks to drain before we assert on the audit row.
    await new Promise((r) => setTimeout(r, 50));

    const logs = await prisma.emailLog.findMany({
      where: { toEmail: TEST_EMAIL_3, type: 'welcome' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('skipped');
    expect(logs[0].errorText).toBe('SMTP not configured');
    expect(logs[0].userId).toBe(newUserId);
    expect(logs[0].subject).toBe('Welcome to MyGasLink — Your login credentials');
  });

  it('PUT /api/users/:id (update) does NOT send a welcome email', async () => {
    const existing = await prisma.user.findFirstOrThrow({
      where: { email: TEST_EMAIL_3 },
    });
    await request(app)
      .put(`/api/users/${existing.id}`)
      .set(auth(adminToken))
      .send({ firstName: 'Renamed' });
    // No new welcome row should be written on update.
    const logs = await prisma.emailLog.count({
      where: { toEmail: TEST_EMAIL_3, type: 'welcome' },
    });
    expect(logs).toBe(1);
  });
});

describe('Users — Tenant Isolation', () => {
  it('cannot fetch a user from another distributor (404)', async () => {
    const dist2User = await prisma.user.findFirst({
      where: { distributorId: 'dist-002', deletedAt: null },
    });
    if (!dist2User) throw new Error('Seed expected a dist-002 user');

    const res = await request(app)
      .get(`/api/users/${dist2User.id}`)
      .set(auth(adminToken));
    expect(res.status).toBe(404);
  });

  it('cannot update a user from another distributor', async () => {
    const dist2User = await prisma.user.findFirst({
      where: { distributorId: 'dist-002', deletedAt: null },
    });
    if (!dist2User) throw new Error('Seed expected a dist-002 user');

    const res = await request(app)
      .put(`/api/users/${dist2User.id}`)
      .set(auth(adminToken))
      .send({ firstName: 'Hijack' });
    expect([403, 404]).toContain(res.status);
  });
});
