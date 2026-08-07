# Next Release — Handoff Brief

**Date opened:** 2026-08-05
**Handoff from:** Claude thread `b0ec4873-...` (deposit-ledger + reports + issueDate anchor push)
**Handoff to:** Fresh Claude Code session
**Prod state at handoff:** `main @ f7f8a08` deployed. Prod API + web live with deposit ledger, GST Filing Export, Invoices CSV, invoice `issueDate = deliveryDate`. Play Store still ships 1.1.1 (users need v1.2.0 push for OTA to reach them). iOS App Store is LIVE (per Suneel).

---

## Session start protocol (first ~5 min)

```bash
# 1. Ground truth
git log --oneline -6
git status --short
gh run list --branch main --limit 3

# 2. Test suite health
pnpm --filter @gaslink/api typecheck
pnpm --filter @gaslink/web typecheck
pnpm --filter @gaslink/mobile typecheck
pnpm --filter @gaslink/api test 2>&1 | tail -3   # expect 2091+ passing

# 3. Read this brief + CLAUDE.md production state section
```

Then tell Suneel: current SHA, tests count, CI status, and which item from this brief we're picking up.

---

## Recent commit history (context)

Most-recent-first, everything from the deposit-ledger sprint that just closed:

```
f7f8a08  fix(web) restore missing Deposits tab in BillingPaymentsPage
2f4ca0e  ci(deploy) NODE_OPTIONS=--max-old-space-size=2048 for prod + staging tsc
15afb89  fix(api) deposit-ledger migration — drop partial-index WHERE to match schema.prisma
65d3421  feat(api,shared,web,mobile) deposit ledger — charges, refunds, voucher PDF, per-type breakdown
fbad094  feat(api,web) reports — GST Filing Export + Invoices CSV export
8141f0c  fix(api) invoice issueDate — anchor to Order.deliveryDate on all paths
e4162fc  feat(api,web) SaaS billing — stable IMGL numbers + Send Invoice email + Razorpay link  (Suneel solo, Aug 2)
1b3677b  feat(api,web) price history — cylinder + empty deposit prices
717342f  feat(api,web) backdated invoice — previous-month grace window (first 10 days)
8a416fc  fix(api) LedgerEntryType — sync enum with DB (deposit_charged/refunded)
```

**EAS Update state:** production channel published at `df5c8508-3910-4e34-be8f-589e068f0085`. Runtime version `1.2.0`. Play Store users on `1.1.1` don't receive this update (see item **B1** below).

---

## Approved for next release — priority-ordered

Suneel's confirmations against the sprint list, verbatim mapping:

### 🔴 CRITICAL / this-week

#### B3 — `app.json` intentFilters duplication root fix
- **What:** Every `eas update` fails today because the RESOLVED Expo config (post-plugin-merge) has two identical `android.intentFilters` entries even though `app.json` only declares one. Some plugin (likely `expo-router` + a plugin combo) duplicates it. EAS server rejects with `must NOT have duplicate items`.
- **Workaround used today:** strip `android.intentFilters` from `app.json` right before publish, restore right after. Fragile.
- **Real fix:** either (a) write a config plugin `plugins/withDedupIntentFilters.js` that runs LAST and dedupes by object-hash before `expo prebuild` writes AndroidManifest.xml; or (b) migrate to `app.config.ts` and dedupe programmatically.
- **Files:** `packages/mobile/app.json`, `packages/mobile/plugins/withDedupIntentFilters.js` (new), possibly `app.json.plugins[]` list update.
- **Test:** run `npx expo config --json` and assert `.android.intentFilters.length === 1` before + after the plugin runs.
- **Effort:** 30 min
- **APK rebuild required:** No (config-only) if using app.json+plugin; Yes if migrating to app.config.ts pattern.

