# Next Release — Verified Handoff Brief (v2)

**Date opened:** 2026-08-05
**Verification pass:** 2026-08-05 (6 Explore agents + baseline tests/typecheck)
**Handoff from:** Claude thread `b0ec4873-...` (deposit-ledger + reports + issueDate anchor sprint)
**Supersedes:** [docs/NEXT-RELEASE-BRIEF-2026-08-05.md](docs/NEXT-RELEASE-BRIEF-2026-08-05.md) — this file is the same plan, corrected against ground truth.

**Verified prod state:** `main @ f7f8a08` deployed. Latest CI green. API + web typecheck clean. Mobile typecheck clean. API test suite: **2089 / 2091 passing, 2 failing in 1 file** — see §Baseline health at end.

---

## What changed since v1 of the brief

The verification pass surfaced **7 material corrections** to the plan + **1 new feature (F8 — Supplier Ledger)** added on Suneel's directive. Read these before starting any work:

| # | Item | v1 said | Reality | Impact |
|---|------|---------|---------|--------|
| 1 | **D1 fix direction** | "Align PDF to in-app convention" | There are TWO in-app conventions — admin surfaces use pre-discount inclusive raw `unitPrice`, customer portal uses post-discount inclusive `totalPrice/quantity`. | Fix must adopt `totalPrice/quantity` (route a′) to reconcile per-line + match customer app. Raw-`unitPrice` route breaks the subtotal math and loses discount transparency for tax officers. |
| 2 | **F1 effort** | 2 days | 3 days for full brief; 2 days only if MVP-scoped (audit-trail + "no compensation" branch first, CN + net-off deferred). | 8 hidden traps documented below. |
| 3 | **F1 file count** | ~15 files | 17-20 files realistic. | Not a blocker, calibrates the commit. |
| 4 | **F1 driver form field name** | `emptiesReturned` | Actual field: `emptiesCollected` (see [orders.tsx:165](packages/mobile/app/(driver)/orders.tsx:165) + [deliveryQueue.ts:15](packages/mobile/src/services/deliveryQueue.ts:15)). New field would be `defectiveFullsReturned`. | Copy-paste-safety. |
| 5 | **F1 ledger enum name** | `CustomerLedgerEntryType` | Actual enum: `LedgerEntryType` (see [schema.prisma:357](packages/api/prisma/schema.prisma:357)). Model is `CustomerLedgerEntry` but its enum-typed column is `LedgerEntryType`. | Copy-paste-safety. |
| 6 | **F2 effort** | 2 days for Phase 1 | 2.5-3 days if P&L + Cash Flow are included. Grouping restructure alone = 1 day flat. | Suggest split: land grouping + Day Book in Phase 1 (1 day); P&L + Cash Flow as Phase 1b (1.5-2 days). |
| 7 | **Billing #4 ship-blocker** | "Verify all 5 landed" | Verified: **4/5 done**. #4 ("Generate Billing" button on `BillingPage.tsx:69` posts empty body → 400) is still open but superseded by the monthly cron `be4f86a`. Trivial 2-line PR to delete the dead button. | Suneel's "done i guess" is defensible. |

---

## Session start protocol (unchanged)

```bash
git log --oneline -6
git status --short
gh run list --branch main --limit 3
pnpm --filter @gaslink/api typecheck
pnpm --filter @gaslink/web typecheck
pnpm --filter @gaslink/mobile typecheck
pnpm --filter @gaslink/api test 2>&1 | grep -E 'Test Files|Tests |FAIL' | tail -20
```

Then tell Suneel: SHA, tests count (**baseline: 2089/2091**), CI status, item picked up.

---

## PRE-WORK CHECK — Ask Suneel

- `M packages/mobile/package.json` + `M pnpm-lock.yaml` are uncommitted at handoff. What are they? A mid-flight dep bump that shouldn't ship without a mobile rebuild deserves a decision before the next session touches mobile.
- **2 failing tests** in the API suite (see §Baseline). Are they known / flaky / a regression to fix first?
- **Report grouping structure** — left-nav / top-tab / filter dropdown? (F2 gates on this.)
- **F5 group ledger** — scope beyond mirroring Change M (UPI QR + Pay To)? See F5 §Verified findings below for the pre-answered "what else is missing" list.

---

## 🔴 CRITICAL / this-week

### B3 — `app.json` intentFilters duplication root fix — **VERIFIED**

**Confirmed by inspection:**
- `packages/mobile/app.json` declares `android.intentFilters` exactly ONCE (lines 45-64) with autoVerify hosts `mygaslink.com` + `www.mygaslink.com`.
- The pre-built `android/app/src/main/AndroidManifest.xml` shows only ONE `<intent-filter android:autoVerify="true" data-generated="true">` block — the `data-generated="true"` marker is stamped by **expo-router's** plugin. So the duplication is in the RESOLVED JS config that EAS ingests, NOT in the manifest XML.
- **Most likely source: `expo-router`** (declared as bare string, merges its generated filter into `config.android.intentFilters` without deduping against the hand-written entry when they overlap).
- No `app.config.ts` exists → option (a) plugin is definitively correct, no JSON→TS migration needed.
- `plugins/` dir already exists with 2 clean templates: `withResizeableActivity.js` + `withoutRecordAudio.js` (~40 lines each).
- `@expo/config-plugins@54.0.5` already transitively installed — no new dependency.
- **No workaround script exists.** The strip-before-publish/restore-after is entirely manual. Nothing to remove when the fix lands.
- No `eas.json` hint about the workaround.

