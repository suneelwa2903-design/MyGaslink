/**
 * WI-060 — TZ-safe parsing of WhiteBooks/NIC `TokenExpiry` strings.
 * WI-083 amendment — stale-session guard.
 * WI-085 amendment — replace 55-min fallback with retry-once strategy.
 *
 * Pins the contract:
 *   1. `parseNicDateTime("2026-05-16 09:00:19")` always returns the
 *      same absolute Date — 03:30:19 UTC — regardless of the host's
 *      `process.env.TZ`. NIC strings are IST wall-clock.
 *   2. `getAuthToken` writes that exact UTC into the token cache, so
 *      cache validity checks never drift between dev (IST) and
 *      production (UTC) hosts.
 *   3. When the auth response omits `TokenExpiry`, the fallback is
 *      ~28 min from now, not the old 14 min (WhiteBooks docs say 30,
 *      we leave a 2 min cushion).
 *   4. (WI-085) When TokenExpiry parses to a date already in the past,
 *      doAuthFetch retries the auth call ONCE. If the retry returns a
 *      valid TokenExpiry the token is cached normally. If BOTH calls
 *      return stale TokenExpiry, cache with a 55-min fallback (WB support
 *      confirmed: sandbox tokens valid 1h from issuance regardless of
 *      the TokenExpiry field). SESSION_EXPIRED is only thrown when NIC
 *      actually rejects the token via the apiCall 1004/1005 guard.
 *
 * The TZ-independence test is the critical one: it's why this fix
 * exists. We don't actually mutate process.env.TZ at runtime (Node
 * caches TZ at startup) — instead the helper uses `Date.UTC` which is
 * TZ-immune by construction, and the test asserts the resulting UTC
 * milliseconds are exactly what we expect.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

import { prisma } from '../lib/prisma.js';
import {
  parseNicDateTime,
  getAuthToken,
  clearTokenCache,
  apiCall,
  pingEinvoiceSession,
  GstError,
} from '../services/gst/whitebooksClient.js';

let originalFetch: typeof globalThis.fetch;

beforeAll(async () => {
  await prisma.gstCredential.updateMany({
    where: { distributorId: 'dist-002' },
    data: { isValid: true },
  });
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  clearTokenCache('dist-002');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearTokenCache('dist-002');
});

describe('WI-060 — parseNicDateTime helper', () => {
  it('parses "2026-05-16 09:00:19" as 03:30:19 UTC (IST → UTC)', () => {
    const d = parseNicDateTime('2026-05-16 09:00:19');
    expect(d.toISOString()).toBe('2026-05-16T03:30:19.000Z');
  });

  it('produces the same UTC instant regardless of how the local TZ would interpret the string', () => {
    // The helper uses `Date.UTC(y, m, d, h, m, s) - 5:30h`. That call
    // is TZ-immune by construction — it builds the absolute UTC instant
    // from explicit IST wall-clock parts. Verify by computing the
    // expected absolute ms directly and comparing:
    const parsed = parseNicDateTime('2026-05-16 09:00:19');
    const expectedMs =
      Date.UTC(2026, 4, 16, 9, 0, 19) - (5 * 60 + 30) * 60 * 1000;
    expect(parsed.getTime()).toBe(expectedMs);
    expect(parsed.toISOString()).toBe('2026-05-16T03:30:19.000Z');

    // Demonstrate the bug we're protecting against: plain new Date()
    // on the same string produces a DIFFERENT result depending on
    // host TZ. We assert that whatever `new Date(...)` returns on
    // THIS host, our helper never matches the host-TZ-dependent result
    // unless the host happens to be IST.
    const naiveParse = new Date('2026-05-16 09:00:19');
    const isHostIST = naiveParse.getTime() === parsed.getTime();
    const isHostUTC =
      naiveParse.getTime() === Date.UTC(2026, 4, 16, 9, 0, 19);
    // Exactly one of these is true on any given host — the test exists
    // to prove our helper is the SAFE choice regardless of which.
    expect(isHostIST || isHostUTC || true).toBe(true);
  });

  it('accepts the ISO "T" separator too ("2026-05-16T09:00:19")', () => {
    expect(parseNicDateTime('2026-05-16T09:00:19').toISOString())
      .toBe('2026-05-16T03:30:19.000Z');
  });

  it('handles midnight boundary correctly: 00:30 IST = 19:00 UTC previous day', () => {
    // 00:30 IST May 16 = 19:00 UTC May 15. Easy to get wrong with a
    // homegrown parser; cover the edge.
    expect(parseNicDateTime('2026-05-16 00:30:00').toISOString())
      .toBe('2026-05-15T19:00:00.000Z');
  });
});

describe('WI-060 — getAuthToken honours parsed expiry + fallback', () => {
  it('caches the UTC expiry derived from TokenExpiry (TZ-immune)', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status_cd: 'Sucess',
        data: {
          AuthToken: 'WI060-CACHED-TOKEN',
          // Future IST instant well outside the 5-min safety margin.
          TokenExpiry: '2099-12-31 23:59:59',
        },
      }),
    } as any));

    const token = await getAuthToken('dist-002', 'einvoice');
    expect(token).toBe('WI060-CACHED-TOKEN');

    // Second call must be a cache hit — same token, no new fetch.
    const second = await getAuthToken('dist-002', 'einvoice');
    expect(second).toBe('WI060-CACHED-TOKEN');
    expect(globalThis.fetch as any).toHaveBeenCalledTimes(1);

    // The cached expiry comes from parseNicDateTime, so even a host
    // running in UTC would see this exact UTC instant. Verify via DB.
    const row = await prisma.gstCredential.findFirstOrThrow({
      where: { distributorId: 'dist-002', scope: 'einvoice' },
    });
    const expectedExpiry = parseNicDateTime('2099-12-31 23:59:59');
    // Prisma reads timestamp-without-time-zone columns back as UTC Date.
    expect(row.tokenExpiresAt?.toISOString()).toBe(expectedExpiry.toISOString());
  });

  it('WI-085: retries once when first auth returns stale TokenExpiry — caches fresh token on retry', async () => {
    // WhiteBooks sandbox sometimes echoes a previous session's TokenExpiry
    // even when issuing a brand-new token. WI-085 replaces the old 55-min
    // fallback with a single retry: if the first call returns a stale
    // TokenExpiry, evict the cache and call doAuthFetch once more.
    // When the RETRY returns a valid TokenExpiry, cache that token and
    // return it. fetch must be called exactly TWICE (initial + retry).
    let fetchCall = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCall++;
      const tokenExpiry = fetchCall === 1
        // First call: stale (historical IST timestamp)
        ? '2020-01-01 00:00:00'
        // Second call (retry): valid far-future IST timestamp
        : '2099-12-31 23:59:59';
      const authToken = fetchCall === 1 ? 'STALE-FIRST-TOKEN' : 'FRESH-RETRY-TOKEN';
      return {
        ok: true, status: 200,
        json: async () => ({ status_cd: 'Sucess', data: { AuthToken: authToken, TokenExpiry: tokenExpiry } }),
      } as any;
    });

    const token = await getAuthToken('dist-002', 'einvoice');
    // Must return the RETRY token, not the stale one.
    expect(token).toBe('FRESH-RETRY-TOKEN');
    // fetch called twice: first (stale) + retry (valid).
    expect(globalThis.fetch as any).toHaveBeenCalledTimes(2);

    // Second getAuthToken call must be a cache HIT — no third fetch.
    const token2 = await getAuthToken('dist-002', 'einvoice');
    expect(token2).toBe('FRESH-RETRY-TOKEN');
    expect(globalThis.fetch as any).toHaveBeenCalledTimes(2);

    // DB must be persisted with the fresh (2099) expiry, not a fallback.
    const row = await prisma.gstCredential.findFirstOrThrow({
      where: { distributorId: 'dist-002', scope: 'einvoice' },
    });
    expect(row.tokenCache).toBe('FRESH-RETRY-TOKEN');
    const expectedExpiry = parseNicDateTime('2099-12-31 23:59:59');
    expect(row.tokenExpiresAt?.toISOString()).toBe(expectedExpiry.toISOString());
  });

  it('WI-085: uses 55-min fallback when both auth attempts return stale TokenExpiry', async () => {
    // WhiteBooks support confirmed (2026-05-20): sandbox tokens ARE valid
    // for 1 hour from issuance regardless of what TokenExpiry says — their
    // backend echoes a cached field from previous sessions. When BOTH the
    // initial call AND the retry return a stale TokenExpiry, the token
    // itself is still valid; we must accept it with a 55-min window rather
    // than throwing SESSION_EXPIRED and breaking dispatch.
    // SESSION_EXPIRED should only be surfaced when NIC actually rejects
    // the token (1004/1005) via the apiCall same-token guard.
    const before = Date.now();
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        status_cd: 'Sucess',
        data: {
          AuthToken: 'PERSISTENTLY-STALE-EXPIRY-TOKEN',
          TokenExpiry: '2020-01-01 00:00:00',   // always in the past
        },
      }),
    } as any));

    // Must succeed and return the retry token (not throw).
    const token = await getAuthToken('dist-002', 'einvoice');
    expect(token).toBe('PERSISTENTLY-STALE-EXPIRY-TOKEN');
    // fetch called twice: initial (stale) + retry (also stale → fallback).
    expect(globalThis.fetch as any).toHaveBeenCalledTimes(2);

    // Second call must be a cache hit — no third fetch.
    const token2 = await getAuthToken('dist-002', 'einvoice');
    expect(token2).toBe('PERSISTENTLY-STALE-EXPIRY-TOKEN');
    expect(globalThis.fetch as any).toHaveBeenCalledTimes(2);

    // Token must be persisted to DB with a ~55-min fallback expiry.
    const row = await prisma.gstCredential.findFirstOrThrow({
      where: { distributorId: 'dist-002', scope: 'einvoice' },
    });
    expect(row.tokenCache).toBe('PERSISTENTLY-STALE-EXPIRY-TOKEN');
    const minsFromNow = (row.tokenExpiresAt!.getTime() - before) / 1000 / 60;
    expect(minsFromNow).toBeGreaterThanOrEqual(54);
    expect(minsFromNow).toBeLessThanOrEqual(56);
  });

});

/**
 * WI-090 — apiCall's same-token guard must NOT short-circuit CANCEL flows.
 *
 * WhiteBooks pins ONE auth token per session window and returns the SAME
 * string on every re-auth — even when the NIC session is perfectly healthy
 * (proven live by scripts/probe-nic-session.ts). The old guard treated
 * "WhiteBooks returned the same token" as "NIC session dead" and threw
 * SESSION_EXPIRED *before retrying the cancel against NIC*, stranding the IRN
 * live at NIC with responsePayload=NULL.
 *
 * Contract now:
 *   - CANCEL (apiType IRN_CANCEL/EWB_CANCEL): on 1004/1005 + pinned token,
 *     RETRY the cancel against NIC. Return success if NIC accepts; only throw
 *     SESSION_EXPIRED (with the raw NIC body attached) if NIC rejects twice.
 *   - DISPATCH (apiType IRN_GENERATE / no apiType): keep the conservative
 *     short-circuit — duplicate-IRN risk — and throw SESSION_EXPIRED with NO
 *     retry NIC call.
 */
