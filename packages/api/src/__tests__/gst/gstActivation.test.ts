// Group A Step 5 — Atomic GST activation / disable endpoint tests.
//
// Uses ad-hoc test distributors per anti-pattern #7 (no dist-001/dist-002
// pollution). Mocks previewTestConnection so we don't hit real WhiteBooks.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { loginAsDistAdmin, loginAsFinance, loginAsSuperAdmin } from '../helpers.js';
import {
  credentialFingerprint,
} from '../../services/gst/gstActivationService.js';
import type { Express } from 'express';

// Mock global fetch. previewTestConnection calls fetch directly so we get
// deterministic control over auth success/failure without real WhiteBooks.
// Vitest module mocks don't catch within-module cross-references, so this
// is the right interception layer.
let mockAuthSuccess = true;
let mockAuthErrorMessage = '';
beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    json: async () =>
      mockAuthSuccess
        ? { status_cd: '1', status_desc: 'OK', data: { AuthToken: 'MOCK_TOKEN', TokenExpiry: '2099-12-31 23:59:59' } }
        : { status_cd: '0', status_desc: mockAuthErrorMessage || 'auth rejected' },
  } as unknown as Response)));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

let app: Express;
let superAdminToken: string;
let distAdminToken: string;
let financeToken: string;

const ADHOC_ID = 'test-group-a-activation';
const ADHOC_GSTIN = '36AABCU9603R1ZM'; // reuse dist-001's GSTIN shape — valid

beforeAll(async () => {
  app = createApp();
  const sa = await loginAsSuperAdmin();
  superAdminToken = sa.token;
  const da = await loginAsDistAdmin();
  distAdminToken = da.token;
  const fin = await loginAsFinance();
  financeToken = fin.token;

  await prisma.distributor.upsert({
    where: { id: ADHOC_ID },
    update: { gstMode: 'disabled', isTestTenant: true, gstin: ADHOC_GSTIN },
    create: {
      id: ADHOC_ID,
      businessName: 'Group A Activation Test',
      legalName: 'Group A Activation Test Pvt Ltd',
      gstin: ADHOC_GSTIN,
      status: 'active',
      gstMode: 'disabled',
      isTestTenant: true,
    },
  });
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { distributorId: ADHOC_ID } });
  await prisma.gstCredential.deleteMany({ where: { distributorId: ADHOC_ID } });
  await prisma.gstDocument.deleteMany({ where: { distributorId: ADHOC_ID } });
  await prisma.distributor.deleteMany({ where: { id: ADHOC_ID } });
});