**Concrete plan (30 min confirmed):**
1. **Create** `packages/mobile/plugins/withDedupIntentFilters.js` (~15 LOC using low-level `withPlugins` — do NOT use `withAndroidManifest`; duplication is in JS-config not XML). Dedup by stable-stringify hash of each filter object.
2. **Edit** `packages/mobile/app.json` — append the plugin as the LAST entry in `expo.plugins[]` (after `expo-build-properties`), so it runs after `expo-router` has contributed its filter.
3. **Verify:** `npx expo config --json | jq '.android.intentFilters | length'` returns `1`.

**APK rebuild required:** No.

### B4 — Switch CI to `prisma migrate deploy` — **VERIFIED**

**Confirmed by inspection:**
- `packages/api/package.json` scripts: `"db:migrate": "prisma migrate dev"` + `"db:migrate:prod": "prisma migrate deploy"` (both present).
- `.github/workflows/ci.yml:120` — the **test job** calls `db:migrate` (dev). This is the CI failure vector.
- `.github/workflows/ci.yml:206, 347` — the **deploy-prod + deploy-staging jobs** already call `db:migrate:prod` (correct).

**Concrete change:** replace `db:migrate` with `db:migrate:prod` at `ci.yml:120` only. Local dev keeps `db:migrate` unchanged. 5 min.

### B5 — EC2 upsize to t3.medium — **UNVERIFIED (Suneel-owned)**

No changes. AWS console click — Suneel does it. `NODE_OPTIONS=--max-old-space-size=2048` at ci.yml:212, 213, 354, 355 can be dropped after the upsize but leave as belt-and-braces.

---

## 🟠 NEW FEATURES

### F1 — Defective full-cylinder tracking — **HEAVILY REVISED**

**Naming corrections (from v1):**
- Driver form field is **`emptiesCollected`** not `emptiesReturned` — new field is **`defectiveFullsReturned`**.
- Enum is **`LedgerEntryType`** not `CustomerLedgerEntryType`. New value: **`defective_full_return`**.
- Enum is **`InventoryEventType`**. New values: **`defective_return`** + **`defective_return_to_corporation`**.

**Existing infrastructure to reuse:**
- `InventoryEvent.condition = 'good' | 'defective'` column already exists ([schema.prisma:2303](packages/api/prisma/schema.prisma:2303)) — currently only used for outgoing-empties tagging.
- Depot History tab ([InventoryPage.tsx:357-376](packages/web/src/pages/InventoryPage.tsx:357)) already has an eventType filter dropdown at line 537-541 (currently `incoming_fulls | outgoing_empties`). Extending it to include the new defective events is the natural F1 UI slot — no new tab needed.
- Single `createInventoryEvent(...)` helper at [inventoryService.ts:12-58](packages/api/src/services/inventoryService.ts:12) — used by 51 files. New eventTypes plug in trivially.
- Deposit-ledger commit (2026-07-31) is the pattern template: additive migration, 2 nullable columns, partial index.

**8 hidden traps (blow the 2-day estimate if not planned around):**

1. **`CreditNote.invoiceId` is NOT nullable** ([schema.prisma:2111](packages/api/prisma/schema.prisma:2111)). The CN branch needs a parent invoice. Options: (a) driver names which delivery invoice at return time (new UX field), (b) schema-migrate to nullable (touches PDF + GST payload builder + Tally export + ledger renderers). Deposit-refund CN sidesteps this by always attaching to an existing invoice — F1 CN branch can do the same, but only if the driver knows/records which delivery invoice.
2. **Invoice generator has NO per-invoice discount concept, only per-line.** [invoiceService.createInvoiceFromOrder:239-345](packages/api/src/services/invoiceService.ts:239) iterates `order.items`. Net-off requires either (a) allocate compensation to matching cylinder-type line via `discountPerUnit` (breaks if next invoice has no matching line), (b) new synthetic line with negative qty (**NIC IRN rejects negative qty** — hard NO), or (c) schema-add `Invoice.priorCompensationApplied` column surfaced on PDF footer + reducing `outstandingAmount` at approval. Option (c) is clean but touches PDF + GST payload + Tally.
3. **GST implications of CN branch:** for a defective full swap where customer receives replacement of equal value, CN + fresh invoice = zero net but doubles GSTR-1 volume (Table 4 sale + Table 9B credit). Needs CA sign-off. "No compensation" branch is safest for v1 — just writes audit-trail ledger row.
4. **`CustomerInventoryBalance.withCustomerQty` double-decrement risk.** [orderService.confirmDelivery:1301-1316](packages/api/src/services/orderService.ts:1301) does `increment: deliveredQty - emptiesCollected`. Naively feeding `defectiveFullsReturned` as an extra empty double-counts. F1 needs a distinct arm — the driver picks up 1 defective full + delivers 1 fresh = net-zero customer holding change.
5. **Anti-pattern #24 exclusion sites.** Both `reportsService.customerStatement` AND `routes/payments.ts /ledger/:customerId` must exclude `defective_full_return` metadata rows from Dr/Cr running balance (compensation flows via CN row, not the audit row).
6. **`customerLedgerPdfService.ts typeLabel / groupTypeLabel`** needs a new case per deposit-ledger precedent.
7. **F3 MUST land WITH F1** — else `defective_return_to_corporation` events show up in Vehicle Ledger as customer trips via generic event fanout in [vehicleLedger:1319](packages/api/src/services/reportsService.ts:1319). Visible bug.
8. **Mini-op + godown-pickup branches** in `confirmDelivery` (lines 1204-1296) — new event writes need to think about mirrors.

**`DefectiveReturnBatch.items[]` shape decision:**
- v1 said `items[]` without defining. The brief's report list ("Defective returns by customer") requires **Option (a): join table `DefectiveReturnBatchItem { batchId, inventoryEventId }`** linking back to the customer-side events. Option (b) aggregate-only loses the "which customers contributed" trail. Option (a) is ~3 days; option (b) is ~4 hours but breaks the report.

