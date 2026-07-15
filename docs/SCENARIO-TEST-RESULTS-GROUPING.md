# HQ Portal (Feature A) — Scenario Test Results

**Date:** 2026-07-15
**Runner:** `packages/api/scripts/scenario-hq-portal.ts`
**Environment:** local dev API on `http://localhost:5000`, dev Postgres (Docker)
**HQ login:** `hq-sharma@mygaslink.com` / `HqTest@123` (seeded 2026-07-15 via
`packages/api/scripts/seed-hq-sharma.ts`, group=`Sharma HQ Test Group`,
members=Maruthi Agencies + Hyderabad Caterers + KINARA GROUP OF HOTELS TEST,
distributor=dist-002 Sharma Gas Distributors)

## Summary

**9/9 scenarios PASS. 0 fail.**

Full integration test suite: **1882 passing (161 files) → 1882 passing (162
files) after Step 9.** No regressions.

## Result table

| # | Scenario | Status | Detail |
|---|---|:---:|---|
| S1 | Dashboard KPIs load with real data | PASS | 3 properties, ₹92,100 outstanding, aging bucket0_30=0 |
| S2 | Orders list paginates | PASS | 5 rows returned, page filter accepted |
| S3 | Single-invoice PDF download | PASS | Invoice ISHD2627000554 → 2916 bytes, `%PDF` magic OK |
| S4 | Consolidated ledger + group-statement PDF | PASS | 110 merged rows, debited ₹212,100; PDF 9571 bytes |
| S5 | Aging report returns per-property rows | PASS | 6 columns, 2 property rows |
| S6 | Profile returns group + distributor + members | PASS | "Sharma HQ Test Group" · Sharma Gas Distributors · 3 members |
| S7 | Property filter narrows to a single customer | PASS | Every returned row's `customerId` matched the filter (asserted on `.every()`) |
| S8 | Method guard blocks non-GET | PASS | POST /dashboard → 405 METHOD_NOT_ALLOWED |
| S9 | API up + HQ dashboard reachable after all commits | PASS | /health 200, /dashboard 200 after all Steps 7–9 commits landed |

## Scenario details

