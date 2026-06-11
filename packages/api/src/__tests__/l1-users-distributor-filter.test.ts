/**
 * Group L1 (2026-06-11) — super-admin Users list tenant filter.
 *
 *   - super_admin without `?distributorId=` sees all tenants (unchanged).
 *   - super_admin with `?distributorId=dist-001` sees ONLY dist-001 users.
 *   - distributor_admin's list stays scoped to their own JWT.distributorId
 *     and ignores the query param (cannot escalate to other tenants).
 *   - Each user row carries `distributor: { id, businessName }` so the
 *     super-admin UI can render a Distributor column without an extra
 *     round-trip per row.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { loginAsSuperAdmin, loginAsDistAdmin } from './helpers.js';

const app = createApp();

let saToken: string;
let distAdminToken: string;
let dist1Id: string;

beforeAll(async () => {
  const sa = await loginAsSuperAdmin();
  saToken = sa.token;
  const da = await loginAsDistAdmin();
  distAdminToken = da.token;
  dist1Id = da.distributorId;
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('L1 — super-admin Users list tenant filter', () => {
  it('super-admin without distributorId sees cross-tenant users (≥ 2 distributors represented)', async () => {
    const res = await request(app).get('/api/users').set(bearer(saToken));
    expect(res.status).toBe(200);
    const distinctDistributorIds = new Set(
      (res.body.data.users as Array<{ distributorId: string | null }>)
        .map((u) => u.distributorId)
        .filter((id): id is string => !!id),
    );
    expect(distinctDistributorIds.size).toBeGreaterThanOrEqual(2);
  });

  it('super-admin with ?distributorId=dist-001 sees only dist-001 users', async () => {
    const res = await request(app)
      .get('/api/users')
      .query({ distributorId: dist1Id })
      .set(bearer(saToken));
    expect(res.status).toBe(200);
    const users = res.body.data.users as Array<{ distributorId: string | null }>;
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) {
      expect(u.distributorId).toBe(dist1Id);
    }
  });

  it('super-admin response includes nested distributor businessName per row', async () => {
    const res = await request(app)
      .get('/api/users')
      .query({ distributorId: dist1Id })
      .set(bearer(saToken));
    const users = res.body.data.users as Array<{ distributor?: { id: string; businessName: string } | null }>;
    expect(users.length).toBeGreaterThan(0);
    expect(users[0].distributor).toBeDefined();
    expect(users[0].distributor?.businessName).toBeTruthy();
    expect(users[0].distributor?.id).toBe(dist1Id);
  });

  it('distributor_admin cannot escalate via ?distributorId=dist-002 — stays scoped to own JWT', async () => {
    const res = await request(app)
      .get('/api/users')
      .query({ distributorId: 'dist-002' })
      .set(bearer(distAdminToken));
    expect(res.status).toBe(200);
    const users = res.body.data.users as Array<{ distributorId: string | null }>;
    expect(users.length).toBeGreaterThan(0);
    // EVERY row must be the caller's own tenant — the query param is ignored.
    for (const u of users) {
      expect(u.distributorId).toBe(dist1Id);
    }
  });

  it('distributor_admin without query param sees only own-tenant users (regression)', async () => {
    const res = await request(app).get('/api/users').set(bearer(distAdminToken));
    expect(res.status).toBe(200);
    const users = res.body.data.users as Array<{ distributorId: string | null }>;
    for (const u of users) {
      expect(u.distributorId).toBe(dist1Id);
    }
  });
});
