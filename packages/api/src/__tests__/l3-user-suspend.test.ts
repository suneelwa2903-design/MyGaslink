/**
 * Group L3 (2026-06-11) — suspend / reactivate user.
 *
 *   - Suspend flips status → 'suspended' and wipes refreshToken.
 *   - Reactivate flips status → 'active'.
 *   - Login as a suspended user → 403 with the specialised message.
 *   - Re-login after reactivate succeeds.
 *   - Guards:
 *       cannot suspend self
 *       cannot suspend a super_admin (lockout protection)
 *       distributor_admin cannot suspend another distributor_admin
 *       distributor_admin cannot suspend cross-tenant (404 not found)
 *   - Audit log row written on suspend AND on reactivate.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../services/authService.js';
import { loginAsSuperAdmin, loginAsDistAdmin } from './helpers.js';

const app = createApp();
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const TRACK_EMAIL = 'l3-suspend-';

let saToken: string;
let distAdminToken: string;
let distAdminUserId: string;
let dist1Id: string;
const dist2Id = 'dist-002';

async function cleanup() {
  await prisma.user.deleteMany({
    where: { email: { startsWith: TRACK_EMAIL } },
  });
  await prisma.auditLog.deleteMany({
    where: { action: { in: ['suspend', 'reactivate'] }, details: { path: ['email'], string_starts_with: TRACK_EMAIL } as never },
  });
}

async function makeUser(email: string, role: 'distributor_admin' | 'finance' | 'inventory', distributorId: string | null) {
  return prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword('TestPass@123'),
      firstName: 'L3',
      lastName: role,
      role,
      distributorId,
      requiresPasswordReset: false,
      status: 'active',
    },
    select: { id: true, email: true, role: true, distributorId: true, status: true },
  });
}

beforeAll(async () => {
  const sa = await loginAsSuperAdmin();
  saToken = sa.token;
  const da = await loginAsDistAdmin();
  distAdminToken = da.token;
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

describe('L3 — suspend / reactivate behavior', () => {
  it('super-admin suspends a dist-001 finance user → status=suspended, refreshToken null', async () => {
    const u = await makeUser(`${TRACK_EMAIL}fin@test.com`, 'finance', dist1Id);
    const res = await request(app).post(`/api/users/${u.id}/suspend`).set(bearer(saToken));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('suspended');

    const row = await prisma.user.findUnique({ where: { id: u.id }, select: { status: true, refreshToken: true } });
    expect(row?.status).toBe('suspended');
    expect(row?.refreshToken).toBeNull();
  });

  it('suspended user login attempt returns 403 with the specialised message', async () => {
    const u = await makeUser(`${TRACK_EMAIL}fin@test.com`, 'finance', dist1Id);
    await request(app).post(`/api/users/${u.id}/suspend`).set(bearer(saToken));
    const res = await request(app).post('/api/auth/login').send({ email: u.email, password: 'TestPass@123' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/suspended/i);
    expect(res.body.error).toMatch(/administrator/i);
  });

  it('reactivate flips back to active and login succeeds again', async () => {
    const u = await makeUser(`${TRACK_EMAIL}fin@test.com`, 'finance', dist1Id);
    await request(app).post(`/api/users/${u.id}/suspend`).set(bearer(saToken));
    const reactivateRes = await request(app).post(`/api/users/${u.id}/reactivate`).set(bearer(saToken));
    expect(reactivateRes.status).toBe(200);
    expect(reactivateRes.body.data.status).toBe('active');

    const loginRes = await request(app).post('/api/auth/login').send({ email: u.email, password: 'TestPass@123' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.data.tokens.accessToken).toBeTruthy();
  });
});

describe('L3 — guards', () => {
  it('cannot suspend yourself (super-admin trying to suspend admin@mygaslink.com)', async () => {
    const me = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@mygaslink.com' } });
    const res = await request(app).post(`/api/users/${me.id}/suspend`).set(bearer(saToken));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CANNOT_SUSPEND_SELF');
  });

  it('cannot suspend a super_admin (lockout-of-platform protection)', async () => {
    // The seeded super-admin row.
    const sa = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@mygaslink.com' } });
    // Use distributor_admin to try (would also be blocked by self-check
    // above for super-admin caller, so use dist-admin).
    const res = await request(app).post(`/api/users/${sa.id}/suspend`).set(bearer(distAdminToken));
    // Two valid outcomes depending on which guard fires first — both protect:
    //   404 = dist-admin can't even see super_admin row (cross-tenant)
    //   403 = explicit super_admin protection
    expect([403, 404]).toContain(res.status);
  });

  it('distributor_admin cannot suspend ANOTHER distributor_admin in the same tenant', async () => {
    const peer = await makeUser(`${TRACK_EMAIL}peer-admin@test.com`, 'distributor_admin', dist1Id);
    const res = await request(app).post(`/api/users/${peer.id}/suspend`).set(bearer(distAdminToken));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CANNOT_SUSPEND_PEER_ADMIN');
  });

  it('super_admin CAN suspend a distributor_admin (the only escalation path)', async () => {
    const target = await makeUser(`${TRACK_EMAIL}target-admin@test.com`, 'distributor_admin', dist1Id);
    const res = await request(app).post(`/api/users/${target.id}/suspend`).set(bearer(saToken));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('suspended');
  });

  it('distributor_admin cannot suspend a user from a different tenant (404)', async () => {
    const otherTenantUser = await makeUser(`${TRACK_EMAIL}cross@test.com`, 'finance', dist2Id);
    const res = await request(app).post(`/api/users/${otherTenantUser.id}/suspend`).set(bearer(distAdminToken));
    expect(res.status).toBe(404);
  });

  it('distributor_admin CAN suspend a finance user in own tenant', async () => {
    const u = await makeUser(`${TRACK_EMAIL}own-fin@test.com`, 'finance', dist1Id);
    const res = await request(app).post(`/api/users/${u.id}/suspend`).set(bearer(distAdminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('suspended');
  });

  it('distributor_admin can reactivate their OWN tenant user', async () => {
    const u = await makeUser(`${TRACK_EMAIL}reac@test.com`, 'finance', dist1Id);
    await request(app).post(`/api/users/${u.id}/suspend`).set(bearer(distAdminToken));
    const res = await request(app).post(`/api/users/${u.id}/reactivate`).set(bearer(distAdminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('active');
  });
});

describe('L3 — audit log persistence', () => {
  it('writes an audit_log row on suspend AND on reactivate', async () => {
    const u = await makeUser(`${TRACK_EMAIL}audit@test.com`, 'finance', dist1Id);

    await request(app).post(`/api/users/${u.id}/suspend`).set(bearer(saToken));
    await request(app).post(`/api/users/${u.id}/reactivate`).set(bearer(saToken));

    const rows = await prisma.auditLog.findMany({
      where: {
        entityType: 'user',
        entityId: u.id,
        action: { in: ['suspend', 'reactivate'] },
      },
      orderBy: { createdAt: 'asc' },
      select: { action: true, userId: true, entityId: true },
    });
    expect(rows.map((r) => r.action)).toEqual(['suspend', 'reactivate']);
    expect(rows[0].entityId).toBe(u.id);
    void distAdminUserId;
  });
});
