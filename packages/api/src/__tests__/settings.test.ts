import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, loginAsFinance } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let financeToken: string;

const TEST_KEY = 'test_setting_alpha';
const TEST_LICENSE_NAMES = ['TEST License Alpha', 'TEST License Beta'];

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;
  financeToken = (await loginAsFinance()).token;
});

afterAll(async () => {
  // Clean: settings + licenses we created
  await prisma.distributorSetting.deleteMany({
    where: { distributorId: 'dist-001', settingKey: TEST_KEY },
  });
  await prisma.license.deleteMany({
    where: {
      distributorId: 'dist-001',
      licenseName: { in: TEST_LICENSE_NAMES },
    },
  });
});

function auth(token: string, distId?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (distId) headers['X-Distributor-Id'] = distId;
  return headers;
}

describe('Settings — Auth', () => {
  it('rejects unauthenticated GET / with 401', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(401);
  });

  it('rejects PUT for non-admin role (403)', async () => {
    const res = await request(app)
      .put(`/api/settings/${TEST_KEY}`)
      .set(auth(financeToken))
      .send({ value: { foo: 'bar' } });
    expect(res.status).toBe(403);
  });

  it('rejects PUT /gst/mode for non-admin role (403)', async () => {
    const res = await request(app)
      .put('/api/settings/gst/mode')
      .set(auth(financeToken))
      .send({ mode: 'sandbox' });
    expect(res.status).toBe(403);
  });
});

describe('Settings — JSONB key-value', () => {
  it('GET / returns the structured settings envelope (gstMode + rawSettings)', async () => {
    // Contract change: GET /settings now returns a DistributorSettings
    // object — gstMode, gstCredentials, rawSettings[] — so every web
    // consumer that reads settings.gstMode actually gets a value.
    const res = await request(app).get('/api/settings').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toBeTypeOf('object');
    expect(Array.isArray(res.body.data.rawSettings)).toBe(true);
    // gstMode reflects the distributor's current mode (string or null).
    expect(res.body.data).toHaveProperty('gstMode');
    expect(res.body.data).toHaveProperty('gstCredentials');
  });

  it('PUT /:key creates a setting and persists', async () => {
    const value = { sla_hours: 48, escalation_email: 'ops@example.com' };
    const res = await request(app)
      .put(`/api/settings/${TEST_KEY}`)
      .set(auth(adminToken))
      .send({ value });
    if (res.status !== 200) console.log('settings PUT error:', res.body);
    expect(res.status).toBe(200);

    // Verify persisted in the DB
    const row = await prisma.distributorSetting.findUnique({
      where: {
        distributorId_settingKey: { distributorId: 'dist-001', settingKey: TEST_KEY },
      },
    });
    expect(row).not.toBeNull();
    expect(row?.settingValue).toMatchObject(value);
  });

  it('GET /:key returns the persisted setting', async () => {
    const res = await request(app)
      .get(`/api/settings/${TEST_KEY}`)
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    // The settings service maps settingValue → value when serialising
    const v = res.body.data?.value ?? res.body.data?.settingValue;
    expect(v?.sla_hours).toBe(48);
  });

  it('GET /:key returns 404 when missing', async () => {
    const res = await request(app)
      .get('/api/settings/this_does_not_exist_xyz')
      .set(auth(adminToken));
    expect(res.status).toBe(404);
  });

  it('DELETE /:key removes the setting', async () => {
    const res = await request(app)
      .delete(`/api/settings/${TEST_KEY}`)
      .set(auth(adminToken));
    expect(res.status).toBe(200);

    const row = await prisma.distributorSetting.findUnique({
      where: {
        distributorId_settingKey: { distributorId: 'dist-001', settingKey: TEST_KEY },
      },
    });
    expect(row).toBeNull();
  });
});

