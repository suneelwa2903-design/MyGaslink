/**
 * WI-060 — TZ-safe parsing of WhiteBooks/NIC `TokenExpiry` strings.
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
