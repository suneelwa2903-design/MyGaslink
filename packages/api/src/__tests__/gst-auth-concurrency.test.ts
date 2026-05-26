/**
 * WI-059 — Auth fetch dedup + pre-warm guards.
 *
 * Pin two invariants in getAuthToken:
 *
 *   1. N concurrent callers for the same (distributorId, scope) on a
 *      cold cache must produce exactly ONE underlying /authenticate
 *      fetch and yield identical tokens. Stops the cold-cache stampede
 *      that bounced 2 of 4 orders with "fetch failed" on 2026-05-16.
 *
 *   2. After a successful fetch, subsequent calls hit the in-memory
 *      cache and DO NOT fetch again (until expiry).
 *
 * The promise-dedup map is exercised by spying on `global.fetch` and
 * counting invocations across simultaneous Promise.all() calls.
 *
 * We do NOT exercise the real WhiteBooks endpoint — fetch is stubbed
 * with a deterministic success body. Goal is the in-process behaviour
 * of `getAuthToken`, not the upstream API.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

import { prisma } from '../lib/prisma.js';
import {
  clearTokenCache,
  getAuthToken,
} from '../services/gst/whitebooksClient.js';

let originalFetch: typeof globalThis.fetch;
let fetchCalls: string[] = [];

beforeAll(async () => {
  // The dist-002 seed row may have been flipped to is_valid=false by
  // prior test runs (markGstCredentialsInvalid). Force it valid so
  // getCredentials returns the row.
  await prisma.gstCredential.updateMany({
    where: { distributorId: 'dist-002' },
    data: { isValid: true },
  });
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchCalls = [];
  // Single shared mock so the call counter is global per-test.
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
    fetchCalls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status_cd: 'Sucess',
        data: {
          AuthToken: 'WI059-TEST-TOKEN-' + fetchCalls.length,
          TokenExpiry: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        },
      }),
    } as Response;
  });
  // Always start from a cold cache so each test exercises the dedup path.
  clearTokenCache('dist-002');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearTokenCache('dist-002');
});

describe('WI-059 — getAuthToken concurrent fetch dedup', () => {
  it('10 simultaneous cold-cache callers produce exactly ONE fetch and identical tokens', async () => {
    const promises = Array.from({ length: 10 }, () =>
      getAuthToken('dist-002', 'einvoice'),
    );
    const tokens = await Promise.all(promises);

    // Exactly one /authenticate request hit the wire.
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]).toContain('/einvoice/authenticate');

    // All 10 callers got the same token.
    const unique = new Set(tokens);
    expect(unique.size).toBe(1);
    expect(tokens[0]).toMatch(/^WI059-TEST-TOKEN-/);
  });

  it('after one successful fetch, 5 subsequent serial calls hit cache (zero new fetches)', async () => {
    // First call — populates cache.
    await getAuthToken('dist-002', 'einvoice');
    expect(fetchCalls.length).toBe(1);

    // 5 more serial calls — all should be cache hits.
    for (let i = 0; i < 5; i++) {
      await getAuthToken('dist-002', 'einvoice');
    }
    expect(fetchCalls.length).toBe(1); // still 1, no new fetches
  });

  it('different scopes are NOT collapsed: concurrent einvoice + ewaybill produce 2 fetches', async () => {
    const [einvoice, ewaybill] = await Promise.all([
      getAuthToken('dist-002', 'einvoice'),
      getAuthToken('dist-002', 'ewaybill'),
    ]);
    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls.some((u) => u.includes('/einvoice/authenticate'))).toBe(true);
    expect(fetchCalls.some((u) => u.includes('/ewaybillapi/v1.03/authenticate'))).toBe(true);
    expect(einvoice).toBeTruthy();
    expect(ewaybill).toBeTruthy();
  });

  it('a rejected fetch releases the in-flight slot so the next call can retry', async () => {
    // First call fails at network level.
    let callIdx = 0;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      fetchCalls.push(String(url));
      callIdx++;
      if (callIdx === 1) throw new Error('simulated fetch failed');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status_cd: 'Sucess',
          data: {
            AuthToken: 'WI059-RETRY-TOKEN',
            TokenExpiry: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          },
        }),
      } as Response;
    });

    await expect(getAuthToken('dist-002', 'einvoice')).rejects.toThrow(/fetch failed/);
    expect(fetchCalls.length).toBe(1);

    // If the in-flight slot wasn't cleared, this second call would
    // forever await the rejected promise. Behaviour test: it must fetch
    // fresh and succeed.
    const token = await getAuthToken('dist-002', 'einvoice');
    expect(token).toBe('WI059-RETRY-TOKEN');
    expect(fetchCalls.length).toBe(2);
  });
});