**Realistic file count: 17-20**, breakdown:
1. `packages/api/prisma/schema.prisma` (2 new InventoryEventType + 1 new LedgerEntryType + 1 new model + optional fields)
2. New migration `20260806000000_defective_returns/migration.sql`
3. `packages/shared/src/enums/index.ts` (mirror)
4. `packages/shared/src/types/index.ts`
5. `packages/shared/src/schemas/index.ts` (extend `deliveryConfirmationSchema`, new `sendDefectiveReturnBatchSchema`)
6. `packages/api/src/services/inventoryService.ts` (optional helpers `recordDefectiveReturn()` + `recordDefectiveReturnToCorporation()`)
7. `packages/api/src/services/orderService.ts` (`confirmDelivery` — new arm)
8. `packages/api/src/services/invoiceService.ts` (net-off consume + new CN reasonCode wiring)
9. `packages/api/src/services/customerService.ts` (statement readers)
10. `packages/api/src/services/reportsService.ts` (defective-by-customer, defective-by-corporation, compensation-outstanding aging; ALSO F3 corp exclusion)
11. New `packages/api/src/services/defectiveReturnService.ts` (batch CRUD + "send to corporation")
12. New `packages/api/src/routes/defectiveReturns.ts`
13. `packages/api/src/routes/orders.ts` OR schema — expose driver field
14. `packages/mobile/app/(driver)/orders.tsx` — new UI section
15. `packages/mobile/src/services/deliveryQueue.ts` — extend offline queue shape
16. `packages/web/src/pages/InventoryPage.tsx` — extend Depot History filter + "Send to Corporation" modal
17. Reports frontend
18. Tests — new `defective-returns.test.ts` + updates to `confirmDelivery` + `createInvoiceFromOrder` guards

**Effort: 3 days for full brief. 2 days only if v1 = MVP (audit-trail + "no compensation" branch, aggregate-only batch, no reports; CN + net-off + reports + join-table deferred to v1.1).**

**APK rebuild required:** No (new JSON field on existing endpoint; new UI section is JS).

### F2 — Reports revamp Phase 1 — **VERIFIED WITH SPLIT**

**Confirmed by inspection:**
- `REPORTS` registry is a flat `Record<string, fn>` at [reportsService.ts:1759-1768](packages/api/src/services/reportsService.ts:1759). 8 report slugs today. No grouping metadata anywhere.
- `ReportsPage.tsx` is a flat horizontal chip bar of reports (lines 190-200), NOT tabs. Two independent panels above (`TallyExportPanel`, `GstFilingExportPanel`). One shared filter row below.
- **Zero hidden dependencies on `REPORTS`**: grep for `REPORTS[` returns only the route handler and its dist copy. No crons consume it. Grouping restructure is safe.
- **P&L and Cash Flow do NOT exist today.** Building blocks are absent — need to pick data sources first (expenses table for P&L? payments+expenses for cash flow?) and align to accounting conventions.
- Day Book pieces PARTIALLY exist: `inventoryMovement` is already daily/per-cyl and could be renamed. `salesSummary` has a `byDay` chart but rows are per-customer not per-day. Daily Driver Movement has no equivalent — would need a new function.

**RECOMMENDED SPLIT:**
- **Phase 1a (1 day flat):** Grouping restructure + Day Book × 3 reports (Daily Sales / Daily Driver Movement / Daily Inventory Movement). Grouping change is metadata-only per §Concrete plan below.
- **Phase 1b (1.5-2 days):** P&L + Cash Flow after accounting-source decision.
- **Phase 2 (F7):** additional reports at 0.5-1 day each.

**Concrete grouping approach (metadata-only, no runtime shape change):**
1. **API** — keep `REPORTS` flat map unchanged. Add sibling metadata `REPORT_CATALOG: Array<{key, group, label, roles?, defaultFilters?}>` in the same file. Add `GET /api/reports/catalog` returning the group tree.
2. **Frontend** — replace horizontal chip bar with a left-nav shell (group headers + report list). `reportKey` state and existing report render logic unchanged.
3. **New reports** — thin wrappers on existing services where possible (`dayBookDailySales` wraps `salesSummary` with per-day roll-up, `dayBookDailyInventoryMovement` renames `inventoryMovement`, `dayBookDailyDriverMovement` is new).

**Permissions note:** all existing reports gated uniformly at route layer. F2's Financial group (P&L, Cash Flow) should narrow to `finance | distributor_admin` only — needs an explicit gate in the route or via `REPORT_CATALOG.roles[]`.

### F3 — Vehicle Ledger corporation-trip exclusion — **VERIFIED, 1 hr**

**Confirmed by inspection.** Concrete delete-set:
- **Service** ([reportsService.ts:1319](packages/api/src/services/reportsService.ts:1319)):
  - Remove `'incoming_fulls'` from the `movementTypes` OR-array at line 1330-1342.
  - Delete the `if (e.eventType === 'incoming_fulls') { … continue }` branch at lines 1447-1454.
  - Delete `corporationMap` declaration at line 1436.
  - Drop the `secondary` field from the return value at lines 1512-1523.
  - Also exclude the new `defective_return_to_corporation` events once F1 lands.
- **Frontend** ([ReportsPage.tsx:440-538 UnifiedVehicleLedger](packages/web/src/pages/ReportsPage.tsx:440)):
  - Drop `vehicleLedgerView` state at line 74.
  - Drop `SecondaryTable` render at 267-281 for vehicle-ledger.
  - Delete `corporationRows` mapping in `UnifiedVehicleLedger` at 464-478.
  - Drop view selector + `showDocument` conditional + `Type` column + `badge-info` chip.