beforeEach(async () => {
  // Reset to a clean activation baseline before every test.
  await prisma.auditLog.deleteMany({ where: { distributorId: ADHOC_ID } });
  await prisma.gstCredential.deleteMany({ where: { distributorId: ADHOC_ID } });
  await prisma.gstDocument.deleteMany({ where: { distributorId: ADHOC_ID } });
  await prisma.distributor.update({
    where: { id: ADHOC_ID },
    data: { gstMode: 'disabled', isTestTenant: true },
  });
  mockAuthSuccess = true;
  mockAuthErrorMessage = '';
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Group A revision: Layer 2 is username + password only. Email is
// GasLink-global Layer 1 (env var), not collected per distributor.
const SAMPLE_CREDS = {
  username: 'testuser',
  password: 'testpass123',
};

const SAMPLE_BODY = {
  mode: 'sandbox' as const,
  einvoice: SAMPLE_CREDS,
  ewaybill: 'same_as_einvoice' as const,
  reason: 'new_distributor_activation' as const,
};

describe('POST /api/admin/distributors/:id/gst/test-connection', () => {
  it('super_admin can preview test with body creds (200)', async () => {
    const res = await request(app)
      .post(`/api/admin/distributors/${ADHOC_ID}/gst/test-connection`)
      .set(auth(superAdminToken))
      .send({ scope: 'einvoice', mode: 'sandbox', credentials: SAMPLE_CREDS });
    expect(res.status).toBe(200);
    expect(res.body.data.authenticated).toBe(true);
    expect(res.body.data.scope).toBe('einvoice');
  });

  it('distributor_admin is denied (403)', async () => {
    const res = await request(app)
      .post(`/api/admin/distributors/${ADHOC_ID}/gst/test-connection`)
      .set(auth(distAdminToken))
      .send({ scope: 'einvoice', mode: 'sandbox', credentials: SAMPLE_CREDS });
    expect([401, 403]).toContain(res.status);
  });

  it('finance is denied (403)', async () => {
    const res = await request(app)
      .post(`/api/admin/distributors/${ADHOC_ID}/gst/test-connection`)
      .set(auth(financeToken))
      .send({ scope: 'einvoice', mode: 'sandbox', credentials: SAMPLE_CREDS });
    expect([401, 403]).toContain(res.status);
  });

  it('missing credentials body returns 400 CREDENTIALS_REQUIRED', async () => {
    const res = await request(app)
      .post(`/api/admin/distributors/${ADHOC_ID}/gst/test-connection`)
      .set(auth(superAdminToken))
      .send({ scope: 'einvoice', mode: 'sandbox' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CREDENTIALS_REQUIRED');
  });

  it('invalid scope returns 400', async () => {
    const res = await request(app)
      .post(`/api/admin/distributors/${ADHOC_ID}/gst/test-connection`)
      .set(auth(superAdminToken))
      .send({ scope: 'wrong', mode: 'sandbox', credentials: SAMPLE_CREDS });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/distributors/:id/gst/activate — happy path', () => {
  it('super_admin activates a fresh tenant: mode flips, creds upserted, audit log written', async () => {
    const res = await request(app)
      .post(`/api/admin/distributors/${ADHOC_ID}/gst/activate`)
      .set(auth(superAdminToken))
      .send(SAMPLE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.data.gstMode).toBe('sandbox');
    expect(res.body.data.einvoiceFingerprint).toHaveLength(16);
    expect(res.body.data.ewaybillFingerprint).toHaveLength(16);

    const dist = await prisma.distributor.findUniqueOrThrow({
      where: { id: ADHOC_ID }, select: { gstMode: true },
    });
    expect(dist.gstMode).toBe('sandbox');

    const creds = await prisma.gstCredential.findMany({
      where: { distributorId: ADHOC_ID }, orderBy: { scope: 'asc' },
    });
    expect(creds).toHaveLength(2);
    expect(creds[0].scope).toBe('einvoice');
    expect(creds[0].username).toBe(SAMPLE_CREDS.username);
    // Group A revision: email is no longer written to gst_credentials.email
    // by the activation flow. The column stays for legacy/cleanup, but is
    // left null on rows created by activate. Email-of-record lives in env.
    expect(creds[0].email).toBeNull();
    expect(creds[0].isValid).toBe(true);
    expect(creds[1].scope).toBe('ewaybill');
    expect(creds[1].username).toBe(SAMPLE_CREDS.username); // same_as_einvoice

    const audit = await prisma.auditLog.findFirst({
      where: { distributorId: ADHOC_ID, action: 'gst_activate' },
    });
    expect(audit).toBeTruthy();
    const details = audit!.details as Record<string, unknown>;
    expect(details.fromMode).toBe('disabled');
    expect(details.toMode).toBe('sandbox');
    expect(details.reason).toBe('new_distributor_activation');
    expect(details.einvoiceCredFingerprint).toBe(
      credentialFingerprint(SAMPLE_CREDS, ADHOC_GSTIN),
    );
    expect(details.ewaybillCredFingerprint).toBe(
      credentialFingerprint(SAMPLE_CREDS, ADHOC_GSTIN),
    );
    expect(details.sameCreds).toBe(true);
  });

  it('different creds per scope: both rows hold their own values, fingerprints differ', async () => {
    const einCreds = { username: 'einu', password: 'einp' };
    const ewbCreds = { username: 'ewbu', password: 'ewbp' };
    const res = await request(app)
      .post(`/api/admin/distributors/${ADHOC_ID}/gst/activate`)
      .set(auth(superAdminToken))
      .send({
        mode: 'sandbox',
        einvoice: einCreds,
        ewaybill: ewbCreds,
        reason: 'credential_rotation',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.einvoiceFingerprint).not.toBe(res.body.data.ewaybillFingerprint);
    const creds = await prisma.gstCredential.findMany({
      where: { distributorId: ADHOC_ID }, orderBy: { scope: 'asc' },
    });
    expect(creds[0].username).toBe('einu');
    expect(creds[1].username).toBe('ewbu');
  });
});

describe('POST /api/admin/distributors/:id/gst/activate — role + validation', () => {
  it('distributor_admin is denied (403)', async () => {
    const res = await request(app)
      .post(`/api/admin/distributors/${ADHOC_ID}/gst/activate`)
      .set(auth(distAdminToken))
      .send(SAMPLE_BODY);
    expect([401, 403]).toContain(res.status);
  });

  it('reason "other" without reasonText returns 400', async () => {
    const res = await request(app)
      .post(`/api/admin/distributors/${ADHOC_ID}/gst/activate`)
      .set(auth(superAdminToken))
      .send({ ...SAMPLE_BODY, reason: 'other' });
    expect(res.status).toBe(400);
  });

  it('reason "other" with reasonText is accepted', async () => {
    const res = await request(app)
      .post(`/api/admin/distributors/${ADHOC_ID}/gst/activate`)
      .set(auth(superAdminToken))
      .send({ ...SAMPLE_BODY, reason: 'other', reasonText: 'Migration from legacy GSP' });
    expect(res.status).toBe(200);
  });

  it('missing username field returns 400', async () => {
    const res = await request(app)
      .post(`/api/admin/distributors/${ADHOC_ID}/gst/activate`)
      .set(auth(superAdminToken))
      .send({
        ...SAMPLE_BODY,
        einvoice: { password: SAMPLE_CREDS.password }, // username missing
      });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown distributor', async () => {
    const res = await request(app)
      .post(`/api/admin/distributors/00000000-0000-0000-0000-000000000000/gst/activate`)
      .set(auth(superAdminToken))
      .send(SAMPLE_BODY);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DISTRIBUTOR_NOT_FOUND');
  });
});

describe('POST /api/admin/distributors/:id/gst/activate — transition guards', () => {
  it('blocks sandbox mode for non-test tenant (SANDBOX_NOT_ALLOWED)', async () => {
    await prisma.distributor.update({
      where: { id: ADHOC_ID }, data: { isTestTenant: false },
    });
    const res = await request(app)
      .post(`/api/admin/distributors/${ADHOC_ID}/gst/activate`)
      .set(auth(superAdminToken))
      .send(SAMPLE_BODY);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SANDBOX_NOT_ALLOWED');
    // No DB writes — verify creds + mode unchanged
    expect(await prisma.gstCredential.count({ where: { distributorId: ADHOC_ID } })).toBe(0);
    const dist = await prisma.distributor.findUniqueOrThrow({
      where: { id: ADHOC_ID }, select: { gstMode: true },
    });
    expect(dist.gstMode).toBe('disabled');
  });

  it('blocks live → sandbox (LIVE_TO_SANDBOX_BLOCKED)', async () => {
    await prisma.distributor.update({
      where: { id: ADHOC_ID }, data: { gstMode: 'live', isTestTenant: true },
    });
    const res = await request(app)
      .post(`/api/admin/distributors/${ADHOC_ID}/gst/activate`)
      .set(auth(superAdminToken))
      .send({ ...SAMPLE_BODY, mode: 'sandbox' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LIVE_TO_SANDBOX_BLOCKED');
  });
});

describe('POST /api/admin/distributors/:id/gst/activate — atomicity (test connection failure)', () => {
  it('TEST_CONNECTION_FAILED on einvoice: no DB writes happen', async () => {
    mockAuthSuccess = false;
    mockAuthErrorMessage = '[401] credentials wrong';

    const res = await request(app)
      .post(`/api/admin/distributors/${ADHOC_ID}/gst/activate`)
      .set(auth(superAdminToken))
      .send(SAMPLE_BODY);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEST_CONNECTION_FAILED');
    expect(res.body.data).toHaveProperty('einvoice');
    expect(res.body.data).toHaveProperty('ewaybill');

    // Verify nothing was written
    expect(await prisma.gstCredential.count({ where: { distributorId: ADHOC_ID } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { distributorId: ADHOC_ID, action: 'gst_activate' } })).toBe(0);
    const dist = await prisma.distributor.findUniqueOrThrow({
      where: { id: ADHOC_ID }, select: { gstMode: true },
    });
    expect(dist.gstMode).toBe('disabled');
  });
});

describe('POST /api/admin/distributors/:id/gst/disable', () => {
  it('super_admin disables a sandbox tenant: mode → disabled, creds preserved, audit log written', async () => {
    // First activate to populate credentials
    await request(app)
      .post(`/api/admin/distributors/${ADHOC_ID}/gst/activate`)
      .set(auth(superAdminToken))
      .send(SAMPLE_BODY);

    const res = await request(app)
      .post(`/api/admin/distributors/${ADHOC_ID}/gst/disable`)
      .set(auth(superAdminToken))
      .send({ reason: 'mode_change' });
    expect(res.status).toBe(200);
    expect(res.body.data.gstMode).toBe('disabled');

    const dist = await prisma.distributor.findUniqueOrThrow({
      where: { id: ADHOC_ID }, select: { gstMode: true },
    });
    expect(dist.gstMode).toBe('disabled');

    // Credentials preserved
    expect(await prisma.gstCredential.count({ where: { distributorId: ADHOC_ID } })).toBe(2);

    const audit = await prisma.auditLog.findFirst({
      where: { distributorId: ADHOC_ID, action: 'gst_disable' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeTruthy();
    const details = audit!.details as Record<string, unknown>;
    expect(details.fromMode).toBe('sandbox');
    expect(details.toMode).toBe('disabled');
    expect(details.reason).toBe('mode_change');
  });

  it('blocks live → disabled when in-flight GST docs exist (IN_FLIGHT_GST_DOCS)', async () => {
    // Put distributor in live, create a fake in-flight gst_document.
    await prisma.distributor.update({
      where: { id: ADHOC_ID },
      data: { gstMode: 'live', isTestTenant: true },
    });
    await prisma.gstDocument.create({
      data: {
        distributorId: ADHOC_ID,
        docType: 'INV',
        irn: 'TEST-IRN-INFLIGHT',
        irnStatus: 'pending',
        ewbStatus: 'active',
        isLatest: true,
      } as never,
    });

    const res = await request(app)
      .post(`/api/admin/distributors/${ADHOC_ID}/gst/disable`)
      .set(auth(superAdminToken))
      .send({ reason: 'revoke_access' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IN_FLIGHT_GST_DOCS');

    // Mode unchanged
    const dist = await prisma.distributor.findUniqueOrThrow({
      where: { id: ADHOC_ID }, select: { gstMode: true },
    });
    expect(dist.gstMode).toBe('live');
  });

  it('distributor_admin is denied (403)', async () => {
    const res = await request(app)
      .post(`/api/admin/distributors/${ADHOC_ID}/gst/disable`)
      .set(auth(distAdminToken))
      .send({ reason: 'mode_change' });
    expect([401, 403]).toContain(res.status);
  });

  it('reason "other" without reasonText returns 400', async () => {
    const res = await request(app)
      .post(`/api/admin/distributors/${ADHOC_ID}/gst/disable`)
      .set(auth(superAdminToken))
      .send({ reason: 'other' });
    expect(res.status).toBe(400);
  });
});

describe('credentialFingerprint', () => {
  it('is deterministic for the same inputs', () => {
    const a = credentialFingerprint(SAMPLE_CREDS, ADHOC_GSTIN);
    const b = credentialFingerprint(SAMPLE_CREDS, ADHOC_GSTIN);
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it('differs when any input changes', () => {
    const a = credentialFingerprint(SAMPLE_CREDS, ADHOC_GSTIN);
    const b = credentialFingerprint({ ...SAMPLE_CREDS, password: 'different' }, ADHOC_GSTIN);
    const c = credentialFingerprint(SAMPLE_CREDS, '36AABCU0000R1ZM');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});
