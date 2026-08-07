# Re-New GasLink — Next Release Proposal (v3, comprehensive)

**Date:** 2026-08-05 pm
**Basis:** 5 deep-research passes on B3/B4 safety, F1 defective ledger design, F2/F7 reports inventory + Report Builder, Vehicle Ledger Qty redesign (F9 new), F8 Supplier Ledger against Confidence PDF.
**Supersedes:** [docs/NEXT-RELEASE-BRIEF-2026-08-05.md](docs/NEXT-RELEASE-BRIEF-2026-08-05.md) (v1) and [docs/NEXT-RELEASE-BRIEF-2026-08-05-VERIFIED.md](docs/NEXT-RELEASE-BRIEF-2026-08-05-VERIFIED.md) (v2).

**Purpose:** exhaustive design proposal ready to convert into implementation specs. Suneel said "no half-baked or partially cooked solutions" — this is that answer.

---

## Progress log

| Date | Item | Status |
|------|------|--------|
| 2026-08-05 | B3 intentFilter dedup plugin — implemented, unit-tested, `expo config` re-verified | ✅ code done, ⏸ uncommitted |
| 2026-08-05 | B4 CI `migrate deploy` switch — one-word change at ci.yml:120 + 12-line explanatory comment | ✅ code done, ⏸ uncommitted |
| 2026-08-05 | **F3 + F9 + F4 bundle** — Vehicle Ledger rewrite (backend + frontend). Removed Corporation Loads secondary + view selector. New columns: Dispatched / Delivered / Returned / Empties Returned / Outstanding — plain text per Suneel, sticky-left on Date/Vehicle/Driver, totals row. 20 tests added (5 shape + 8 computed math + 3 corp exclusion regression + 4 existing attribution). All 3 typechecks clean. API lint clean (0 new errors). | ✅ code + tests done, ⏸ uncommitted |
| 2026-08-05 | **Depot History Amount column** — new column on Inventory → Depot History table. Data was already on the wire (Prisma `InventoryEvent.amount` Decimal, was ignored by web). Shared TS type updated (`amount: string \| number \| null` — Prisma Decimal wire shape varies by adapter). 3 tests added (positive with amount / positive null / wire-shape). | ✅ code + tests done, ⏸ uncommitted |
| 2026-08-05 | **Full green-gate pass** — API/Web/Mobile typecheck clean; API lint 0 errors (7 pre-existing warnings, none in my files); full API test suite **2105 passing / 2 failing / 2107 total** (2 fails are the pre-existing `users.test.ts` welcome-email baseline; **0 new regressions from this bundle**). Also updated `reports.test.ts` at L41 to reflect F3's intentional removal of `secondary`. | ✅ verified |
| 2026-08-05 | **Sprint B Chunk 1 — F2 grouping restructure** end-to-end. Backend: 4 new shared types (ReportBucket/ReportBucketDef/ReportCatalogEntry/ReportCatalogResponse), 3 new backend exports (REPORT_BUCKETS with 7 buckets, REPORT_CATALOG with 11 v1 entries, getReportCatalog(role) filter), 1 new API route (GET /api/reports/catalog), 9 new tests (positive/negative/regression/wire-shape — all pass). Web: replaced horizontal chip bar with left sidebar (`<ReportsSidebar>`, ~110 LOC), grid-cols layout with sticky sidebar, download-kind entries routed to Tally/GST panels or hint cards. Mobile: SelectField picker rebuilt with bucket-prefixed labels, sorted by bucket order, download-kind entries filtered out (web-only). Backwards-compat: every existing slug still resolves at old URL. | ✅ code + tests done, ⏸ uncommitted |
| 2026-08-05 | **Sprint B Chunk 2 — Day Book × 3 new reports.** Three new inline-kind entries added to `REPORTS` + `REPORT_CATALOG` in Daily Book bucket: (1) `day-close-summary` N20 — end-of-day one-pager with 6 sections (Revenue/Payments/Deliveries/Inventory/Expenses/Customers), 10 parallel queries, `{metric, amount, count}` row shape; (2) `daily-sales` — per-day roll-up of delivered orders + payments received; (3) `daily-driver-movement` — per (day, driver) row with trips/deliveries/fulls/revenue. **22 new tests** (7+6+9) covering positive math, empty-range edge, wire-shape, generic-route regression, CSV export, cross-tenant. Catalog now has 14 entries (13 role-filtered for inventory). | ✅ code + tests done, ⏸ uncommitted |
| 2026-08-05 | **Sprint B Chunk 3 — 6 quick-win reports.** Batch 3a (N24 Deposit Ledger per Customer / N26 Stock Adjustment Audit Log / N32 Expense Register) filled 3 previously-empty buckets (Customers, Inventory, Expenses). Batch 3b (N28 Credit Notes Register / N29 Debit Notes Register / N31 Opening Balance Certificates Register) added 3 more to Invoicing & Payments. **N06 Purchase Register deferred to Sprint D alongside F8 role-gate widening** (mini-op-only today). Both batches: 24 new tests total covering positive/wire-shape/regression/CSV/cross-tenant. **1 bug caught by tests**: Prisma `NOT: { referenceType: 'X' }` excludes NULL rows (SQL trinary logic); fixed with explicit `OR: [{ null }, { not: 'X' }]`. Catalog now has 20 entries (19 role-filtered for inventory). | ✅ code + tests done, ⏸ uncommitted |
| 2026-08-05 | **Sprint B Chunks 5-7 — Accordion + Report Builder Phase 1 + Phase 2.** ACCORDION: single-bucket-open sidebar (previous auto-collapses on new selection). PHASE 1 (localStorage-only, zero server): 4 UX features shipped — (A) save/load filter presets per report, (B) hide-columns toggle per report, (C) sticky date range across reports, (D) recent-reports section at top of sidebar. PHASE 2 (true single-model builder): 2 new Prisma models (`SavedReport` + `SavedReportRun`) with migration, ReportBuilderSpec + zod validator (14 filter ops + 7 aggregations + 9 date presets), field × role allowlist matrix for 6 models × 5 staff roles, safe executor (never string-concats SQL, always injects tenant scope, 50k row cap, 10s timeout, 60s cache, unindexed-filter warning), CRUD routes at `/api/saved-reports` + preview + run endpoints, `<ReportBuilderPage>` web UI (3-section form + live preview) mounted at `/app/report-builder`, "My Custom Reports" section added to Reports sidebar. **27 new tests** — zod validation, allowlist enforcement, executor RAW + GROUPED modes, safety (cross-tenant guard, unindexed warning), SavedReports CRUD lifecycle, sharing model (private vs distributor), end-to-end preview→save→run flow. | ✅ code + tests done, ⏸ uncommitted |
| 2026-08-05 | **Sprint B Chunk 4 — 10 medium reports + 1 placeholder.** Ten new services: N10 Cylinder Rotation (Customers), N12 Route/Driver Performance (Daily Book), N13 Driver & Vehicle Cost Breakdown (Expenses — expanded per Suneel from fuel-only to fuel/maint/toll/insurance/other + ₹/delivery + cost % rev), N14 Empties-in-Transit (Inventory), N17 Payment Method Mix (Invoicing & Payments), N19 Rate Variance/Discount Leakage (Invoicing & Payments), N21 Cash Book (Month-End), N22 Cashflow Statement (Month-End), N33 Expenses-by-Category Trend (Expenses), N34 Accountability Log Report (Customers). Plus N27 Delivery Challan PDF as `comingSoon:true` catalog placeholder. **Skipped per Suneel:** N25 Customer Activity (Customer Statement covers 80%), N30 Quotations Register (parked). **33 new tests** in one `reports-chunk4.test.ts` file (positive/wire-shape/regression/CSV per report). Catalog now has 31 entries (30 role-filtered for inventory). | ✅ code + tests done, ⏸ uncommitted |
| 2026-08-05 pm | **Sharma demo seed + smoke check.** 12 months of dummy data across all tables for `dist-002` — 40 new Hyderabad-flavored B2B customers, 12 Telugu-name drivers, 4 TS09EG vehicles, 8 expense categories, 1783 orders, 2251 invoices, 1151 payments, 4574 inventory events, 718 expenses, 35 deposits. Idempotent via `SEED_DEMO_2026-08-05_SHARMA` marker on `Order.specialInstructions`. Charts added to `cashflowStatement` (grouped bar), `paymentMethodMix` (stacked bar), `expensesByCategoryTrend` (line). Smoke check ran all 27 inline reports successfully. | ✅ done, ⏸ uncommitted |
| 2026-08-06 am | **Bundle F (FX-A → FX-J) — Reports UX cleanup.** Post-testing feedback from Suneel — 10 fixes in one bundle: FX-A null money → em-dash (was rendering as ₹0 on count-only rows); FX-B report description subtitle from catalog above filter row; FX-C Opening Balance Certs ignore date filter (historical set, was hidden by month-ago..today default); FX-D seed extensions — 15 stock adjustments + 15 CustomerCylinderDiscount configs; FX-E Daily Sales enriched with Cyl Mix + Empties Collected + Expenses columns; FX-F Cylinder Rotation added `avgCycleDays` + `deviationDays`; FX-G Cylinder Rotation moved from Customers → Inventory bucket (single entry, no mirror); FX-H sortable column headers universally on ReportTable (client-side, click-to-sort asc/desc/clear); FX-I chart polish — proper x/y axis labels, compact INR ticks (₹1.5L / ₹1.2Cr), rotated date labels, gridlines, legend; FX-J full green gates (2216/2216 tests, 0 typecheck errors, web lint at baseline 0 errors + 7 warnings). Also removed Recent Reports section (duplicated entries) + made sidebar independently scrollable + bucket typography uppercase for hierarchy + hid top Analytics date picker on Reports tab + removed Driver Statement (PDF) dead-end catalog entry. Fixed Report Builder `/api/saved-reports/preview` 500 (empty-string enum values → 400 with clear message). Fixed pre-existing users.test.ts baseline flakes (inventorySeats bump + Welcome describe pre-clean). | ✅ code + tests done, ⏸ uncommitted |
| 2026-08-06 eve | **F1 UX iteration cycle — 18 fixes on top of the initial 7-slice build**, all driven by live testing feedback from Suneel. Final shape (converged with operator's mental model): (a) **Modal-only entry** — sidebar entry deleted, Defective Return is a button on Inventory > Daily Summary alongside Empties Return / Adjust Stock (Adjust-Stock-modal pattern). (b) **Tabbed modal** — 2 tabs: New Return + History. Send-to-Corp tab dropped (was over-engineering — see next bullet). (c) **One-shot capture+CN** — clicking Record fires capture + auto-raises CN in a single client-side chain. No more "check ledger then raise CN" two-step dance. History page still has manual Raise CN button for the rare partial-failure case. (d) **Ledger renderers wired** — `defective_collected` LedgerEntryType now shows on customer statement PDF (individual + group), web ledger table, mobile customer detail, Customer Statement XLSX. Del Full column shows `-N` deduction on defective rows, running total unchanged (CN row that follows handles money side). Total row Del Full subtotal correctly nets defective. Post-CN narration is short: "Defective: 1× 19 KG · CN CSHD…". (e) **Outgoing Empties modal — include-defectives section** — per-cyl-type checkbox surfacing depot's ready-to-ship defective bucket. On submit: empties record + defective batch fire in sequence, one toast if both succeed. Corporation name inherits from challan-type field. Send-to-Corp dedicated flow deleted — it lives here now inline. (f) **Daily Summary — 3 defective columns** — CORPORATION > Defective Out (`defectiveFullsOut`), AT CUSTOMER > Defective In (`defectiveFullsIn`), CLOSING > Defective (`closingDefectiveFulls`). Same shape as Fulls/Empties. (g) **Depot History — Defective correlation column** — for each outgoing_empties row, sums matching DefectiveReturnBatch.items where challan number matches event's documentNumber. Blank on incoming, blank on outgoing without piggyback, `+N` (amber) when defective was shipped in same challan. Depot History event-type list stays incoming_fulls + outgoing_empties (defective is a subcategory annotation, not its own row) — Suneel's explicit call to keep it clean. (h) **Empties Return modal also tabbed** — matches Defective/Adjust-Stock pattern, gets its own History tab (backend added `/api/inventory/empties-return-history` endpoint). Fix list: F1-FIX-1 through F1-FIX-18 spanning ledger renderers, sidebar/menu placement, atomic-CN chain, narration truncation, Del Full deduction display + subtotal, tab-modal redesigns, and the Send-to-Corp merger into Outgoing Empties. All 36 F1 backend tests continue to pass throughout the iteration cycle. Zero backend contract changes across the 18 fixes — pure UX/UI convergence. | ✅ code + tests done, ⏸ uncommitted |
| 2026-08-06 pm | **F1 Defective Cylinder Returns — DONE end-to-end.** Full 7-slice implementation: (1) Schema + migration — `DefectiveCylinderLedger` + `DefectiveReturnBatch` tables + 3 new `InventorySummary` columns (defectiveFullsIn/Out/closingDefectiveFulls) + 5-value `DefectiveReturnStatus` enum + 2 new `InventoryEventType` values + 1 new `LedgerEntryType` value + 'F' prefix on `numberingService`. WI-106 zone (closingFulls) UNTOUCHED byte-for-byte. Migration applied additively to dev DB. (2) `defectiveReturnService.ts` — 9 exports: `listDefectiveEligibleInvoices` (90d picker w/ per-line remaining qty subtracted for prior claims), `captureDefectiveReturn` (physical + ledger stub, no CN yet), `raiseDefectiveCn` (cumulative-CN pre-check + `createCreditNote → approveCreditNote` mirror of `orderService.resolveDispute` pattern), `listDefectiveHistory`, `getPendingCnCount`, `getDefectiveDepotBucket`, `cancelDefectiveReturn` (reverses customer balance + event, restores inventory), `createDefectiveReturnBatch` ('F' number allocated in-tx, fires `defective_return_to_corporation` event, cascades summary), `markBatchCorpCreditReceived`. (3) 9-route surface at `/api/defective-returns/*` with dual role gate — staff-tier for capture, CN-approve-tier for raise-CN/cancel/corp-credit. (4) Web `DefectiveReturnsPage.tsx` — 3 tabs (New Entry wizard, History, Send to Corporation) + sidebar menu item with amber pending-CN badge. (5) Outgoing Empties modal — new nudge banner surfaces depot's defective bucket count with a deep-link to the DR page (Suneel's "when I do outgoing empties, remind me" spec). (6) **36 new integration tests** covering capture positive/negative/multi-cyl/cross-tenant, raise-CN positive/paid-invoice/cross-invoice/cumulative-guard, history + pending count + depot bucket + role visibility (inventory can capture but not CN, finance can, driver 403), inventory aggregation regression (closingFulls unchanged), anti-pattern #24 guards (credit gate + empties reader), outgoing batch positive + wrong-status guard + corp-credit-received + sourceDistributorId FK, cancel positive + status guard, invoice picker filtering, and end-to-end happy path scenario (capture → check ledger → raise CN → check ledger → batch → corp credit received). (7) **Full green gates: typecheck clean on all 4 packages, lint clean (was 1 error, fixed), 2275/2275 tests pass (was 2239, +36 F1, ZERO regressions), live E2E browser smoke verified — captured 1×47.5KG defective on Sharma test invoice → CN CSHD2627000471 fired → depot bucket showed 1×47.5KG → batch FSHD2627000001 sent to IOCL with 'F' prefix (proving numberingService integration).** N18 followup — corporation identity: added optional `sourceDistributorId` FK on DefectiveReturnBatch pointing to SourceDistributor (was mini-op-only, now open to regular distributors too) so F8 corp-purchases lands cleanly without a follow-up migration. Unblocks N01-N04 defective reports for the next chunk. | ✅ code + tests + browser verified, ⏸ uncommitted |
| 2026-08-06 pm | **N18 Customer Profitability landed.** Per-customer credit-cost-adjusted revenue model: Revenue / Orders / Avg Outstanding (from ledger opening+closing) / DSO / Empties Value (withCustomerQty × latest EmptyCylinderPrice) / AR Cost / Empty Deposit Cost / Adjusted Revenue / Margin %. Interest rate is editable per-run (0-50%, default 12%) — no schema field, no distributor setting, per Suneel's "rate differs from time to time" ask. Sorts worst-margin customers to the top so the eye lands on who's eating credit cost. All-staff role gate in Customers bucket. Live at `/api/reports/customer-profitability` + CSV. Web input field on ReportsPage. **11 new tests** — high-outstanding AR-cost math @ 12%, rate scaling linear (24% = 2×12%), empties-holding empty-cost signal, worst-adjusted sorts first, zero-revenue customer excluded, rate=0 zeros both costs, rate=999 clamps to 50, 10-column wire shape, HTTP reachable, CSV headers, inventory role can see it (unlike GST reports). Catalog now 32 entries (29 for inventory). COGS deferred to backlog per Suneel — will re-approach post-F8 with purchase-order landed-cost basis. | ✅ code + tests done, ⏸ uncommitted |
| 2026-08-06 pm | **Sprint B Chunk-11 — Driver Reports merge + backdated audit + auto-adjustment.** Two related deliverables: (1) **Driver Daily Log** — merged the previous DailyDriverMovement + RouteDriverPerformance into ONE report per (date × driver) with per-trip child rows (chevron expand pattern like Delivery Performance). Columns: Date · Driver · Trip · #Trips · Deliveries · Cancelled · Fulls · Empties · Revenue · On-Time% · Cancel%. Delivery Performance kept untouched per Suneel. Delta: -2 old catalog entries, +1 new. (2) **Backdated-order audit + Gap 1/2 fixes** — 12 order-write-path gaps found (see DDL-1 audit report). Fixed the critical two: Gap 2 (backdated adjustments were writing `manual_adjustment` events silently invisible to Vehicle Ledger / Inventory Movement / Cylinder Rotation) — rewrote `applyBackdatedInventoryAdjustment` to emit the SAME 4 events real deliveries write: `dispatch` + `delivery` + `collection` + `reconciliation_empties_return`, tagged with driver/vehicle for attribution, plus `CustomerInventoryBalance` upsert. Auto-runs at `createBackdatedOrder` + `createBackdatedTrip` post-commit — operator can't forget. Gap 1 fix — `tripNumber` field added to backdated schemas (default 1, operator increments same-day). Anti-pattern #26 documented in CLAUDE.md. Backfill script for existing broken backdated orders. 30 demo backdated orders seeded via real service to prove end-to-end. Gap 3 (schema-level driverId requirement) parked per user. Gap 6 (reconcile force-cancel bypass) parked per user. Gaps 5/7/9/10/11/12 parked with rationale in this session's transcript. **KPI verification script cross-checked raw DB vs report output — 100% PASS across Delivery Performance, Driver Daily Log, Vehicle Ledger, Inventory Movement, Day-Close Summary, Cylinder Rotation.** All 26 remaining inline reports render. 2216/2216 tests pass. | ✅ code + tests done, ⏸ uncommitted |
| 2026-08-07 | **F8v2 Corporation Ledger + F8v2-R (5 Corporation reports).** F8v2 Corporation Ledger page went from skeleton to shipped: multi-line Incoming Fulls modal (shared between Corp Ledger + Inventory pages), Deposit + Debit Note modals, Physical Activity + Landed Cost + Deposit panels, sidebar rename Corporations→Corporations with single-OMC direct-link, mini-op-parity page removed for regular tenants. F8v2-FIX-A unified Incoming Fulls + Outgoing Empties modals; F8v2-FIX-B seeded Sharma / HPCL Corporation data to parity with Bhargava. Then F8v2-R shipped 5 new Corporation-bucket reports: (1) `corp-landed-cost-trend` — per-month × per-cyl-type landed cost with bar chart; (2) `corp-statement-register` — running-balance statement per OMC; (3) `corp-purchase-vs-sale-margin` — margin math joining landed cost with realized sale rate; (4) `corp-supplier-payment-aging` — 0-30/31-60/61-90/90+ day buckets; (5) `corp-landed-cost-reconciliation` — OMC headline rate vs computed landed cost variance. Corporation Ledger UI polish: KIND_LABELS now say Incoming/Outgoing (not internal ERV enum names); Doc No + Qty populated on every row; purchase narration includes cyl-type + qty; all internal FSHD/PSHD references eliminated from ledger renders (only OMC-side challan/invoice numbers surface — Suneel's "why are we assigning something new" fix). Also fixed real anti-pattern #21 bug in paymentService.entryDateFrom (UTC vs local-TZ), landedCostService TZ-guard violation, and CorpEntryModals lint error. Full gates green: 2293/2293 tests, 0 typecheck errors, 0 lint errors. | ✅ code + tests + verified, ⏸ uncommitted |
| 2026-08-07 | **N4 SSL certificate pinning — DONE + fully verified (positive AND negative).** ISRG-root SPKI pinning via OS-native config plugin (no native module ⇒ no extra store-review surface). Verified end-to-end on the `gaslink-test` emulator with the EAS preview build `cc68154e`: (a) pins decoded out of the SHIPPED APK via `aapt2`; (b) real sign-in against prod API returned a genuine **401 "Invalid email or password"** — proving handshake + pin check + request + response all succeed; (c) **negative path** — a self-signed impostor server (openssl + Node + emulator `iptables` REDIRECT, no third-party tooling) was refused with `tls alert certificate unknown` (SSL alert 46), **5/5 attempts, 0 requests ever reaching the impostor**. Evidence tables in [RUNBOOK-CERT-ROTATION.md §1b](RUNBOOK-CERT-ROTATION.md). Residual: blocked-screen UI render unconfirmed (logic has 6 unit tests; emulator UI automation too flaky) + UptimeRobot monitor. CI tripwire test fails 90 days before pin expiry so the annual bump can't be forgotten. | ✅ code + tests + emulator-verified, ⏸ uncommitted |
| 2026-08-07 | **Codebase-sweep findings triaged — 2 real, 1 false alarm.** (1) **Anti-pattern #21 two-line form** — `const d = new Date();` then `d.toISOString().split('T')[0]` on a later line, invisible to the line-oriented CI guard whose own header had documented this blind spot as "left to code review". A proper detector found **3** sites (reported: 1): `customerService.ts` (cosmetic — note string only), `driversVehicles.test.ts`, and `payment-commitment.test.ts` (**latent midnight-window test failure** — "tomorrow" resolves to today in the IST window and the customer-portal API rejects same-day delivery). All 3 fixed via `localTodayISO()` / `localDateISO()`; new Node-based guard [check-tz-twoline.mjs](../packages/api/scripts/check-tz-twoline.mjs) wired into `pnpm lint`, proven to catch the live bug BEFORE the fix and clean after. (2) **Public contact form had no dedicated rate limiter** — inherited only the global 1000/15min, a usable inbox-flood vector; now 5/15min in prod, placed ahead of `validate()`. (3) **REJECTED:** `/api/admin/login-history` "missing authenticate" — the router's single route declares `authenticate` + `requireRole('super_admin')` inline; the mount point doesn't need it. A structural test now asserts every route in that router carries `authenticate`, so the non-bug can't become a real one. 6 new guard tests. Full suite **2299/2299**, typecheck 0, lint clean. | ✅ code + tests done, ⏸ uncommitted |
| — | Everything else below | ⏸ not started |

---

## 🎯 CONSOLIDATED PENDING ITEMS — SINGLE SOURCE OF TRUTH (2026-08-07)

**Refer to this table first.** Everything below (Sprint C/D/E/F breakdowns, N-report matrix, open questions) is the source data — this section is the executive summary. When a sprint or item lands, update the row here + strike the underlying detail line.

### Master pending items — grouped by track

#### 🅰️ Sprint B residual — Report Builder Phase 3 (0% done)

| Item | Functional description | Est. | Open questions on you |
|---|---|---|---|
| Phase 3a — Pivots + Charts in Builder | Add `pivot: { field, cardinalityCap: 20 }` to the SavedReport spec; matrix output `{rowKeys[], colKeys[], cells}`. Chart renderer (bar/line) for one measure × one grouping. PNG export via canvas, embed in PDF. Lets users build ad-hoc cross-tabs like "Deliveries by Driver × Day" without writing SQL. | 4-5 d | Should charts be inline in the Builder preview, or download-only? |
| Phase 3b — Cross-model joins + role-scoped sharing | Whitelisted joins across the Order + Customer + Driver + Invoice quartet (currently the Builder is single-model only). Add `sharedWithRoles: string[]` on `SavedReport` + per-role sharing UI. Enables things like "customer statement joined with driver attribution" as one saved report. | 5-7 d | Which cross-model joins are actually needed vs theoretical? (Suggestion: start with Order+Customer, add others when asked.) |
| Phase 3c — Scheduling + delivery | New `SavedReportSchedule` model (cron, deliverBy, recipients, format). `reportSchedulerJob.ts` runs the cron, generates report, emails/webhooks it. Uses existing SMTP + webhook infra. Distributors get "email me the day-close every night at 10pm" without opening the app. | 4-5 d | Q12 unresolved: v1 requirement or defer? Original ask was "clients can do whatever reports they want" — could be interpreted either way. |
| PDF export from Builder | Builder currently CSV-only. Wire the PDF pipeline (already used by canonical reports) to Builder output. | 2 d | None. |
| Mobile Report Builder | Currently web-only. Mobile parity means rebuilding the 3-panel builder UI in RN. | 3-5 d | Is this even needed for v1.0? Distributor admins mostly build on web then run on mobile. |

#### 🅱️ Sprint B residual — Supplier/Corporation reports

| Item | Functional description | Est. | Open questions on you |
|---|---|---|---|
| N05 — Supplier Statement PDF (Confidence format) | Portrait A4 PDF matching the Confidence-brand supplier statement layout (7 columns). One page per corporation. Fully separate from the on-screen Corporation Ledger which is HTML-only today. | 2 d | Do you want it identical to the Confidence PDF, or use your ledger's field set? The two differ in ~3 columns. |
| N06 — Purchase Register CSV+PDF | Flat register of every incoming-fulls purchase entry across all corporations for the date range. Companion to the per-corporation ledger. | 1 d | None — spec is clean. |
| N07 — Credit-Notes-Received Log | Chronological register of purchase credit notes received from OMCs (the F8v2 `PurchaseCreditNote` rows), with cumulative amount + linked invoice references. | 1 d | None — spec is clean. |
| N08 — Corporation-wise Purchase Split | Grouped-bar view of purchase spend by corporation × month. Effectively already surfaced by the new `corp-landed-cost-trend`, but N08 is the "which OMC costs us most" flat view. | 0.5 d | Confirm not redundant with `corp-landed-cost-trend` (which is per-cyl-type). |
| N09 — Landed-Cost per Cylinder | ✅ **Functionally shipped as `corp-landed-cost-trend` on 2026-08-07.** Close as done. | — | — |

#### 🅲 Sprint B residual — Parked N-reports (waiting on you)

| Item | Functional description | Blocker | Open questions on you |
|---|---|---|---|
| N01 — Defective Returns by outgoing load | Show every outgoing empties batch with its defective piggyback count + cumulative CN raised. Answers: "for load L, what did we send back?" | Parked by you 2026-08-06 post-F1 ship. F1 schema in place; queries straightforward when unparked. | Do you want it now that F1 has settled? |
| N02 — Defective Returns by customer | Per-customer defective claim history + running CN total + settlement mode used. Answers: "which customers report the most defectives?" | Same. | Same. |
| N03 — Defective Returns by corporation | Per-corporation return volumes + credit-received status. Answers: "how much are we shipping back to IOCL vs HPCL, and how much have they credited?" | Same. | Same. |
| N04 — Defective compensation aging | Aging bucket of pending customer CNs (raised but not consumed) + pending corp credits (batch sent but no credit received). | Same. | Same. |
| **N27 — Delivery Challan PDF** | **PDF for the physical challan the driver hands to the customer.** Contains driver + vehicle + destinations + cyl qty per type + signature block + T&C footer. Statutory + operational document. | **Parked by you 2026-08-06 — waiting on shape decision.** | (a) Single-order per PDF, or one PDF per trip listing all deliveries on that dispatch? (b) PDF download-only, or also viewable in-app before print? (c) Statutory numbering — new challan number series, or reuse invoice/order number? |
| N11 — Cylinder-Age Report | Per-physical-cylinder age since first fill. Requires per-cyl serial capture. | Needs `PhysicalCylinder` schema + serial capture (3-5 d schema work before reports). | Is per-cyl serial tracking on the roadmap at all? If no, close N11 as won't-do. |
| N23 — P&L Preview | Revenue − COGS − Expenses = Profit, monthly view. | Needs accounting-source decision (cash-basis vs accrual). | Cash-basis (money in - money out) or accrual (invoice date - expense date)? Cash is simpler; accrual is what an accountant would want. |
| N30 — Quotations Register + Win/Loss | List of quotations sent + status (accepted/rejected/expired) + conversion rate. | Parked per Suneel. | Do you use quotations as a distinct step, or is every order already a "won" one? |
| N25 — Customer Activity Report | Chronological log per customer of every event (order placed, invoice raised, payment, statement download). | ⏹ Skipped per Suneel — Customer Statement covers 80%. | Confirm as SKIPPED (remove from pending list)? |

#### 🅳 Sprint C — Deferred UX + Consistency

| Item | Functional description | Est. | Open questions on you |
|---|---|---|---|
| F6 — Mobile Deposits customer filter | On the (finance)/deposits mobile screen, add a "filter by customer" input. Currently shows all deposits distributor-wide. Small, self-contained, no schema. | 1.5-2 hr + 30-45 min tests | None. |
| D1 — PDF unit-price alignment | Anti-pattern #16 refinement: admin web + finance mobile + admin mobile show `unitPrice` (pre-discount GST-inclusive) while PDF shows post-discount GST-exclusive with separate `Discount: ₹X/unit` sub-line. Pick route (a) align PDF to in-app, or (b) add both columns to in-app. Apply to all 3 surfaces in one commit. | 4 hr | Pick approach (a) or (b). |
| Billing #4 — dead button cleanup | Super-admin billing has a button wired to a stub that returns 501. Remove or wire. | 5 min | None. |
| Update SUPERADMIN-BILLING-AUDIT.md resolved header | Doc-only. | 10 min | None. |

#### 🅴 Sprint D — Full F1 + F8 (mostly landed)

| Item | Functional description | Status |
|---|---|---|
| F1 Defective Ledger | ✅ 7 slices + 18 UX iterations shipped 2026-08-06. |
| F8 Supplier Ledger v1 | ✅ Shipped. |
| F8v2 Corporation Ledger | ✅ Shipped 2026-08-07. |
| F8v2-R (5 Corp reports) | ✅ Shipped 2026-08-07. |

#### 🅵 Sprint E — v1.1 mobile push track (post-iOS-live)

| Item | Functional description | Est. | Open questions on you |
|---|---|---|---|
| N1 — Push notifications | Wire real APNs + FCM via `expo-notifications`. Currently a no-op stub; SSE only covers driver foreground. 5-step Sentry activation runs in parallel. Called out as super-critical in CLAUDE.md. | 2 d | Confirm we're waiting until iOS ships? (Package + code stubs retained for v1.1 rebuild.) |
| N2 iOS — Universal Links | **Android half DONE (verified 2026-08-07 via Play Console + Google Digital Asset Links API — both fingerprints crawlable, both domains show "No issues found", "All links working" green banner).** iOS half remains: declare `expo.ios.associatedDomains` in app.json; deploy AASA file at `https://mygaslink.com/.well-known/apple-app-site-association`; validate via Apple CDN. Requires Apple Team ID (post-enrollment). | 0.5 d | **HARD DEADLINE 2026-08-31 for iOS half.** Blocks on Apple Developer Program enrollment (Team ID). |
| N4 — SSL cert pinning | ✅ **IMPLEMENTED 2026-08-07** (⏸ uncommitted). ISRG-root SPKI pinning via OS-native config plugin (no new native module), advisory kill-switch on CloudFront, blocking-screen UX, 15 Jest guards, prebuild-verified. See §SSL-CERT-PINNING AS-BUILT + [RUNBOOK-CERT-ROTATION.md](RUNBOOK-CERT-ROTATION.md). | done | **Suneel residuals:** EAS preview cloud build → real-device positive + mitmproxy negative test → UptimeRobot monitor → Aug 1 annual calendar reminder (runbook §2f). Ships with next store release (config change → normal review, no new entitlement). |
| N6-N15 | Assorted per v2 brief. | Varies | Case-by-case. |

#### 🅶 Sprint F — Deferred debt (park/pick per your call)

| Item | Functional description | Est. | Open questions on you |
|---|---|---|---|
| D2 — dedicated reconcile-flow integration test | Assert the DVA transition + SSE emit shape + cross-tenant negative for `confirmVehicleReconciliation`. Currently indirectly guarded by `gst/tripAutoAdvance.test.ts`. Robustness improvement, not a coverage gap. | ~100 LOC | None. |
| D3 — B2C reissue docNo bump | On B2C reissue, bump the docNo suffix (`INV-…/R2`) instead of reusing. Prevents NIC from rejecting the second issue for the same invoice number. | ~1 d | None — clear spec. |
| D4 — Float-to-Decimal service migration (WI-006) | Systematic sweep of money-column reads/writes from `Number(...)` to `Decimal`. Prevents FP drift on cumulative math (₹0.01 errors compound over 10k orders). | ~1 week | None — pure refactor. |
| D5 — Customer ledger live in-app screen view (WI-075) | Currently customers can only download PDF. Add live screen view (mobile + web-portal). | ~1 d | None. |
| D6 — `pendingReturns` dead-column cleanup | `CustomerInventoryBalance.pendingReturns` was hidden from UI 2026-06-11 but the column + service writes + zod + 9 test-assertion sites remain. Drop everything in one migration. | 0.5 d | Confirm not needed? (Not consumed by business logic today.) |
| N11 — Cylinder-Age (schema-heavy) | Per-cyl serial tracking. Multi-day schema work before reports. | 3-5 d | Same as N11 above — is serial tracking on the roadmap? |
| F5 — Group ledger Change M mirror + per-page subtotals | Group-parent statement PDF gets the "Change M" summary + per-page subtotals for multi-page statements. | ~1-2 d | Reference a Change M example so we know the exact layout. |

#### 🅷 Session-parked gaps (report-affecting, from Bundle B audit)

| Item | Functional description | Est. | Open questions on you |
|---|---|---|---|
| Gap 5 — `customerConfirmDelivery` dispute path drift | When a customer disputes a delivery, the dispute path doesn't fire the compensating InventoryEvent. Vehicle Ledger + Day-Close DELIVERIES section stay stale for hours until the next event on same cyl type triggers recompute. | ~2 hr | None. |
| Gap 9 — Returns-only orders skip driver tagging | When a driver does a returns-only pickup (no fulls delivered), the InventoryEvent's `driverName` isn't set. Vehicle Ledger empties column can't attribute empties to the driver on returns pickups. | ~4 hr (mobile + web + backend) | None. |
| Gap 10 — `updateOrder` no compensating dispatch on post-preflight qty edit | If an operator edits an order's qty AFTER preflight ran (rare but happens), no compensating dispatch InventoryEvent fires. Vehicle Ledger shows phantom "on truck" balance until a physical count catches it. | ~3-4 hr | None. |
| Hide cancelled entries from customer statement PDF | Customer-facing PDF is noisier than it should be. Admin still needs to see full ledger. | ~2 hr | Should admin ledger view also get a "hide cancelled" toggle, or admin-always-full? |

#### 🅸 V3 open questions still unanswered (from §6)

| Q# | Question | Recommendation |
|---|---|---|
| Q9 | Reports landing page — Day Book (ops), Financial (finance), or role-adaptive? | Role-adaptive: distributor_admin → Day Book, finance → Financial, inventory → Inventory. |
| Q10 | Cross-listing — Delivery Performance in Daily Book AND Operations, or once with Related chip? | Once canonical + Related chip (avoids sidebar bloat). |
| Q12 | Report Builder scheduling — v1 requirement or Phase 3? | Phase 3c per the roadmap (defer). |
| Q13 | Customer-facing Report Builder — visible with allowlist OR internal-only? | Internal-only for v1 (defer customer-visibility to v1.1). |

#### 🅹 Uncommitted diff snapshot

25+ commits worth of work sitting uncommitted since 2026-08-05 (Sprint A + all of Sprint B including F1 + F8 + F8v2 + F8v2-R + Corp Ledger polish). Needs a chunked commit pass before starting new tracks. Estimated **~2 hr** to break into logical commits with proper messages.

---

## 🔐 SSL-CERT-PINNING — deep-dive spec (added 2026-08-07)

**Status:** ✅ **IMPLEMENTED + EMULATOR-VERIFIED 2026-08-07** (same-day; ⏸ uncommitted). EAS preview build `cc68154e` installed on the `gaslink-test` emulator (Android 14): pins confirmed inside the shipped APK via `aapt2`, app launches clean, and an in-app sign-in against the prod API returned a real **401 "Invalid email or password"** — proving the TLS handshake, pin check, request and response all succeed end-to-end. Full evidence table in [RUNBOOK-CERT-ROTATION.md §1b](RUNBOOK-CERT-ROTATION.md). · **Residual:** MITM negative-path test (needs mitmproxy + system-CA install), UptimeRobot monitor, annual expiration bump — now also guarded by a CI tripwire test that fails 90 days before the pin-set expires.

### ⚠️ AS-BUILT DEVIATIONS from the plan below (important)

The original spec below assumed **Amazon ACM** TLS. Live probe on 2026-08-07 showed prod is **Let's Encrypt** (leaf → LE `YE1` → ISRG Root YE → X2 → X1), and LE leaf certs renew every ~60-90 days with a NEW private key by default — leaf/SPKI-leaf dual-pinning as specced would brick the app quarterly. The as-built design is **strictly simpler and safer**:

1. **ISRG ROOT pinning** (X1 →2035, X2 →2040, Root YE →2032) instead of leaf dual-pin. Survives every leaf AND intermediate rotation with zero app releases; still defeats captive portals / corporate proxies / rogue CAs.
2. **No native library at all** — OS-native enforcement: Android `network_security_config.xml` `<pin-set>` + iOS `NSPinnedDomains` via config plugin `plugins/withSslPinning.js`, env-gated (`SSL_PINNING=true` on preview+production EAS profiles only). No new native module ⇒ smaller store-review delta than planned.
3. **Android dead-man switch** — `<pin-set expiration="2027-11-01">` fails OPEN after that date (annual bump in runbook). iOS mitigated by decade-stable root pins.
4. **Kill-switch = advisory messaging channel**, not remote unpin (OS pins can't be disabled remotely): `packages/web/public/pinning-status.json` on CloudFront (`mygaslink.com` — unpinned origin), probed by `src/lib/pinning.ts` when the pinned API fails at network layer. Probe-reachable ⇒ "Secure connection blocked" full-screen UX (`NetworkSecurityScreen.tsx`); probe-dead ⇒ plain offline (existing handling). **No DNS work needed** — the file ships with normal web deploys.
5. **15 Jest guards** in `packages/mobile/src/__tests__/sslPinning.test.ts` + positive/negative `expo prebuild` verification (Android). iOS plist verified at payload-shape level; final iOS proof = EAS cloud build (Windows cannot prebuild iOS).

Operational procedures, rotation playbook, CA-migration protocol (the one genuinely dangerous event: moving off Let's Encrypt), and the real-device MITM test procedure all live in **[docs/RUNBOOK-CERT-ROTATION.md](RUNBOOK-CERT-ROTATION.md)** — that file is the operational source of truth; the section below is the original design rationale.

**V3 sprint slot:** was Sprint E v1.1 · **Effort actual:** ~half-day Claude-side (vs 3-day estimate — OS-native approach eliminated the library integration + custom fallback-transport day)

### 1. What SSL cert pinning actually is

Standard HTTPS: the phone trusts any cert signed by any Certificate Authority in its system trust store (~200 CAs shipped by Apple/Google, ~50 more from carrier profiles, MDM policies, or user-installed roots). If ANY of those CAs is tricked, coerced, or hacked into issuing a fraudulent cert for `api.mygaslink.com`, the phone accepts it — every request is silently intercepted, decrypted, re-encrypted, and forwarded on. The user sees no warning. The app sees no error.

SSL cert pinning **hardcodes** the acceptable server cert (or its public key, or the intermediate CA that signs it) into the app binary. On every HTTPS request the pinning layer compares the server's presented cert against the pinned value BEFORE trusting it. Match → request proceeds. Mismatch → connection is dropped, no data is sent, no request completes.

Three flavors:
1. **Certificate pinning** — hash of the exact leaf cert. Rotation requires app update.
2. **Public key pinning (SPKI)** — hash of the public key inside the cert. Cert can be re-issued with the same key across rotations; pin survives. **Industry recommendation.**
3. **Intermediate CA pinning** — hash of the intermediate CA (e.g. Amazon's issuing CA). Leaf can rotate freely as long as the same intermediate signs it. **Riskier** — if AWS rotates its intermediate you're bricked.

### 2. Why it's needed for MyGasLink

The concrete attack surfaces we have today:

| Attack vector | Realistic? | Impact without pinning |
|---|---|---|
| **Public Wi-Fi captive portal** (café, airport, mall Wi-Fi that intercepts HTTPS to inject a "Terms of Service" page) | Common in India | Portal cert accepted → API traffic visible to portal operator. LPG customer PII + order data leaked. |
| **Corporate SSL-inspecting proxy** (a distributor's IT department installs its own root CA on employee phones so it can inspect HTTPS traffic for DLP) | Enterprise/Bulk customers likely | Every API request decrypted by proxy vendor. Payment intent + Razorpay call parameters visible. |
| **Rogue certificate issued to a government/carrier CA under coercion** | Rare but real in India (DoT + STQC mandates evolving) | Government-level MITM. Undetectable to user. |
| **Compromised device with attacker-installed root CA** (jailbroken/rooted phone, or user tricked into installing an .mobileconfig profile) | Uncommon in our audience | Full traffic capture on that device only. |
| **Compromised public CA** (DigiNotar 2011, Symantec distrust 2017, various since) | Every 1-2 years, industry-wide | Anyone globally can issue certs for api.mygaslink.com until the compromise is detected. |
| **Employee at your ISP/CDN with cert access** | Insider-threat scenario | Silent capture from network edge. |

**Regulatory driver:** DPDP Act 2023 §8 (reasonable security safeguards) doesn't name SSL pinning explicitly, but a security auditor evaluating "reasonable safeguards for a fintech-adjacent app handling payment intent + customer PII + GST invoices" will ask why it's not there. Answer today: nothing. Answer post-N4: "pinned to Amazon ACM leaf via SPKI, dual-pin rotation, monitored."

### 3. Impact WITHOUT it (current state, 2026-08-07)

- ✅ App works everywhere HTTPS works
- ✅ Zero operational burden — cert rotates, app keeps working
- ✅ Zero release-cycle coupling to cert expiry
- ❌ Any of the 6 attack vectors above succeeds silently
- ❌ DPDP audit finding: **"MITM protection: absent"**
- ❌ B2B enterprise deals asking "do you pin certs?" get a "no, planned for v1.1"
- ❌ Newspaper-headline risk: one captive-portal PII leak affecting a paying distributor becomes an existential story

### 4. Impact WITH it (post-N4, done right)

- ✅ All 6 attack vectors fail closed — the app refuses to connect to a spoofed endpoint
- ✅ DPDP audit finding: "MITM protection: SPKI-pinned to Amazon ACM issuer; dual-pin with backup key; monitored"
- ✅ Enterprise sales conversation shifts from defensive to proactive
- ⚠️ **New operational burden** — cert rotation now requires an app release
- ⚠️ **New failure mode** — if you forget to publish the new pin BEFORE the old cert expires, every installed app instance is bricked until users update. This is the single biggest reason pinning gets done wrong.
- ⚠️ **New attack surface** — if the pinned key is ever leaked (e.g. a private key breach on the server), rotating requires (a) new key, (b) new app release with new pin, (c) forced user upgrade before old-pin users are cut off. Non-trivial to execute cleanly.

### 5. Why NOT the naive 1-day path

The naive plan: `npm install react-native-ssl-pinning`, add cert hash to config, ship. Wrong because:

1. **Single-pin failure mode.** If we pin just one cert hash, an emergency cert rotation (server compromise, ACM auto-renewal edge case) requires immediate app release AND every user to update BEFORE the old cert expires. In practice ~30% of your install base doesn't auto-update in the first 48h — those users get bricked. **Every real SSL pinning deployment uses dual-pinning** (primary + backup key baked in) precisely to avoid this.

2. **Cert vs SPKI decision skipped.** Cert pinning breaks on every ACM auto-rotation (Amazon rotates leaf certs regularly). SPKI pinning survives rotations as long as you keep the same key (which AWS does unless you tell it to rotate). The library choice affects which mode is available.

3. **No fallback for pin mismatch.** What does the app show when pin fails? A red "connection refused" screen with no context? A friendly "your app version is out of date, please update" message? A "your device network is compromised" warning? Each is a different UX and needs design + copy + a link somewhere. Naive path leaves user staring at a spinner forever.

4. **No monitoring.** Once pinned, how do we know when pins are about to expire? We need a cron that hits the API from a monitoring service and alerts if the cert changes unexpectedly, PLUS a calendar reminder ~30 days before the pin's known expiry so we have time to ship an update. Naive path installs the pin and forgets it — 6 months later on a normal Tuesday the app dies for everyone.

5. **No public-key-rotation-in-place plan.** When ACM does rotate the key (rare but happens on some triggers), we need a documented playbook: (a) generate new cert with new key, (b) ship app v1.n with pins for both old + new keys, (c) wait until ≥95% of installs are on v1.n or later, (d) rotate ACM to new cert, (e) ship v1.n+1 with only the new pin, (f) confirm no old-pin traffic in production logs, (g) revoke old cert. Missing this playbook means the next rotation is a 3AM incident.

### 6. Plan — Sprint E v1.1 SSL pinning (3 dev-days)

**Day 1 — Design + prep**

- **Pinning strategy:** SPKI (public key) pinning, not cert pinning. Survives ACM auto-rotations.
- **Library:** `react-native-ssl-pinning` v1.5.x (community-maintained, native module for both platforms, supports SPKI via Base64 encoding of the SHA-256 hash of the SubjectPublicKeyInfo). Confirm compatibility with current Expo SDK 54 — if it needs prebuild/eject, use a config plugin to inject at build time.
- **Key inventory:**
  - Primary pin: SHA-256 SPKI hash of the current `api.mygaslink.com` cert (extract with `openssl s_client -servername api.mygaslink.com -connect api.mygaslink.com:443 </dev/null 2>/dev/null | openssl x509 -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl enc -base64`)
  - Backup pin: generate a NEW keypair now, wrap in a CSR, get ACM to sign it and hold in escrow (unused, but pin published from day 1). If primary key ever compromised, we swap ACM to the backup cert and the app already trusts it — no app release needed for the emergency swap; only for the eventual re-establishment of dual pins.
  - Third pin (belt-and-braces): the Amazon Root CA 1 public key hash. Only used as a break-glass if BOTH leaf pins fail somehow.
- **Fallback UX design:** pin mismatch → app shows dedicated screen "This network appears to be intercepting secure traffic. Please switch to a trusted network or update the app." with two buttons: (a) Retry, (b) Open Play Store / App Store to check for update. Copy needs to be non-technical but honest.
- **Bypass paths:** dev builds MUST NOT pin (breaks Metro bundler + local API testing). Guard by `__DEV__` OR by build variant. Preview/staging builds pin against a separate staging cert.

**Day 2 — Implementation**

- Wire `react-native-ssl-pinning` as a transport adapter in `packages/mobile/src/lib/api.ts` — replace the plain `axios.create()` fetch adapter with the pinning-aware one.
- Config file `packages/mobile/src/lib/certPins.ts` — exports the primary + backup + root pins as `Base64` strings. Environment-aware (dev/preview/prod).
- Error handler recognises the pin-mismatch error code specifically and routes to the fallback screen (not the generic "network error" toast).
- Config plugin for iOS if needed (`NSAppTransportSecurity` + `pinning-cert` binary asset).
- Config plugin for Android — pins go in `network_security_config.xml` for the fallback native path; SDK-level pinning is via the JS layer.

**Day 3 — Testing + monitoring + docs**

- Unit test: mock the fetch adapter, assert pinning check fires on every request.
- Integration test: point at a local mitmproxy with a self-signed cert — confirm requests are refused.
- Integration test: point at the real API — confirm requests succeed.
- E2E on a real device with a corporate SSL-inspecting proxy (simulate with mitmproxy + rooted Android in dev — requires manual step, not automatable).
- Wire an UptimeRobot HTTPS heartbeat that alerts if the cert changes unexpectedly.
- Add a calendar reminder in Suneel's Google Calendar 30 days before pin expiry (once expiry date is confirmed from ACM console).
- Runbook doc: `docs/RUNBOOK-CERT-ROTATION.md` — the 7-step ACM rotation playbook (from §5 point 5 above).
- Update CLAUDE.md security-audit section with the pinning posture.
- Update this V3 doc with cert-rotation calendar dates.

### 7. Blast radius if we get it wrong

**Silent failure (the nightmare):** dev builds work, staging works, prod ships with a pin mismatch bug, users update the app → **entire user base loses connectivity simultaneously**. Server sees traffic drop to zero. Requires an emergency app release + Play Store expedited review (~24h) + App Store expedited review (~48h). Every distributor is offline for that window. Every driver can't dispatch. Every customer's order goes into limbo.

**Mitigations built into the plan:**
- Preview build with pinning enabled goes to a small alpha channel first (2-3 distributors including Suneel personally) — 3 days of soaking before promoting to prod
- Feature flag `SSL_PINNING_ENFORCED` — flip to `false` remote-config-style if a mass-outage is detected. Requires a server-side kill switch that the app checks BEFORE pinning kicks in (chicken-and-egg problem — the kill switch itself must be reachable, so it lives on a separate unpinned CDN endpoint like `https://kill-switch.mygaslink.com/pinning-status.json`)
- Rollback plan: emergency release with pinning disabled, published within 4 hours of incident detection

### 8. Recommendation

- **Ship v1.0 WITHOUT** cert pinning. Timeline pressure + iOS submission risk make it a bad Q3 2026 investment.
- **Ship in v1.1 Sprint 1** alongside push notifications. Both are mobile-track work, both benefit from the same release cycle.
- **Do NOT take the naive 1-day path** — the operational risk is real and the industry has documented enough case studies (Signal, Duo, Slack all had cert-pinning outages that took hours to recover from) that we should do it right or not at all.
- **When we do it:** SPKI pinning, dual-pin (primary + backup), documented rotation runbook, monitored, feature-flag kill switch, alpha channel soak, then prod.

### 9. Update this V3 §5 sprint spec

- Sprint E N4 line replaced with a pointer to §SSL-CERT-PINNING (this section)
- Effort revised from "1 day" (matches the naive path) to "3 days" (matches the right path)

---

## Reports + Builder — post-thread status matrix (2026-08-06)

Sprint B is functionally COMPLETE for everything that doesn't need F1 (defective) or F8 (supplier ledger) as a schema pre-req. Table below is the definitive state of V3 §3.1 (N01-N34 slate) + §3.3 (Report Builder phases) after this thread's work.

### N-series reports — 34 items

| N# | Report | Bucket | Status | Blocker (if pending) |
|---|---|---|---|---|
| N01 | Defective Returns — by outgoing load | Inventory | ⏸ PARKED 2026-08-06 by Suneel post-F1 ship. F1 schema is in place; queries are straightforward when unparked. |
| N02 | Defective Returns — by customer | Customers | ⏸ PARKED 2026-08-06 by Suneel post-F1 ship. |
| N03 | Defective Returns — by corporation | Suppliers/OMCs | ⏸ PARKED 2026-08-06 by Suneel post-F1 ship. |
| N04 | Defective compensation aging | Financial | ⏸ PARKED 2026-08-06 by Suneel post-F1 ship. |
| N05 | **Supplier Statement PDF (Confidence format)** | Suppliers/OMCs | ⏸ PENDING | Needs F8 (portrait A4 PDF + PurchaseCreditNote model) |
| N06 | Purchase Register CSV+PDF | Suppliers/OMCs | ⏸ PENDING | Needs F8 role-gate widening (mini-op-only today) |
| N07 | Credit-Notes-Received Log | Suppliers/OMCs | ⏸ PENDING | Needs F8 `PurchaseCreditNote` model |
| N08 | Corporation-wise Purchase Split | Suppliers/OMCs | ⏸ PENDING | Needs F8 |
| N09 | Landed-Cost per Cylinder | Suppliers/OMCs | ⏸ PENDING | Needs F8 |
| N10 | Cylinder Rotation | Inventory (moved 2026-08-06) | ✅ DONE | — |
| N11 | Cylinder-Age Report | Inventory | ⏸ PARKED | Needs `PhysicalCylinder` schema + serial capture (3-5 days) |
| N12 | Route/Driver Performance | Daily Book | ✅ DONE — merged into Driver Daily Log 2026-08-06 | — |
| N13 | Driver & Vehicle Cost Breakdown | Expenses | ✅ DONE | — |
| N14 | Empties-in-Transit | Inventory | ✅ DONE | — |
| N15 | GST Reconciliation (dispatched vs delivered vs IRN'd) | Month-End | ✅ DONE (2026-08-06) — classifies orders into 6 shapes, flags only real mismatches (skipped-by-design NOT a mismatch). Finance-only role gate. |
| N16 | GSTR-3B Preview (Table 3.1 outward supplies) | Month-End | ✅ DONE (2026-08-06) — per-slab breakdown of taxable/CGST/SGST/IGST with CN adjustment + net-liability row. Finance-only role gate. |
| N17 | Payment Method Mix | Invoicing & Payments | ✅ DONE | — |
| N18 | Customer Profitability | Financial | ✅ DONE (2026-08-06) | Per-customer Revenue / Avg Outstanding / AR Cost / Empties Deposit Cost / Adjusted Revenue / Margin % / DSO. Interest rate is editable per-run (0-50%), not a schema field — per Suneel's "rate differs from time to time" spec. Sorts by adjusted revenue ASC so the worst-margin customers surface first. COGS deliberately NOT included in v1 (see backlog note below); scope was "credit-cost-adjusted revenue" only. Finance-visible catalog entry in Customers bucket (all-staff role gate). Live at `/api/reports/customer-profitability` + CSV. Web input field on ReportsPage. 11 tests green covering positive/negative/rate-scaling/rate-clamp/sort/wire/CSV/role-visibility. |
| N19 | Rate Variance / Discount Leakage | Invoicing & Payments | ✅ DONE | — |
| N20 | Day-Close Summary | Daily Book | ✅ DONE | — |
| N21 | Cash Book | Month-End | ✅ DONE | — |
| N22 | Cashflow Statement | Month-End | ✅ DONE | — |
| N23 | P&L Preview | Financial | ⏸ PARKED | Needs accounting-source decision (cash-basis vs accrual) |
| N24 | Deposit Ledger per Customer | Customers | ✅ DONE | — |
| N25 | Customer Activity Report | Customers | ⏹ SKIPPED per Suneel — Customer Statement covers 80% |
| N26 | Stock-Adjustment Audit Log | Inventory | ✅ DONE | — |
| N27 | Delivery Challan PDF | Invoicing & Payments | ⏸ PARKED 2026-08-06 by Suneel. Catalog placeholder (`comingSoon: true`) stays visible so distributors know it's on the roadmap. Suneel wants to define the shape (single-order vs multi-order trip sheet, PDF vs inline, field set) later. No code work until he unparks. |
| N28 | Credit Notes Register | Invoicing & Payments | ✅ DONE | — |
| N29 | Debit Notes Register | Invoicing & Payments | ✅ DONE | — |
| N30 | Quotations Register + Win/Loss | Invoicing & Payments | ⏸ PARKED per Suneel |
| N31 | Opening Balance Certificates Register | Invoicing & Payments | ✅ DONE (date filter ignored per FX-C — historical set) | — |
| N32 | Expense Register CSV | Expenses | ✅ DONE | — |
| N33 | Expenses-by-Category Trend | Expenses | ✅ DONE (with line chart) | — |
| N34 | Accountability Log Report | Customers | ✅ DONE | — |
| + | **Driver Daily Log (new)** | Daily Book | ✅ DONE — merges Daily Driver Movement + N12 | — |
| + | **Daily Sales** (new, added Sprint B Chunk 2) | Daily Book | ✅ DONE | — |

**Score (updated 2026-08-06 eve):** 22 DONE (N15+N16+N18 landed) · 10 skipped/parked (N01–N04 parked-today, N11, N23, N25, N27-parked, N30, plus N12 merged) · 2 PENDING — N05-N09 need F8 (supplier ledger). **F1 shipped** with 25 total commits worth of work (7 slices + 18 UX iterations). Report queue is empty pending F8; next feature-track is F8 supplier ledger.

### Report Builder — 3-phase rollout

| Phase | Scope | Status |
|---|---|---|
| Phase 1 | Templates polish — filter presets, hide-columns, sticky dates, recent reports | ✅ DONE (Recent removed 2026-08-06 as confusing per user; other 3 kept) |
| Phase 2 | True single-model Builder — 6 models × 5 roles allowlist matrix, zod spec (14 filter ops + 7 aggregations + 9 date presets), safe executor (tenant scope, 50k cap, 10s timeout), CRUD + preview + run routes, web UI, sharing (private / distributor-wide) | ✅ DONE |
| Phase 3a | Pivots (rows × cols matrix) + Charts in Builder output | ⏸ PENDING (~4-5 days) |
| Phase 3b | Cross-model joins (Order+Customer+Driver+Invoice quartet) + Role-scoped sharing | ⏸ PENDING (~5-7 days) |
| Phase 3c | Scheduling + Email/Webhook delivery of saved reports | ⏸ PENDING (~4-5 days) |
| + | PDF export from Builder (currently CSV only) | ⏸ PENDING (~2 days) |
| + | Mobile Report Builder (currently web-only) | ⏸ PENDING (~3-5 days) |

### V3 §6 open questions still unanswered (Reports + Builder subset)

| Q# | Question | Recommendation |
|---|---|---|
| Q9 | Reports landing page — Day Book (ops), Financial (finance), or role-adaptive? | Role-adaptive: distributor_admin → Day Book, finance → Financial, inventory → Inventory |
| Q10 | Cross-listing — Delivery Performance in Daily Book AND Operations, or once with Related chip? | Once canonical + Related chip (avoids sidebar bloat) |
| Q11 | ~~N18 Customer Profitability AR-interest source~~ | **RESOLVED 2026-08-06 → per-run filter (0-50%, default 12%), NO schema field.** Suneel's guidance: "rate differs from time to time" — a cash-crunch quarter warrants 18%, a normal quarter 10-12%. Persisted per-user via preset localStorage. |
| Q12 | Report Builder scheduling — v1 requirement or Phase 3? | Phase 3c per the roadmap (defer) |
| Q13 | Customer-facing Report Builder — visible with allowlist OR internal-only? | Internal-only for v1 (defer customer-visibility to v1.1) |

### Session-parked report-affecting gaps (from Bundle B audit, this thread)

| # | Item | Report impact | Effort |
|---|---|---|---|
| Gap 5 | `customerConfirmDelivery` dispute path drift | Vehicle Ledger + Day-Close DELIVERIES section stale for hours until next event on same cyl type triggers recompute | ~2 hrs |
| Gap 9 | Returns-only orders skip driver tagging in modal | Vehicle Ledger empties column doesn't attribute empties to driver on returns-only pickups | ~4 hrs (mobile + web + backend event tag) |
| Gap 10 | `updateOrder` no compensating dispatch on post-preflight qty edit | Vehicle Ledger phantom "on truck" balance until physical count catches it | ~3-4 hrs |
| + | Hide cancelled entries from customer statement PDF | Customer statement PDF cleaner; admin still sees full ledger | ~2 hrs |

### N18 followup — COGS enrichment (backlog, post-v1.0)

**Deferred from 2026-08-06 N18 build** at Suneel's explicit ask: *"cant we do cogs from expenses?? or may be later — just add it backlog??"*

N18 v1 ships without a Cost of Goods Sold column, so its "Adjusted Revenue" is really "credit-cost-adjusted revenue" — a customer that pays fast but buys at rock-bottom margins still looks good in v1. The full picture needs per-order COGS attribution.

**Approach A — from Expenses (rejected as unusable for per-customer COGS):** Expenses are tracked at distributor level (rent, salary, fuel), not attributable per cylinder or per customer. Even prorating by revenue-share would just scale everyone's margin identically — no signal about which customer is actually profitable.

**Approach B — landed cost from purchase orders (recommended):** Every `PurchaseOrder → PurchaseOrderItem` records what the distributor paid the OMC per cyl type. Landed cost = (unit cost + freight allocation + taxes claimed) at the moment of the OMC receipt. Store as `CylinderType.avgLandedCost` (rolling avg from PO receipts) OR compute on the fly per-report from the last N POs. Multiply by `OrderItem.deliveredQuantity` for each customer's delivered orders → per-customer COGS. Then N18 becomes:

  - **Gross Profit** = Revenue − COGS
  - **Adjusted Gross Profit** = Gross Profit − AR Cost − Empty Cost
  - **True Margin %** = Adjusted Gross Profit / Revenue × 100

**Effort:** ~2 days. Depends on:
1. Purchase order data quality (Vanasthali / Sharma actually recording every OMC receipt with true landed cost including freight — currently uneven).
2. Decision on rolling-avg vs FIFO vs latest-cost basis (affects which quarter's cost hits which order).
3. Whether to add `CylinderType.avgLandedCost` snapshot column (fast reads) vs compute-on-the-fly (accurate at every query but slower).

**Blocker:** F8 Supplier Ledger landing first — it's the natural place to snapshot landed cost per receipt, and once it's in, N18 v2 is a small add.

---

## Uncommitted diff footprint (as of 2026-08-05 evening)

```
 M .github/workflows/ci.yml                                (B4)
 M packages/mobile/app.json                                (B3)
?? packages/mobile/plugins/withDedupIntentFilters.js       (B3)
 M packages/api/src/services/reportsService.ts             (F3/F9)
 M packages/web/src/pages/ReportsPage.tsx                  (F3/F9/F4)
 M packages/web/src/pages/InventoryPage.tsx                (Depot Amount)
 M packages/shared/src/types/index.ts                      (Depot Amount)
 M packages/api/src/__tests__/reports.test.ts              (F3 regression fix)
?? packages/api/src/__tests__/reports-vehicle-ledger-shape.test.ts       (new)
?? packages/api/src/__tests__/reports-vehicle-ledger-computed.test.ts    (new)
?? packages/api/src/__tests__/depot-history-amount.test.ts               (new)
```

Pre-existing (NOT mine, from prior session's expo-updates dep add):
```
 M packages/mobile/package.json
 M pnpm-lock.yaml
```

Untracked (this session's brief docs):
```
?? docs/NEXT-RELEASE-BRIEF-2026-08-05.md
?? docs/NEXT-RELEASE-BRIEF-2026-08-05-VERIFIED.md
?? docs/NEXT-RELEASE-PROPOSAL-V3.md
```

---

## Next feature — F6: Mobile Deposits customer filter (recommended)

Small, self-contained, no schema. Perfect follow-up to the big Vehicle Ledger rewrite. Estimated **1.5-2 hr code + 30-45 min tests**.

### What it does functionally (before → after)

**Today** — mobile Deposits screen (`DepositsView.tsx`) has 2 filter dropdowns in a header row: **Event** (All / Charged / Refunded) and **Cylinder type** (All types / 5 KG / 19 KG / 47.5 KG). No customer filter. If a distributor admin on mobile wants to see "deposits recorded for customer X", they scroll the full paginated list and manually eyeball.

Web already has a customer combobox filter at [BillingPaymentsPage.tsx:2440-2488](packages/web/src/pages/BillingPaymentsPage.tsx:2440) with type-to-search. Mobile lost parity when a UI polish pass (documented in `DepositsView.tsx:86-95` comment) replaced pill filters with SelectField dropdowns and forgot to convert the customer pill.

**After** — third picker added to the header, using the same `PickerOverlay` pattern the Record Deposit sheet already uses 3 times. Customer picker opens a modal with a search input at top + scrollable list. Tapping a customer filters the deposits list to just their events.

### User workflow

**Persona:** distributor admin on mobile. Say she's investigating a customer's complaint that they were double-charged deposits.

Today (no filter):
1. Open Deposits tab
2. Scroll page after page trying to find rows for that customer
3. Give up, switch to web

After F6:
1. Open Deposits tab
2. Tap "Customer" picker → search "Royal Kitchen" → tap
3. List filters to just Royal Kitchen's charged + refunded deposits
4. Confirm/deny the double-charge in 5 seconds

### Files I'll touch

| File | Change |
|------|--------|
| `packages/mobile/src/components/DepositsView.tsx` | Re-add `customerFilter` state (currently marked "dropped, re-add if needed" at L86-95); add third SelectField-shaped Customer picker button; wire `customerId` param into the query key + `useApiQuery` params; add on-demand customer fetch (gated on filter picker open, NOT on tab load — preserves the Change I performance win) |
| No API change | Backend `GET /api/payments/deposits` at [routes/payments.ts:167-183](packages/api/src/routes/payments.ts:167) already accepts `customerId` |
| No schema change | — |
| No shared type change | — |

### Anti-pattern #25 compliance

The existing `PickerOverlay` at `DepositsView.tsx:920-961` already honors it (`useSafeAreaInsets`, `keyboardShouldPersistTaps="handled"`, `statusBarTranslucent`, `onRequestClose`). New Customer picker reuses that component directly — no CI-guard failure.

### Testing plan

**Backend** — no changes, but add a wire-shape guard test to prevent future silent shape drift:
- `packages/api/src/__tests__/payments-deposits-customer-filter.test.ts`:
  - **Positive:** `GET /api/payments/deposits?customerId=X` returns only that customer's rows
  - **Negative:** invalid `customerId` (not owned by tenant) returns empty rows (not 403 leak)
  - **Regression:** without `customerId`, still returns all rows

**Mobile** — no unit-test infra for RN today. I'll skip formal component tests and rely on:
- Manual UAT on mobile (Suneel's device or Expo Go)
- Or launch mobile via `preview_start name: 'mobile'` if port 8081 free (both API + web ports are held by other chat, mobile might be free)

### Questions before I start

1. **Search behavior** — customer picker should support (a) fuzzy substring match on `customerName` (my recommendation, matches web Combobox behavior), or (b) prefix-match only? Same behavior as the existing Record Deposit customer picker either way — I'll copy that exact filter logic so parity is automatic.
2. **"Clear customer filter" affordance** — the picker either (a) shows an "All customers" row at the top of the list to clear the filter, or (b) has a small ✕ badge next to the picker button when active. Recommend (a) — matches the Event / Cylinder type dropdowns which have "All" as first option.
3. **Preload timing** — customer list is currently fetched only when `showRecord` is true (Change I performance fix). New picker triggers a SECOND on-demand fetch when the customer-filter picker opens. Both would share the same TanStack query key so they cache-hit after either opens once. OK to proceed with that pattern, or do you want to lift the fetch back to tab-open time?

### Alternative next-feature options (if F6 isn't the right pick)

If you'd rather skip F6 and go to something bigger, my ranked alternatives:

1. **D1 — Admin web unit-price vs PDF Rate inconsistency** (~4 hr) — the customer-facing UX bug where app shows ₹2,500 unit price but PDF Rate column shows ₹2,118.64 + separate discount line. Route (a′) verified correct in earlier research. Landing this would close one of the highest-visibility "why don't these match?" support tickets.
2. **F2 grouping — Reports left-nav + Day Book × 3** (~1 day) — the reports revamp Phase 1a. Ships the taxonomy restructure + 3 new Day Book reports. Sets up the substrate for the 34 N-series reports and Report Builder Phase 1.
3. **F1 MVP — Defective cylinder audit trail** (~2 days) — schema + `DefectiveCylinderLedger` + `DefectiveReturnBatch` + `no_compensation` settlement mode only + Depot History filter extension + depot defective-fulls columns. The 3 real settlement modes (CN / skip / reverse) deferred to Sprint B.

Pick your favorite and say the word.

---

## Testing mandate (added 2026-08-05 by Suneel)

**Every new feature from this release onwards MUST ship with:**
1. **Positive tests** — happy path, expected inputs → expected outputs
2. **Negative tests** — empty inputs / unauthorized users / bad state → correct rejection
3. **Regression tests** — nothing existing that touched the same file / query / component breaks
4. **Integration tests** — end-to-end path that exercises the real service + DB + response envelope + wire shape (per anti-pattern #9)

**Also mandatory before any commit:**
- `pnpm --filter @gaslink/api typecheck` exits 0
- `pnpm --filter @gaslink/web typecheck` exits 0
- `pnpm --filter @gaslink/mobile typecheck` exits 0
- `pnpm --filter @gaslink/api run lint` — zero new errors
- `pnpm --filter @gaslink/api test` — 2091+ passing (or if baseline is currently 2089 failing at users.test.ts, we do not regress from that baseline; failing tests must be triaged before shipping new features)

**No half-baked or partially cooked solutions.** This applies to F3/F9/F4, F6, D1, F2, F1, F8, and every subsequent item.

---

## 0. Executive summary — what changed from v2

| Item | v2 estimate | v3 verified estimate | Why the change |
|------|-------------|----------------------|----------------|
| B3 intentFilter dedup plugin | 30 min | 30 min ✅ | Verified — 2 templates in `plugins/`, `@expo/config-plugins@54.0.5` transitively installed |
| B4 CI `migrate deploy` | 5 min | 5 min ✅ | Verified — one word on one line; strictly a subset of `migrate dev` |
| **F1 defective tracking** | 2-3 days | **9-11 days full scope** | Deep design surfaced: 3 real settlement modes (CN / skip-next / reverse), outgoing-empties modal must become multi-line, dedicated `DefectiveCylinderLedger` table with 5-status lifecycle, parallel `InventorySummary` columns for defective bucket, invoice generator changes for `priorCompensationApplied`, mini-op mirror branches. v2's 2-3 day was MVP-only. |
| F2 grouping + Day Book | 2 days | 2-3 days ✅ | Confirmed. Catalog is flat with `groups: string[]` array (allows cross-listing). |
| **F7 additional reports** | 0.5-1 day each | 22-26 dev-days for full N01-N34 slate | Expanded from 7 candidates → 34 concrete reports across all groups. Most 0.3-1 day each. Big ones flagged. |
| **F8 Supplier Ledger** | 4-5 days | **9 days full / 4 days MVP** | Deep design surfaced: existing `getSupplierLedger` at [purchasePaymentService.ts:451](packages/api/src/services/purchasePaymentService.ts:451) needs v2 alongside (mobile compat), existing `purchaseLedgerPdfService.ts` is landscape "detailed" — Confidence-format wants NEW portrait `supplierLedgerPdfService.ts`. `PurchaseEntry` already auto-emits `InventoryEvent` (0.5 day saved). Added `PurchaseCreditNote` + `PurchaseLedgerAdjustment` models. |
| **F9 (NEW) Vehicle Ledger Qty split** | — | 3-4 hr standalone, or bundled with F3 + F4 = 5-7 hr | Discovered: web collapses 6 backend columns → 1 via `firstNonZero()`; mobile already shows all 4; CSV already has all 6. Suneel's ask is a web-only display fix. F4 outstanding-empties column REQUIRES F9 to make sense visually. |
| **Report Builder** | v1 "templates only" recommended | Phased: **Phase 1 (3-4 days) = polished templates + saved filters** ships with F2; **Phase 2 (8-12 days) = true single-model builder** is its own sprint; Phase 3 (cross-model + charts + scheduling) is later | Verified zero existing builder infra. Greenfield build — safety layer entirely on us. Detailed 8-section design in Part D of the F2 research. |

**Bottom line: what was "6-8 days" in v1/v2 is realistically 25-35 dev-days across 3-4 sprints if you want every item done properly.** The right split is (a) this release = polish + F9 + F2 grouping + defective MVP, (b) Sprint N+1 = F1 full + F8 full, (c) Sprint N+2 = Report Builder Phase 2 + N-series reports.

---

## 1. B3 + B4 — SAFE TO GREEN-LIGHT (verified)

Already given inline. Recap:

- **B4:** `db:migrate` → `db:migrate:prod` at `ci.yml:120`. `migrate deploy` is a strict subset of `migrate dev` (same migrations, same target, minus drift detection + shadow DB + client generate). Both prod deploy paths already use it. **Zero impact.**
- **B3:** ~15-line plugin using low-level `withPlugins` API from `@expo/config-plugins@54.0.5`. Dedupes `config.android.intentFilters` by stable-stringify hash. Registered LAST in `expo.plugins[]`. Runtime behavior identical (still 1 filter for `mygaslink.com` autoVerify). **Zero runtime impact.** Two 30-second verify commands documented.

---

## 2. F1 — Defective Cylinder Ledger (comprehensive design)

### 2.1 Why the earlier estimate was too small

v1 said 2 days assuming "audit trail + no compensation branch only." Real ask is 3 settlement modes + follow-through into outgoing-empties + fulls-count math + reports. Full-scope work items:

| Chunk | Days |
|---|---|
| Schema + migration + prisma-generate + summary column defaults backfill | 0.5 |
| `defectiveReturnService.ts` (CRUD + settlement + batch + gates) | 1.0 |
| `confirmDelivery` extension + `deliveryQueue` shape + `reconcileVehicle` auto-transition | 0.75 |
| Outgoing-empties modal rewrite — web (multi-line + defective panel) | 0.75 |
| Outgoing-empties modal rewrite — mobile | 0.5 |
| Driver delivery flow extension — mobile | 0.5 |
| Settlement UI (web `DefectiveReturnsPage` with 5 status tabs, bulk actions, CN trigger) | 1.0 |
| Depot fulls display + column toggle (web + mobile) | 0.25 |
| CN flow wiring + `Invoice.priorCompensationApplied` PDF change + invoice generator consume | 0.75 |
| Reverse-transaction gating + integration with `orderService.cancelOrder` | 0.25 |
| Reports (defective-by-customer / by-corp / compensation aging / by-outgoing-load) | 1.0 |
| Customer-ledger PDF new labels + statement exclusions | 0.5 |
| Vehicle-ledger corp exclusion (F3 folded in) | 0.25 |
| Tests (`defective-returns.test.ts`, `confirmDelivery` extended, `createInvoiceFromOrder` compensation, `inventorySummary` new columns, `reconcileVehicle` auto-transition, anti-pattern #24 gates) | 1.0 |
| Docs — CLAUDE.md anti-pattern entries for new invariants | 0.25 |
| Buffer for mini-op + godown-pickup branches (trap #8) | 0.5 |
| **Total** | **~9.75 days** |

Realistic call: **9-11 working days.**

### 2.2 The core design (validated against Suneel's directive)

Suneel: "maintain a separate ledger only for defective cylinder... they get deducted from full count and not empty."

**New table: `DefectiveCylinderLedger`** — per-incident row, 5-status lifecycle:
`reported → picked_up_from_customer → received_at_depot → sent_to_corporation → corporation_credit_received` (plus `written_off`, `cancelled`).

**Additional new table: `DefectiveReturnBatch`** — header row for outgoing shipment to OMC, groups N ledger rows via `corporationBatchId`.

**Full Prisma DDL** ready to paste — see Appendix A (300 lines, produced by research agent).

### 2.3 Depot fulls-count design — CRITICAL

**Do NOT touch the `closingFulls` formula.** WI-106 flag-critical (byte-for-byte). Instead, add 3 parallel columns to `InventorySummary`:

```
defectiveFullsIn      Int @default(0) @map("defective_fulls_in")
defectiveFullsOut     Int @default(0) @map("defective_fulls_out")
closingDefectiveFulls Int @default(0) @map("closing_defective_fulls")
```

Aggregator: three new event types feed these (`defective_return`, `defective_return_to_corporation`, `defective_write_off`). `closingFulls` formula unchanged. This matches Suneel's intent — a defective full is counted separately from good-saleable fulls, and not conflated with empties.

### 2.4 Settlement modes — 4, not 3

Suneel listed 3; adding `no_compensation` for the same-visit 1-for-1 swap case (driver already handed customer a fresh full — no money movement, ledger audit trail only):

| Mode | When applicable | Implementation |
|------|-----------------|----------------|
| `credit_note` | Any time. Requires `sourceInvoiceId` on ledger row (CN.invoiceId is non-nullable). | Call `invoiceService.createCreditNote + approveCreditNote` — reuse deposit-refund pattern. Store CN.id in `settlementRefId`. |
| `skip_next_billing` | Any time. | Write `CustomerLedgerEntry` with new `entryType='defective_full_compensation'`, negative amountDelta. Extend `invoiceService.createInvoiceFromOrder` to consume via new `Invoice.priorCompensationApplied` decimal column, subtracted from `outstandingAmount`, shown on PDF footer. **Do NOT use synthetic negative-qty lines** — NIC IRN rejects negative qty. |
| `reverse_transaction` | Only if `IRN ≤ 24h old AND GSTR-1 not filed AND cancelling whole delivery makes sense`. | Delegate to `orderService.cancelOrder(orderId, ..., { cancellationType: 'damaged_returned', applyAsCustomerCredit })`. Reuse existing mini-op cancellation path — no new cancel type invented. |
| `no_compensation` | 1-for-1 swap at pickup. | Zero money movement. Ledger row is the only artifact. |

### 2.5 The "follow through outgoing empties" workflow (Suneel's core ask)

**Current state:** outgoing-empties modal (both web + mobile) is single-line, single-cyl-type, no defective concept beyond a hidden `condition` field that nothing reads.

**Proposed:** modal becomes multi-line with a NEW "Defective Fulls Being Returned" section that auto-populates from `DefectiveCylinderLedger.where({status: 'received_at_depot'})`. Office cannot record an outgoing batch without seeing what defective inventory is queued.

Concrete mockup:
```
Depot → Corporation Return Shipment
──────────────────────────────────────────────────────────
Corporation:      [ IOCL ▾ ]         Vehicle: [ KA-01-... ▾ ]
Challan Type:     [ Return Challan ]
Challan No.:      [ RC/2026/... ]    Challan Date: [ 2026-08-05 ]
Authorization:    [                                            ]

═══ EMPTIES BEING RETURNED ═══
+ Add empty line
  [ 19 KG ▾ ]  Qty [ 100 ]  Notes [               ]
  [ 5 KG  ▾ ]  Qty [  20 ]  Notes [               ]

═══ DEFECTIVE FULLS BEING RETURNED ═══
Pending defective fulls at depot: 4×19 KG, 1×5 KG
  ☑ Include ALL pending 19 KG (4 units)
      3 from CUS-100 (delivery INV-...); 1 from CUS-201 (INV-...)
  ☐ Include ALL pending 5 KG (1 unit)
+ Add specific defective line...
                                       [ Cancel ]  [ Record ]
```

Same treatment on the driver-side delivery-confirmation modal — pre-populated `defectiveFullsPickedUp` when the customer has open `reported` rows.

### 2.6 Ripple risks (documented)

1. **`recalculateSummariesFromDate`** — 3 new `InventorySummary` columns require historical backfill. O(distributors × days × cylTypes). ~2-5 min on prod-size data — deploy-time one-shot.
2. **Vehicle-ledger tests** — will break with new event types. F3 change covers this.
3. **Empties-return tests** — several will need updates (extended `confirmDelivery` items shape).
4. **`CustomerInventoryBalance.withCustomerQty`** — new writer added. 5 readers to verify (anti-pattern #24).
5. **Mini-op + godown-pickup branches** in `confirmDelivery` need mirror handling.
6. **`InventoryEvent.condition`** — becomes structurally redundant. DO NOT drop this commit; flag as follow-up cleanup after 1 release of parallel writes.
7. **Anti-pattern #24 gates** — new `defective_full_return` and `defective_full_compensation` ledger types must be tested against every reader (credit gate, Tally export, AR aging, dashboard KPI).
8. **Numbering allowlist** — `'F'` prefix for `DefectiveReturnBatch.batchNumber` (D/C/I/R/O/V taken).
9. **Anti-pattern #25** — every new mobile modal needs `useSafeAreaInsets` + `keyboardShouldPersistTaps="handled"` or CI guard fails.

### 2.7 Open questions on F1 (8) — consolidated in §7

---

## 3. F2 + F7 — Reports revamp with 10 groups + 34 reports

### 3.1 The 10-group taxonomy (recommended)

Merged Suneel's two suggestions (Day Book / Financial / GST / Invoicing / Customer + Inventory / Financial / Delivery / Expenses) into an intent-first structure that supports cross-listing.

| Group | Purpose | Existing reports moving here | New reports (N-numbered) |
|-------|---------|-----------------------------|--------------------------|
| **1. Day Book** | Everyday ops, one-day-at-a-time | Sales Summary, Delivery Performance, Inventory Movement, Vehicle Ledger, Payment Collections | N20 Day-Close Summary, N21 Cash Book |
| **2. Financial** | Collections, receivables, cashflow | Outstanding & Aging, Payment Collections (cross-listed), Payments Register (surface existing) | N17 Payment Method Mix, N18 Customer Profitability, N19 Rate Variance / Discount Leakage, N22 Cashflow Statement, N23 P&L Preview |
| **3. Statutory & Compliance** | GST + Tally + returns | GST Summary, GST Filing Export, Tally Export | N15 GST Reconciliation, N16 GSTR-3B Preview |
| **4. Invoicing & Documents** | Anything printed for a customer | Invoices Register CSV, Tax Invoice PDF, Credit Note PDF, Debit Note PDF, Quotation PDF | N27 Delivery Challan PDF (real gap!), N28 Credit Notes Register, N29 Debit Notes Register, N30 Quotations Register + Win/Loss, N31 Opening Balance Certificates Register |
| **5. Operations** | Delivery / fleet / drivers | Delivery Performance (cross-listed), Driver Statement PDF, Vehicle Ledger (cross-listed), Order Register CSV+PDF, Trip Sheet PDF | N10 Cylinder Rotation, N11 Cylinder-Age (schema-heavy — defer), N12 Route/Driver Performance, N13 Driver Fuel Consumption, N14 Empties-in-Transit, N34 Accountability Log Report |
| **6. Inventory** | Depot stock + adjustments | Inventory Movement (cross-listed), Depot History, Manual Stock Adjustments CSV, Stock Mismatch Log CSV, Corporation Loads Received (moved from Vehicle Ledger per F3) | N01-N04 Defective Returns (by-load / by-customer / by-corp / aging — needs F1), N26 Stock-Adjustment Audit Log |
| **7. Customer** | Customer-centric AR + activity | Customer Statement, Empty Cylinders per Customer, Overdue Call List, Customer LTV, Top Customers by Revenue | N24 Deposit Ledger per Customer, N25 Customer Activity Report |
| **8. Purchases & Suppliers** | F8 territory | (Purchase Register existing, Purchase Ledger PDF existing) | N05 Supplier Statement PDF (Confidence-format!), N06 Purchase Register CSV+PDF, N07 Credit-Notes-Received Log, N08 Corporation-wise Purchase Split, N09 Landed-Cost per Cylinder |
| **9. Expenses** | Kept as own group (Mini-Op #5) | Expense Report PDF | N32 Expense Register CSV, N33 Expenses-by-Category Trend |
| **10. Platform / SaaS** | super_admin only, separate nav | SaaS Billing Invoice PDF | (nothing) |

**Catalog shape:** flat map with `groups: string[]` (allows cross-listing without duplication). Left-nav in UI. See appendix B for the `ReportCatalogEntry` type.

### 3.2 New reports — complete list with effort

34 new reports catalogued in the F2/F7 research (N01-N34). Highlights:

**Immediate wins (0.3-0.5 day each):**
- N06 Purchase Register CSV+PDF
- N07 Credit-Notes-Received Log
- N17 Payment Method Mix
- N19 Rate Variance / Discount Leakage
- N24 Deposit Ledger per Customer
- N26 Stock-Adjustment Audit Log
- N27 Delivery Challan PDF (real gap — currently no non-taxable challan for pre-invoice delivery)
- N28-N31 CN/DN/Quotation/OB registers
- N32 Expense Register CSV
- N34 Accountability Log Report

**Medium (0.5-1 day):**
- N05 Supplier Statement PDF (Confidence-format) — the crown jewel of F8
- N10 Cylinder Rotation
- N12 Route/Driver Performance
- N15 GST Reconciliation
- N18 Customer Profitability (needs `Distributor.arInterestRate` setting)
- N20 Day-Close Summary
- N21 Cash Book
- N22 Cashflow Statement
- N25 Customer Activity Report
- N33 Expenses-by-Category Trend

**Big/deferred:**
- N11 Cylinder-Age Report — requires per-cylinder serial-number tracking; **schema-heavy, defer to a separate sprint** (~3-5 days). Would need a new `PhysicalCylinder` model + serial capture at delivery.
- N16 GSTR-3B Preview (~1 day)
- N23 P&L Preview (~1.5 days, needs accounting-source decision)

**Sub-total: ~22-26 dev-days for the full N01-N34 slate** (many are quick wins once F2 grouping + a report template are in place). Most bundle naturally with F1 (N01-N04) or F8 (N05-N09).

### 3.3 Report Builder — 3-phase rollout

**Zero existing builder infra** in codebase (verified: no `queryBuilder`/`customQuery`/`SavedReport`/`reportTemplate`; production data-access 100% Prisma ORM; `$queryRaw` only in tests + `/health` route). Greenfield build — safety layer entirely on us.

**Phase 1 — Parameterized templates + saved filters (3-4 days) — ships with F2:**
- Column-visibility toggle per template (client-only)
- "Save current filter" via localStorage
- Cross-template sticky `dateFrom/dateTo`
- No new tables. UX enhancement.

**Phase 2 — True single-model Builder (8-12 days) — its own sprint:**
- New `SavedReport` + `SavedReportRun` models
- Field allowlist per model per role (detailed matrix in F2/F7 research, Part D.1)
- 7 aggregations (`sum, count, count_distinct, avg, min, max, running_total`)
- Filter shape (`eq/neq/gt/gte/lt/lte/in/not_in/between/preset/contains/starts_with/is_null/is_not_null`)
- Server safety: zod validation → role allowlist → tenant scope injection → row-level scope injection → Prisma builder (never string concat, never `$queryRaw`)
- 50k row cap + 10s statement timeout + unindexed-filter warning
- Distributor-wide sharing only

**Phase 3 (future) — cross-model joins, pivots, charts, scheduling + email/webhook delivery, role-scoped sharing.**

Aggressively **NOT** building drag-drop from schema browser in v1 — that reinvents Metabase. Phase 2 delivers 80% of value at 20% risk.

### 3.4 Vehicle Ledger Qty (F9 — new item)

**Web currently collapses 6 backend numeric columns → 1 display cell** via `firstNonZero()` in `UnifiedVehicleLedger`. Mobile ALREADY shows all 4 columns. CSV ALREADY has all 6.

**Design decision:** Option A (Split into `Fulls` + `Empties` + `Outstanding` columns with sticky-left on Date/Vehicle/Driver). Delete `firstNonZero()` entirely.

**F3 + F9 + F4 bundle as ONE commit** — all touch `ReportsPage.tsx` `UnifiedVehicleLedger` component. Total 5-7 hr. Only one file changes. No backend change. No CSV change. No mobile change.

---

## 4. F8 — Supplier Ledger comprehensive (9 days full)

### 4.1 What already exists (surprises)

- **`getSupplierLedger` already exists** at [purchasePaymentService.ts:451](packages/api/src/services/purchasePaymentService.ts:451). Used by mobile purchases page. Lacks opening-balance fold, Dr/Cr suffix, credit-note kind, adjustment kind. Need a v2 alongside; keep old for mobile backward-compat.
- **`purchaseLedgerPdfService.ts` already exists** — landscape A4, 9 columns, movement+money hybrid. Not Confidence format. Need a NEW portrait `supplierLedgerPdfService.ts` alongside. Both stay useful.
- **`PurchaseEntry` already auto-emits `InventoryEvent`** in the same transaction. Zero new work here. (v2 brief listed this as scope; it's not.)

### 4.2 New models — 2 tables

**`PurchaseCreditNote` + `PurchaseCreditNoteAllocation`** — mirrors `PurchasePayment + PurchasePaymentAllocation` byte-for-byte. Reduces running Dr balance same direction as a payment; multi-invoice split supported; `PCN` numbering prefix.

**`PurchaseLedgerAdjustment` + `LedgerAdjustmentDirection` enum** — free-text debit or credit not captured elsewhere (interest, bank charges, freight rebate, correction). `PA` numbering prefix. No allocations — floats against supplier's overall balance.

Full Prisma DDL ready to paste — see Appendix C.

### 4.3 Ledger service + row shape

New file `supplierLedgerService.ts` alongside existing. Returns rows matching Confidence PDF exactly:

```ts
interface SupplierLedgerRow {
  vrDate: string;
  vrType: 'opening'|'purchase_invoice'|'purchase_payment'|'purchase_credit_note'|'adjustment'|'closing';
  vrNumber: string | null;
  narration: string;
  debit: number;
  credit: number;
  runningBalance: number;         // absolute
  runningBalanceKind: 'Dr' | 'Cr'; // signals suffix
  sourceRefType: '...'|null;
  sourceRefId: string | null;
}
```

### 4.4 Stock vs Financial rows — RECOMMENDED Option 3

**Financial ledger looks EXACTLY like Confidence PDF** + separate "Stock Position" collapsible card on the same web page showing per-cylinder-type opening empties held / +fulls in / −empties out / current balance.

Two PDF downloads offered:
- **Statement of Account** (new, portrait A4, 7 columns) — matches Confidence format for OMC-facing use
- **Detailed Ledger** (existing, landscape A4, 9 columns) — internal ops reconciliation

Design mockup + code paths in F8 research report.

### 4.5 Multi-supplier UI shell

- `/app/purchases/suppliers` — dashboard: list of all suppliers with balance chips
- `/app/purchases/suppliers/:id/ledger?from=&to=` — the ledger view with 4 KPI tiles + action buttons (Record Payment / Credit Note / Adjustment / Download PDF) + table + drill-down + Stock Position card
- No combined-across-suppliers ledger (meaningless — each OMC has its own balance)
- Mobile parity — mirror 3 new modals on existing `packages/mobile/app/(admin)/purchases.tsx`

### 4.6 File list — 9 days

| Day | Work |
|-----|------|
| 1 | Schema + migration + Zod schemas |
| 2 | `purchaseCreditNoteService.ts` + `purchaseLedgerAdjustmentService.ts` + `supplierLedgerService.ts` v2 |
| 3 | Routes (`purchaseCreditNotes.ts` + `purchaseLedgerAdjustments.ts` + `supplierLedger.ts`) + role gate widening on 3 existing route files |
| 4 | PDF (`supplierLedgerPdfService.ts`) + drill-down variant |
| 5-6 | Web UI (`SuppliersPage.tsx` + `SupplierLedgerPage.tsx` + 4 modals + routes + sidebar) |
| 7 | Mobile UI (2 new modals + supplier panel extension) |
| 8 | Tests (5 test files) |
| 9 | Buffer + numbering counter seeds + docs |

MVP scope (financial ledger only, no adjustments, no drill-down, web-only): **~4 days.**

### 4.7 Ripple risks — all LOW

- No test blocks distributor_admin from purchase routes today
- No dashboard KPI reads purchase tables assuming zero on non-mini-op
- One thing to verify: `MiniOpOnboardingCard` component should stay mini-op-only
- Old vs new `recordIncomingFulls` — documentation risk: don't use both for the same shipment

---

## 5. Sequencing — v3.2 reshuffle (2026-08-05 pm)

Suneel directive:
- Push **F6 (mobile Deposits filter) + D1 (PDF unit-price)** to Sprint C
- Elevate **F2 grouping + all quick-win reports + Report Builder Phase 1 + Phase 2 + Phase 3** as the immediate next batch

### Sprint A — Delivered so far (~1 day) ✅

- B3 intentFilter dedup plugin (code done, uncommitted)
- B4 CI `migrate deploy` (code done, uncommitted)
- F3 + F9 + F4 Vehicle Ledger rewrite + tests (code done, uncommitted)
- Depot History Amount column + tests (code done, uncommitted)

### Sprint B — Reports & Builder mega-bundle (~18-25 days) ← **NEXT**

**Goal:** ship the entire reports revamp end-to-end in one coherent thread — catalog restructure, all quick-win reports, Report Builder in phases 1→2→3 stacked. Reason: they share the same infrastructure (catalog metadata, allowlist, TanStack query pattern) so building them together is 30-40% cheaper than serialising across sprints.

1. **Chunk 1 (~2-3 days) — F2 grouping restructure:**
   - `ReportCatalogEntry[]` metadata alongside existing `REPORTS` map (flat, with `groups: string[]`)
   - New `GET /api/reports/catalog` route returning group tree + role gates + descriptions
   - Web: replace horizontal chip bar with left-nav shell (collapsible group headers, report list, description tooltip)
   - Mobile: same catalog, tabs → group-picker
   - Migrate existing 8 reports into their canonical groups (Day Book / Financial / Statutory / Ops / Inventory / Customer / etc)
   - Route-layer role gates driven from catalog (single source of truth)
   - **Backwards-compat:** every existing slug still resolves at `/api/reports/:slug` — no client that hardcoded a URL breaks

2. **Chunk 2 (~2 days) — Day Book × 3 new reports:**
   - N20 Day-Close Summary (revenue + cash mix + deliveries + empties + cash-in-hand, signable snapshot)
   - Daily Sales (thin wrapper on `salesSummary` with per-day roll-up instead of per-customer)
   - Daily Driver Movement (new function pulling from `deliveryPerformance` aggregates keyed per day per driver)

3. **Chunk 3 (~2 days) — Quick-win reports batch 1 (7 reports, 0.3-0.5 day each):**
   - N06 Purchase Register CSV+PDF
   - N24 Deposit Ledger per Customer
   - N26 Stock-Adjustment Audit Log
   - N32 Expense Register CSV
   - N28 Credit Notes Register
   - N29 Debit Notes Register
   - N31 Opening Balance Certificates Register

4. **Chunk 4 (~3 days) — Quick-win reports batch 2 (6 reports, 0.5 day each):**
   - N17 Payment Method Mix
   - N19 Rate Variance / Discount Leakage
   - N21 Cash Book
   - N25 Customer Activity Report
   - N27 Delivery Challan PDF (real schema gap)
   - N33 Expenses-by-Category Trend
   - N34 Accountability Log Report

5. **Chunk 5 (~2 days) — Medium reports batch (3 reports, 1 day each may split):**
   - N10 Cylinder Rotation (needs `CustomerInventoryBalance` snapshot walk)
   - N12 Route/Driver Performance (uses `DeliveryProof` timestamps)
   - N14 Empties-in-Transit
   - N22 Cashflow Statement
   - N30 Quotations Register + Win/Loss
   - **N18 Customer Profitability** — needs new `Distributor.arInterestRate` setting; light migration + settings UI + report
   - **N23 P&L Preview** — needs accounting-source decision (cash-basis vs accrual); flagged as open-question below

6. **Chunk 6 (~3-4 days) — Report Builder Phase 1: polished templates + saved filters:**
   - Column-visibility toggle per report (client-only, hides columns before CSV export)
   - "Save current filter" + "Load saved filter" (localStorage-only, no server model)
   - Cross-report sticky `dateFrom`/`dateTo` across nav
   - "Recently used" reports quick-list
   - Guard tests for each behavior

7. **Chunk 7 (~8-12 days) — Report Builder Phase 2: single-model true builder:**
   - Schema: `SavedReport` + `SavedReportRun` migration
   - Backend: `services/reportBuilder/` — allowlist per model per role, zod validator, safe Prisma executor (never string-concat SQL, always injects `distributorId`, applies row-level scope for driver/customer/customer_hq)
   - Field allowlist matrix (already designed in F2/F7 research Appendix D)
   - 7 aggregations (sum, count, count_distinct, avg, min, max, running_total)
   - Filter shape (14 operators including presets, between, in, is_null)
   - 6 initial models to build on: Order, Invoice, PaymentTransaction, CustomerLedgerEntry, Expense, PurchaseEntry
   - Web UI: three-panel (model picker → field browser → filter/grouping panel) + live preview + save-as
   - CSV + PDF export
   - 50k row cap + 10s statement timeout + unindexed-filter warning
   - Tests: allowlist enforcement, cross-tenant guard, row-level scope, SQL injection resistance, timeout handling
   - Distributor-wide visibility only in this phase

8. **Chunk 8 (~4-5 days) — Report Builder Phase 3a: pivots + charts:**
   - Add `pivot: { field, cardinalityCap: 20 }` to spec
   - Matrix output `{ rowKeys[], colKeys[], cells }`
   - Chart renderer: bar / line for one measure × one grouping
   - Chart export as PNG (via canvas), embed in PDF

9. **Chunk 9 (~5-7 days) — Report Builder Phase 3b: cross-model joins + role-scoped sharing:**
   - Whitelisted joins (Order + Customer + Driver + Invoice being the primary quartet)
   - Add `sharedWithRoles: string[]` on `SavedReport`
   - Sharing UI (per-role toggle)
   - Distributor-shared template library (mini_op admin distributes a standard company template to their tenants)

10. **Chunk 10 (~4-5 days) — Report Builder Phase 3c: scheduling + delivery:**
    - `SavedReportSchedule` model (cron, deliverBy, recipients, format)
    - `packages/api/src/jobs/reportSchedulerJob.ts` — runs cron scheduler, generates report, emails/webhooks it
    - Email delivery via existing SMTP infra (`emailService`)
    - Webhook delivery (POST to configured URL)
    - Web UI for creating + managing schedules

**Sprint B total: ~30-40 working days for the full Report Builder mega-bundle + all reports.** MVP scope (Chunks 1-7, drops Phase 3) = ~20-25 days.

### Sprint C — Deferred UX + Consistency (~1 week)

- **F6 Mobile Deposits customer filter** (1-2 hr)
- **D1 PDF unit-price alignment** using route a′ (4 hr)
- Billing #4 — dead button cleanup (5 min)
- Update `SUPERADMIN-BILLING-AUDIT.md` resolved header

### Sprint D — Full F1 Defective + F8 Supplier Ledger (~15-18 days)

11. **Chunks 11-12 (~9-11 days) — F1 full completion:**
    - Full `DefectiveCylinderLedger` + `DefectiveReturnBatch` schema
    - All 4 settlement modes wired (credit_note / skip_next_billing / reverse_transaction / no_compensation)
    - Driver-side delivery-modal extension with `defectiveFullsPickedUp`
    - `reconcileVehicle` auto-transition
    - Outgoing-empties modal rewrite (web + mobile) — multi-line + defective panel
    - `Invoice.priorCompensationApplied` column + PDF footer + invoice generator consume
    - Depot fulls columns on `InventorySummary`
    - N01-N04 defective reports (needs `DefectiveReturnBatchItem` join table)
    - Full test suite: settlement math, gating, anti-pattern #24 guards

12. **Chunks 13-14 (~9 days) — F8 full completion:**
    - `PurchaseCreditNote` + `PurchaseLedgerAdjustment` schema + migration
    - Role gate widening on `purchaseEntries` / `purchasePayments` / `sourceDistributors` routes
    - `supplierLedgerService.ts` v2 (Confidence-format shape)
    - `supplierLedgerPdfService.ts` (portrait A4, 7 cols matching Confidence PDF)
    - Web `SuppliersPage.tsx` + `SupplierLedgerPage.tsx` + 4 modals (Payment / Credit Note / Adjustment / Ledger)
    - Mobile parity (extend existing `(admin)/purchases.tsx`)
    - N05, N07, N08, N09 supplier reports

### Sprint E — v1.1 Mobile push track (post-iOS-live)

- N1 Push notifications (2 days)
- **N2 iOS Universal Links** — HARD DEADLINE 2026-08-31 (0.5 day) — **Android half DONE 2026-08-07**, iOS blocked on Apple Team ID
- ~~N4 SSL cert pinning~~ — ✅ **DONE 2026-08-07** (see §SSL-CERT-PINNING AS-BUILT + RUNBOOK-CERT-ROTATION.md; Suneel residuals: cloud build + device test + monitor)
- N6-N15 assorted (per v2 brief)

### Sprint F — Deferred debt (park/pick per Suneel call)

- D2 dedicated reconcile-flow integration test
- D3 B2C reissue docNo bump
- D4 Float-to-Decimal service migration
- D5 Customer ledger live in-app screen view
- D6 `pendingReturns` dead-column cleanup
- N11 Cylinder-Age (schema-heavy — per-cyl serial tracking)
- N15 GST Reconciliation (needs F8)
- N16 GSTR-3B Preview
- F5 Group ledger Change M mirror + per-page subtotals (parked)

**Grand total for the full comprehensive slate: ~35-45 dev-days across 3-4 sprints.**

---

## 6. Consolidated open questions for Suneel (18 items across 4 areas)

Grouped so answering feels like one focused conversation, not a rain of blockers.

### 6.1 F1 Defective Cylinder Tracking (8 questions)

1. **Corporation identity master.** Free-text `corporationName` on `DefectiveReturnBatch` for now, or wait for F8's optional `Corporation` master table to land and FK to it? Recommendation: free-text now, migrate to FK when F8 lands.
2. **Reason enum + free text.** Free text confirmed for v1 — but do you want a suggested-values dropdown (bad seal / low weight / damaged valve / leaking / other) with free-editable text field? Zero cost to add, makes reports usable earlier.
3. **`skip_next_billing` scope.** Consume against 1 invoice or spread across N invoices if credit > 1 invoice's total? Recommendation: mirror deposit-refund behaviour ("consume as much as fits, roll remainder forward").
4. **Corporation credit unit-price.** When we ship defectives back to IOCL, credit at (a) MRP, (b) our cost, (c) fixed reject-return rate per corp? Determines whether `corporationCreditAmount` is free entry / suggested / looked-up.
5. **Reversal window enforcement.** Hard-block `reverse_transaction` after 24h from IRN regardless of GSTR-1 filing status (recommended), or allow up to GSTR-1 cutoff (definitely not recommended)?
6. **Per-customer default settlement policy.** Add `Customer.defaultDefectiveSettlement` field? Adds 30 min but saves office picking same mode 50 times.
7. **Driver-side origination.** Can drivers ORIGINATE reports (not just execute office-created pickups)? Recommendation: yes — driver often first to hear.
8. **`no_compensation` billing.** When driver swaps 1-for-1 at pickup, is that swap billed on a separate order (customer paid fresh), or is it a free replacement (customer doesn't pay)? Determines whether `no_compensation` needs any money-side wiring.

### 6.2 F2 Reports Grouping + Report Builder (5 questions)

9. **Landing page.** Reports opens on Day Book (ops default), Financial (finance default), or role-adaptive?
10. **Cross-listing.** Delivery Performance in both Day Book AND Operations, or once with a "Related" chip? Recommendation: once canonical + Related chip.
11. **N18 Customer Profitability AR interest.** Pull from new `Distributor.arInterestRate` setting (default 12% p.a.) or per-run filter?
12. **Report Builder scheduling.** V1 requirement (Suneel mentioned "clients can do whatever reports they want") or Phase 3 later?
13. **Customer-facing Report Builder.** Should customer / customer_hq see the Builder at all (with aggressive allowlist) or internal-only?

### 6.3 F8 Supplier Ledger (5 questions)

14. **Role expansion.** distributor_admin gets full supplier ledger + purchases + CN + adjustments, OR strictly mini-op with just a nicer format? All planning above assumes former.
15. **PCN allocation semantics.** When PCN is allocated to Invoice X, does Invoice X's outstanding go down (recommended, matches Confidence PDF implication) OR does PCN only reduce supplier overall balance and leave invoice outstanding intact?
16. **Adjustment scope.** Do "manual adjustments" also apply to CUSTOMER-side ledger? Recommendation: supplier-side only for this ticket.
17. **Empties running counter tie-in.** Every "empties returned to Corp X" MUST be captured via `PurchaseEntryItem.emptiesGivenOut` on a Purchase Entry (current model), OR add standalone `SupplierEmptiesReturn` table for empties-only returns without corresponding fulls receipt? Rare but possible in real ops.
18. **Mobile parity urgency.** Ship web-only first, mobile in follow sprint (recommended), OR both simultaneously (adds 1.5 days)?

---

## 7. Recommendations — what to ship, in what order

Given the 35-45 day total scope, I recommend Suneel treats this as **3 releases, not 1**:

### Release 1 (Sprint A, ~1.5 weeks) — "Polish + F9 + F2 + F1 MVP"

Ships everything that doesn't need CN-flow / reverse-transaction / F8-schema:
- B3, B4 (safe green-lit)
- D1 PDF fix (route a′)
- F6 mobile deposits filter
- F3 + F9 + F4 bundle (vehicle ledger rewrite)
- F2 grouping restructure + left-nav + Day Book × 3
- Report Builder Phase 1 (polished templates + saved filters)
- Quick-win reports N06, N24, N26, N32
- F1 MVP (audit trail + `no_compensation` settlement + Depot History tab extension + depot fulls columns)
- Billing #4 dead button cleanup

**All shippable within 2 weeks of Suneel greenlighting.** Low risk. Big user-visible wins (Vehicle Ledger + Reports revamp are the crown jewels of this release).

### Release 2 (Sprint B, ~3-4 weeks) — "F1 Full + F8 Full"

Ships the heavy features:
- F1 full — 3 more settlement modes + driver-side + auto-transition + reports + comprehensive tests
- F8 full — Confidence PDF format + credit notes + adjustments + drill-down + web + mobile

Deep design already done — no more research needed.

### Release 3 (Sprint C, ~2-3 weeks) — "Report Builder Phase 2 + N-series"

Ships:
- Report Builder Phase 2 (single-model true builder)
- N05, N07-N09 supplier reports (needs F8)
- N01-N04 defective reports (needs F1 full)
- Remaining N-series reports on demand

### Release 4 (Sprint D, ~1 week) — "Mobile v1.1 track (per v2 brief)"

- N1 push notifications
- N2 Universal Links + Android App Links (BEFORE Aug 31)
- N4 SSL cert pinning

---

## 8. Files to read at Session-1 start

1. This file — `docs/NEXT-RELEASE-PROPOSAL-V3.md`
2. `CLAUDE.md` PRODUCTION STATE + anti-patterns sections
3. Full F1 research: subagent output referenced in Sprint B planning
4. Full F8 research: same
5. Full F2/F7 research: catalog + Report Builder design
6. F9 (Vehicle Ledger) design: bundled in Sprint A prep
7. `docs/DEPOSIT-LEDGER-HANDOFF.md` — F1 pattern template
8. `docs/INVOICE-NUMBERS-AUDIT.md` — D1 context

TESTING_PROGRESS.md is stale (last update 2026-05-21). Either resurrect or update CLAUDE.md session-start protocol.

---

## Appendices

### Appendix A — `DefectiveCylinderLedger` full Prisma DDL

Full model definition (~300 lines) captured in the F1 research report. Copy-paste ready. Includes:
- `DefectiveCylinderLedger` model (30+ columns, 8 relations, 5 indexes)
- `DefectiveReturnBatch` model
- `DefectiveCylinderStatus` enum (7 values)
- `DefectiveSettlementMode` enum (5 values)
- 3 new `InventoryEventType` values
- 2 new `LedgerEntryType` values
- 3 new `InventorySummary` columns
- 1 new `Customer.defaultDefectiveSettlement` column
- 1 new `Invoice.priorCompensationApplied` column
- Reverse relations on Customer, CylinderType, Order, Invoice, Driver, User, DriverVehicleAssignment, Distributor

### Appendix B — `ReportCatalogEntry` type + example entries

Captured in F2/F7 research Part B. Type shape:
```ts
interface ReportCatalogEntry {
  slug: string;
  label: string;
  groups: ReportGroup[];        // cross-listing support
  subGroup?: string;
  roles: UserRole[];
  filters: FilterKey[];
  requires?: 'customer' | 'driver' | 'vehicle';
  outputs: ('json' | 'csv' | 'pdf' | 'xlsx' | 'xml')[];
  handler?: Function;
  pdfHandler?: Function;
  description?: string;
  new?: boolean;
  deprecated?: boolean;
}
```

### Appendix C — `PurchaseCreditNote` + `PurchaseLedgerAdjustment` full Prisma DDL

Full model definitions captured in F8 research. Copy-paste ready. Both mirror existing `PurchasePayment` conventions (soft-delete, snapshot denorm, numbering prefix, tenant scope).

### Appendix D — Report Builder security allowlist matrix

Full role × model × field allowlist captured in F2/F7 research Part D.1. Enforced in `services/reportBuilder/allowlist.ts` as a static `Record<Model, Record<UserRole, string[]>>`.

---

_End of proposal v3. Ready to convert into per-sprint specs once Suneel answers the 18 questions in §6._