- **Test:** update `packages/api/src/__tests__/reports-vehicle-ledger-attribution.test.ts` (adjust corporation-related assertions).

Estimate confirmed: 1 hr, ~25 LOC service delete + 40-60 LOC frontend delete + test tweaks. Best folded into the F1 commit.

### F4 — Vehicle Ledger outstanding-empties + sticky columns — **VERIFIED**

**Confirmed by inspection:**
- Current `MoveRow` shape at [reportsService.ts:1438-1442](packages/api/src/services/reportsService.ts:1438) has 11 columns backend-side but frontend `UnifiedVehicleLedger` renders only 7 (collapses fulls/empties into a single `Quantity` cell via `firstNonZero()`). F4 needs to consider both.
- `emptiesGap = emptiesCollected − emptiesReturnedVerified` today (line 1497) — driver-vs-depot reconciliation. F4's "outstanding empties" is `fullsDelivered − emptiesCollected` — customer-owed. **Confirmed distinct metrics.**
- **Trip-level outstanding empties = 1-line derivation on `MoveRow`** (`fullsDelivered - emptiesCollected`).
- **Customer-cumulative running balance = new join layer** (event → order → customer → `CustomerInventoryBalance.withCustomerQty`). `CustomerInventoryBalance` already exists at [schema.prisma:1341-1361](packages/api/prisma/schema.prisma:1341) and 5+ services read it (drilldown, paymentService, driverStatement PDF, portal). Pattern is reusable but not a drop-in call.
- **No sticky columns exist anywhere in ReportsPage.tsx** — grep for `sticky` empty. `overflow-x-auto` wrapper is already present. Sticky-column CSS is ~30 min: `position:sticky` + `left:` offsets + `bg` + `z-index` on the first 3 `<th>` / `<td>`.

Estimate: **trip-level only = 3-4 hr** (per brief). **Trip + customer-cumulative = 5-7 hr** — check with Suneel which he needs.

### F5 — Group ledger PDF Change M mirror — **VERIFIED**

**Confirmed by inspection:**
- `groupLedgerPdfService.ts` does **NOT exist** as a separate file. Both `generateCustomerLedgerPdf` (L262) and `generateGroupLedgerPdf` (L928) live in [customerLedgerPdfService.ts](packages/api/src/services/pdf/customerLedgerPdfService.ts) — same file.
- Route: `GET /ledger/pdf` at [customerGroupPortal.ts:203-230](packages/api/src/routes/customerGroupPortal.ts:203), gated by `requireRole('customer_hq') + requireGroupAccess`.
- Change M gap in group PDF = exactly 4 code blocks to mirror:
  1. Distributor SELECT fields for `bankName / bankAccountNumber / bankBranchName / ifscCode / upiId` (currently at L939-949 missing all 5).
  2. UPI QR buffer generation (customer version at L300-318).
  3. QR render in header centered between distributor block and title (customer version at L353-368).
  4. Pay To bank block right-aligned beside customer name (customer version at L393-429).

**Additional polish items surfaced by side-by-side comparison:**
- Period date on group PDF prints raw ISO strings at L995-996 vs customer PDF uses `formatDate()` with "Beginning" fallback (L435). **5-min fix, worth including.**
- Per-page subtotal row on multi-page — customer has it (`emitPageSubtotal` L469-513, invoked L586-593 + L750-752), group PDF just adds a page at L1141-1146 without a per-page subtotal. **~3-4 hr on its own; probably out of scope for F5's 2-4hr window — deferred item.**
- Everything else is at parity (cancelled-row treatment, indicative-cost note, closing balance summary, empties narration, footer boilerplate).

**Estimate: 2-4 hr for QR + Pay To + formatDate.** +3-4 hr if per-page subtotal included (recommend deferring).

**Answer for Suneel's "overall changes"**: the 4 Change M blocks + the formatDate fix. Per-page subtotal is a bigger commit worth its own item.

### F6 — Mobile Deposits customer filter — **VERIFIED, 1-2 hr**

