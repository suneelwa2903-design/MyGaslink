# Phase 2 — Testing Guide

**Session:** 2026-08-05
**Scope tested:** Accordion sidebar · Phase 1 (4 UX features) · Phase 2 (Report Builder end-to-end)
**Uncommitted:** yes — nothing pushed yet, waiting on your review

---

## Automated coverage — passed

| Layer | Result |
|---|---|
| API typecheck | ✅ clean |
| Web typecheck | ✅ clean |
| Mobile typecheck | ✅ clean |
| API lint | ✅ 0 errors (7 pre-existing warnings, none in my files) |
| Full API test suite | ✅ **2219 passing / 2 failing / 2221 total** — 2 fails are the pre-existing `users.test.ts` baseline, unchanged |
| Report Builder test file | ✅ 27/27 pass |

**Zero new regressions.**

Suite added tests in `packages/api/src/__tests__/report-builder.test.ts`:
- Spec validation (6 tests) — zod rejects malformed / SQL-ish / out-of-bounds specs
- Allowlist enforcement (5 tests) — role → model → field × filterable × groupable × aggregatable matrix
- Executor RAW mode (3 tests) — findMany path with fields + filters
- Executor GROUPED mode (2 tests) — groupBy + aggregations
- Safety layer (2 tests) — meta.rowCount / durationMs / unindexedWarning
- CRUD lifecycle (3 tests) — create → list → get → update → delete + 403 gates for driver/customer
- Sharing model (3 tests) — private vs distributor visibility + owner-only delete
- End-to-end integration (3 tests) — preview → save → run identical + regression on catalog + vehicle-ledger

---

## Manual testing — please do these in order

### Prep

1. Start your dev servers (`api` + `web`) — my code changes will hot-reload
2. Log in as a **distributor_admin** user (e.g. `bhargava@gasagency.com`)
3. Open the app → click **Reports** in the top nav

### Test 1 — Accordion sidebar (30 sec)

- Left sidebar shows the 7 buckets
- Click **Daily Book** → it expands, entries appear
- Click **Money & GST** (or **Invoicing & Payments**) → it opens, **Daily Book auto-collapses**
- Click **Money & GST** again → it collapses (nothing open)
- Click **Vehicle Ledger** inside Daily Book → report loads, Daily Book stays expanded

**Expected:** exactly ONE bucket open at a time. Selected report's parent bucket stays open.

---

### Test 2 — Phase 1A: Filter presets (2 min)

Setup: on **Vehicle Ledger** or **Payment Collections**.

1. Pick a driver from the Driver filter
2. Click **"Save filter…"** button
3. Give it a name like "My weekly review" → **Save preset**
4. See toast: "Preset 'My weekly review' saved"
5. In the header, the **Preset** dropdown now shows your preset — pick another item, clear the filter, then re-select your preset from dropdown → filters restore
6. Click **Delete preset** while a preset is loaded → gone from dropdown