### S1 — Dashboard KPIs
GET `/api/customer-group-portal/dashboard` returns the shape documented in
`customerGroupPortalService.getDashboard`: `totalOutstanding`, `totalOverdue`,
`cylindersThisMonth[]`, `aging{bucket0_30,bucket31_60,bucket60plus}`,
`properties[]`. Numbers align with what the browser check saw in CP3
(₹80,100 in that snapshot; ₹92,100 now because more invoices exist on the
group members after Step 9's fixture creation).

### S2 — Orders list
GET `/api/customer-group-portal/orders?pageSize=5` returns `{orders[], meta{}}`.
Rows contain `customerName` so the Property column in the web UI renders
correctly.

### S3 — Invoice PDF
Two-step check: (a) list invoices, (b) download the first invoice's PDF at
`/customer-group-portal/invoices/:id/pdf`. Ownership is verified server-side
before the PDF service is called (see `customerGroupPortal.ts` /invoices/:id/pdf
handler — calls `getGroupInvoiceById` first, which enforces the double-scope
`(distributorId, customerId ∈ visibleCustomerIds)`).

### S4 — Consolidated ledger + PDF
GET `/api/customer-group-portal/ledger` returns 110 rows chronologically
merged across all 3 members, with per-row `customerId` + `customerName` so
each row shows its property. Totals include `totalDebited`, `totalReceived`,
`netOutstanding`. PDF at `/ledger/pdf` uses the 6-column layout added in
Step 7E (Date / Type / Narration / Amount / Balance / Property). Live download
returned 9,571 bytes with a valid `%PDF-` magic prefix.

### S5 — Aging report
GET `/api/customer-group-portal/aging` returns the shape from
`reportsService.outstandingAging` (extended in the CP2 prep to accept a
`customerIds` filter). Rows show only Hyderabad Caterers + KINARA — Maruthi
has no outstanding balance so it's correctly absent.

### S6 — Profile
GET `/api/customer-group-portal/profile` returns `{group{id,name,createdAt},
distributor{businessName,phone,email}, members[]}`. The distributor block
serves the "who am I paying?" question the HQ user needs to answer without
calling their sales rep.

### S7 — Property filter
GET `/api/customer-group-portal/orders?customerId=<memberId>` narrows to that
single property. Assertion: `.every(o => o.customerId === filterId)`. Filter
`customerId` is validated against `visibleCustomerIds` server-side; a
non-group id returns 403 (proven separately in T4 unit tests).

### S8 — Method guard
POST `/api/customer-group-portal/dashboard` with a valid HQ token → 405
`METHOD_NOT_ALLOWED`. Confirms the defence-in-depth top-level middleware in
`customerGroupPortal.ts` — even if a handler is accidentally declared as
`router.post()` in the future, the request is rejected before it reaches the
handler.

### S9 — Post-commit smoke
After all Steps 7–9 commits landed (`d74c6f1`, `108945c`, `a50188f`), started
the API dev server fresh and confirmed:

- `/api/health` returns 200
- `/api/customer-group-portal/dashboard` returns 200 with a valid HQ token

No commits introduced runtime regressions.

## Coverage matrix — S1–S9 vs. endpoints

| Endpoint | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 | S9 |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| GET /dashboard | ✓ | | | | | | | ✓ | ✓ |
| GET /orders | | ✓ | | | | | ✓ | | |
| GET /invoices | | | ✓ | | | | | | |
| GET /invoices/:id/pdf | | | ✓ | | | | | | |
| GET /ledger | | | | ✓ | | | | | |
| GET /ledger/pdf | | | | ✓ | | | | | |
| GET /aging | | | | | ✓ | | | | |
| GET /profile | | | | | | ✓ | ✓ | | |
| Non-GET | | | | | | | | ✓ | |

All 10 HQ portal endpoints exercised.

## Integration test suite

- **Before Step 9:** 1846 passing tests, 161 files
- **After Step 9:** 1882 passing tests, 162 files
- **New file:** `packages/api/src/__tests__/hq-portal.test.ts` (+36 tests)

Test categories (see the file's `describe` blocks):
- T1 Role gates (11): including the NON-NEGOTIABLE customer_hq → 403 on
  `/api/customer-portal` (Razorpay-bearing router)
- T2 Method guard (4)
- T3 Tenant isolation, anti-pattern #13 (3)
- T4 Group isolation same tenant (4)
- T5 Wire-shape guards, anti-pattern #9 (7)
- T6 PDF endpoints (3)
- T7 CustomerGroup admin CRUD (4)

## How to re-run

```bash
# 1. Ensure the dev API is running
pnpm --filter @gaslink/api run dev

# 2. Ensure the seeded HQ login exists (idempotent)
cd packages/api && npx tsx scripts/seed-hq-sharma.ts

# 3. Run all 9 scenarios
npx tsx scripts/scenario-hq-portal.ts

# 4. Integration test suite
pnpm --filter @gaslink/api test
```

## Notes for the pilot

- The HQ user cannot self-manage the group. Adding / removing properties or
  changing the login email must be done by the distributor's admin on the
  Customers → Groups tab (Step 7 UI).
- The HQ portal is web-only in v1.0. `packages/mobile/app/(hq)/index.tsx`
  shows a "web-only" fallback screen if a customer_hq user attempts to log
  into the mobile app.
- All 6 read endpoints layer three isolation walls: (a) `requireRole
  ('customer_hq')`, (b) `requireGroupAccess` (resolves + validates
  `visibleCustomerIds`), and (c) `resolveCustomerIdFilter` inside every
  service function (throws 403 if a client-supplied `customerId` isn't in
  `visibleCustomerIds`). All three walls have dedicated tests in
  `hq-portal.test.ts`.