#### B4 — Switch CI to `prisma migrate deploy`
- **What:** CI's `db:migrate` script runs `prisma migrate dev` which does drift detection + shadow migrations. That's for LOCAL dev. Prod uses `migrate deploy` (already available as `db:migrate:prod`). Today's `65d3421` failure was drift detection false-positive — schema.prisma declared a full index, migration created a partial one, shadow migration tried to add duplicate → 42P07.
- **File:** `packages/api/package.json` (`"db:migrate"` script) OR `.github/workflows/ci.yml` (change what it calls). Prefer editing ci.yml so local dev still uses `migrate dev`.
- **Change:** in ci.yml wherever `db:migrate` is called → replace with `db:migrate:prod`. Two locations: the `test` job and (already fine) the `deploy-*` jobs.
- **Effort:** 5 min
- **Risk:** none — `migrate deploy` is strictly less permissive than `migrate dev`.

#### B5 — EC2 upsize to t3.medium (before next release)
- **What:** Prod EC2 is 2 GB RAM. `tsc` OOM'd on today's deploy (`2f4ca0e` added `NODE_OPTIONS=--max-old-space-size=2048` as a workaround but it thrashes swap during build). Upsize to `t3.medium` (4 GB) = ~$15/mo more.
- **How:** AWS Console → EC2 → Stop → Change instance type → `t3.medium` → Start. Elastic IP + EBS stay attached. Downtime ~5 min.
- **After:** can drop the `NODE_OPTIONS` flag from ci.yml (leave it in as belt-and-braces).
- **Owner:** Suneel (AWS console access)
- **Effort:** 5 min work + 5 min downtime

---

### 🟠 NEW FEATURES

