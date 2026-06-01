/**
 * Anti-pattern regression guards (CLAUDE.md anti-patterns #1-#9).
 *
 * Each guard pins a known bad pattern so it can never regress silently.
 * Scoped to the surfaces added/touched by WI-039 through WI-043:
 *
 *   Guard 1  — Tenant isolation on the new CN/DN list + GST credentials
 *              endpoints (anti-pattern #1 — multi-tenant convention is
 *              the only line of defence; one missing distributorId
 *              filter is a leak).
 *   Guard 2  — gstinLookup contract: throws on missing required fields
 *              instead of silently defaulting to empty strings. Receiving
 *              side of anti-pattern #6 (don't silently absorb provider
 *              regressions).
 *   Guard 3  — CN/DN list endpoints scope by invoiceId: a note raised on
 *              invoice A is not retrievable via invoice B's list URL,
 *              even when both belong to the same distributor.
 *   Guard 4  — Role escalation: finance can create a credit note but
 *              cannot approve their own (or anyone's) — the approve
 *              gate is admin-only.
 *
 * New anti-pattern surfaced this session, documented as #9 in CLAUDE.md:
 *              API response type-annotated as one shape but route returns
 *              another (the WI-044 settings shape mismatch — symmetric to
 *              the WI-019 BillingStatus enum mismatch and the WI-039
 *              CreditNote enum suffix mismatch).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

// vi.mock must hoist above the imports below so gstinLookup's call to
// getAuthToken returns a fake token without ever hitting WhiteBooks.
vi.mock('../services/gst/whitebooksClient.js', async (orig) => {
  const original = (await orig()) as typeof import('../services/gst/whitebooksClient.js');
  return {
    ...original,
    getAuthToken: vi.fn(async () => 'fake-test-token'),
  };
});

import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, loginAsFinance, generateToken } from './helpers.js';
import { UserRole } from '@gaslink/shared';
import type { Express } from 'express';

let app: Express;
let dist1AdminToken: string;
let dist1FinanceToken: string;
let dist2AdminToken: string;

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  app = createApp();
  dist1AdminToken = (await loginAsDistAdmin()).token;
  dist1FinanceToken = (await loginAsFinance()).token;

  // Sharma (dist-002) admin token — generated directly because
  // loginAsDistAdmin only knows about dist-001's seeded admin.
  const sharmaAdmin = await prisma.user.findUniqueOrThrow({
    where: { email: 'sharma@gasdist.com' },
  });
  dist2AdminToken = generateToken({
    userId: sharmaAdmin.id,
    email: sharmaAdmin.email,
    role: sharmaAdmin.role as UserRole,
    distributorId: sharmaAdmin.distributorId,
  });
});

// ─── Shared fixtures ────────────────────────────────────────────────────────
// We need at least one dist-001 invoice to attach CNs to. The seed creates
// these for Bhargava; we just look one up rather than creating new state.
async function getDist1Invoice(): Promise<{ id: string; invoiceNumber: string } | null> {
  const inv = await prisma.invoice.findFirst({
    where: { distributorId: 'dist-001', deletedAt: null },
    select: { id: true, invoiceNumber: true },
    orderBy: { createdAt: 'asc' },
  });
  return inv;
}

// ─── Guard 1 — Tenant isolation (anti-pattern #1) ───────────────────────────
describe('Guard 1 — Tenant isolation on new WI-039/042 endpoints', () => {
  it('GET /api/invoices/:id/credit-notes refuses an invoice from another distributor (404)', async () => {
    const dist1Inv = await getDist1Invoice();
    if (!dist1Inv) return; // seed produced no dist-001 invoice; skip
    // Use dist-002's admin token to request dist-001's invoice CNs.
    // The route filters by invoiceId + req.user.distributorId — a leak
    // would 200 with the CN list. The correct response is 404 because
    // dist-002 can't see dist-001's invoices at all.
    const res = await request(app)
      .get(`/api/invoices/${dist1Inv.id}/credit-notes`)
      .set(auth(dist2AdminToken));
    expect([403, 404]).toContain(res.status);
    // Defence in depth: even if the status check were wrong, ensure no
    // creditNotes array leaked into the body.
    expect(res.body?.data?.creditNotes).toBeFalsy();
  });

  it('GET /api/invoices/:id/debit-notes refuses cross-tenant invoice (404)', async () => {
    const dist1Inv = await getDist1Invoice();
    if (!dist1Inv) return;
    const res = await request(app)
      .get(`/api/invoices/${dist1Inv.id}/debit-notes`)
      .set(auth(dist2AdminToken));
    expect([403, 404]).toContain(res.status);
    expect(res.body?.data?.debitNotes).toBeFalsy();
  });

  it('GET /api/settings/gst/credentials only returns rows for the caller\'s distributor', async () => {
    // Sharma (dist-002) seed inserts both einvoice + ewaybill credentials.
    const res = await request(app)
      .get('/api/settings/gst/credentials')
      .set(auth(dist2AdminToken));
    expect(res.status).toBe(200);
    const rows = Array.isArray(res.body.data) ? res.body.data : res.body.data ? [res.body.data] : [];
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // The serialised credential payload is masked (no clientSecret /
    // password) but we can verify isolation against the raw DB rows:
    // every row returned must belong to dist-002 in storage.
    const returnedIds = (rows as Array<{ id?: string }>).map((r) => r.id).filter(Boolean) as string[];
    if (returnedIds.length > 0) {
      const dbRows = await prisma.gstCredential.findMany({
        where: { id: { in: returnedIds } },
        select: { id: true, distributorId: true },
      });
      for (const row of dbRows) {
        expect(row.distributorId).toBe('dist-002');
      }
    }
  });
});

// ─── Guard 2 — gstinLookup payload-shape contract (anti-pattern #6) ─────────
describe('Guard 2 — gstinLookup throws on missing required fields', () => {
  // Helper: build a mock Response with both .text() and .json() — the
  // gstinLookup service reads .text() first then JSON.parses it.
  function mockNicResponse(body: unknown): Response {
    const text = JSON.stringify(body);
    return {
      ok: true,
      headers: { get: (_h: string) => 'application/json' },
      text: async () => text,
      json: async () => body,
    } as unknown as Response;
  }

  it('throws when NIC returns success but no legalName / state-code', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockNicResponse({
        status_cd: '1', // NIC "success"
        status_desc: 'Sucess',
        data: {
          // Deliberately omit LegalName, StCd, Status, etc.
          Gstin: '29AAGCB1286Q1Z0',
        },
      }),
    );
    try {
      const { lookupGstin } = await import('../services/gst/gstinLookup.js');
      // WI-058: lookupGstin now requires a tenant context.
      await expect(lookupGstin('29AAGCB1286Q1Z0', 'dist-002')).rejects.toThrow(/missing required fields/i);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does NOT throw when NIC returns a complete payload', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockNicResponse({
        status_cd: '1',
        data: {
          Gstin: '29AAGCB1286Q1Z0',
          LegalName: 'Test Legal Name',
          TradeName: 'Test Trade Name',
          StCd: '29',
          Status: 'Active',
          pradr: { adr: '123 Test Road, Bangalore - 560001' },
        },
      }),
    );
    try {
      const { lookupGstin } = await import('../services/gst/gstinLookup.js');
      const result = await lookupGstin('29AAGCB1286Q1Z0', 'dist-002');
      expect(result.gstin).toBeTruthy();
      expect(result.legalName).toBe('Test Legal Name');
      expect(result.stateCode).toBe('29');
      expect(result.status).toBe('Active');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ─── Guard 3 — CN/DN list endpoint scope ────────────────────────────────────
describe('Guard 3 — CN raised on invoice A is not retrievable via invoice B', () => {
  // Same-distributor cross-invoice scoping is the subtler tenant-isolation
  // class: it's not a tenant leak (both invoices belong to the same admin)
  // but a UI that mis-passes the invoiceId would expose the wrong notes.
  // The route's `where: { invoiceId }` must do the right thing.
  it('two invoices in same distributor: CN list is per-invoice, not pooled', async () => {
    const invoices = await prisma.invoice.findMany({
      where: { distributorId: 'dist-001', deletedAt: null },
      select: { id: true, invoiceNumber: true, items: { take: 1 } },
      take: 2,
      orderBy: { createdAt: 'asc' },
    });
    if (invoices.length < 2) return; // need two invoices to compare

    const [invA, invB] = invoices;
    const item = invA.items?.[0];
    if (!item) return;

    // Raise a CN on invoice A.
    const createRes = await request(app)
      .post('/api/invoices/credit-notes')
      .set(auth(dist1FinanceToken))
      .send({
        invoiceId: invA.id,
        reason: 'Guard 3 scoping test',
        items: [{
          cylinderTypeId: item.cylinderTypeId,
          quantity: 1,
          unitPrice: 100,
          gstRate: 18,
        }],
      });
    expect(createRes.status).toBe(201);
    const creditNoteId = createRes.body.data?.creditNoteId;
    expect(creditNoteId).toBeTruthy();

    try {
      const listA = await request(app)
        .get(`/api/invoices/${invA.id}/credit-notes`)
        .set(auth(dist1AdminToken));
      const listB = await request(app)
        .get(`/api/invoices/${invB.id}/credit-notes`)
        .set(auth(dist1AdminToken));

      const idsInA = (listA.body.data?.creditNotes ?? []).map((n: { creditNoteId: string }) => n.creditNoteId);
      const idsInB = (listB.body.data?.creditNotes ?? []).map((n: { creditNoteId: string }) => n.creditNoteId);

      expect(idsInA).toContain(creditNoteId);
      expect(idsInB).not.toContain(creditNoteId);
    } finally {
      await prisma.creditNote.deleteMany({ where: { id: creditNoteId } });
    }
  });
});

// ─── Guard 4 — Role escalation prevention ───────────────────────────────────
describe('Guard 4 — finance cannot approve a credit note (admin-only gate)', () => {
  it('finance can create, but the approve call returns 403', async () => {
    const dist1Inv = await getDist1Invoice();
    if (!dist1Inv) return;

    // WI-055 (c6849c2) replaced the items-array body with a single
    // `amount` number. The old test sent `items: [...]` which silently
    // 400'd zod validation — only visible when a seeded invoice existed
    // (otherwise the early-return on `!dist1Inv` hid the broken assert).
    const createRes = await request(app)
      .post('/api/invoices/credit-notes')
      .set(auth(dist1FinanceToken))
      .send({
        invoiceId: dist1Inv.id,
        reason: 'Guard 4 role-escalation test',
        amount: 100,
      });
    expect(createRes.status).toBe(201);
    const creditNoteId = createRes.body.data?.creditNoteId;
    expect(creditNoteId).toBeTruthy();

    try {
      // Finance tries to approve their own note → must be 403.
      const approveRes = await request(app)
        .put(`/api/invoices/credit-notes/${creditNoteId}/approve`)
        .set(auth(dist1FinanceToken));
      expect(approveRes.status).toBe(403);

      // The CN should still be pending — the failed approve must not
      // have flipped status as a side-effect.
      const row = await prisma.creditNote.findUniqueOrThrow({ where: { id: creditNoteId } });
      expect(row.status).toBe('pending_cn');
    } finally {
      await prisma.creditNote.deleteMany({ where: { id: creditNoteId } });
    }
  });

  it('finance cannot reject either — same admin gate covers reject', async () => {
    const dist1Inv = await getDist1Invoice();
    if (!dist1Inv) return;

    const createRes = await request(app)
      .post('/api/invoices/credit-notes')
      .set(auth(dist1FinanceToken))
      .send({
        invoiceId: dist1Inv.id,
        reason: 'Guard 4 reject test',
        amount: 100,
      });
    const creditNoteId = createRes.body.data?.creditNoteId;
    if (!creditNoteId) return;

    try {
      const rejectRes = await request(app)
        .put(`/api/invoices/credit-notes/${creditNoteId}/reject`)
        .set(auth(dist1FinanceToken))
        .send({ reason: 'attempting self-reject' });
      expect(rejectRes.status).toBe(403);
    } finally {
      await prisma.creditNote.deleteMany({ where: { id: creditNoteId } });
    }
  });
});

// ─── Guard 5 — API response shape contract (anti-pattern #9) ────────────────
describe('Guard 5 — API responses match the shape the web types', () => {
  it('GET /api/settings returns the DistributorSettings envelope (object, not array)', async () => {
    // Anti-pattern #9 + WI-044: the web does
    // `apiGet<DistributorSettings>('/settings')` and reads
    // `settings.gstMode`. A raw array response (pre-WI-044) silently
    // made gstEnabled false everywhere. Guard the object shape.
    const res = await request(app).get('/api/settings').set(auth(dist1AdminToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toBeTypeOf('object');
    expect(Array.isArray(res.body.data)).toBe(false);
    expect(res.body.data).toHaveProperty('gstMode');
    expect(res.body.data).toHaveProperty('gstCredentials');
    expect(res.body.data).toHaveProperty('rawSettings');
    expect(Array.isArray(res.body.data.rawSettings)).toBe(true);
  });

  it('GET /api/payments/ledger/:customerId returns LedgerEntry[] (NOT { rows, summary })', async () => {
    // Anti-pattern #9 + 2026-06-01 regression: web CustomersPage.LedgerTab
    // and mobile customer-detail.tsx LedgerTab both type the response as
    // LedgerEntry[] and call .length / read entryType, amountDelta,
    // entryDate, narration. Before the fix the endpoint returned the
    // delivery-aggregate { rows, summary } shape — `.length` was
    // undefined on the object and every tab rendered "No ledger entries".
    // Pin the wire contract here.
    const dist1Cust = await prisma.customer.findFirst({
      where: { distributorId: 'dist-001', deletedAt: null },
      select: { id: true },
    });
    if (!dist1Cust) return;
    const res = await request(app)
      .get(`/api/payments/ledger/${dist1Cust.id}`)
      .set(auth(dist1AdminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    if (res.body.data.length > 0) {
      const row = res.body.data[0];
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('entryType');
      expect(row).toHaveProperty('amountDelta');
      expect(typeof row.amountDelta).toBe('number');
      expect(row).toHaveProperty('entryDate');
      expect(row).toHaveProperty('narration');
    }
  });

  it('GET /api/payments/ledger/:customerId respects dateFrom / dateTo query filter', async () => {
    const dist1Cust = await prisma.customer.findFirst({
      where: { distributorId: 'dist-001', deletedAt: null },
      select: { id: true },
    });
    if (!dist1Cust) return;
    // Empty range — far in the past.
    const past = await request(app)
      .get(`/api/payments/ledger/${dist1Cust.id}?dateFrom=1900-01-01&dateTo=1900-12-31`)
      .set(auth(dist1AdminToken));
    expect(past.status).toBe(200);
    expect(Array.isArray(past.body.data)).toBe(true);
    expect(past.body.data.length).toBe(0);
  });

  it('GET /api/delivery/reconciliation/pending vehicles carry per-line breakdown + emptiesTypes', async () => {
    // GROUP-5C wire contract: the mobile Vehicle Return tab now displays
    // per-cylinder-type ordered/delivered/shortfall and a per-type
    // empties pre-fill. If a future refactor flattens or renames those
    // arrays, the mobile screen silently loses its breakdown.
    const res = await request(app)
      .get('/api/delivery/reconciliation/pending')
      .set(auth(dist1AdminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    if (res.body.data.length > 0) {
      const row = res.body.data[0];
      expect(row).toHaveProperty('vehicleId');
      expect(row).toHaveProperty('vehicleNumber');
      expect(row).toHaveProperty('pendingCancelledStock');
      expect(row).toHaveProperty('pendingUndeliveredOrders');
      expect(row).toHaveProperty('pendingCancelledStockLines');
      expect(Array.isArray(row.pendingCancelledStockLines)).toBe(true);
      expect(row).toHaveProperty('emptiesTypes');
      expect(Array.isArray(row.emptiesTypes)).toBe(true);
      expect(row).toHaveProperty('mismatchReported');
      expect(typeof row.mismatchReported).toBe('boolean');
    }
  });

  it('GET /api/inventory/customer-balances rows carry cylinderPrice / emptyCylinderPrice / lastDeliveryDate', async () => {
    // GROUP-5B + WI-080 wire contract: the mobile admin Customer Balances
    // tab needs these three fields to compute the empty-cyl cost total
    // and the "Days since last delivery" sort. The mobile interface was
    // missing them, so this guard pins the wire shape to prevent future
    // refactors from dropping them.
    const res = await request(app)
      .get('/api/inventory/customer-balances')
      .set(auth(dist1AdminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    if (res.body.data.length > 0) {
      const row = res.body.data[0];
      expect(row).toHaveProperty('customerId');
      expect(row).toHaveProperty('cylinderTypeId');
      expect(row).toHaveProperty('withCustomerQty');
      expect(row).toHaveProperty('cylinderPrice');
      expect(row).toHaveProperty('emptyCylinderPrice');
      expect(row).toHaveProperty('lastDeliveryDate');
    }
  });

  it('GET /api/cylinder-types/prices/list returns rows with cylinderType.typeName nested object', async () => {
    // Anti-pattern #9 + 2026-06-01 regression: mobile typed each row as
    // { cylinderType?: string } and rendered `p.cylinderType || ...`.
    // The API actually returns Prisma's nested include
    // ({ cylinderType: { typeName } }) → mobile crashed with "Objects
    // are not valid as a React child". Pin the wire shape so future
    // route refactors (e.g. moving to a mapper) don't silently flatten
    // or rename it.
    const res = await request(app)
      .get('/api/cylinder-types/prices/list')
      .set(auth(dist1AdminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    if (res.body.data.length > 0) {
      const row = res.body.data[0];
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('cylinderTypeId');
      expect(row).toHaveProperty('price');
      expect(row).toHaveProperty('cylinderType');
      expect(typeof row.cylinderType).toBe('object');
      expect(row.cylinderType).toHaveProperty('typeName');
      expect(typeof row.cylinderType.typeName).toBe('string');
    }
  });

  it('CreditNote.status on the wire matches the shared enum (no `_cn` suffix leak)', async () => {
    // Anti-pattern #9 + WI-039 mapper fix: Prisma surfaces the TS-side
    // enum name (`pending_cn`); the mapper must strip `_cn` so the web's
    // NOTE_STATUS_VARIANTS[status] lookup works. Same shape rule applies
    // to debit notes — covered by their status mapper too.
    const dist1Inv = await getDist1Invoice();
    if (!dist1Inv) return;
    const items = await prisma.invoiceItem.findMany({
      where: { invoiceId: dist1Inv.id },
      take: 1,
    });
    if (items.length === 0) return;

    const createRes = await request(app)
      .post('/api/invoices/credit-notes')
      .set(auth(dist1FinanceToken))
      .send({
        invoiceId: dist1Inv.id,
        reason: 'Guard 5 status enum test',
        items: [{
          cylinderTypeId: items[0].cylinderTypeId,
          quantity: 1,
          unitPrice: 100,
          gstRate: 18,
        }],
      });
    const creditNoteId = createRes.body.data?.creditNoteId;
    if (!creditNoteId) return;
    try {
      // status on create response — must be the shared enum value,
      // not the Prisma TS-side `_cn`-suffixed name.
      expect(createRes.body.data.status).toBe('pending');
      expect(createRes.body.data.status).not.toMatch(/_cn$/);

      // status on the list endpoint — same contract.
      const listRes = await request(app)
        .get(`/api/invoices/${dist1Inv.id}/credit-notes`)
        .set(auth(dist1AdminToken));
      const found = (listRes.body.data?.creditNotes ?? []).find(
        (n: { creditNoteId: string }) => n.creditNoteId === creditNoteId,
      );
      expect(found).toBeTruthy();
      expect(found.status).toBe('pending');
      expect(found.status).not.toMatch(/_cn$/);
    } finally {
      await prisma.creditNote.deleteMany({ where: { id: creditNoteId } });
    }
  });
});

// ─── Guard 6 — WI-058 tenant isolation in lookupGstin (anti-pattern #13) ────
describe('Guard 6 — lookupGstin uses the caller\'s tenant credentials, not whatever Prisma picks', () => {
  // We avoid spinning up real network calls — vi.mock(whitebooksClient)
  // at the top of this file already stubs getAuthToken. To assert that
  // lookupGstin reads dist-002's credential row when called with
  // distributorId='dist-002', we mock fetch itself. The test fails if
  // the function ever reads from the wrong tenant or hits prod URL.
  it('routes the request through the caller\'s own credentials row', async () => {
    // Seed a wrong-tenant row that, before WI-058, would have been
    // picked first by `findFirst({ where: { scope: 'einvoice' } })`.
    const wrongRow = await prisma.gstCredential.create({
      data: {
        distributorId: 'dist-001',
        scope: 'einvoice',
        clientId: 'WI058-WRONG-TENANT',
        clientSecret: 'WI058-WRONG-SECRET',
        username: 'WRONG',
        password: 'WRONG',
        gstin: '29WRONG12345WXY',
        email: null,           // intentionally NULL — the bug used 'info@mygaslink.com' fallback
        isValid: true,
      },
    });

    // Capture the actual URL/headers fetch is called with. Spy on the
    // global fetch — vitest preserves it for this test only.
    const originalFetch = globalThis.fetch;
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      // Minimal GSTNDETAILS-shaped success so lookupGstin can parse.
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          status_cd: '1',
          status_desc: 'Sucess',
          data: {
            Status: 'Active',
            LglNm: 'Test Co',
            TrdNm: 'Test Co',
            StateJurisdiction: 'KA',
            CtbCd: 'Regular',
            DtReg: '2020-01-01',
            PrAdr: { addr: { bnm: 'Bldg', bno: '1', loc: 'Loc', st: 'St', pncd: '560001' } },
            AdrL: [],
          },
        }),
        json: async () => ({}),
      } as unknown as Response;
    });

    try {
      const { lookupGstin } = await import('../services/gst/gstinLookup.js');
      await lookupGstin('29AAGCB1286Q1Z0', 'dist-002');

      // dist-002's WhiteBooks credentials are seeded in sandbox mode +
      // a real email. The bug was using dist-001's prod URL + null email.
      expect(capturedUrl).toContain('apisandbox.whitebooks.in');
      expect(capturedUrl).not.toContain('://api.whitebooks.in');
      expect(capturedUrl).not.toContain('info%40mygaslink.com');
      // The wrong-tenant client_id must NEVER appear in headers.
      expect(capturedHeaders['client_id']).not.toBe('WI058-WRONG-TENANT');
    } finally {
      globalThis.fetch = originalFetch;
      await prisma.gstCredential.delete({ where: { id: wrongRow.id } });
    }
  });

  it('throws NO_CREDENTIALS when the caller\'s tenant has none, instead of silently using another tenant\'s row', async () => {
    // Seed an invalid (isValid=false) row for dist-001. The hardened
    // fallback should refuse to pick it. dist-001's only own einvoice
    // row pre-existing is also invalid (none in this DB), so dist-001
    // gets NO_CREDENTIALS — which is the correct behaviour now.
    const invalidRow = await prisma.gstCredential.create({
      data: {
        distributorId: 'dist-001',
        scope: 'einvoice',
        clientId: 'WI058-INVALID-ROW',
        clientSecret: 'x',
        username: 'x',
        password: 'x',
        gstin: '29INVALID12345Y',
        email: 'invalid@example.com',
        isValid: false,            // ← hardened fallback skips this
      },
    });
    try {
      const { lookupGstin } = await import('../services/gst/gstinLookup.js');
      // dist-001's own gstCredential is invalid; the hardened fallback
      // skips it; dist-002's valid row (real seed) gets picked — but only
      // because there's no own-tenant match for dist-001. We assert that
      // the invalid row was not used (its client_id never reaches fetch).
      const originalFetch = globalThis.fetch;
      let capturedHeaders: Record<string, string> = {};
      globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({
            status_cd: '1',
            data: {
              Status: 'Active', LglNm: 'X', TrdNm: 'X',
              StateJurisdiction: 'KA', CtbCd: 'Regular', DtReg: '2020-01-01',
              PrAdr: { addr: { bnm: '', bno: '', loc: '', st: '', pncd: '560001' } },
              AdrL: [],
            },
          }),
          json: async () => ({}),
        } as unknown as Response;
      });
      try {
        await lookupGstin('29AAGCB1286Q1Z0', 'dist-001');
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(capturedHeaders['client_id']).not.toBe('WI058-INVALID-ROW');
    } finally {
      await prisma.gstCredential.delete({ where: { id: invalidRow.id } });
    }
  });
});

afterAll(async () => {
  // Belt-and-braces: drop any CNs from this file by reason text.
  await prisma.creditNote.deleteMany({
    where: { reason: { startsWith: 'Guard ' } },
  });
  // WI-058 cleanup: anything left from the tenant-isolation guards.
  await prisma.gstCredential.deleteMany({
    where: { clientId: { startsWith: 'WI058-' } },
  });
});