describe('Settings — GST mode toggle', () => {
  it('switching GST mode persists on the distributor row', async () => {
    // dist-001 starts with gstMode = 'disabled' per seed.
    const before = await prisma.distributor.findUniqueOrThrow({
      where: { id: 'dist-001' },
      select: { gstMode: true },
    });

    const res = await request(app)
      .put('/api/settings/gst/mode')
      .set(auth(adminToken))
      .send({ mode: 'sandbox' });
    if (res.status !== 200) console.log('gst mode error:', res.body);
    expect(res.status).toBe(200);

    const after = await prisma.distributor.findUniqueOrThrow({
      where: { id: 'dist-001' },
      select: { gstMode: true },
    });
    expect(after.gstMode).toBe('sandbox');

    // Restore so it doesn't pollute other tests that depend on dist-001
    // being GST-disabled.
    await prisma.distributor.update({
      where: { id: 'dist-001' },
      data: { gstMode: before.gstMode },
    });
  });

  it('rejects invalid GST mode (400)', async () => {
    const res = await request(app)
      .put('/api/settings/gst/mode')
      .set(auth(adminToken))
      .send({ mode: 'magical' });
    expect(res.status).toBe(400);
  });
});

describe('Settings — Cylinder thresholds & workflows', () => {
  it('GET /cylinder-thresholds/list returns an array', async () => {
    const res = await request(app)
      .get('/api/settings/cylinder-thresholds/list')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /approval-workflows/list returns an array', async () => {
    const res = await request(app)
      .get('/api/settings/approval-workflows/list')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('Settings — Licenses', () => {
  let createdLicenseId: string;

  it('POST /licenses creates a license', async () => {
    const res = await request(app)
      .post('/api/settings/licenses')
      .set(auth(adminToken))
      .send({
        licenseType: 'peso',
        licenseName: TEST_LICENSE_NAMES[0],
        licenseNumber: 'PESO-TEST-001',
        expiryDate: '2027-01-01',
      });
    if (res.status !== 201) console.log('license create error:', res.body);
    expect(res.status).toBe(201);
    expect(res.body.data.licenseName).toBe(TEST_LICENSE_NAMES[0]);
    createdLicenseId = res.body.data.id;
  });

  it('rejects POST /licenses with missing fields (400)', async () => {
    const res = await request(app)
      .post('/api/settings/licenses')
      .set(auth(adminToken))
      .send({ /* empty */ });
    expect(res.status).toBe(400);
  });

  it('GET /licenses/list returns the new license scoped to caller', async () => {
    const res = await request(app)
      .get('/api/settings/licenses/list')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const found = res.body.data.find((l: { licenseName: string }) => l.licenseName === TEST_LICENSE_NAMES[0]);
    expect(found).toBeDefined();
  });

  it('PUT /licenses/:id updates the license', async () => {
    const res = await request(app)
      .put(`/api/settings/licenses/${createdLicenseId}`)
      .set(auth(adminToken))
      .send({ licenseName: TEST_LICENSE_NAMES[1] });
    expect(res.status).toBe(200);
    expect(res.body.data.licenseName).toBe(TEST_LICENSE_NAMES[1]);
  });

  it('DELETE /licenses/:id removes the license', async () => {
    const res = await request(app)
      .delete(`/api/settings/licenses/${createdLicenseId}`)
      .set(auth(adminToken));
    expect(res.status).toBe(200);
  });
});

describe('Settings — Tenant Isolation', () => {
  it('cannot fetch another distributor\'s setting via GET /:key', async () => {
    // Seed a setting on dist-002.
    const dist2Key = 'dist2_only_key';
    await prisma.distributorSetting.upsert({
      where: { distributorId_settingKey: { distributorId: 'dist-002', settingKey: dist2Key } },
      create: { distributorId: 'dist-002', settingKey: dist2Key, settingValue: { secret: true } },
      update: { settingValue: { secret: true } },
    });

    const res = await request(app)
      .get(`/api/settings/${dist2Key}`)
      .set(auth(adminToken)); // dist-001 admin
    expect(res.status).toBe(404);

    // Cleanup
    await prisma.distributorSetting.delete({
      where: { distributorId_settingKey: { distributorId: 'dist-002', settingKey: dist2Key } },
    });
  });

  it('cannot update another distributor\'s license', async () => {
    // Create a license on dist-002.
    const dist2License = await prisma.license.create({
      data: {
        distributorId: 'dist-002',
        licenseType: 'peso',
        licenseName: 'TEST Dist2 License',
      },
    });

    const res = await request(app)
      .put(`/api/settings/licenses/${dist2License.id}`)
      .set(auth(adminToken)) // dist-001 admin
      .send({ licenseName: 'Hijacked Name' });
    expect([403, 404]).toContain(res.status);

    // Cleanup
    await prisma.license.delete({ where: { id: dist2License.id } });
  });
});

// WI-042 — scoped GST credentials Test & Save + role gating.
// We can't authenticate against real WhiteBooks here, so we send
// obviously-bogus credentials and expect the route's authenticate
// failure path: 400 with code AUTH_FAILED, and isValid=false on the
// stored row. The role gate runs before the WhiteBooks call.
describe('Settings — Scoped GST credentials (WI-042)', () => {
  const distId = 'dist-001';
  const stamp = Date.now();
  const validShape = {
    clientId: `TEST-CLIENT-${stamp}`,
    clientSecret: `TEST-SECRET-${stamp}`,
    username: 'TESTUSER',
    password: 'TESTPASS',
    gstin: '29AAGCB1286Q1Z0', // valid format; WhiteBooks will still reject
    email: 'test@mygaslink.com',
  };

  afterAll(async () => {
    // Delete just the row this test created so the seed credentials are
    // not affected for other tests.
    await prisma.gstCredential.deleteMany({
      where: {
        distributorId: distId,
        clientId: validShape.clientId,
      },
    });
    // WI-058 belt-and-braces: also remove any TEST-CLIENT-* / test-client-id
    // rows leaked by prior runs (the dev DB is shared with manual testing,
    // anti-pattern #2 / #7). One such leak in May-2026 routed every Sharma
    // GSTIN lookup through prod WhiteBooks with bogus dist-001 creds for
    // a full day before we caught it.
    await prisma.gstCredential.deleteMany({
      where: {
        OR: [
          { clientId: { startsWith: 'TEST-CLIENT' } },
          { clientId: 'test-client-id' },
        ],
      },
    });
  });

  it('finance is rejected (403) — only admin can PUT scoped credentials', async () => {
    const res = await request(app)
      .put('/api/settings/gst/credentials/einvoice')
      .set(auth(financeToken))
      .send(validShape);
    expect(res.status).toBe(403);
  });

  it('admin Test & Save: rejects bad scope param (400 BAD_SCOPE)', async () => {
    const res = await request(app)
      .put('/api/settings/gst/credentials/nonsense')
      .set(auth(adminToken))
      .send(validShape);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_SCOPE');
  });

  it('admin Test & Save: stores row then fails WhiteBooks auth → 400 AUTH_FAILED + isValid=false', async () => {
    const res = await request(app)
      .put('/api/settings/gst/credentials/einvoice')
      .set(auth(adminToken))
      .send(validShape);
    // We expect AUTH_FAILED because the bogus credentials won't pass
    // real WhiteBooks. If somehow the network is unreachable in CI we
    // still get 400 from the same error path.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AUTH_FAILED');

    const row = await prisma.gstCredential.findFirst({
      where: { distributorId: distId, scope: 'einvoice', clientId: validShape.clientId },
    });
    expect(row).toBeTruthy();
    expect(row?.isValid).toBe(false);
  });

  it('POST /test rejects bad scope (400 BAD_SCOPE)', async () => {
    const res = await request(app)
      .post('/api/settings/gst/credentials/garbage/test')
      .set(auth(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_SCOPE');
  });

  it('POST /test as finance is rejected (403)', async () => {
    const res = await request(app)
      .post('/api/settings/gst/credentials/einvoice/test')
      .set(auth(financeToken));
    expect(res.status).toBe(403);
  });
});