#### F1 — Defective full-cylinder tracking (return + compensation + return-to-corporation)
- **Domain:** IOCL/HPCL delivers 100 fulls; some are defective (bad seal / low weight / damaged valve). Discovered by customer post-delivery. On driver's next visit: takes back the defective FULL + normal empties, delivers a replacement full. Distributor eventually returns defective fulls to the corporation for credit.
- **Data model:**
  - New `InventoryEvent.eventType = 'defective_return'` (customer → depot, refills the depot's "defective_fulls" bucket separate from empties)
  - New `InventoryEvent.eventType = 'defective_return_to_corporation'` (depot → corporation)
  - New `CustomerLedgerEntry.entryType = 'defective_full_return'` (audit trail per customer with `cylinderTypeId + qtyDelta + optional amountDelta` for compensation)
  - New table `DefectiveReturnBatch { id, corporationRef, sentAt, distributorId, items[] }` for the outgoing-to-corp flow
- **Compensation branches (operator choice at return time):**
  - **Credit Note** — reuse the deposit-refund CN path
  - **Net-off next invoice** — mark rows `pendingCompensation=true`; invoice generator subtracts qty×rate as a discount line
  - **No compensation** — driver swapped a fresh unit of same value at pickup
- **UI:**
  - Driver mobile: `defectiveFullsReturned: [{cylinderTypeId, qty, reason}]` alongside the existing `emptiesReturned` on the delivery form
  - Web Inventory: "Defective Returns" tab → list + "Send to Corporation" batch entry
- **Reports it unlocks:**
  - Defective returns by customer (repeat offenders)
  - Defective returns by corporation (leverage for negotiation)
  - Compensation-outstanding aging (defective returns without CN or net-off yet)
- **Files touched (est.):** ~15 — schema.prisma, migration, inventoryService, customerService, mobile delivery form, web Inventory page, new DefectiveReturnBatch route, reports table.
- **Effort:** 2 days
- **APK rebuild required:** No (mobile add is a new JSON field on an existing endpoint)

#### F2 — Reports revamp Phase 1 — grouped taxonomy + report builder
Suneel's proposed grouping (verbatim):
- **Day Book group**
  - Daily sales
  - Daily driver movement
  - Daily inventory movement
- **Financial group** — P&L, Cash Flow
- **GST group** — GSTR-1, GSTR-3B (existing GST Filing Export lives here)
- **Invoicing group** — invoice register / AR aging / CSV export
- **Customer group** — customer statement / profitability / ledger

**Additional idea — Report Builder:**
> "Client can do whatever reports they want."

Two ways:
1. **Predefined + parameters** — pre-built templates with configurable columns / filters / groupings. Fast to build, easy to constrain.
2. **True builder** — drag-and-drop columns from a schema browser, custom filters, custom aggregations. Massive scope (weeks). Would need a query safety layer (never let user write raw SQL against the DB — always through a curated view / column allowlist per role).

**Recommendation:** start with #1 (parameterized templates in the grouped taxonomy). Add a "custom view" only after we see which combinations users actually want. Avoid re-inventing Metabase.

**Files:** `packages/api/src/services/reportsService.ts` (heavy refactor to group `REPORTS` map), `packages/web/src/pages/ReportsPage.tsx` (new nav with group tabs), new report files for Day Book / P&L / Cash Flow / Daily Driver Movement / Daily Inventory Movement.

**Effort:** 2 days for Phase 1 (Day Book + P&L + Cash Flow + grouping), plus incremental 0.5-1 day per new report thereafter.

#### F3 — Vehicle Ledger corporation-trip exclusion + F1 integration
Suneel's clarification (verbatim):
> "We can exclude corporation trips from reports vehicle ledger because both incoming and outgoing visible in depot history already — revisit the logic here only."

**What this means:**
- Vehicle Ledger main table today shows customer-facing vehicle trips (dispatch → delivery → return)
- The **secondary "Corporation Loads Received"** table shows corp-to-depot IN
- Once F1 lands, there'll ALSO be defective-fulls-going-OUT-to-corp events
- Both directions should live in **Inventory → Depot History** (existing screen)
- Vehicle Ledger should focus purely on **customer-facing vehicle activity** — no corp-side movements at all

**Change:** in `reportsService.ts vehicleLedger()`, drop the `incoming_fulls` include (currently rendered in secondary table). Also exclude the new `defective_return_to_corporation` events. Both stay visible in Depot History which is the right home for supplier-side movements.

**Files:** `packages/api/src/services/reportsService.ts` (vehicleLedger fn ~line 1319), `packages/web/src/pages/ReportsPage.tsx` (drop the corporation secondary table renderer).

**Effort:** 1 hr

#### F4 — Vehicle Ledger — outstanding empties column + sticky columns
Suneel's ask (verbatim):
> "We need to add outstanding empties in reports vehicle ledger."

**What "outstanding empties" means in this context:**
- Per trip: `fullsDelivered - emptiesCollected` = empties the customer owes back after this trip
- Cumulative per customer over the date range: running "empties held by customer" balance
- Not the same as `emptiesGap` (which is `emptiesCollected - emptiesReturnedVerified` — a driver-vs-depot reconciliation metric)

**Also do the sticky-column UX polish while here** — the current 11-column table scrolls horizontally on laptops, and empties columns fall off-screen right. Freeze `Date | Vehicle | Trip` columns so users see identity + all numeric columns together.

**Files:** `packages/api/src/services/reportsService.ts` (add `outstandingEmpties` to `MoveRow`), `packages/web/src/pages/ReportsPage.tsx UnifiedVehicleLedger` (sticky columns CSS).

**Effort:** 3-4 hr including sticky UX

#### F5 — Group ledger overall changes (deferred from Change M)
- Change M added a UPI scan-to-pay QR + bank details block to the customer ledger PDF
- **F5:** apply the same treatment to the **group ledger PDF** (customer-HQ view that aggregates multiple customers under one group)
- Also review other polish items on group ledger surface (may be more than just QR)
- **Files:** `packages/api/src/services/pdf/groupLedgerPdfService.ts` (verify file name; may be an extension of customerLedgerPdfService)
- **Effort:** 2-4 hr
- **Depends on:** confirming with Suneel what else on group ledger needs work

#### F6 — Mobile customer picker in Deposits filter
- During today's mobile UI polish (Change #27), the on-screen customer filter was removed from Deposits screen (SelectField dropdowns replaced pills; customer wasn't converted). Web still has a customer combobox filter.
- **F6:** add a customer SelectField / bottom-sheet picker to the mobile Deposits filter row, matching web parity. Reuse the picker pattern from Record Deposit modal (already has customer + cyl type + invoice pickers).
- **Files:** `packages/mobile/src/components/DepositsView.tsx` — restore `customerFilter` state (currently removed with comment), wire it to a new SelectField or bottom-sheet picker.
- **Effort:** 1-2 hr
- **APK rebuild required:** No — OTA-safe

#### F7 — Additional reports (extends F2 grouping)
Once F2's grouping is in place, add these one-by-one to the right groups:

