// Group A Step 2 — Layer 1 env-var routing for WhiteBooks credentials.
// Pure unit test: no DB, no HTTP. Verifies the env→DB-fallback contract.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getLayer1Credentials, GstError } from '../../services/gst/whitebooksClient.js';

const KEYS = [
  'WHITEBOOKS_EINVOICE_SANDBOX_CLIENT_ID',
  'WHITEBOOKS_EINVOICE_SANDBOX_CLIENT_SECRET',
  'WHITEBOOKS_EWAYBILL_SANDBOX_CLIENT_ID',
  'WHITEBOOKS_EWAYBILL_SANDBOX_CLIENT_SECRET',
  'WHITEBOOKS_EINVOICE_PROD_CLIENT_ID',
  'WHITEBOOKS_EINVOICE_PROD_CLIENT_SECRET',
  'WHITEBOOKS_EWAYBILL_PROD_CLIENT_ID',
  'WHITEBOOKS_EWAYBILL_PROD_CLIENT_SECRET',
] as const;

describe('getLayer1Credentials — Group A env-var routing', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns env-var values when both env vars are set (einvoice sandbox)', () => {
    process.env.WHITEBOOKS_EINVOICE_SANDBOX_CLIENT_ID = 'env-cid';
    process.env.WHITEBOOKS_EINVOICE_SANDBOX_CLIENT_SECRET = 'env-csec';
    expect(getLayer1Credentials('einvoice', 'sandbox')).toEqual({
      clientId: 'env-cid',
      clientSecret: 'env-csec',
    });
  });

  it('returns env-var values when both env vars are set (ewaybill prod)', () => {
    process.env.WHITEBOOKS_EWAYBILL_PROD_CLIENT_ID = 'env-ewb-cid';
    process.env.WHITEBOOKS_EWAYBILL_PROD_CLIENT_SECRET = 'env-ewb-csec';
    expect(getLayer1Credentials('ewaybill', 'live')).toEqual({
      clientId: 'env-ewb-cid',
      clientSecret: 'env-ewb-csec',
    });
  });

  it('returns null in sandbox when env vars are missing (caller falls back to DB)', () => {
    expect(getLayer1Credentials('einvoice', 'sandbox')).toBeNull();
    expect(getLayer1Credentials('ewaybill', 'sandbox')).toBeNull();
  });

  it('returns null in sandbox when only ONE of the two vars is set (incomplete pair → DB fallback)', () => {
    process.env.WHITEBOOKS_EINVOICE_SANDBOX_CLIENT_ID = 'env-cid-only';
    // CLIENT_SECRET not set
    expect(getLayer1Credentials('einvoice', 'sandbox')).toBeNull();
  });

  it('throws NO_PROD_CREDS in live mode when env vars are missing', () => {
    expect(() => getLayer1Credentials('einvoice', 'live')).toThrow(GstError);
    try {
      getLayer1Credentials('einvoice', 'live');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(GstError);
      expect((e as GstError).code).toBe('NO_PROD_CREDS');
      expect((e as Error).message).toMatch(/Production WhiteBooks credentials not configured/);
    }
  });

  it('throws NO_PROD_CREDS in live mode when only ONE of the two vars is set (live never falls back)', () => {
    process.env.WHITEBOOKS_EINVOICE_PROD_CLIENT_ID = 'env-cid-only';
    expect(() => getLayer1Credentials('einvoice', 'live')).toThrow(GstError);
  });

  it('einvoice and ewaybill scopes resolve to independent env-var names', () => {
    process.env.WHITEBOOKS_EINVOICE_SANDBOX_CLIENT_ID = 'einv-cid';
    process.env.WHITEBOOKS_EINVOICE_SANDBOX_CLIENT_SECRET = 'einv-csec';
    process.env.WHITEBOOKS_EWAYBILL_SANDBOX_CLIENT_ID = 'ewb-cid';
    process.env.WHITEBOOKS_EWAYBILL_SANDBOX_CLIENT_SECRET = 'ewb-csec';
    expect(getLayer1Credentials('einvoice', 'sandbox')).toEqual({
      clientId: 'einv-cid', clientSecret: 'einv-csec',
    });
    expect(getLayer1Credentials('ewaybill', 'sandbox')).toEqual({
      clientId: 'ewb-cid', clientSecret: 'ewb-csec',
    });
  });

  it('sandbox and live envs are independent — sandbox set, live not → live throws', () => {
    process.env.WHITEBOOKS_EINVOICE_SANDBOX_CLIENT_ID = 'sbx-cid';
    process.env.WHITEBOOKS_EINVOICE_SANDBOX_CLIENT_SECRET = 'sbx-csec';
    expect(getLayer1Credentials('einvoice', 'sandbox')).not.toBeNull();
    expect(() => getLayer1Credentials('einvoice', 'live')).toThrow(GstError);
  });
});
