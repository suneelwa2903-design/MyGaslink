/**
 * Phase 2 — distributor name in /auth/me + login response.
 *
 * Wire-shape guards (anti-pattern #9): the web sidebar and mobile header
 * both read `user.distributorName` directly off the auth profile. If
 * either endpoint stops returning the field — or returns it under the
 * wrong name — every consumer renders nothing silently. These tests pin
 * the field's presence, name, and per-role value.
 *
 * Positive: dist-admin login + /me both return the businessName.
 * Negative: super-admin /me returns null (super-admin isn't pinned to a
 *           single tenant; the DistributorSelector already covers that).
 * Regression: every other UserProfile field still present.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { loginAsDistAdmin, loginAsSuperAdmin } from './helpers.js';
import type { Express } from 'express';

let app: Express;

beforeAll(() => {
  app = createApp();
});

describe('Phase 2 — distributorName on auth profile', () => {
  describe('POST /api/auth/login', () => {
    it('returns distributorName matching the user\'s Distributor.businessName', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'bhargava@gasagency.com', password: 'Distadmin@123' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user).toHaveProperty('distributorName');
      expect(res.body.data.user.distributorName).toBe('Bhargava Gas Agency');
    });

    it('returns null distributorName for a user with no distributorId (super_admin)', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'admin@mygaslink.com', password: 'Admin@123' });

      expect(res.status).toBe(200);
      expect(res.body.data.user).toHaveProperty('distributorName');
      expect(res.body.data.user.distributorName).toBeNull();
      expect(res.body.data.user.distributorId).toBeNull();
    });

    it('keeps every other UserProfile field on the login response (no regression)', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'bhargava@gasagency.com', password: 'Distadmin@123' });

      const user = res.body.data.user;
      expect(user).toMatchObject({
        userId: expect.any(String),
        email: 'bhargava@gasagency.com',
        firstName: expect.any(String),
        lastName: expect.any(String),
        role: 'distributor_admin',
        status: 'active',
        distributorId: expect.any(String),
        distributorName: expect.any(String),
        customerId: null,
        requiresPasswordReset: expect.any(Boolean),
      });
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns distributorName for an authenticated distributor_admin', async () => {
      const { token } = await loginAsDistAdmin();
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('distributorName');
      expect(res.body.data.distributorName).toBe('Bhargava Gas Agency');
    });

    it('returns null distributorName for super-admin (not pinned to one tenant)', async () => {
      const { token } = await loginAsSuperAdmin();
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('distributorName');
      expect(res.body.data.distributorName).toBeNull();
    });

    it('keeps every other /auth/me field present (no regression)', async () => {
      const { token } = await loginAsDistAdmin();
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.body.data).toMatchObject({
        userId: expect.any(String),
        email: expect.any(String),
        firstName: expect.any(String),
        lastName: expect.any(String),
        role: expect.any(String),
        status: expect.any(String),
        distributorId: expect.any(String),
        distributorName: expect.any(String),
        requiresPasswordReset: expect.any(Boolean),
      });
    });
  });
});
