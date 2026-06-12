/**
 * Group A regression — GSTIN lookup tenant isolation.
 *
 * Background: WI-058 added `email: { not: null }` to lookupGstin's
 * credential queries to prevent the 2026-05-16 outage where a leaked
 * NULL-email row served as the fallback for everyone. That fix worked
 * for the era when Layer 1 (client_id/secret/email) lived in the DB.
 *
 * After Group A (late May 2026), Layer 1 credentials moved to env
 * vars. The activation flow now writes the per-distributor row with
 * `email = NULL` and `client_id = 'ENV_VAR_ROUTED'` — the real values
 * come from process.env at call time. This is the new normal for
 * every live tenant.
 *
 * The bug: WI-058's `email: { not: null }` filter excludes every
 * Group-A-activated row. The fallback (also email-filtered) then
 * picks the only row that DOES have email != null — dist-demo's
 * sandbox row — and every live tenant's lookups silently route
 * through dist-demo's sandbox URL.
 *
 * Observed in prod logs (2026-06-12 08:32:39):
 *   GET /api/distributors/gstin-lookup/36AAMFH8885N1ZA
 *   url: https://apisandbox.whitebooks.in/...     ← wrong
 *   distributorId: "dist-demo"                    ← wrong tenant
 *
 * Pure unit test — no DB, no HTTP. Mocks prisma.gstCredential.findFirst
 * to faithfully reproduce the WHERE-clause behaviour, mocks fetch to
 * capture the outbound URL, and pins env vars for both modes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// vi.mock hoists ABOVE imports. Mock prisma so we can control what
// findFirst returns based on the WHERE clause. Mock whitebooksClient's
// getAuthToken so no real network call is attempted, but leave
// getLayer1Credentials untouched — we want to exercise the real env
// var reading code path.
vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    gstCredential: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('../../services/gst/whitebooksClient.js', async (orig) => {
  const original = (await orig()) as typeof import('../../services/gst/whitebooksClient.js');
  return {
    ...original,
    getAuthToken: vi.fn(async () => 'fake-test-token'),
  };
});

import { prisma } from '../../lib/prisma.js';
import { lookupGstin } from '../../services/gst/gstinLookup.js';
import { GstError } from '../../services/gst/whitebooksClient.js';

const VANASTHALI_ID = 'test-vanasthali-id';
const DIST_DEMO_ID = 'test-dist-demo-id';

// Faithfully simulate what prisma.gstCredential.findFirst would do
// against a 2-row test DB (Vanasthali + dist-demo) honouring the WHERE
// clause that the code under test passes.
type FakeRow = {
  id: string;
  distributorId: string;
  scope: 'einvoice' | 'ewaybill';
  isValid: boolean;
  email: string | null;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  gstin: string;
  lastValidated: Date | null;
  distributor?: { id?: string; gstMode: string };
};

const ROW_VANASTHALI: FakeRow = {
  id: 'cred-vanasthali',
  distributorId: VANASTHALI_ID,
  scope: 'einvoice',
  isValid: true,
  email: null, // ← Group A pattern: email lives in Layer 1 env, not row
  clientId: 'ENV_VAR_ROUTED',
  clientSecret: 'ENV_VAR_ROUTED',
  username: 'API_VGSMGL',
  password: 'fake-pass-1',
  gstin: '36AMXPM3145R1Z1',
  lastValidated: new Date('2026-06-11T10:03:32Z'),
  distributor: { gstMode: 'live' },
};

const ROW_DIST_DEMO: FakeRow = {
  id: 'cred-dist-demo',
  distributorId: DIST_DEMO_ID,
  scope: 'einvoice',
  isValid: true,
  email: 'mvsuneelkumar2903@gmail.com', // ← email populated (pre-Group-A pattern)
  clientId: 'EINSc0e87f75-real-sandbox-id',
  clientSecret: 'sandbox-client-secret',
  username: 'BVMGSP',
  password: 'fake-pass-2',
  gstin: '29AAGCB1286Q000',
  lastValidated: new Date('2026-06-11T14:39:57Z'),
  distributor: { id: DIST_DEMO_ID, gstMode: 'sandbox' },
};

function applyWhere(rows: FakeRow[], where: Record<string, unknown> | undefined): FakeRow[] {
  if (!where) return rows;
  return rows.filter((r) => {
    if (where.distributorId !== undefined && r.distributorId !== where.distributorId) return false;
    if (where.scope !== undefined && r.scope !== where.scope) return false;
    if (where.isValid !== undefined && r.isValid !== where.isValid) return false;
    // email filter — supports `{ not: null }` or absence
    if (where.email !== undefined) {
      const f = where.email as { not?: unknown };
      if (f && typeof f === 'object' && 'not' in f && f.not === null) {
        if (r.email === null) return false;
      }
    }
    return true;
  });
}

// fetch mock — capture outbound calls, return a valid NIC-shaped success.
const originalFetch = global.fetch;
let fetchCalls: Array<{ url: string }> = [];

function installFetchMock() {
  fetchCalls = [];
  // Cast: vitest doesn't have a typed signature for global fetch
  global.fetch = vi.fn(async (input: string | URL | Request) => {
    fetchCalls.push({ url: String(input) });
    return {
      ok: true,
      text: async () => JSON.stringify({
        status_cd: '1',
        data: {
          LegalName: 'Test Buyer Pvt Ltd',
          TradeName: 'Test Buyer',
          Status: 'ACT',
          StateCode: '29',
          AddrPncd: 560001,
          AddrBnm: 'Test Building',
          AddrLoc: 'Bangalore',
        },
      }),
    };
  }) as unknown as typeof fetch;
}

const ENV_KEYS = [
  'WHITEBOOKS_EINVOICE_PROD_CLIENT_ID',
  'WHITEBOOKS_EINVOICE_PROD_CLIENT_SECRET',
  'WHITEBOOKS_EINVOICE_PROD_EMAIL',
  'WHITEBOOKS_EINVOICE_SANDBOX_CLIENT_ID',
  'WHITEBOOKS_EINVOICE_SANDBOX_CLIENT_SECRET',
  'WHITEBOOKS_EINVOICE_SANDBOX_EMAIL',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeAll(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
  // Pin to known test values — these are the Layer 1 env vars the fix
  // expects to find for live tenants.
  process.env.WHITEBOOKS_EINVOICE_PROD_CLIENT_ID = 'real-prod-client-id-40-chars-len';
  process.env.WHITEBOOKS_EINVOICE_PROD_CLIENT_SECRET = 'real-prod-client-secret-40-len-x';
  process.env.WHITEBOOKS_EINVOICE_PROD_EMAIL = 'info@mygaslink.com';
  process.env.WHITEBOOKS_EINVOICE_SANDBOX_CLIENT_ID = 'sandbox-client-id-40-chars-len-x';
  process.env.WHITEBOOKS_EINVOICE_SANDBOX_CLIENT_SECRET = 'sandbox-client-secret-40-len-xx';
  process.env.WHITEBOOKS_EINVOICE_SANDBOX_EMAIL = 'mvsuneelkumar2903@gmail.com';
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  global.fetch = originalFetch;
});

beforeEach(() => {
  installFetchMock();
  vi.mocked(prisma.gstCredential.findFirst).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GSTIN lookup tenant isolation (Group A regression — gstinLookup.ts:162, 204)', () => {
  it('Test 1: live tenant with email=NULL must use OWN credentials (Layer 1 env), NOT dist-demo', async () => {
    // Simulate a 2-row DB: Vanasthali (email=null, live) + dist-demo (email NOT null, sandbox).
    // findFirst respects the WHERE clause that the code passes.
    vi.mocked(prisma.gstCredential.findFirst).mockImplementation(async (args) => {
      const where = (args as { where?: Record<string, unknown> }).where;
      return applyWhere([ROW_VANASTHALI, ROW_DIST_DEMO], where)[0] ?? null;
    });

    await lookupGstin('36AAMFH8885N1ZA', VANASTHALI_ID);

    expect(fetchCalls.length).toBeGreaterThan(0);
    const url = fetchCalls[0].url;
    // The fix must route to PRODUCTION URL, not sandbox.
    expect(url, `URL was ${url}`).toContain('api.whitebooks.in');
    expect(url, `URL was ${url}`).not.toContain('apisandbox.whitebooks.in');
    // The email used in the URL must come from Layer 1 PROD env var, NOT dist-demo's
    // sandbox email (mvsuneelkumar2903@gmail.com).
    expect(url).toContain('info%40mygaslink.com');
    expect(url).not.toContain('mvsuneelkumar2903');
  });

  it('Test 2: sandbox tenant with email NOT NULL must still route to sandbox (no regression)', async () => {
    vi.mocked(prisma.gstCredential.findFirst).mockImplementation(async (args) => {
      const where = (args as { where?: Record<string, unknown> }).where;
      return applyWhere([ROW_VANASTHALI, ROW_DIST_DEMO], where)[0] ?? null;
    });

    await lookupGstin('29AAGCB1286Q000', DIST_DEMO_ID);

    expect(fetchCalls.length).toBeGreaterThan(0);
    const url = fetchCalls[0].url;
    expect(url, `URL was ${url}`).toContain('apisandbox.whitebooks.in');
    expect(url).toContain('mvsuneelkumar2903'); // sandbox email
  });

  it('Test 3: cross-tenant isolation — live tenant lookup must NEVER use sandbox tenant credentials', async () => {
    vi.mocked(prisma.gstCredential.findFirst).mockImplementation(async (args) => {
      const where = (args as { where?: Record<string, unknown> }).where;
      return applyWhere([ROW_VANASTHALI, ROW_DIST_DEMO], where)[0] ?? null;
    });

    await lookupGstin('36AAMFH8885N1ZA', VANASTHALI_ID);

    expect(fetchCalls.length).toBeGreaterThan(0);
    const url = fetchCalls[0].url;
    // Sandbox URL would mean dist-demo's row hijacked the lookup → cross-tenant leak.
    expect(url, 'Cross-tenant credential leak: live tenant routed to sandbox URL').not.toContain('apisandbox');
    // Sandbox email would mean dist-demo's email got used → same leak.
    expect(url, 'Cross-tenant credential leak: live tenant used sandbox email').not.toContain('mvsuneelkumar2903');
  });

  it('Test 4: no credentials at all must throw a clear error, not silently fall back', async () => {
    // Both queries return null — no row matches.
    vi.mocked(prisma.gstCredential.findFirst).mockResolvedValue(null);

    await expect(lookupGstin('36ANYGSTIN12X1Z5', 'unknown-tenant'))
      .rejects.toBeInstanceOf(GstError);
    // No HTTP call should have been made.
    expect(fetchCalls.length).toBe(0);
  });
});
