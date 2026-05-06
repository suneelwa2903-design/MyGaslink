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
    expect(res.body.data.distributorId).toBe('dist-001');
    expect(res.body.data.email).toBe(TEST_EMAIL);
    createdId = res.body.data.userId;
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