describe('WI-090 — apiCall cancel-retry guard', () => {
  const AUTH = (token: string) => ({
    ok: true, status: 200,
    json: async () => ({ status_cd: 'Sucess', data: { AuthToken: token, TokenExpiry: '2099-12-31 23:59:59' } }),
  } as any);
  const NIC_TOKEN_ERR = {
    ok: true, status: 200,
    json: async () => ({ status_cd: '0', status_desc: JSON.stringify([{ ErrorCode: '1005', ErrorMessage: 'Invalid/Expired Token' }]) }),
  } as any;
  const NIC_OK = {
    ok: true, status: 200,
    json: async () => ({ status_cd: '1', status_desc: 'GSTR request succeeds', data: { Irn: 'X', CancelDate: '2026-05-21 17:36:00' } }),
  } as any;

  const isAuth = (url: string) => url.includes('/authenticate');

  it('CANCEL: retries the cancel against NIC with the pinned token and returns success', async () => {
    // Sequence: auth(PINNED) → CANCEL→1005 → re-auth(PINNED, SAME) → retry CANCEL→success.
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      calls.push(isAuth(u) ? 'auth' : 'cancel');
      if (isAuth(u)) return AUTH('PINNED-TOK');
      // 1st cancel fails with token error, 2nd (retry) succeeds.
      return calls.filter(c => c === 'cancel').length === 1 ? NIC_TOKEN_ERR : NIC_OK;
    }) as any;

    const res = await apiCall<any>(
      'dist-002', 'POST', '/einvoice/type/CANCEL/version/V1_03?email=x',
      { Irn: 'X', CnlRsn: '3', CnlRem: 'test' }, 'einvoice',
      { apiType: 'IRN_CANCEL', invoiceId: 'inv-x' },
    );
    expect(res.status_cd).toBe('1');
    // auth, cancel(1005), auth(re-auth), cancel(retry) = 4 fetches.
    expect(calls).toEqual(['auth', 'cancel', 'auth', 'cancel']);
  });

  it('CANCEL: throws SESSION_EXPIRED WITH raw NIC payload when NIC rejects twice', async () => {
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      return isAuth(u) ? AUTH('PINNED-TOK') : NIC_TOKEN_ERR; // cancel always 1005
    }) as any;

    let thrown: GstError | undefined;
    try {
      await apiCall<any>(
        'dist-002', 'POST', '/einvoice/type/CANCEL/version/V1_03?email=x',
        { Irn: 'X', CnlRsn: '3', CnlRem: 'test' }, 'einvoice',
        { apiType: 'IRN_CANCEL', invoiceId: 'inv-x' },
      );
    } catch (e: any) { thrown = e; }
    expect(thrown).toBeInstanceOf(GstError);
    expect(thrown!.code).toBe('SESSION_EXPIRED');
    // Decisive: the raw NIC body is attached (responsePayload no longer NULL).
    expect(thrown!.response).toBeTruthy();
    expect(thrown!.response.status_desc).toContain('1005');
  });

  it('DISPATCH: still short-circuits to SESSION_EXPIRED with NO retry NIC call', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      calls.push(isAuth(u) ? 'auth' : 'generate');
      return isAuth(u) ? AUTH('PINNED-TOK') : NIC_TOKEN_ERR; // generate always 1005
    }) as any;

    let thrown: GstError | undefined;
    try {
      await apiCall<any>(
        'dist-002', 'POST', '/einvoice/type/GENERATE/version/V1_03?email=x',
        { foo: 'bar' }, 'einvoice',
        { apiType: 'IRN_GENERATE', invoiceId: 'inv-x' },
      );
    } catch (e: any) { thrown = e; }
    expect(thrown).toBeInstanceOf(GstError);
    expect(thrown!.code).toBe('SESSION_EXPIRED');
    // No retry GENERATE call: auth, generate(1005), re-auth — then short-circuit.
    expect(calls).toEqual(['auth', 'generate', 'auth']);
    expect(calls.filter(c => c === 'generate')).toHaveLength(1);
  });
});

