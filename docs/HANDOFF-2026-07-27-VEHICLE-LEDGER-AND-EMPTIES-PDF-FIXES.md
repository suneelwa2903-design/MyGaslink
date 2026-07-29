# Handoff — Vehicle Ledger + Empties PDF fixes (2026-07-27)

**Author**: Suneel + Claude session on this branch.
**Base commit**: `18d6427` (quotations CC recipients — mini-op #7).
**Status**: Fix 3 **already committed** (bundled inside `e1f6302` — see note below). Fix 1 + Fix 2 still uncommitted, gates green.

## ⚠️ Commit-bundling note (2026-07-27 21:28 IST)

The parallel expense-taxonomy commit `e1f6302` (`feat(mini-op #5 v3) expense taxonomy tightening`) was authored after I had staged Fix 3 files to the working tree but before I finished my other two fixes. That commit's `git add` swept up ALL modified/untracked files at the time — including MY `reportsService.ts` and the new `reports-vehicle-ledger-attribution.test.ts`. The commit message doesn't mention them.

**Verify**: `git show e1f6302 -- packages/api/src/services/reportsService.ts` shows the Fix 3 diff verbatim. Test file at `packages/api/src/__tests__/reports-vehicle-ledger-attribution.test.ts` (9,870 bytes) is present in that commit.

**Impact**:
- Fix 3 code IS on main; correctness of Fix 3 is not affected.
- The audit trail is muddy — a future `git log --follow reportsService.ts` will attribute Fix 3 to a commit labeled "expense taxonomy".
- Nothing to un-do; nothing to re-do. Just be aware when reviewing history.

**Prevention for the parallel thread**: use `git add -p` or explicit file lists (never `git add -A` / `git add .`) when other unrelated work is in the tree. Same rule that's in CLAUDE.md § "Git Safety Protocol": *"prefer adding specific files by name rather than using git add -A or git add ., which can accidentally include sensitive files ... or large binaries"* — the same failure mode also captures another thread's WIP.

## What's on disk (staged only when Suneel says go)

Six files touched, three uncommitted changes from the parallel expense-work thread also present. **Do not stage anything you don't understand** — the recommended commit split is at the bottom.

### Files modified

| File | Fix |
|---|---|
| `packages/api/src/services/reportsService.ts` | Fix 3 — Vehicle Ledger API attribution |
| `packages/api/src/services/paymentService.ts` | Fix 1 — customer ledger empties reader |
| `packages/api/src/services/pdf/customerLedgerPdfService.ts` | Fix 1 — PDF empties row + Total roll-up |
| `packages/web/src/pages/ReportsPage.tsx` | Fix 2 — Vehicle Ledger web display |
| `packages/api/src/__tests__/reports-vehicle-ledger-attribution.test.ts` | NEW — 4 tests for Fix 3 |
| `packages/api/src/__tests__/empties-return.test.ts` | +T4c for Fix 1 |
| `packages/api/src/__tests__/ledger-pdf-consistency.test.ts` | Fingerprint updated to match new empties cell shape |

### Also on disk (from the parallel thread — LEAVE ALONE)

```
M packages/api/prisma/schema.prisma
M packages/api/src/services/expenseCategoryService.ts
M packages/api/src/services/expenseService.ts
M packages/shared/src/schemas/index.ts
M packages/shared/src/types/index.ts
?? packages/api/prisma/migrations/20260727240000_expense_taxonomy_v2/
```

These are the expense-taxonomy v2 changes from the parallel thread. They compile clean alongside my fixes but they're a separate deliverable.

---

## The three fixes

### Fix 1 — Customer statement PDF: empties row credits Pend E

**Root cause (3-layer bug):**
- `emptiesReturnService` writer emitted the return with structured `emptiesChange` + `cylinderTypeId` on the `inventoryEvent` row, but only put the qty in the `CustomerLedgerEntry.narration` STRING.
- `paymentService.getCustomerLedger` case `empties_return` emitted the row with `emptyCylsCollected = 0` and `pendingEmptyCyls = 0` — never fed the returned qty into the running per-type counter.
- `customerLedgerPdfService` (individual + group) Total row's Pend E formula = `openingSeeded + delivered − collected` where `totalCollected` was accumulated ONLY from invoice/debit/adjustment rows, never from empties_return. Standalone returns were invisible in the Total.

**Fix (reader-only + PDF-only, no schema, no backfill):**
1. `getCustomerLedger` pre-loads `inventoryEvent` rows keyed by `${dateISO}|${qty}` (dedupes to `eventType='returns_collection'` to avoid the paired `reconciliation_empties_return` row from being counted twice).
2. `processLedgerEntries` empties_return case matches ledger entry to the pre-fetched map (parsing `qty` from the `"Empties: N× TYPE"` narration to disambiguate same-date rows), decrements `pendingEmptiesPerType[cylinderTypeId]`, and attaches `emptyCylsCollected` + running `pendingEmptyCyls` + `cylinderType` to the emitted row.
3. Both PDF branches (individual `customerLedgerPdfService.ts:570` + group `:1018`) now (a) accumulate the empties_return row's qty into `totalCollected` so the Total row's formula subtracts standalone returns and (b) render Emp C + Pend E on the empties_return row itself instead of all dashes.

**Prod impact (all read-side):**
- 6 statements ever change: 1× Kruthee/WEALTH AURA (07-24, 8× 47.5LOT), 1× Kruthee/Chaitanya Food Court (07-25, 1× 19.2KG), 3× Vanasthali (Kanakadurga Tiffins / GOTETI KALYANA VEDIKA / Balaji Tiffin), 1× Bhargava/Athidhi Restaurant.
- Nothing to backfill, no DB writes changed.
- Non-money surfaces unaffected (web ledger table, mobile ledger cards, AR-aging, customer portal, invoice PDFs).

### Fix 2 — Vehicle Ledger web: Qty column showed 0 for everything

**Root cause**: `packages/web/src/pages/ReportsPage.tsx:441` mapped Qty via `r.fullsDispatched ?? r.deliveredQty ?? r.collectedEmpties ?? ''`. Two bugs:
- `??` treats 0 as a real value, so `fullsDispatched === 0` short-circuited to 0 (never fell through).
- The follow-up keys `deliveredQty` / `collectedEmpties` DON'T EXIST — API emits `fullsDelivered` / `emptiesCollected`.

**Fix**: replaced with an explicit `firstNonZero(fullsDispatched, fullsDelivered, emptiesCollected)` helper. Pure display bug — one function added, one line replaced.

### Fix 3 — Vehicle Ledger API: attribution + backdated visibility

**Root cause**: `reportsService.vehicleLedger`'s `attrFor()` at line 1350 only resolved `referenceType` ∈ `{order, driver_vehicle_assignment, cancelled_stock}`. Everything else fell into the `{vehicleNumber: '—', driverName: '—'}` fallback. And the eventType whitelist at line 1303 excluded `manual_adjustment`, so backdated trips (which write `manual_adjustment` for the fulls leg) never even fetched.

**Fix** (extended reader only, no writer changes):
1. Fetch scope extended: `manual_adjustment` events are included **only when `referenceType='backdated_inventory_adjustment'`** — so genuine Adjust-Stock corrections (referenceType=null) stay hidden from Vehicle Ledger. Prod audit confirmed only 3 null-refType rows exist across all distributors — all genuine stock corrections.
2. `attrFor` extended to handle 4 new referenceTypes:
   - `godown_pickup` → Order.id → synthetic `{vehicleNumber:'GODOWN', driverName:'Godown Pickup'}` bucket (mirrors deliveryPerformance's convention)
   - `mini_operator_order` → Order.id → normal order attribution
   - `backdated_inventory_adjustment` → Order.id → normal order attribution
   - `dva_load_manifest` → `DVALoadManifest.dvaId` → DVA → vehicle/driver
3. Switch case added: `manual_adjustment` (fulls leg of backdated) → `fullsDelivered` bucket. Semantic: the fulls debit stands in for the delivery leg the live flow would have emitted.

**Prod impact when deployed**:
- Vehicle Ledger will surface ~1,351 previously-invisible events across 4 distributors:
  - Vanasthali: 1,150 backdated + 5 float + 12 godown = 1,167
  - Mannava Bhargava: 137 mini-op
  - Kruthee: 6 backdated + 9 float = 15
  - Demo Gas Agency: 3 backdated + 29 float = 32
- 3 stock corrections stay hidden (correct behaviour): Vanasthali 06-30 ×2 ("Incorrect Closing as confirmed with Sandeep"), Mannava 07-21 ("empties 62 fulls 18").

---

## Gates (run in this order, all green as of this handoff)

```bash
pnpm run typecheck        # all 4 packages clean
pnpm --filter @gaslink/api test         # 2028 passing / 174 files
```

**Lint status**: `pnpm run lint` fails at the **root** because of pre-existing errors in `packages/web/src/pages/QuotationsPage.tsx` (react-hooks/set-state-in-effect, react/no-unescaped-entities) and `packages/web/src/pages/hq/PaymentsPage.tsx` — both from the parallel expense/quotations thread, NOT from these fixes. Every file I touched is lint-clean when linted individually. Confirmed with:

```bash
cd packages/web && npx eslint src/pages/ReportsPage.tsx
cd packages/api && npx eslint src/services/reportsService.ts src/services/paymentService.ts src/services/pdf/customerLedgerPdfService.ts src/__tests__/reports-vehicle-ledger-attribution.test.ts src/__tests__/empties-return.test.ts
```

Fix those two pre-existing files in your track OR revert them before committing lint-blocking work.

---

## Manual test plan (after commit + deploy)

### Fix 1 — Empties in customer statement PDF

1. **Kruthee > Customers > WEALTH AURA > Ledger > Download Statement** (period 27-Jun to 27-Jul):
   - Empties row (24-Jul) should show `Emp C = 8`, `Pend E = 12` (was blank/blank).
   - Total row should show `Emp C = 35`, `Pend E = 12` (was 27 / 20).
2. **Repeat for other 5 affected customers** (list in "Prod impact" above).
3. **Group PDF test**: any customer that's in a group — download group consolidated statement, confirm Total Pend E rolls up correctly.
4. **Regression**: any customer WITHOUT a standalone empties return — the PDF should look byte-identical to before.

### Fix 2 + Fix 3 — Vehicle Ledger

1. **Analytics > Vehicle Ledger, 27-Jun to 27-Jul, view "All", any distributor**:
   - Corporation rows: unchanged.
   - Trip rows: real vehicle numbers, real driver names, non-zero quantities. Days with no trip activity stop appearing as fake "Trip 0" rows.
2. **View "Vehicle Trips Only"**: per-trip breakdown, no "—" vehicle/driver.
3. **Vanasthali specifically** — should surface ~1,167 events that were previously invisible. Spot-check one date with known backdated activity.
4. **Backdated trip visibility**: create a new backdated trip via Orders > New Backdated; the Vehicle Ledger for that date shows it with vehicle + driver.
5. **Godown pickup**: any godown-pickup order shows in Vehicle Ledger as vehicle=GODOWN, driver=Godown Pickup.
6. **Float dispatch**: any preflight dispatch of float appears with the DVA's vehicle/driver.
7. **Regression on live-flow trips**: recent live trips still resolve correctly.
8. **CSV export**: download Vehicle Ledger CSV, columns match the on-screen table.
9. **Adjust Stock regression**: `Inventory > Adjust Stock` corrections MUST NOT appear in Vehicle Ledger (guarded by the referenceType filter — 3 known rows in prod, none should surface).

---

## Recommended commit split

Three separate commits so any rollback is surgical. `git add` only the files listed under each — do NOT stage the parallel expense/quotations changes.

### Commit A — Fix 3 (Vehicle Ledger API attribution + backdated)
**ALREADY COMMITTED** inside `e1f6302` (see bundling note above). Skip.

### Commit B — Fix 2 (Vehicle Ledger web display)
```
git add packages/web/src/pages/ReportsPage.tsx
git commit -m "fix(web) vehicle ledger Qty column — fix nullish-short-circuit + wrong keys"
```

### Commit C — Fix 1 (Empties PDF Pend E roll-up)
```
git add packages/api/src/services/paymentService.ts
git add packages/api/src/services/pdf/customerLedgerPdfService.ts
git add packages/api/src/__tests__/empties-return.test.ts
git add packages/api/src/__tests__/ledger-pdf-consistency.test.ts
git commit -m "fix(pdf) customer statement — standalone empties returns credit Pend E"
```

Then push.

---

## Adverse effects summary

- **Zero data loss.**
- **Zero data corruption.**
- **No schema changes, no migrations, no backfills.**
- All three fixes are read-side. Rollback = revert the commit. No DB repair needed.
- 1 test needed a fingerprint update (`ledger-pdf-consistency.test.ts` — a deliberate-change guard; already updated).
- The Adjust-Stock trap (3 rows in prod that legitimately are NOT trips) is scoped out by `referenceType='backdated_inventory_adjustment'` — confirmed by test `T2` in `reports-vehicle-ledger-attribution.test.ts`.

## Reference commits + code lines

- Backdated writer (unchanged): [backdatedAdjustmentService.ts:91-149](packages/api/src/services/backdatedAdjustmentService.ts)
- Empties writer (unchanged): [emptiesReturnService.ts:57-135](packages/api/src/services/emptiesReturnService.ts)
- Prod audit that validated Fix 3's scoping: see conversation transcript, ~2026-07-27 session