**Confirmed by inspection:**
- [DepositsView.tsx:86-95](packages/mobile/src/components/DepositsView.tsx:86) has an explicit comment documenting the Change H tradeoff: "dropped the on-screen customer filter — the polished header now has 2 SelectField dropdowns."
- Backend `GET /api/payments/deposits` already accepts `customerId` param at [routes/payments.ts:167-183](packages/api/src/routes/payments.ts:167) — no API change needed.
- Web parity reference: `Combobox` at [BillingPaymentsPage.tsx:2440-2488](packages/web/src/pages/BillingPaymentsPage.tsx:2440) with 500-cap fetch keyed `customers-list-for-deposit-picker` + `staleTime: 60_000`.
- Reusable picker pattern lives in the SAME file — `PickerOverlay` at DepositsView.tsx:920-961 (used by the Record Deposit sheet's 3 pickers). Already honors anti-pattern #25: `useSafeAreaInsets` + `paddingBottom: Math.max(insets.bottom + 8, 16)` + `contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}` on FlatList + `keyboardShouldPersistTaps="handled"` + `statusBarTranslucent`.
- **Real watchout:** customers preload is gated on `showRecord` at DepositsView.tsx:118-123 (Change I performance fix). F6 must NOT lift the gate (regression risk on 500-cust tenants). Add a second on-demand fetch tied to `customerFilterPickerOpen`, sharing the same query key so both cache once either opens.

**No shared bottom-sheet component exists** in `packages/mobile/src/components/ui/`. Either copy the local `PickerOverlay` pattern OR lift it to `components/ui/` for reuse (RecordDepositSheet uses it 3× already — lift is worth it if a 3rd screen needs it soon).

Estimate: **1-2 hr confirmed.**

**APK rebuild required:** No — OTA-safe.

### F7 — Additional reports (unchanged)

No new findings. Order once F2 grouping lands. 0.5-1 day each.

### F8 — Supplier Ledger (distributor-side purchase book) — **NEW, added 2026-08-05 pm**

**Origin:** Confidence Petroleum supplier statement PDF surfaced during a Jeevan conversation. Universal LPG business flow — every distributor buys from an OMC (IOCL/HPCL/BPCL/Confidence/SuperGas), pays full MRP up front, then receives an **incentive credit note ~8 days later** that determines their true landed cost. Today distributors keep this book in Tally / Excel outside MyGasLink — inventory events and Tally purchase entries drift silently.

**Verified against current schema (2026-08-05):**

| Model | Line | Status |
|-------|------|--------|
| `SourceDistributor` | [schema.prisma:584](packages/api/prisma/schema.prisma:584) | ✅ EXISTS — supplier master |
| `SourceDistributorEmptyOpening` | [schema.prisma:622](packages/api/prisma/schema.prisma:622) | ✅ EXISTS — opening empties owed to supplier |
| `PurchaseEntry` | [schema.prisma:653](packages/api/prisma/schema.prisma:653) | ✅ EXISTS — purchase invoice header (Confidence-style `NM26S-02687`) |
| `PurchaseEntryItem` | [schema.prisma:691](packages/api/prisma/schema.prisma:691) | ✅ EXISTS — line items |
| `PurchasePayment` | [schema.prisma:715](packages/api/prisma/schema.prisma:715) | ✅ EXISTS — payments to supplier |
| `PurchasePaymentAllocation` | [schema.prisma:749](packages/api/prisma/schema.prisma:749) | ✅ EXISTS — allocation to specific purchases |
| `PurchaseCreditNote` | — | ❌ **GAP** — the 8-day-later incentive credit lives nowhere |
| Supplier Ledger report | — | ❌ **GAP** — no PDF matching the OMC supplier-statement format |

**Verified role gate: `mini_operator_admin` only.** Router-level gate on all 3 route files:
- [purchaseEntries.ts:37, 55, 89, 109, 128, 152](packages/api/src/routes/purchaseEntries.ts) — 6 endpoints, each with `requireRole('mini_operator_admin')`
- [sourceDistributors.ts:47, 62, 85, 113, 138](packages/api/src/routes/sourceDistributors.ts) — 5 endpoints similarly gated
- [purchasePayments.ts:35](packages/api/src/routes/purchasePayments.ts) — `router.use(requireRole('mini_operator_admin'))` gates the whole router

So "unlock the gate" is a real, single-line-per-endpoint change (~12 decorators + 3 router-level uses). Prior-chat's "60% exists" holds up — 6 of 8 building blocks land-of-the-existing.

**Scope (7 items, ~4-5 days):**

| # | Work | Effort | Files |
|---|------|--------|-------|
| 1 | Drop `mini_operator_admin` gate on `SourceDistributor` + `PurchaseEntry` + `PurchasePayment` routes. Replace with `distributor_admin \| finance \| mini_operator_admin` (super_admin auto-passes). | 0.5 day | 3 route files + wire-shape guard tests |
| 2 | "Suppliers" section in web Settings (CRUD supplier master) | 0.5 day | new `packages/web/src/pages/settings/SuppliersTab.tsx` |
| 3 | "Purchases" tab in web (list + Add-Purchase modal capturing doc no / date / items / freight / GST breakup / total) | 1 day | new `packages/web/src/pages/PurchasesPage.tsx` + modal |
| 4 | New `PurchaseCreditNote` model + migration + route (post 8-day incentive credit against a `PurchaseEntry`) | 1 day | schema.prisma + migration + new `packages/api/src/routes/purchaseCreditNotes.ts` + `packages/api/src/services/purchaseCreditNoteService.ts` |
| 5 | Supplier Ledger report (Vr Date / Vr Type / Vr No / Debit / Credit / Running Dr — mirror Confidence PDF) | 1 day | new `packages/api/src/services/pdf/supplierLedgerPdfService.ts` + route + web download button on Purchases page |
| 6 | Wire existing `incoming_fulls` inventory event to auto-create from `PurchaseEntry` (stock intake + supplier payable in one flow, not two) | 0.5 day | [inventoryService.ts:12](packages/api/src/services/inventoryService.ts) hook + `purchaseEntryService.create` |
| 7 | Wire-shape tests + multi-tenant guards (anti-patterns #1 + #9) | 0.5 day | new `packages/api/src/__tests__/supplier-ledger.test.ts` + `purchase-credit-note.test.ts` + cross-tenant negatives |

**Deliberately OUT of scope (do NOT bundle):**
- ITC claiming / GSTR-2A auto-reconciliation
- Multi-corporation price masters (each OMC has its own MRP)
- Distributor-side P&L / landed-cost analytics — natural follow-up feature, needs supplier ledger first
- TDS on supplier payments

**Modelling note for the `PurchaseCreditNote.reason`:**
Different OMCs use different reasons (freight rebate / quality claim / promo incentive / bulk discount / seasonal scheme). **Ship v1 as free-text `reason: string` + `amount: Decimal`.** Formal categorisation is a v1.2 enhancement once we see what distributors actually type.

**Strategic argument (worth restating):** MyGasLink today is a **half-book system** — perfectly captures the customer-facing side but nothing about where stock came from. Adding this closes the loop. The natural downstream feature ("what's my margin per cylinder?") becomes a one-query answer: `sale_price_effective − landed_cost_from_supplier`. This is the pitch that turns MyGasLink from "an operations tool" into "the accounting tool" — a high retention lever for a small build.

**Recommendation for THIS release:** Given the release is already at 6-8 days and F1 alone contests for 3, F8 is **too big to fold into this release** without pushing to 10-13 days. Either:
- (a) **Recommended:** log now, ship as its own 4-5 day sprint immediately after this release (Sprint N+1). Draft the full spec at `docs/WI-SUPPLIER-LEDGER.md` this session — Confidence PDF is a perfect acceptance-test fixture.
- (b) If Suneel wants it in THIS release, drop F2 Phase 1b (P&L + Cash Flow, ~1.5-2 days) + defer F5 per-page subtotal, and F8 fits inside a 9-10 day release.

**APK rebuild required:** No — web-only feature. Mobile can consume the ledger PDF via existing web view later.

**Files to touch (est. 8-10):** 3 route files (unlock), 3 new services (`purchaseCreditNoteService`, `supplierLedgerPdfService`, `supplierLedgerReport`), 1 new route file (`purchaseCreditNotes`), 1 new web settings tab, 1 new web page + modal, 1 migration, 2 test files.

---

## 🟡 KNOWN DEBT

### D1 — Unit price vs PDF rate inconsistency — **FIX DIRECTION CORRECTED**

**Confirmed by inspection:**
- **PDF before-state** at [invoicePdfService.ts:180-187 COL_DEFS](packages/api/src/services/pdf/invoicePdfService.ts:180) + `computeItems` at 227-276 + `drawItemsTable` at 558-571:
  - Divides by `(1 + gstRate/100)` (≈ `/1.18`) → produces GST-exclusive, post-discount `baseRate`.
  - Renders `formatMoney(item.baseRate)` under "Rate" column.
  - Renders separate `Discount: ₹X/unit` sub-line under item name when `discountPerUnit > 0` (gated at line 531).
- **Admin surface state:**
  - Admin web [InvoicesPage.tsx:458-469](packages/web/src/pages/InvoicesPage.tsx:458) → raw `formatCurrency(item.unitPrice)` (pre-discount inclusive, no discount annotation).
  - Finance mobile [(finance)/invoices.tsx:351](packages/mobile/app/(finance)/invoices.tsx:351) → `{item.quantity} x {formatINR(item.unitPrice)} @ {item.gstRate}% GST` (same).
  - Admin mobile [(admin)/finance.tsx:867](packages/mobile/app/(admin)/finance.tsx:867) → same.
- **Customer portal state:** [mappers.ts:430-447](packages/api/src/utils/mappers.ts:430) → `unitPrice = totalPrice / quantity`, **strips `discountPerUnit` from response** at line 440. Post-discount inclusive, fully reconciles.
- **`InvoiceItem.totalPrice` = post-discount inclusive** confirmed at [invoiceService.ts:287](packages/api/src/services/invoiceService.ts:287) comment.

**KEY CORRECTION TO v1 BRIEF:** "In-app convention" is TWO conventions:
- Admin/finance surfaces show **pre-discount inclusive** raw `unitPrice` (same D1 UX confusion in reverse — customer comparing app to app-with-shown-discount sees mismatch too).
- Customer portal shows **post-discount inclusive** `totalPrice/quantity` (reconciles).

**REVISED FIX DIRECTION — Route (a′): PDF adopts `totalPrice/quantity`.**
- Matches customer app (the surface most likely to be compared to PDF by a customer).
- Reconciles per-line: `qty × shown = lineTotal` always.
- Safely drops the `Discount: ₹X/unit` sub-line — customer never sees the discount broken out (which was the goal).
- Subtotal formula still works (`Σ(totalPrice)` is the natural aggregate; no need for `Σ baseRate × qty` compensation math).

Route (a′) contrast with brief's option (a) "align PDF to in-app convention":
- Option (a) is ambiguous — if it meant raw `unitPrice`, PDF subtotal math breaks (`Σ up × qty ≠ grandTotal` on discounted rows unless discount aggregate subtracted first). Route (a′) sidesteps this.

**`discountPerUnit` column stays** — still consumed by:
- [tallyExportService.ts:178, 371](packages/api/src/services/tallyExportService.ts:178)
- [gstFilingExportService.ts:396](packages/api/src/services/gstFilingExportService.ts:396)
- IRN payload builders (per anti-pattern #16 flow)
- The writer at invoiceService

Only the customer-facing PDF row loses the sub-line.

**Test file to rewrite:** `packages/api/src/__tests__/invoice-pdf-rate-reconciles.test.ts` — the SINGLE test that pins the current Rate/discount contract. All expected values (31779.66, 30508.47, negative-pin 35593.22, subtotal 6742.37) need re-derivation under (a′). **No snapshot tests exist.**

**Edge cases pre-checked:**
1. Zero-discount rows — identical under (a′) vs current. Test #3 in the reconciles suite covers this.
2. Variable per-line discount within one invoice — under (a′) the customer sees `1800/unit × 1 = 1800` cleanly, no hidden discount. This is a step FORWARD in transparency compared to raw-`up` route.
3. `gstRate = 0` — `computeItems` line 235 coerces `gstRate = item.gstRate || 18`. Neither route touches this fallback. Orthogonal quirk (worth flagging separately).
4. Rounding drift `totalPrice/qty` vs `(up - discount)` ≤ 0.005; test tolerance is 2¢. Safe.
5. NIC IRN payload untouched (comment at computeItems lines 251-253 explicit).
6. Related loose ends: F-3 (admin web no Subtotal row) + F-5 (dead `cgst/sgst/igst` params in `drawTotals` at invoicePdfService.ts:605). Cheap to bundle.

**Effort: 4 hr confirmed** (5 min code change, 1 hr test rewrite, 30 min manual PDF check, 1 hr regression pass, 1.5 hr buffer for edge cases).

### D2 — Reconcile-flow integration test (unchanged)
Low priority. 2 hr. Currently covered indirectly by `gst/tripAutoAdvance.test.ts` test #3.

### D3 — B2C reissue docNo bump (unchanged)
Low priority. 1-2 hr. Not touched by INVOICE-NUMBERS-AUDIT (scoped to display, not numbering).

### D4 — Float-to-Decimal service migration (unchanged)
Medium priority. 1 day. No known incident but a ticking correctness bomb.

### D5 — Customer ledger view (unchanged)
Medium priority. 4-6 hr. PDF covers today; screen view is nice-to-have.

### D6 — `CustomerInventoryBalance.pendingReturns` cleanup (unchanged)
Low priority. 2 hr mechanical. Documented drop sequence still applies.

---

## 🟢 v1.1 SPRINT (post-iOS-live)

Everything unchanged from v1 brief. Highlights re-verified:

- **N1 Push notifications** — 2 days. IMPORTANT per Suneel.
- **N2 Universal Links + Android App Links** — 1 day. **HARD DEADLINE 2026-08-31.** Depends on B3 (Android intentFilter dedup must land first).
- **N4 SSL cert pinning** — 1 day. DPDP audit requirement.
- **N6-N15** — unchanged.

### Super Admin billing — **VERIFIED, effectively DONE**

Verified against [docs/SUPERADMIN-BILLING-AUDIT.md](docs/SUPERADMIN-BILLING-AUDIT.md) (2026-06-08) + commit inspection:

| # | Ship-blocker | Status | Closing commit |
|---|--------------|--------|----------------|
| 1 | Supplier GSTIN hard-coded PENDING | ✅ DONE | `305c231` (Jul 1) wired `36ABCFG7518A1ZQ` into `billingInvoicePdfService.GASLINK` |
| 2 | Supplier legal name + address absent | ✅ DONE | `305c231` added `drawBillFrom` block |
| 3 | Invoice number not serial / regenerates | ✅ DONE | `305c231` shipped `SaasInvoiceCounter` + `IMGL<FY><seq>`; `e4162fc` (Aug 4) closed residual stability bug (persist in same transaction) |
| 4 | "Generate Billing" button posts empty body → 400 | ⚠️ STILL OPEN — but superseded by monthly cron `be4f86a`. [BillingPage.tsx:69](packages/web/src/pages/BillingPage.tsx:69) still `apiPost('/billing/generate')` with no body; [billing.ts:61-77](packages/api/src/routes/billing.ts:61) still requires 4 fields. Dead UI. | Trivial 2-line PR to delete or wire the button. |
| 5 | Intra-state check by state-name only, GSTIN ignored | ✅ DONE | Landed silently as part of `305c231`; [billingInvoicePdfService.ts:124-138](packages/api/src/services/pdf/billingInvoicePdfService.ts:124) now uses `buyerGstin.slice(0, 2) === sellerStateCode` first |

**Verdict:** 4/5 done + #4 trivially closable. Suneel's "done i guess" is defensible.

**Recommended action for next thread:** (a) delete or wire the empty Generate Billing button on BillingPage.tsx:69 (5-min PR), (b) add "resolved 2026-08-04" header to `SUPERADMIN-BILLING-AUDIT.md` to close it out.

---

## Baseline health — verified 2026-08-05

```
Git:              main @ f7f8a08 (latest CI green: fix(web) restore missing Deposits tab)
API typecheck:    ✅ clean
Web typecheck:    ✅ clean
Mobile typecheck: ✅ clean
API tests:        2089 passing / 2 failing / 2091 total in 1 failing file
```

**⚠️ 2 failing tests in 1 file need investigation before/alongside first commit.**

**Failing file:** [packages/api/src/__tests__/users.test.ts](packages/api/src/__tests__/users.test.ts)
**Failing describe:** "Users — Welcome email + audit log (Group B Part 2)"

- **Test 1 (users.test.ts:264):** `POST /api/users writes an email_logs row (type=welcome, status=skipped when SMTP unconfigured)` — `expected 500 to be 201`. The POST returns 500 instead of 201.
- **Test 2 (users.test.ts:283):** `PUT /api/users/:id (update) does NOT send a welcome email` — `prisma.user.findFirstOrThrow` fails because no matching user exists. **This is a cascade** from test 1 failing to create the user.

**Root cause = test 1.** Likely candidates: welcome-email code path throws (SMTP config check misconfigured), or the `email_logs` row insert conflicts with something added recently (deposit-ledger migration touched several service paths). Not a mass regression — the other 2089 tests pass. **10-30 min triage.** If it's a stale flake, re-run and confirm. If it reproduces, spawn a fix as Session 1 item 1.

Uncommitted at handoff:
- `M packages/mobile/package.json`
- `M pnpm-lock.yaml`

Both untracked deposit-ledger docs already in repo. **Ask Suneel about the mobile deps before starting mobile work.**

---

## Recommended sequencing (revised)

Same shape as v1 brief with corrections:

**Session 1 (~3-4 hr):**
1. **Triage the 2 failing tests** (10-30 min — could be a stale-flake or a real regression)
2. B3 — intentFilter dedup plugin (30 min)
3. B4 — CI to `migrate deploy` at ci.yml:120 (5 min)
4. B5 — coordinate with Suneel on EC2 upsize (5 min prep)
5. F4 — Vehicle Ledger outstanding-empties + sticky UX (3 hr trip-level; add 2-3 hr if customer-cumulative wanted)

**Session 2 (~1.5 days) — F1 + F3 (bundled):**
6. F1 — MVP scope only (audit trail + `defective_return` + `defective_return_to_corporation` events + Depot History filter extension + driver form field). **Defer** CN + net-off + reports + join-table `DefectiveReturnBatchItem` to v1.1. This makes 2-day estimate achievable.
7. F3 — folded into F1 commit (1 hr)

If Suneel wants FULL F1 in this release (all 3 compensation branches + reports + join table), budget 3 days for F1 alone.

**Session 3 (~1 day) — F2 Phase 1a:**
8. Grouping restructure + Day Book × 3 (1 day). Defer P&L + Cash Flow to Phase 1b next release OR add 1.5-2 days here.

**Session 4 (~0.5 day):**
9. F6 — Mobile Deposits customer filter (1-2 hr)
10. F5 — Group ledger Change M mirror + formatDate fix (2-4 hr). Defer per-page subtotal.

**Session 5 (~1 day):**
11. N2 — Universal Links + Android App Links (**HARD DEADLINE 2026-08-31**)
12. F7 — First 2-3 additional reports per customer feedback

**Session 6 (~2 days):**
13. N1 — Push notifications
14. N4 — SSL cert pinning

**Session 7 (cleanup):**
15. D1 — Rate/PDF consistency using **route (a′)** (4 hr)
16. Billing #4 — delete/wire dead Generate Billing button (5 min)
17. Update `SUPERADMIN-BILLING-AUDIT.md` with resolved header
18. D3, D4, D5, D6 per Suneel's decisions

**Total (base plan): 6-8 working days for approved list — same as v1 brief.**

**Sprint N+1 (recommended for F8) — Supplier Ledger:**
- **Session A (~2 days):** F8 items 1-4 — unlock role gate, Suppliers Settings tab, Purchases tab + Add-Purchase modal, `PurchaseCreditNote` model + route
- **Session B (~2-3 days):** F8 items 5-7 — Supplier Ledger PDF + report + inventory-event wiring + tests
- **Also draft** `docs/WI-SUPPLIER-LEDGER.md` this session using the Confidence PDF as acceptance fixture

**If F8 is bundled into THIS release instead** (Suneel call): 10-13 working days total. Drop F2 Phase 1b (P&L + Cash Flow) + defer F5 per-page subtotal to fit in 9-10 days.

---

## Open questions for Suneel — pre-answered where possible

1. **Report grouping structure** — (a) left-nav / (b) top-tabs / (c) filter dropdown?
   - Recommendation: **(a) left-nav** — 8 reports today + F7 adds 7 more = 15 in Phase 2. Chip bar breaks at ~10; top-tabs assume ~5-7 groups fit; left nav scales cleanly.
2. **Report Builder scope** — parameterized templates (Phase 1) or true builder?
   - Recommendation: **templates only** — after F2 + F7 land, revisit if users request specific ad-hoc combinations.
3. **F5 group ledger scope** — what beyond UPI QR?
   - **Pre-answered:** 4 Change M blocks (SELECT, QR gen, header render, Pay To) + formatDate on period line. Per-page subtotal deferred as bigger.
4. **D3-D6** — take now or park?
   - Recommendation: **park all four** for this release. D1 is the only pinned debt item. Session 7 revisits if bandwidth remains.
5. **SaaS billing** — verify 5 ship-blockers?
   - **Pre-answered above:** 4/5 done, #4 is trivial dead-UI fix.
6. **F1 scope** — MVP or full?
   - Recommendation: **MVP (audit trail + "no compensation" branch + Depot History extension)** for this release. CN + net-off + reports + join table are v1.1 material. Full F1 in v1.0 pushes the release by 1-1.5 days AND requires a CA GSTR-1 conversation.
7. **F4 outstanding empties** — trip-level only or trip + customer-cumulative?
   - Ask directly; trip-level is 3-4 hr, customer-cumulative adds 2-3 hr.
8. **F8 Supplier Ledger** — bundle in this release or ship as Sprint N+1?
   - Recommendation: **Sprint N+1** (4-5 days as its own sprint). Draft `docs/WI-SUPPLIER-LEDGER.md` this session using the Confidence PDF as acceptance fixture. Bundling into this release pushes total to 10-13 days and would force dropping F2 Phase 1b (P&L + Cash Flow).

---

## Not shipping (unchanged)

- B1 (Play Store 1.2.0)
- B2 (iOS — already live)
- N5 (iPad)
- iPad ASC screenshots
- i18n branch merge

---

## Working conventions (unchanged)

See v1 brief §Working conventions. All anti-patterns still apply. New notes from research pass:
- **Anti-pattern #16 refinement lives in code but NOT in schema `///` comments.** [schema.prisma:2089](packages/api/prisma/schema.prisma:2089) InvoiceItem block has no per-field unit convention. Consider adding `///` comments in a small cleanup PR — pays back the next time someone reads the schema cold.

---

## Files to read at session start (updated order)

1. **This file** — `docs/NEXT-RELEASE-BRIEF-2026-08-05-VERIFIED.md`
2. `CLAUDE.md` — PRODUCTION STATE + Parked items
3. `docs/DEPOSIT-LEDGER-HANDOFF.md` — F1 pattern template (additive migration, anti-pattern #24 exclusion)
4. `docs/INVOICE-NUMBERS-AUDIT.md` — D1 context (D2/F-4 in the audit's numbering)
5. `docs/SUPERADMIN-BILLING-AUDIT.md` — billing verification (mostly done)
6. `docs/IOS-PHASE0-GROUND-TRUTH.md` — mostly obsolete; brief-tracked items (N1/N2/N4) survived

**TESTING_PROGRESS.md is stale** (last update 2026-05-21, claims 484 tests when reality is 2091). Either resurrect as current tracker or archive. CLAUDE.md session-start protocol still requires reading it — update that protocol OR revive the doc.

---

_End of verified brief. Corrections applied: 7 material items. Estimated total effort: 6-8 working days across 7 sessions (unchanged from v1). Ready to hand off._