- **Cylinder Rotation Report** (Customer group) — average days-held per customer per cylinder type. Spots hoarders costing deposit float. Aggregates over date range.
- **Route / Driver Performance** (Operations group) — orders/day, avg delivery time, empties-collected-vs-fulls-delivered ratio, revenue per driver.
- **GST Reconciliation** (GST group) — our invoice totals vs corporation purchase totals per month → surfaces missed billings.
- **Corporation-wise Purchase Split** (Operations/Financial group) — multi-corp support (IOCL / HPCL / BPCL) with margin per corp. Needs `Corporation` model or purchase-entry.corpName field.
- **Payment Method Mix** (Financial group) — cash / UPI / cheque / credit split over time; forecasting input.
- **Customer Profitability** (Customer group) — revenue − discounts − AR carrying cost, ranked. Needs an AR-carrying-cost assumption (interest rate).
- **Rate Variance / Discount Leakage** (Customer group) — flags customers whose effective discount drifts from their configured discount.

**Effort:** 0.5-1 day per report

---

### 🟡 KNOWN DEBT (D1-D6, discuss + finalize)

#### D1 — Admin web unit-price vs PDF rate inconsistency
- **Surfaced in:** `docs/INVOICE-NUMBERS-AUDIT.md`, deferred from P0-1
- **Concrete problem:** Admin web / finance-mobile / admin-mobile invoice DETAIL screens show `item.unitPrice` = raw schema field = **pre-discount GST-INCLUSIVE**. But the PDF's "Rate" column shows **post-discount GST-EXCLUSIVE** with a separate `Discount: ₹X/unit` sub-line. A customer comparing the two sees different numbers for the same line item.
- **Not customer-facing on Android** — the customer-portal Android invoice view (P0-1) uses `totalPrice / quantity` which sidesteps this. Only the admin/finance surfaces vs PDF are inconsistent.
- **Fix options:**
  - (a) Align PDF to in-app convention: display inclusive rate, no separate discount row. Fewer columns on PDF; matches app.
  - (b) Add both columns to in-app view: Rate + Discount + Line Total. PDF-app parity but wider in-app table.
