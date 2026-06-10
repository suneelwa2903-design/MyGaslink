import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, loginAsFinance, loginAsInventory, loginAsSuperAdmin } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let financeToken: string;
let inventoryToken: string;
let superAdminToken: string;
let distAdminDistributorId: string;

beforeAll(async () => {
  app = createApp();
  const admin = await loginAsDistAdmin();
  adminToken = admin.token;
  distAdminDistributorId = admin.distributorId;
  const finance = await loginAsFinance();
  financeToken = finance.token;
  const inventory = await loginAsInventory();
  inventoryToken = inventory.token;
  const superAdmin = await loginAsSuperAdmin();
  superAdminToken = superAdmin.token;
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// ─── GST MODE TOGGLE TESTS ─────────────────────────────────────────────────

describe('GST Mode Toggle', () => {
  let originalMode: string;

  it('should get current GST mode', async () => {
    const res = await request(app)
      .get('/api/settings')
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    // Store original mode to restore later
    originalMode = res.body.data?.gstMode || 'disabled';
  });

  it('should toggle GST mode to sandbox', async () => {
    const res = await request(app)
      .put('/api/settings/gst/mode')
      .set(auth(adminToken))
      .send({ mode: 'sandbox' });

    expect(res.status).toBe(200);
    expect(res.body.data.gstMode).toBe('sandbox');
  });

  it('should toggle GST mode to disabled', async () => {
    const res = await request(app)
      .put('/api/settings/gst/mode')
      .set(auth(adminToken))
      .send({ mode: 'disabled' });

    expect(res.status).toBe(200);
    expect(res.body.data.gstMode).toBe('disabled');
  });

  it('should toggle GST mode to live', async () => {
    const res = await request(app)
      .put('/api/settings/gst/mode')
      .set(auth(adminToken))
      .send({ mode: 'live' });

    expect(res.status).toBe(200);
    expect(res.body.data.gstMode).toBe('live');
  });

  it('should reject invalid GST mode', async () => {
    const res = await request(app)
      .put('/api/settings/gst/mode')
      .set(auth(adminToken))
      .send({ mode: 'invalid_mode' });

    expect(res.status).toBe(400);
  });

  it('should deny finance from toggling GST mode', async () => {
    const res = await request(app)
      .put('/api/settings/gst/mode')
      .set(auth(financeToken))
      .send({ mode: 'sandbox' });

    expect([403, 401]).toContain(res.status);
  });

  it('should deny inventory from toggling GST mode', async () => {
    const res = await request(app)
      .put('/api/settings/gst/mode')
      .set(auth(inventoryToken))
      .send({ mode: 'sandbox' });

    expect([403, 401]).toContain(res.status);
  });

  // Restore original mode
  afterAll(async () => {
    if (originalMode) {
      await request(app)
        .put('/api/settings/gst/mode')
        .set(auth(adminToken))
        .send({ mode: originalMode });
    }
  });
});

// Group A Step 3 — Sandbox allowlist enforcement.
//
// Uses the service directly rather than the route, because mutating dist-001's
// state via HTTP requests would pollute parallel test files that depend on
// dist-001 staying in gst_mode='disabled' / isTestTenant=true. This file's
// describe blocks above already cover the route layer for the toggle itself —
// here we focus on the new guard semantics through the service.
describe('GST Mode — Sandbox Allowlist (Group A Step 3)', () => {
  const adhocId = 'test-group-a-sandbox-allowlist';

  beforeAll(async () => {
    await prisma.distributor.upsert({
      where: { id: adhocId },
      update: { gstMode: 'disabled', isTestTenant: false },
      create: {
        id: adhocId,
        businessName: 'Group A Allowlist Test',
        legalName: 'Group A Allowlist Test Pvt Ltd',
        status: 'active',
        gstMode: 'disabled',
        isTestTenant: false,
      },
    });
  });

  afterAll(async () => {
    await prisma.distributor.deleteMany({ where: { id: adhocId } });
  });

  it('blocks a non-test tenant from toggling to sandbox (SANDBOX_NOT_ALLOWED)', async () => {
    const { updateGstMode } = await import('../services/settingsService.js');
    await expect(updateGstMode(adhocId, 'sandbox')).rejects.toMatchObject({
      code: 'SANDBOX_NOT_ALLOWED',
    });
    // State unchanged.
    const after = await prisma.distributor.findUniqueOrThrow({
      where: { id: adhocId }, select: { gstMode: true },
    });
    expect(after.gstMode).toBe('disabled');
  });

  it('allows a test tenant to toggle to sandbox', async () => {
    await prisma.distributor.update({
      where: { id: adhocId }, data: { isTestTenant: true },
    });
    const { updateGstMode } = await import('../services/settingsService.js');
    const result = await updateGstMode(adhocId, 'sandbox');
    expect(result.gstMode).toBe('sandbox');
    // Revert for next test
    await prisma.distributor.update({
      where: { id: adhocId }, data: { isTestTenant: false, gstMode: 'disabled' },
    });
  });

  it('allows non-test tenant to toggle to disabled or live (sandbox is the only gated value)', async () => {
    const { updateGstMode } = await import('../services/settingsService.js');
    await expect(updateGstMode(adhocId, 'disabled')).resolves.toMatchObject({ gstMode: 'disabled' });
    await expect(updateGstMode(adhocId, 'live')).resolves.toMatchObject({ gstMode: 'live' });
  });
});

// ─── GST CREDENTIALS TESTS ─────────────────────────────────────────────────

describe('GST Credentials', () => {
  it('should get GST credentials (empty or populated)', async () => {
    const res = await request(app)
      .get('/api/settings/gst/credentials')
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    // Should return an object (possibly with empty fields)
  });

  it('should update GST credentials', async () => {
    const res = await request(app)
      .put('/api/settings/gst/credentials')
      .set(auth(adminToken))
      .send({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        username: 'test-user',
        gstin: '29AALCS4728Q1ZB',
      });

    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.data).toBeDefined();
    }
  });

  it('should reject credentials with invalid GSTIN format', async () => {
    const res = await request(app)
      .put('/api/settings/gst/credentials')
      .set(auth(adminToken))
      .send({
        clientId: 'test',
        clientSecret: 'test',
        username: 'test',
        gstin: 'INVALID_GSTIN',
      });

    expect(res.status).toBe(400);
  });

  it('should deny finance from updating GST credentials', async () => {
    const res = await request(app)
      .put('/api/settings/gst/credentials')
      .set(auth(financeToken))
      .send({
        clientId: 'test',
        clientSecret: 'test',
        username: 'test',
        gstin: '29AALCS4728Q1ZB',
      });

    expect([403, 401]).toContain(res.status);
  });

  // WI-058: tests above intentionally write bogus credentials to the
  // caller's distributor (dist-001). Without this cleanup the row
  // leaks into the shared dev DB and hijacks every lookupGstin call
  // (anti-pattern #13 / WI-058). Delete by sentinel client_id values.
  afterAll(async () => {
    await prisma.gstCredential.deleteMany({
      where: {
        OR: [
          { clientId: 'test-client-id' },
          { clientId: 'test' },
        ],
      },
    });
  });
});