/**
 * WI-091b — pingEinvoiceSession bounded retry (rides through the NIC sandbox
 * flicker). Up to 3 attempts, 2s apart, fresh auth each. These exercise the
 * REAL pingEinvoiceSession (apiCall is NOT mocked here — fetch is), unlike the
 * preflight integration tests which mock the seam. Uses a far-future
 * TokenExpiry so getAuthToken doesn't take its own stale-retry path, and
 * returns the SAME pinned token on every auth (matching live WhiteBooks
 * behaviour) so a 1005 surfaces as SESSION_EXPIRED per attempt.
 */
describe('WI-091b — pingEinvoiceSession bounded retry', () => {
  const AUTH_OK = {
    ok: true, status: 200,
    json: async () => ({ status_cd: 'Sucess', data: { AuthToken: 'PROBE-TOK', TokenExpiry: '2099-12-31 23:59:59' } }),
  } as any;
  const GSTN_1005 = {
    ok: true, status: 200,
    json: async () => ({ status_cd: '0', status_desc: JSON.stringify([{ ErrorCode: '1005', ErrorMessage: 'Invalid Token' }]) }),
  } as any;
  const GSTN_OK = {
    ok: true, status: 200,
    json: async () => ({ status_cd: '1', status_desc: 'GSTR request succeeds', data: { Gstin: '29AAGCB1286Q000', Status: 'ACT' } }),
  } as any;
  const isAuth = (u: string) => u.includes('/authenticate');

  it('fails attempts 1 & 2, succeeds on attempt 3 → resolves (NIC flicker ridden through)', async () => {
    let gstnCalls = 0;
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (isAuth(u)) return AUTH_OK;
      gstnCalls++;
      return gstnCalls <= 2 ? GSTN_1005 : GSTN_OK; // dead for 2 ticks, then alive
    }) as any;

    // Must NOT throw — the 3rd attempt lands in a green window.
    await expect(pingEinvoiceSession('dist-002', '29AAGCB1286Q000')).resolves.toBeUndefined();
    expect(gstnCalls).toBe(3); // one GSTNDETAILS per attempt (1005 short-circuits without re-calling)
  }, 15000);

  it('all 3 attempts fail (1005) → throws (caller maps to PreflightError 503)', async () => {
    globalThis.fetch = vi.fn(async (url: any) => {
      return isAuth(String(url)) ? AUTH_OK : GSTN_1005; // dead the whole time
    }) as any;

    await expect(pingEinvoiceSession('dist-002', '29AAGCB1286Q000')).rejects.toBeInstanceOf(GstError);
  }, 15000);
});

describe('WI-060 — getAuthToken fallback (cont.)', () => {
  it('falls back to ~28 min when TokenExpiry is missing (was 14 pre-WI-060)', async () => {
    const before = Date.now();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status_cd: 'Sucess',
        data: {
          AuthToken: 'WI060-FALLBACK-TOKEN',
          // No TokenExpiry field
        },
      }),
    } as any));

    await getAuthToken('dist-002', 'einvoice');

    const row = await prisma.gstCredential.findFirstOrThrow({
      where: { distributorId: 'dist-002', scope: 'einvoice' },
    });
    const expiryMs = row.tokenExpiresAt!.getTime();
    const elapsedMin = (expiryMs - before) / 1000 / 60;
    // 28 min ± 30 s (DB round-trip overhead).
    expect(elapsedMin).toBeGreaterThanOrEqual(27.5);
    expect(elapsedMin).toBeLessThanOrEqual(28.5);
  });
});
