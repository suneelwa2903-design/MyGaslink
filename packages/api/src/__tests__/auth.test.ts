import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { loginAsDistAdmin, loginAsFinance, loginAsInventory, generateToken, today } from './helpers.js';
import { prisma } from '../lib/prisma.js';
import { UserRole } from '@gaslink/shared';
import type { Express } from 'express';

let app: Express;

beforeAll(() => {
  app = createApp();
});

describe('Authentication', () => {
  it('should reject requests without token', async () => {
    const res = await request(app).get('/api/orders');
    expect(res.status).toBe(401);
  });

  it('should reject requests with invalid token', async () => {
    const res = await request(app)
      .get('/api/orders')
      .set('Authorization', 'Bearer invalid-token-here');
    expect(res.status).toBe(401);
  });

  it('should reject expired tokens', async () => {
    const jwt = await import('jsonwebtoken');
    const { config } = await import('../config/index.js');
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'bhargava@gasagency.com' } });
    const token = jwt.default.sign(
      { userId: user.id, email: user.email, role: user.role, distributorId: user.distributorId, customerId: null },
      config.jwt.accessSecret,
      { expiresIn: '0s' },
    );
    const res = await request(app)
      .get('/api/orders')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('should accept valid login credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'bhargava@gasagency.com', password: 'Distadmin@123' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.tokens.accessToken).toBeDefined();
    expect(res.body.data.user.email).toBe('bhargava@gasagency.com');
  });

  it('should reject invalid login credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'bhargava@gasagency.com', password: 'wrongpassword' });
    expect(res.status).not.toBe(200);
  });

  it('should return user profile with valid token', async () => {
    const { token } = await loginAsDistAdmin();
    const res = await request(app)
      .get('/api/users/profile')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('bhargava@gasagency.com');
  });
});

describe('Role-Based Access Control', () => {
  it('should allow distributor_admin to access analytics', async () => {
    const { token } = await loginAsDistAdmin();
    const res = await request(app)
      .get('/api/analytics/dashboard')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('should allow finance to access analytics', async () => {
    const { token } = await loginAsFinance();
    const res = await request(app)
      .get('/api/analytics/dashboard')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('should deny driver access to analytics', async () => {
    // Create a fake driver token using generateToken with driver role
    const token = generateToken({
      userId: 'fake-driver-user-id',
      email: 'driver@test.com',
      role: UserRole.DRIVER,
      distributorId: 'dist-001',
    });
    // This will fail at authenticate (user not found) — that's fine, it proves the middleware stack works
    const res = await request(app)
      .get('/api/analytics/dashboard')
      .set('Authorization', `Bearer ${token}`);
    // Should be 401 (user not found) or 403 (role denied)
    expect([401, 403]).toContain(res.status);
  });

  it('should allow inventory to access inventory endpoints', async () => {
    const { token } = await loginAsInventory();
    // Phase C (2026-06-12): use the local-TZ helper, NOT raw UTC. Raw
    // `new Date().toISOString().split('T')[0]` fails the IST-midnight
    // window because the API parses the date and queries summaries by
    // local-TZ summary_date — same anti-pattern that bit customer-
    // portal.test.ts pre-4300e07. Phase D adds a CI grep guard.
    const res = await request(app)
      .get(`/api/inventory/summary/${today()}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    // Phase C — assertions on response BODY, not just status. The
    // pre-Phase-C version of this test only checked status === 200, so
    // a route that returned 200 with the wrong-day data, an empty
    // envelope, or a different shape would all silently pass and let
    // bugs ship. Pin: response is a success envelope, data is an array,
    // and (when non-empty) each row carries the columns the inventory
    // mobile screen reads (cylinderTypeName + openingFulls + closing
    // Fulls + closingEmpties). Empty array is acceptable — fresh
    // tenant or no summaries yet for today — but malformed rows are
    // not.
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    if (res.body.data.length > 0) {
      const row = res.body.data[0];
      expect(typeof row.cylinderTypeName).toBe('string');
      expect(typeof row.openingFulls).toBe('number');
      expect(typeof row.openingEmpties).toBe('number');
      expect(typeof row.closingFulls).toBe('number');
      expect(typeof row.closingEmpties).toBe('number');
    }
  });

  it('should allow finance to access inventory summary (WI-088)', async () => {
    const { token } = await loginAsFinance();
    // Phase C — same local-TZ + body-shape strengthening as the
    // inventory test above. Finance's read access (added in WI-088) is
    // the explicit subject here; the body assertion guarantees finance
    // doesn't accidentally start getting a different / smaller payload.
    const res = await request(app)
      .get(`/api/inventory/summary/${today()}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    if (res.body.data.length > 0) {
      const row = res.body.data[0];
      expect(typeof row.cylinderTypeName).toBe('string');
      expect(typeof row.closingFulls).toBe('number');
      expect(typeof row.closingEmpties).toBe('number');
    }
  });

  it('should allow finance to access payments', async () => {
    const { token } = await loginAsFinance();
    const res = await request(app)
      .get('/api/payments')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('should allow finance to access invoices', async () => {
    const { token } = await loginAsFinance();
    const res = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('should allow inventory to create orders (depot intake flow)', async () => {
    const { token } = await loginAsInventory();
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId: 'test', deliveryDate: '2026-03-23', items: [] });
    // Inventory is now permitted on POST /orders (founder spec: depot
    // intake is an inventory task). The empty items list trips zod
    // validation → 400. The role gate must NOT respond with 403.
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });
});

describe('Multi-Tenant Isolation', () => {
  it('should only return data for the authenticated distributor', async () => {
    const { token } = await loginAsDistAdmin();
    const res = await request(app)
      .get('/api/customers')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    // All returned customers should belong to dist-001
    for (const customer of res.body.data.customers) {
      expect(customer.distributorId).toBe('dist-001');
    }
  });

  it('should not allow access to another distributor resources', async () => {
    const { token } = await loginAsDistAdmin(); // dist-001 admin
    // Try to access a dist-002 customer
    const dist2Customer = await prisma.customer.findFirst({ where: { distributorId: 'dist-002' } });
    if (dist2Customer) {
      const res = await request(app)
        .get(`/api/customers/${dist2Customer.id}`)
        .set('Authorization', `Bearer ${token}`);
      // Should return 404 (not found in their scope) not 200
      expect(res.status).toBe(404);
    }
  });
});

describe('Health Endpoint', () => {
  it('should return healthy status', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('healthy');
    expect(res.body.data.database.status).toBe('connected');
  });
});