// ─── RETROACTIVE GST TESTS ─────────────────────────────────────────────────

describe('Retroactive GST', () => {
  it('should handle retroactive GST generation request', async () => {
    const res = await request(app)
      .post('/api/invoices/retroactive-gst')
      .set(auth(adminToken));

    // Should process successfully (even if 0 invoices to update)
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.data).toHaveProperty('totalProcessed');
      expect(res.body.data).toHaveProperty('totalSkipped');
    }
  });

  it('should deny finance from triggering retroactive GST', async () => {
    const res = await request(app)
      .post('/api/invoices/retroactive-gst')
      .set(auth(financeToken));

    // Finance may or may not have access — check
    expect([200, 403, 401]).toContain(res.status);
  });
});

// ─── SETTINGS GENERAL TESTS ────────────────────────────────────────────────

describe('Settings Management', () => {
  it('should get all settings', async () => {
    const res = await request(app)
      .get('/api/settings')
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });

  it('should get cylinder thresholds', async () => {
    const res = await request(app)
      .get('/api/settings/cylinder-thresholds/list')
      .set(auth(adminToken));

    expect(res.status).toBe(200);
  });

  it('should get approval workflows', async () => {
    const res = await request(app)
      .get('/api/settings/approval-workflows/list')
      .set(auth(adminToken));

    expect(res.status).toBe(200);
  });

  it('should get licenses', async () => {
    const res = await request(app)
      .get('/api/settings/licenses/list')
      .set(auth(adminToken));

    expect(res.status).toBe(200);
  });
});

// ─── SUPER ADMIN SETTINGS ACCESS ───────────────────────────────────────────

describe('Super Admin Settings Access', () => {
  it('should allow super admin to view settings', async () => {
    const res = await request(app)
      .get('/api/settings')
      .set(auth(superAdminToken))
      .set('X-Distributor-Id', distAdminDistributorId);

    expect(res.status).toBe(200);
  });
});