- **Recommendation:** (a) — simpler PDF, admin surfaces already comfortable, no operator confusion. Only downside: harder to see the "what discount did I give?" data on the PDF, but the item.discountPerUnit is still stored in DB for reports.
- **Files:** `packages/api/src/services/pdf/invoicePdfService.ts` (drop discount sub-line, use inclusive rate) — apply to admin-web + finance-mobile + admin-mobile screens (they already read `item.unitPrice` correctly per anti-pattern #16; PDF just needs to match).
- **Effort:** 4 hr including test suite update
- **Guard test:** add wire-shape assertion + PDF snapshot comparison

#### D2 — Dedicated reconcile-flow integration test
- **Deferred from:** P2-1 commit `cd6ce49` (WI-100 Gap A — vehicle reconciliation confirm)
- **What's missing:** direct integration test for `confirmVehicleReconciliation()` asserting: (a) DVA state transition (`status → dispatch_ready`, `isReconciled → true`, `reconciledAt` set), (b) SSE emit shape `{type: 'trip_updated', payload: {dvaId}}` targeting the correct driver, (c) cross-tenant negative — reconciliation on dist-001 does NOT emit to a dist-002 driver.
- **Current coverage:** SSE payload shape is indirectly tested by `gst/tripAutoAdvance.test.ts` test #3 — any breaking change surfaces there first. So this is robustness, not a coverage gap.
- **Reference:** mirror `notifyDriver` mock pattern from `gst/tripAutoAdvance.test.ts`
- **Estimated:** ~100 lines including returned-vehicle + non-cancelled-DVA + order setup fixture
- **Effort:** 2 hr
- **Priority:** low — nice-to-have robustness

#### D3 — B2C reissue docNo bump
- **Context:** GST reissue flow (`gstReissueService.ts`) — for B2C invoices being re-issued (fix wrong GSTIN / item change), the invoice number sequence needs to bump. Currently a subtle bug where docNo isn't incremented on B2C reissue path (B2B works via `allocateNumber('R', ...)`).
- **Files:** `packages/api/src/services/gst/gstReissueService.ts`
- **Test:** add case for B2C reissue that asserts `invoiceNumber` differs from original and follows FY sequence
- **Effort:** 1-2 hr
- **Priority:** low unless a customer hits it

#### D4 — Float-to-Decimal service migration (WI-006)
- **Context:** Some legacy services still use JS `number` for money instead of Prisma `Decimal`. Introduces IEEE-754 floating-point rounding errors on tax-inclusive math (fractional paise). Anti-pattern #16 sibling.
- **Scope:** audit every `.reduce((s, r) => s + r.amount, 0)` and `.amount * qty` in services; convert to Decimal.js arithmetic where the result feeds back into DB.
- **Files:** several — needs a discovery pass first
- **Effort:** 1 day
- **Priority:** medium — no known live incident, but a ticking correctness bomb for tax-heavy tenants

#### D5 — Customer ledger view (WI-075)
- **Context:** existing "Customer Statement" PDF exists (per-customer, date range). WI-075 asks for a live in-app **screen view** of the same ledger — no PDF, real-time table with sort/filter, quick-drill from each row to source invoice/payment/deposit.
- **Files:** new `packages/web/src/pages/CustomerLedgerPage.tsx` or extend `CustomersPage → Ledger tab` (which today shows a summary; drilldown missing).
- **Related:** the mobile app's admin Deposits screen already surfaces per-event data; extend the pattern to customer-scoped ledger.
- **Effort:** 4-6 hr
- **Priority:** medium — nice for on-call ops but PDF covers today

#### D6 — `CustomerInventoryBalance.pendingReturns` cleanup pass
- **Context:** Column exists in DB + schema.prisma + shared TS + zod + service writes + route response + web/mobile payload, but is HIDDEN from all UI as of 2026-06-11 (removed from Cylinder Balances tab column + input, hidden from mobile inventory cell).
- **Not currently consumed by any business logic** — safe to drop.
- **Full drop sequence (per CLAUDE.md open-items):**
  1. Migration to drop `pending_returns` column
  2. Remove field from Prisma schema
  3. Remove from shared zod schema + TS type
  4. Delete 4 service-write sites in `customerService.ts`
  5. Delete field from route response
  6. Remove from seed data
  7. Delete K7 validate-findings probe
  8. Remove 9 assertion sites across `customer-balance-get-b.test.ts` + `empty-balances-g4.test.ts`
- **Effort:** 2 hr — mechanical
- **Priority:** low — dead code, no user impact, cleanup

---

### 🟢 v1.1 SPRINT ITEMS (post-iOS confirmed live)

Since iOS App Store went live, the whole v1.1 sprint 1 unlocks:

#### N1 — Push notifications (real APNs + FCM via expo-notifications)
- **Status:** stubbed today; SSE covers driver foreground only
- **Requires APK + IPA rebuild** (native plugin `expo-notifications` back in `app.json`)
- **Two-step:** (1) re-add plugin to `app.json` under `plugins[]`; (2) implement server-side push via `expo-server-sdk` for the actual send routes.
- **Server:** add push-token registration endpoint + push-send helper for existing SSE-emit call sites (mark-delivered, new-order-assigned, deposit-refund-approved).
- **Effort:** 2 days
- **Suneel labeled "IMPORTANT"**

#### N2 — Universal Links (iOS) + App Links (Android) — before Aug 31
Suneel added: "some android deep links to be done before aug 31"

**Combined scope:**
- **iOS Universal Links:**
  - `expo.ios.associatedDomains` in `app.json`
  - AASA file deployed at `https://mygaslink.com/.well-known/apple-app-site-association`
  - Validate via Apple CDN
  - Requires Apple Team ID (now available since iOS is live)
- **Android App Links:**
  - `expo.android.intentFilters` with `autoVerify: true` (already declared for `mygaslink.com` — but this is where the DUPLICATION bug lives; B3 must land first)
  - Digital Asset Links file at `https://mygaslink.com/.well-known/assetlinks.json` with SHA-256 fingerprint of the release signing cert
  - Verify with `adb shell pm verify-app-links --re-verify com.mygaslink.app`
- **Server work:** ensure any HTTPS deep link the app might receive is either a hard-registered path in the AASA/assetlinks OR falls back to a web page. Suggested paths: `/invoice/:id`, `/order/:id`, `/customer/:id/statement`.
- **Requires APK + IPA rebuild** for the app.json changes
- **Effort:** 1 day (0.5 iOS + 0.5 Android), + web-side .well-known files
- **DEADLINE: 2026-08-31**

#### N4 — SSL cert pinning in mobile
- **Status:** for DPDP compliance
- **Requires APK + IPA rebuild** (adds native pin config to `NSExceptionDomains` and Android network-security-config XML)
- **Approach:** use `react-native-ssl-pinning` OR the built-in `expo-secure-store` + custom axios interceptor with cert-fingerprint check
- **Files:** mobile axios instance, `app.json` (ios.infoPlist + android.plugin config)
- **Effort:** 1 day
- **Priority:** required for DPDP audit — Apple doesn't require but Indian regulators may

#### Super Admin billing — CONFIRM STATUS
Suneel said "super admin billing done i guess". Per CLAUDE.md the 5 ship-blockers were parked with July-1 deadline for first-real-billing event. **Action for next thread:**
- Read `docs/SUPERADMIN-BILLING-AUDIT.md` and verify all 5 items landed
- If any pending: prioritize (billing IS live per commit `e4162fc` on Aug 2 which fixed IMGL number stability — that suggests billing shipped; verify)

#### Other v1.1 items (verify with Suneel, may or may not be in this release)
- N6 — `expo-system-ui` install (APK rebuild) — 15 min, cosmetic
- N7 — `RECORD_AUDIO` manifest tombstone (APK rebuild) — 0.5 day, low priority
- N8 — Sentry source-map upload activation (APK + IPA rebuild) — 1 hr, 4-step procedure
- N9 — Real production monitor (CI/infra) — 1-2 days
- N10 — Account deletion UI v2 — reactive to Apple flags (iOS is live so may be unblocked or unnecessary)
- N11 — WhiteBooks production activation — 2 hr, business ops
- N12 — GSTR-1 JSON export for NIC portal upload — 1 day (beyond current xlsx GST Filing Export)
- N13 — Distributor NIC portal registration push — business ops
- N14 — WhatsApp outreach to new distributors — sales
- N15 — FLAG_SECURE removal (APK rebuild) — 5 min, cleanup

---

## Items I MAY be missing (Suneel to sanity-check)

Grep'd `TODO/FIXME/deferred` in the codebase; distilled non-noise items:

1. **Overdue-invoices status refresh cron** — CLAUDE.md marked "TODO_FILE: wire a daily cron to call this so the status badge stays fresh." Currently invoice.status = 'overdue' is calculated ad-hoc. Should be a scheduled sweep.
2. **Deferred /customers fetch** — mobile Deposits + Record modals defer customer fetch until modal opens. Confirmed working; performance win captured; documenting so it's not accidentally undone.
3. **Sentry SDK activated but Expo plugin NOT** — CLAUDE.md documents the 4-step activation procedure. Crashes captured at runtime already; source-map upload is the delta (N8 above).
4. **Delivery-proof camera removed** in commit `6abbb23` (2026-06-19) alongside payment attachment upload gutting. Not on any pending list because it was a scope cut, not deferred. Mention only if Suneel raises.

---

## Deferred but worth naming (post-v1.1)

- **iPad layouts** (N5) — only if a customer asks
- **Report Builder (true drag-and-drop)** — after F2 grouped taxonomy proves user needs
- **Vehicle Ledger — driver-side reconciliation view** — the "did the driver actually return N empties or N-1?" trust gap. Currently the gap column shows it; a dedicated flow to challenge/adjust would help disputes.
- **Multi-language content on the customer PDF** — currently English-only (i18n branch exists at `claude/sharp-grothendieck` per CLAUDE.md but not merged)
- **Customer HQ role hardening** — the customer_hq role for chain/group customers exists; needs more UAT
- **Anti-pattern audit sweep** — items #21, #22 (banned-pattern grep guards for dates) are active; run a fresh sweep periodically as new files land

---

## Sequencing recommendation (next thread's suggested order)

**Session 1 (~3-4 hr):**
1. B3 — app.json intentFilter dedupe plugin (30 min)
2. B4 — CI to `migrate deploy` (5 min)
3. B5 — coordinate with Suneel on EC2 upsize (5 min prep, Suneel does the console click)
4. F4 — Vehicle Ledger outstanding-empties column + sticky UX (3 hr)

**Session 2 (~1 day):**
5. F1 — Defective full-cylinder tracking (backend + mobile field)
6. F3 — Vehicle Ledger corporation-trip exclusion (30 min, folds into F1 commit)

**Session 3 (~1 day):**
7. F2 — Reports revamp Phase 1 (grouping + Day Book + P&L + Cash Flow)

**Session 4 (~0.5 day):**
8. F6 — Mobile Deposits customer filter
9. F5 — Group ledger overall changes (once Suneel clarifies scope)

**Session 5 (~1 day):**
10. N2 — Universal Links + Android App Links (before Aug 31 — HARD DEADLINE)
11. F7 — First 2-3 additional reports based on customer feedback

**Session 6 (~2 days):**
12. N1 — Push notifications
13. N4 — SSL cert pinning

**Session 7 (cleanup):**
14. D1 — Rate/PDF consistency
15. D3, D4, D5, D6 — after Suneel finalizes which to include

---

## Open questions for Suneel at session start

1. **Report grouping structure** — does Suneel want:
   - (a) Left-nav category tree (Day Book / Financial / GST / Invoicing / Customer)
   - (b) Top-tab groups on the Reports page
   - (c) Filter dropdown that categorizes existing REPORTS list
2. **Report Builder scope** — parameterized templates (Phase 1) or true builder (later)?
3. **F5 — group ledger scope** — Suneel wrote "overall changes" — what beyond UPI QR is expected?
4. **D3-D6** — which of these do we take now vs park?
5. **SaaS billing** — verify per docs/SUPERADMIN-BILLING-AUDIT.md that all 5 ship-blockers landed with commit `e4162fc`

---

## Not shipping in this release (explicitly parked)

- B1 (Play Store 1.2.0 submission) — Suneel: "will happen with next release, ok"
- B2 (iOS submission) — already live per Suneel
- N5 (iPad) — only on customer request
- iPad-specific screenshots for ASC — depends on N5
- Multi-language (i18n branch merge) — not raised

---

## Working conventions (from CLAUDE.md — reinforce)

- Every session start: `git log --oneline -5`, `git status --short`, read this brief and CLAUDE.md's PRODUCTION STATE
- Every commit: end with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`
- Never `new Date().toISOString().split('T')[0]` or `.slice(0, 10)` — use `localTodayISO()` / `localDateISO(d)` from `@gaslink/shared` (anti-pattern #21)
- Never destructive DB ops without `TEST_DATE='2099-12-31'` fixture pattern (anti-pattern #7)
- All Prisma queries on tenant-scoped models MUST include `where: { distributorId }` (anti-pattern #1)
- Mobile pickers with FlatList + Modal: MUST use `useSafeAreaInsets` + `keyboardShouldPersistTaps="handled"` (anti-pattern #25)
- Every external-API integration MUST have a `-payload-shape.test.ts` that asserts field formats without mocking (anti-pattern #6)
- Never use `pnpm -r run <script>` — pnpm 9 swallows exit codes. Use explicit per-package calls (anti-pattern in CLAUDE.md § accepted security risks)

---

## Files to read at session start (in order)

1. This brief — `docs/NEXT-RELEASE-BRIEF-2026-08-05.md`
2. `CLAUDE.md` — PRODUCTION STATE + Parked items sections
3. `docs/DEPOSIT-LEDGER-HANDOFF.md` — deposit-ledger design (for defective-return context in F1)
4. `docs/INVOICE-NUMBERS-AUDIT.md` — for D1 context
5. `docs/SUPERADMIN-BILLING-AUDIT.md` — for billing verification
6. `docs/IOS-PHASE0-GROUND-TRUTH.md` — iOS state (may be stale now that Store is live)

---

_End of brief. Handoff-ready. Estimated total effort for approved-list only: **6-8 working days** across ~7 sessions._