**Expected:** presets persist across page reloads (they're in localStorage). If you open Reports on a different browser, they don't sync — that's intentional (per-device).

---

### Test 3 — Phase 1B: Hide columns (1 min)

Any report with a table (e.g. **Vehicle Ledger**, **Sales Summary**).

1. Click **"Columns"** button
2. Modal opens with checkbox per column
3. Uncheck 2 columns (e.g. "Empties Returned Verified", "Cancelled Returns")
4. Close modal → those columns are gone from the table
5. Reload page → columns still hidden (localStorage persists)
6. Click "Columns" → **"Show all"** → all columns back

**Expected:** hidden columns disappear from the on-screen table only. CSV download still includes all columns (documented in the modal footer).

---

### Test 4 — Phase 1C: Sticky dates (30 sec)

1. On **Sales Summary**, change dateFrom to 2026-07-01 and dateTo to 2026-07-31
2. Click **Payment Collections** in sidebar
3. Notice dateFrom / dateTo are still 2026-07-01 / 2026-07-31
4. Click **Reset dates** → snaps back to default (month-ago..today for most reports, yesterday..today for Delivery Performance)

**Expected:** dates carry between reports until you Reset.

---

### Test 5 — Phase 1D: Recent reports (1 min)

1. Click 5 different reports one after another
2. Look at the top of the sidebar → **⏱ Recent** section appears with the 5 you just clicked, most-recent first
3. Click any Recent entry → it opens that report

**Expected:** deduped — clicking the same report twice doesn't add duplicates. Max 5 items.

---

### Test 6 — Report Builder Phase 2 (5 min) 🎯

**This is the big one.**

1. In the sidebar, scroll to bottom → **"👤 My Custom Reports"** section
2. Click the **"+ New"** button in the section header → navigates to `/app/report-builder`
3. **Section 1 — What are you reporting on?**
   - Data source: pick **"Orders"**
   - Uncheck a few columns you don't want (e.g. "PO Number", "Vehicle")
4. **Section 2 — Filter**
   - Click **"+ Add filter"**
   - Field: **Status**, Operator: **equals**, Value: `delivered`
   - Click **"+ Add filter"** again
   - Field: **Delivery Date**, Operator: **date preset**, Preset: **This month**
5. **Section 3 — Group + Summarise** (optional)
   - Group by: check **Delivery Date**
   - Click **"+ Add metric"**
   - `Sum` of `Total Amount` as `Revenue`
   - Click **"+ Add metric"**
   - `Count` of `(all rows)` as `Order count`
6. **Section 4 — Preview**
   - Click **"Run preview"**
   - Table shows per-day aggregates for this month's delivered orders
   - Watch for warnings: row cap or unindexed filter (should be neither for this spec)
7. Give it a name at the top: **"Delivered orders — daily revenue"**
8. Set visibility to **"Everyone in company"** (dropdown top-right)
9. Click **"Save report"** → navigates to `/app/report-builder/<id>`
10. Go back to Reports (click Back button)
11. In the sidebar, **My Custom Reports** section now shows your saved report with a 🏢 icon (means it's shared)
12. Click it → opens the builder page loaded with your saved spec
13. Click **"Run preview"** → same data as before

**Expected:** the same report renders identical results whether you preview or run-a-saved. The spec persists across reloads.

---

### Test 7 — Report Builder safety (2 min) — try to break it

1. In the Builder, try to filter by a field the UI DIDN'T show (open browser dev tools, edit the request body to add `filters: [{ field: "passwordHash", op: "eq", value: "x" }]`) → server returns 400 "Field not allowed"
2. Log in as an **inventory** role user → open Report Builder → pick **Orders** → the fields list should NOT show "Total Amount" (inventory sees no money fields per allowlist)
3. Try to save a spec with `visibility: "role"` (not in the enum) → 400
4. Try to run a saved report you don't own (belonging to another user in same tenant, visibility: private) → 404

---

### Test 8 — Cross-role sharing (2 min)

Requires 2 user accounts in the same tenant:

1. Log in as **distributor_admin** → create a Custom Report → set visibility to **"Everyone in company"** → Save
2. Log out
3. Log in as **finance** in the same tenant → open Reports → the shared report should appear in **My Custom Reports** section with 🏢 icon
4. Click it → runs successfully

**Expected:** shared reports execute under the CALLER's role (not the owner's) — so if finance runs a report the admin built that references money fields, finance still sees money fields (both roles have access). Inventory would get 400 if the report referenced money fields.

---

### Test 9 — Regression: everything still works (2 min)

Sanity-check that Chunks 1-4 aren't broken:

1. Open **Reports** → click each of the 7 buckets — all show their entries
2. Click **Day-Close Summary** → renders the 6 sections
3. Click **Vehicle Ledger** → shows Dispatched/Delivered/Returned/Empties Returned/Outstanding columns with sticky-left
4. Click **Deposit Ledger per Customer** → renders
5. Click **Tally Export** → download panel appears
6. Click **GST Filing Export** → month picker + download appears
7. Any report → click **CSV** button → downloads a CSV

**Expected:** all 31 catalog entries still work.

---

## What to watch for while testing

- ⚠ **Bad UX:** anything that feels confusing or requires reading a tooltip to understand → tell me and I'll simplify
- ⚠ **Slow queries:** the preview should return in ≤3s for typical filters; if you see 10s+, that means the safety timeout is firing (also a warning banner will appear)
- ⚠ **Missing fields:** if a field you expect to see isn't in the Builder's Fields checklist, it's likely off the allowlist for your role — tell me which one and I'll add it

## What's NOT built (deferred to Phase 3)

- **Cross-model joins** ("Order + Customer + Driver" — Phase 3b)
- **Pivots** (rows × columns matrix — Phase 3a)
- **Charts** in the Builder output (Phase 3a)
- **Scheduling + email delivery** of saved reports (Phase 3c)
- **Role-scoped sharing** (only Private + Distributor-wide today)
- **PDF export** from the Builder (CSV works via the underlying `/api/reports/*` endpoints, but Builder doesn't have a dedicated PDF button yet)
- **Mobile Report Builder** (web-only for now; mobile users can consume saved reports the admin created via web)

## Files uncommitted for review

```
NEW  packages/api/prisma/migrations/20260806000000_saved_reports/migration.sql
NEW  packages/api/src/services/reportBuilder/allowlist.ts
NEW  packages/api/src/services/reportBuilder/spec.ts
NEW  packages/api/src/services/reportBuilder/executor.ts
NEW  packages/api/src/routes/savedReports.ts
NEW  packages/api/src/__tests__/report-builder.test.ts
NEW  packages/web/src/lib/reportPreferences.ts
NEW  packages/web/src/pages/ReportBuilderPage.tsx
NEW  docs/PHASE-2-TESTING-GUIDE.md          (this file)

MOD  packages/api/prisma/schema.prisma      (SavedReport + SavedReportRun models)
MOD  packages/api/src/app.ts                (mount /api/saved-reports router)
MOD  packages/shared/src/types/index.ts     (ReportBuilder types + SavedReportDto)
MOD  packages/web/src/pages/ReportsPage.tsx (accordion + Phase 1 + Custom Reports section)
MOD  packages/web/src/routes/index.tsx      (/app/report-builder route)
```

## What to tell me after testing

- ✅ Anything that works fine — great, we ship it
- ⚠ Anything unclear or awkward — I'll adjust the UI
- 🐛 Anything broken — I'll fix + re-test
- 💡 Anything you want changed — say the word

Once you're happy, say the word and I do the commit split.
