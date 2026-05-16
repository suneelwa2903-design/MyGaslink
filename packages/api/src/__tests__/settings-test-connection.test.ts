/**
 * WI-054 — Test Connection endpoint behaviour.
 *
 * Pins the two-stage probe + cache-bypass contract:
 *   1. POST /api/settings/gst/credentials/:scope/test ALWAYS bypasses
 *      the in-memory token cache. A cached token must not short-circuit
 *      a successful response — the 2026-05-16 outage stayed invisible
 *      under the old endpoint exactly because of that short-circuit.
 *   2. The response carries BOTH `authenticated` and `nicReachable`
 *      booleans on every call, regardless of outcome (anti-pattern #9
 *      shape guard).
 *   3. NIC reachability is probed via a read-only GSTNDETAILS call —
 *      not GENERATE. Cost: zero IRNs created.
 *   4. ewaybill scope skips Stage 2 (its own /authenticate already
 *      touches NIC EWB portal); response mirrors auth into nicReachable.
 *
 * vi.mock must hoist above the route imports so getAuthToken and
 * validateGstin are replaced before app.ts wires them up.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

// vi.mock is hoisted to the top of the file BEFORE any const declarations,
// so we use vi.hoisted() to create the mock fns at the same hoisted level.
const { getAuthTokenMock, clearTokenCacheMock, validateGstinMock } = vi.hoisted(() => ({
  getAuthTokenMock: vi.fn(),
  clearTokenCacheMock: vi.fn(),
  validateGstinMock: vi.fn(),
}));

vi.mock('../services/gst/whitebooksClient.js', async (orig) => {
  const original: any = await orig();
  return {
    ...original,
    getAuthToken: getAuthTokenMock,
    clearTokenCache: clearTokenCacheMock,
  };
});

vi.mock('../services/gst/gstService.js', async (orig) => {
  const original: any = await orig();
  return {
    ...original,
    validateGstin: validateGstinMock,
  };
});

import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let sharmaAdminToken: string;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  app = createApp();
  const sharmaAdmin = await prisma.user.findUniqueOrThrow({
    where: { email: 'sharma@gasdist.com' },
  });
  sharmaAdminToken = generateToken({
    userId: sharmaAdmin.id,
    email: sharmaAdmin.email,
    role: sharmaAdmin.role as any,
    distributorId: sharmaAdmin.distributorId,
  });
});

beforeEach(() => {
  getAuthTokenMock.mockReset();
  clearTokenCacheMock.mockReset();
  validateGstinMock.mockReset();
});

describe('WI-054 — Test Connection two-stage probe', () => {
  it('clears the token cache before calling getAuthToken (force fresh auth)', async () => {
    getAuthTokenMock.mockResolvedValueOnce('fresh-token');
    validateGstinMock.mockResolvedValueOnce({ valid: true });

    await request(app)
      .post('/api/settings/gst/credentials/einvoice/test')
      .set(auth(sharmaAdminToken));

    // clearTokenCache must run BEFORE getAuthToken to invalidate any
    // cached token from a prior successful call.
    expect(clearTokenCacheMock).toHaveBeenCalledTimes(1);
    expect(clearTokenCacheMock).toHaveBeenCalledWith('dist-002');
    expect(getAuthTokenMock).toHaveBeenCalled();
    // Ensure clear happened first by comparing invocation order.
    const clearOrder = clearTokenCacheMock.mock.invocationCallOrder[0];
    const authOrder = getAuthTokenMock.mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(authOrder);
  });

  it('both stages green → {authenticated:true, nicReachable:true}', async () => {
    getAuthTokenMock.mockResolvedValueOnce('fresh-token');
    validateGstinMock.mockResolvedValueOnce({ valid: true, source: 'whitebooks', data: { name: 'X' } });

    const res = await request(app)
      .post('/api/settings/gst/credentials/einvoice/test')
      .set(auth(sharmaAdminToken));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      authenticated: true,
      nicReachable: true,
      scope: 'einvoice',
    });
    // message phrasing is asserted loosely so future copy tweaks don't break.
    expect(res.body.data.message).toMatch(/auth.*OK.*NIC.*respond/i);
  });

  it('auth fails → {authenticated:false, nicReachable:false} and Stage 2 skipped', async () => {
    getAuthTokenMock.mockRejectedValueOnce(new Error('This email is not registered with WhiteBooks'));

    const res = await request(app)
      .post('/api/settings/gst/credentials/einvoice/test')
      .set(auth(sharmaAdminToken));

    expect(res.status).toBe(200);
    expect(res.body.data.authenticated).toBe(false);
    expect(res.body.data.nicReachable).toBe(false);
    expect(res.body.data.authError).toMatch(/not registered/i);
    // Stage 2 must NOT run when Stage 1 failed.
    expect(validateGstinMock).not.toHaveBeenCalled();
  });

  it('auth ok but NIC GSTNDETAILS fails → {authenticated:true, nicReachable:false} (this is yesterday\'s outage)', async () => {
    getAuthTokenMock.mockResolvedValueOnce('fresh-token');
    validateGstinMock.mockResolvedValueOnce({
      valid: false,
      source: 'whitebooks',
      error: '[5002] Application error, issue with application',
    });

    const res = await request(app)
      .post('/api/settings/gst/credentials/einvoice/test')
      .set(auth(sharmaAdminToken));

    expect(res.status).toBe(200);
    expect(res.body.data.authenticated).toBe(true);
    expect(res.body.data.nicReachable).toBe(false);
    expect(res.body.data.nicError).toMatch(/5002/);
  });

  it('ewaybill scope: auth success mirrors into nicReachable (no Stage 2 call)', async () => {
    getAuthTokenMock.mockResolvedValueOnce('fresh-token');

    const res = await request(app)
      .post('/api/settings/gst/credentials/ewaybill/test')
      .set(auth(sharmaAdminToken));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      authenticated: true,
      nicReachable: true,
      scope: 'ewaybill',
    });
    // validateGstin is einvoice-only; ewaybill must not invoke it.
    expect(validateGstinMock).not.toHaveBeenCalled();
  });

  it('Anti-pattern #9 — response carries BOTH boolean fields on every call', async () => {
    // Failure case
    getAuthTokenMock.mockRejectedValueOnce(new Error('fail'));
    let res = await request(app)
      .post('/api/settings/gst/credentials/einvoice/test')
      .set(auth(sharmaAdminToken));
    expect(res.body.data).toHaveProperty('authenticated');
    expect(res.body.data).toHaveProperty('nicReachable');
    expect(typeof res.body.data.authenticated).toBe('boolean');
    expect(typeof res.body.data.nicReachable).toBe('boolean');

    // Success case
    getAuthTokenMock.mockResolvedValueOnce('t');
    validateGstinMock.mockResolvedValueOnce({ valid: true });
    res = await request(app)
      .post('/api/settings/gst/credentials/einvoice/test')
      .set(auth(sharmaAdminToken));
    expect(res.body.data).toHaveProperty('authenticated');
    expect(res.body.data).toHaveProperty('nicReachable');
    expect(typeof res.body.data.authenticated).toBe('boolean');
    expect(typeof res.body.data.nicReachable).toBe('boolean');
  });
});
