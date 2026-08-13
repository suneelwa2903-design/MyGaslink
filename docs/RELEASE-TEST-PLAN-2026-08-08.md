# Release Test Plan — 2026-08-08

**Comparing:** last successful push `f7f8a08` → local `a88e27f` (HEAD)
**Delta:** 13 commits · 176 files · ~30,292 insertions / ~1,160 deletions
**Purpose:** exhaustive, role-by-role manual test plan for the entire feature push before it goes to production. Test on **laptop (web) → mobile (Expo) → Android → iOS**.

> How to use this doc: work feature by feature. For each feature, read *What it does*, glance at *Web/Mobile/API changes*, then execute the *Test scenarios* for every role listed. Tick each scenario. A ⛔ means "must fail / be forbidden" — that is a passing test if it correctly refuses.

---

## 0. Test accounts & tenants

| Role | Email | Password | Tenant / notes |
|------|-------|----------|----------------|
| Super Admin | admin@mygaslink.com | Admin@123 | platform; must pick a distributor via top-bar selector |
| Dist Admin (GST OFF) | bhargava@gasagency.com | Distadmin@123 | Bhargava Gas Agency — **dist-001**, gstMode disabled |
| Dist Admin (GST ON) | sharma@gasdist.com | Gstadmin@123 | Sharma Gas Distributors — **dist-002**, GST live, HPCL corp seeded |
| Finance | finance@gasagency.com | Finance@123 | dist-001 |
| Inventory | inventory@gasagency.com | Inventory@123 | dist-001 |
| Driver | raju@gasagency.com | Driver@123 | dist-001 (mobile primary) |
| Customer | royal@kitchen.com | Customer@123 | dist-001 |

Also exercise: **Customer HQ** and **Mini-Operator Admin** where they have their own portals.

## 0.1 Role → page access map (confirmed from `Sidebar.tsx`)

| Page / path | SUPER | DIST_ADMIN | FINANCE | INVENTORY | DRIVER | CUSTOMER | CUST_HQ | MINI_OP |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Analytics (`/app/analytics`) incl. Overview + Reports tabs | ✅ | ✅ | ✅ | ✅ | ✅(web) | — | — | Dashboard tab only |
| Orders (`/app/orders`) | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | ✅ |
| Inventory (`/app/inventory`) — **F1 lives here** | ✅ | ✅ | ✅ | ✅ | — | — | — | ✅ (Stock) |
| Customers | ✅ | ✅ | ✅ | ✅ | — | — | — | ✅ |
| Billing & Payments | ✅ | ✅ | ✅ | ✅ | — | — | — | ✅ |
| Collections | ✅ | ✅ | ✅ | ✅ | — | — | — | — |
| Fleet | ✅ | ✅ | ✅ | ✅ | — | — | — | — |
| Expenses | ✅ | ✅ | ✅ | — | — | — | — | ✅ |
| **Corporations (`/app/corporations`) — F8** | ✅ | ✅ | ✅ | — | — | — | — | (Purchases page) |
| Settings | ✅ | ✅ | ✅ | ✅ | — | — | — | ✅ |
| Distributors / Provider Catalog / Health / Deletions | ✅ | — | — | — | — | — | — | — |
| Customer portal (`/app/customer/*`) | — | — | — | — | — | ✅ | — | — |
| Customer-HQ portal (`/hq/*`) | — | — | — | — | — | — | ✅ | — |

---

## 1. F1 — Defective Cylinder Returns

**Commit:** `7597cce` (feature) + `efa15f7` (schema/types). Migration `20260806120000_f1_defective` (additive).

### What it does (plain)
When a customer hands back a **full** cylinder that is defective (leaky valve, bad seal, low weight, damaged body), the office can now record it in one click and the customer is automatically refunded via a credit note. Previously stock silently drifted and refunds were manual.

Flow: **Inventory → Daily Summary → Defective Return** opens a tabbed modal. On **New Return**, pick the customer → pick the source invoice the cylinder was billed on (only invoices from the **last 90 days**) → enter defective qty per cylinder type → **Record Defective Return & Raise CN**. That single action (a) records the physical movement (defective full leaves the customer, lands in a depot "defective bucket") and (b) auto-raises a **credit note** for exactly what the customer paid (`invoice line totalPrice ÷ qty` — post-discount, GST-inclusive, so it reconciles with their statement). A cumulative guard prevents ever crediting more than the invoice total.

Defective fulls accumulate at the depot. Later, **Record Outgoing Empties** surfaces the defective bucket so defectives ride out to the oil corporation (OMC) on the same challan.

**GST implications:** for a GST-ON tenant (Sharma) issuing to a **B2B** customer, approving the CN fires a NIC credit-note IRN (CRN) in the background (fire-and-forget). **B2C** customers and **GST-OFF** tenants (Bhargava) skip NIC silently but the CN still posts to the ledger.

### Web changes
- **`InventoryPage.tsx`** — Daily Summary gains a **Defective Return** button with an **amber pending-CN badge** (count of `collected` rows, polled 60s). Opens **DefectiveReturnModal** (tabs: New Return / History).
  - *New Return*: customer search → "Source Invoice (last 90 days)" select → per-line qty grid (Cylinder / Rate / Defective qty / Line total, clamped to remaining qty) → Collected Date (default today, max today) → Reason dropdown → Notes → live **CN Preview ₹** → *Record Defective Return & Raise CN* (chains capture then raise-CN; partial-success recoverable via History).
  - *History*: status filter + table (Date / Customer / Src Inv / Cyl / Qty / CN # / CN Amt / Status); `collected` rows show **Raise CN** + **Cancel** buttons.
  - Daily Summary new columns: **Defective Out** (Corporation, `-N` red), **Defective In** (At Customer, `+N` amber), **Defective** closing balance.
  - **Outgoing Empties modal** gains an "include defectives" per-cyl checkbox section (empties recorded first; defective batch is a warning-only follow-up).
  - **Depot History** gains a correlation-based **Defective** column on outgoing rows.
- **`DefectiveReturnsPage.tsx`** (new) — standalone page still routed at `/app/defective-returns` (sidebar chip removed per request; URL access retained).

### Mobile changes
- **`customer-detail.tsx`** — ledger renderer recognizes `entryType === 'defective_collected'`: shows title "Defective Return", amount "—" (stock-only, not a ₹0.00 debit). **No mobile entry screen** — F1 capture/CN/batch is web-only for v1; mobile only *displays* the resulting ledger row.

### API / data changes
- New tables `defective_cylinder_ledger`, `defective_return_batches`; new `InventorySummary` columns `defective_fulls_in/out`, `closing_defective_fulls` (parallel to good-fulls; **`closingFulls` formula untouched**).
- Enums: `DefectiveReturnStatus` (collected→cn_issued→sent_to_corporation→corporation_credit_received, +cancelled); `InventoryEventType` +2; `LedgerEntryType` +`defective_collected`; DocNumberType +`'F'` (batch numbers).
- Routes at `/api/defective-returns` (all tenant-scoped, zod-validated):

| Method + Path | Allowed roles |
|---|---|
| `GET /eligible-invoices` | admin, finance, inventory, mini-op |
| `POST /` (capture) | admin, finance, inventory, mini-op |
| `POST /:id/raise-cn` | admin, finance, mini-op — **inventory ⛔** |
| `POST /:id/cancel` | admin, finance — **inventory & mini-op ⛔** |
| `GET /`, `/pending-count`, `/depot-bucket` | admin, finance, inventory, mini-op |
| `POST /batches` | admin, finance, inventory, mini-op |
| `POST /batches/:id/corp-credit` | admin, finance, mini-op — **inventory ⛔** |

- The `defective_collected` ledger row always has `amountDelta=0`, `invoiceId=null` (stock-only; money lands on the separate `credit_note` row) — protects the credit gate (anti-pattern #24) and empties-owed counts.
- **Regression baseline:** 36 committed tests `defective-returns.test.ts` (T1–T36).

### Test scenarios

**DISTRIBUTOR_ADMIN (primary — run on both Bhargava GST-OFF and Sharma GST-ON):**
1. Happy path (Bhargava): capture 1 defective → CN Preview correct → Record & Raise CN → toast with CN #, History shows **CN issued**. No NIC call.
2. CN amount: open customer ledger (web + mobile Customer Detail) → `defective_collected` row (amount "—") + `credit_note` row `amountDelta = -(totalPrice/qty)`; sum equals the invoice line inclusive amount exactly.
3. Daily Summary: **Defective In +1**, **Closing Defective 1**; **good Fulls closing UNCHANGED**.
4. Multi-cyl-type invoice: qty on 2+ types → N rows, one combined CN, preview = sum.
5. 90-day window: customer with only >90-day invoices → "No invoices in last 90 days"; API capture on stale invoice ⛔ 400.
6. Remaining-qty guard: line qty 3, capture 3 (ok), 4th ⛔ 400 "exceeds remaining 0"; grid clamps input, shows `avail 0/3`.
7. Validation: all qty 0 → button disabled; empty items ⛔; `quantity:0` ⛔; missing customer/invoice ⛔; future `collectedDate` ⛔.
8. Cumulative-CN guard: invoice ₹1000 with prior CN ₹900 → defective CN ₹200 ⛔; ₹100 ✅.
9. CN against PAID invoice: succeeds → carry-forward customer credit; verify on statement.
10. History Raise CN fallback: `collected` row → Raise CN → confirm → flips to CN issued, badge decrements.
11. Cancel before CN: capture → History → Cancel → status `cancelled`, `withCustomerQty` restored, narration "CANCELLED", Daily Summary recomputed down.
12. Cancel after CN: `cn_issued` row → `POST /:id/cancel` ⛔ 400; no Cancel button in UI.
13. Send to corp: `cn_issued` row → Outgoing Empties → tick "include defectives" → submit → empties + defective batch (F-prefixed number); rows → `sent_to_corporation`; **Defective Out -N**, closing down; Depot History outgoing shows Defective count.
14. Empties-succeeds/batch-fails: empties still recorded + warning toast; defectives stay in bucket.
15. Mark corp credit: `POST /batches/:id/corp-credit` amount ≥0 → batch & rows advance; negative ⛔; non-'sent' batch ⛔.
16. Regression: a normal delivery + normal empties return the same day — good-fulls closing & pending-empties unchanged by defective activity.
17. PDF: individual + group ledger PDF → "Def Ret" row shows `-N` in Del Full, subtotal nets it, CN row carries the money.

**DISTRIBUTOR_ADMIN — GST-ON (Sharma):**
18. B2B customer CN → NIC CRN fires (check `gst_api_logs` / CN IRN status). UI does not block.
19. B2C customer CN → CN posts, **no NIC call**, no error.
20. B2B CN GST split matches source invoice line proportion; inclusive total = `perCylRate × qty`.

**FINANCE:** 21. Can capture AND raise CN (repeat 1, 8, 10). 22. Can cancel a `collected` row. 23. Can mark corp credit.

**INVENTORY:** 24. Can capture (`POST /`). 25. **Raise CN ⛔ 403** — capture lands but CN step forbidden; row stays `collected`, appears in pending badge; verify the New-Return one-shot shows the warning toast and hands off. 26. **Cancel ⛔ 403**. 27. Can read history/pending/depot-bucket + create batch; **corp-credit ⛔ 403**.

**MINI_OPERATOR_ADMIN:** 28. Can capture + raise CN + batch + corp-credit. 29. **Cancel ⛔ 403**.

**DRIVER:** 30. Any `/api/defective-returns/*` ⛔ 403; no driver UI exposes it (verify mobile driver app).

**CUSTOMER:** 31. All endpoints ⛔ 403. 32. Read-only: sees `defective_collected` (stock-only, no ₹) + CN reducing balance on their portal/statement.

**CUSTOMER_HQ:** 33. All F1 endpoints ⛔ 403; only downstream ledger/statement effects for child customers (read).

**SUPER_ADMIN:** 34. Must select distributor context; run happy path under dist-001 then dist-002, confirm no data bleed.

**Cross-tenant isolation (critical):**
35. dist-001 admin capturing for a dist-002 customer ⛔ 404 "Customer not found".
36. Valid dist-001 customer + foreign `sourceInvoiceId` ⛔ 404.
37. raise-CN / batch with foreign `defectiveIds` ⛔ 404.
38. `POST /:id/raise-cn` where URL id ∉ body `defectiveIds` ⛔ 400.

**Data integrity:** 39. Credit gate (`computeCustomerOverdue`) unchanged after capture (no accidental block/unblock). 40. Empties-owed counts not polluted by defective decrement. 41. `closingFulls` (WI-106) untouched through capture→batch.

---

## 2. F8 — Corporation Ledger (OMC / Supplier)

**Commit:** `2d3c4ea` + `efa15f7` (schema). Migrations `20260806140000_f8_supplier`, `20260806160000_f8v2_corp` (additive).

### What it does (plain)
Every distributor buys filled cylinders from an **OMC / "Corporation"** (IOCL, HPCL, BPCL…). Just as the app tracks what each customer owes, the **Corporation Ledger** tracks the account the distributor runs **with** the OMC — one running-balance statement per corporation folding in: filled cylinders in (purchase invoices), empties/defectives out (ERV), cylinder deposits paid, payments made, OMC credit notes (incentives/freight reimbursements) and OMC debit notes (short-supply, damage, interest). At a glance: "how much do I owe HPCL", "how much refundable deposit is with them", "what physically moved". Deposits are a separate refundable pool — they never inflate "gas outstanding".

**Landed cost** is the headline output: the OMC invoice rate is *not* the true per-cylinder cost. Landed = (invoice line + freight + debit-note additions − credit-note offsets) ÷ cylinders received, per cyl-type per month, and **GST-mode aware** — GST-registered tenants strip tax (claimable ITC → GST-exclusive); non-GST tenants keep it (unrecoverable → GST-inclusive). This is the number needed to price sales for a target margin (the "Purchase vs Sale Margin" report).

A **Supplier Statement PDF** (Confidence-format portrait A4: Date/Type/Doc No/Narration/Debit/Credit/Balance/Dr-Cr) can be downloaded. Hard rule throughout: **no invented references** — only the OMC's own document numbers appear; internal auto-numbers (PSHD/FSHD/P-…) stay server-side; blank shows "—".

### Web changes
- **`CorporationLedgerPage.tsx`** (new, routes `/app/corporations` + `/:corpId`) — replaces the Purchases surface for regular tenants. Corp picker (>1 corp) or plain heading (single-OMC direct link) or amber empty-state (0 corps). 4 summary chips (Outstanding / Deposit Balance / Avg Landed per Cyl 30d / Last Activity). Statement PDF button. **+ Add Entry** dropdown (Incoming Fulls / Outgoing Empties / Payment / Credit Note / Debit Note / Deposit). Filter bar (From/To default FY-start→today + entry-type). Money table (8 Confidence columns + totals tfoot). Panels: Physical Activity, Landed Cost (with GST-excl/incl footnote), Deposit Ledger.
- **`components/corporations/CorpEntryModals.tsx`** (new) — `DepositInvoiceModal` (multi-line, forces `documentType=deposit_invoice`), `PaymentModal` (server FIFO allocation), `CreditNoteModal`/`DebitNoteModal` (shared shell + allocation table against outstanding invoices).
- **Reused, not duplicated:** `IncomingFullsModal` + `OutgoingEmptiesModal` imported from `InventoryPage.tsx` (identical modal on both surfaces). *Finding:* the quick Incoming Fulls modal does **not** expose GST% or Plant → entries made there persist `gstRate=0`/`plantName=null` (see A17).
- **`PurchasesPage.tsx`** (mini-op, retained) — Sources tab gains **Record CN** per supplier.
- **`Sidebar.tsx`** — new **Corporations** item for **super_admin / distributor_admin / finance** only (inventory excluded — CN/DN/payment is admin+finance work).
- **`ReportsPage.tsx`** — new **Corporation** report bucket (5 reports).

### Mobile changes
- **None.** F8 is web-only. The pre-existing mobile Purchases tab still reads the older `supplier-balances`/`supplier-ledger` endpoints (backward-compatible; new fields default to 0).

### API / data changes
- Enums: `PurchaseDocumentType` (invoice/deposit_invoice), `PurchaseEntryChargeType`, `PurchaseCreditNoteReason`, `PurchaseDebitNoteReason`.
- Columns: `PurchaseEntry.supplierDocumentNumber/supplierDocumentDate/plantName/documentType`; `PurchaseEntryItem.gstRate`. New tables `PurchaseEntryCharge`, `PurchaseCreditNote(+Allocation)`, `PurchaseDebitNote(+Allocation)` (each `@@unique([distributorId, number])`, allocations must sum to total).
- Routes (all tenant-scoped): `/api/purchase-credit-notes`, `/api/purchase-debit-notes` — **mini-op, admin, finance** (+super); **inventory ⛔**. `/api/purchase-payments` widened same gate + sub-routes (`supplier-balances`, `supplier-ledger/:id`, `.../statement.pdf`, `landed-cost`, `landed-cost/avg/:id`, `outstanding/:id`, `:id/reverse`). `/api/purchase-entries` + `/api/source-distributors` widened same gate. `POST /api/inventory/incoming-fulls` — admin/finance/**inventory**/mini-op (physical action, inventory included). Corp reports via `GET /api/reports/:type` (all 5 staff roles).
- Auto-seed suppliers from `Distributor.providerCodes` on create/update (idempotent).
- **Regression baseline:** `f8-supplier-ledger.test.ts` (23 cases), `mini-operator-scenarios.test.ts` (gate flips).

### Test scenarios

Access summary: **admin/finance** full; **super_admin** full (switch tenant); **mini-op** via Purchases page (not Corporations link); **inventory** can do physical Incoming/Outgoing + run reports, but ⛔ Corporations link/route + all money endpoints; **driver/customer/customer_hq** ⛔ everything.

**DISTRIBUTOR_ADMIN (run on dist-001 GST-OFF and dist-002 GST-ON):**
1. Navigate to Corporations → single-OMC lands directly on ledger; multi-OMC shows picker.
2. Empty-state (no provider codes) → amber notice, no ledger.
3. Record Incoming Fulls (single cyl type): Source hidden+labelled when 1 OMC; enter type/qty/date/rate. Save → **INCOMING** debit row, balance up, Physical Activity qty, Outstanding chip up; Doc No = your reference (never PSHD).
4. Rate↔Amount: enter Amount 42000 qty 20 → unitPrice 2100 derived; both set → Rate wins.
5. Incoming with freight ₹1500 charge → entry debit = line + 1500; Landed Cost shows freight pro-rated.
6. Record Deposit (multi-line, 2 cyl rows + OMC deposit invoice no + plant) → **DEPOSIT** row debit but **running Balance unchanged**; Deposit Balance chip up; landed cost **unaffected**.
7. Record Payment (partial, bank transfer) → **PAYMENT** credit row; balance down; server FIFO-allocated to oldest invoices.
8. Overpay → accepted, residual unallocated, netOutstanding can go negative → Dr flips to **Cr**.
9. Raise Credit Note (OMC CN no, reason volume_incentive, allocate to invoices summing to total) → **CREDIT NOTE** credit row; Landed Cost CN column up → landedPerCyl down.
10. CN allocation sum ≠ total ⛔ (client refine + server 400 ALLOCATION_SUM_MISMATCH).
11. CN duplicate number ⛔ 409.
12. CN allocated to a different OMC's entry ⛔ 400 INVALID_ALLOCATION_TARGET.
13. Raise Debit Note (short_supply) → **DEBIT NOTE** debit; balance up; Landed Cost DN column up → landedPerCyl up.
14. Reverse (delete) a CN → drops from ledger + summary; netOutstanding + landed cost recompute.
15. Ledger correctness: `netOutstanding = totalPurchased + totalDebitNotes − totalPaid − totalCreditNotes`, deposits excluded; tfoot totals match filtered rows.
16. Landed cost GST-OFF (dist-001): footnote "GST-inclusive (ITC not claimed)"; raw prices.
17. Landed cost GST-ON (dist-002): record an entry with per-line gstRate via the mini-op purchase-entry path (quick modal writes gstRate=0) → footnote "GST-EXCLUSIVE"; line ÷ (1+rate/100).
18. Filters re-scope table + panels; summary chips remain all-time.
19. Statement PDF → portrait A4; header business/GSTIN; Doc No only OMC refs; Dr where balance>0; summary lines; on-screen ↔ PDF Dr/Cr agree.
20. Corp reports: Landed Cost Trend (+bar chart), Statement Register (running balance), Purchase vs Sale Margin, Supplier Payment Aging (0-30/31-60/61-90/90+), Landed Cost Reconciliation. Scope via Corporation dropdown; CSV export works.

**FINANCE:** 21. Repeat 1,3,6–14,19,20 — identical access (finance in every corp gate; confirmed finance-can-POST-CN).

**INVENTORY:** 22. **No Corporations sidebar link.** 23. Direct `/app/corporations` ⛔ blocked. 24. Record Incoming Fulls / Outgoing Empties via Inventory page ✅ (spawns PurchaseEntry if sourceDistributorId passed). 25. POST purchase-credit-notes / debit-notes / payments / purchase-entries / source-distributors ⛔ 403. 26. Run a corp report ✅.

**MINI_OPERATOR_ADMIN:** 27. Purchases page loads with **Record CN** per supplier; CN allocates to outstanding. 28. No Corporations sidebar/route (regular-tenant surface).

**DRIVER / CUSTOMER / CUSTOMER_HQ:** 29. No sidebar link, no route, **403 on every F8 endpoint**.

**SUPER_ADMIN:** 30. Switch to dist-002 via header → view seeded HPCL corp ledger, run reports scoped to tenant.

**Negative/validation:** 31. CN/DN empty allocations ⛔; negative/zero allocation ⛔; payment ≤0 ⛔; bad date format ⛔; deposit isolation (never in landed cost / netOutstanding); reverse already-reversed payment ⛔ 409.

**Cross-tenant:** 32. dist-001 admin records CN naming dist-002 supplier ⛔ 404. 33. dist-001 CN list never returns dist-002. 34. supplier ledger/balances/reports contain only own-tenant rows. 35. cross-tenant cylinder type on opening-state seed ⛔ 400.

---

## 3. Reports — Bucketed Catalog + N-series + Report Builder + Vehicle Ledger

**Commit:** `3d0192a` + `efa15f7` (saved-reports schema). Migration `20260806000000_saved_reports`.

### What it does (plain)
The Reports area (Analytics → **Reports** tab) was rebuilt around a **left-nav bucketed catalog** — a sticky accordion sidebar with **7 category buckets** (exactly one open at a time; clicking a report auto-expands its parent). Below sits **"My Custom Reports"**. The catalog has **37 role-filtered entries** from `GET /api/reports/catalog` — ~26 brand-new "N-series" reports plus the 8 pre-existing ones (which kept their old URLs, so nothing breaks).

**7 buckets & their new reports:**
- **Daily Book** — Day-Close Summary (end-of-day one-pager), Daily Sales (day-by-day roll-up + revenue chart), Driver Daily Log (per date×driver, expand to per-trip children).
- **Invoicing & Payments** — Credit Notes Register, Debit Notes Register, Opening Balance Certificates (*ignores date filter*), Payment Method Mix, Rate Variance / Discount Leakage.
- **Inventory** — Cylinder Rotation (deposit float + avg-cycle-days), Empties in Transit, Stock Adjustment Audit Log.
- **Customers** — Deposit Ledger per Customer, Accountability Log, Customer Profitability (*editable AR interest rate per run, default 12%*).
- **Corporation** — Landed Cost Trend, Corporation Statement Register, Purchase vs Sale Margin, Supplier Payment Aging, Landed Cost Reconciliation (all OMC-refs only, no PSHD).
- **Expenses** — Expense Register, Driver & Vehicle Cost Breakdown, Expenses by Category (Trend).
- **Month-End** — Cash Book, Cashflow Statement, GST Reconciliation (*finance-only*), GSTR-3B Preview (*finance-only*), + Tally/GST-Filing exports.

**Vehicle-ledger rewrite:** per-trip/per-day physical movement — columns **Dispatched / Delivered / Returned / Empties Returned / Outstanding** where `Returned = Dispatched − Delivered` and `Outstanding = Delivered − Empties Returned`. Identity columns (Date/Vehicle/Driver) sticky-pinned; totals row at bottom. Old "Corporation Loads Received" panel + view selector **removed** (that lives on Inventory → Depot History now).

**Report Builder (saved custom reports):** staff build a one-model report through dropdowns/checkboxes only (never SQL): pick a source (6 models), choose columns, add filters (14 operators + 9 date presets), optionally group + aggregate, live-preview 20 rows, save (private or shared company-wide). A **server-side allowlist** (model × role × field) is authoritative; **inventory sees no money fields**. Every query is tenant-scoped, 50k-row capped, 10s timeout.

### Web changes
- **`ReportsPage.tsx`** (major rewrite) — `ReportsSidebar` accordion (7 buckets, count badges, empty buckets greyed, single-open); "My Custom Reports" + "+ New"; per-report filter row (cylinderType/driver/customer/vehicle/groupBy/entryDate/arInterestRate); own From/To per report (top Analytics date picker hidden on Reports tab); description subtitle; sortable headers (asc→desc→clear, nulls last, totals pinned); null money → em-dash; overdue rows red; special renderers (`UnifiedVehicleLedger` sticky cols, `DriverDailyLogTable` expand, `DeliveryPerformanceTable`); toolbar (Save filter / Delete preset / Columns / Reset dates / CSV / PDF). *Column-hide is on-screen only — CSV exports all columns.*
- **`ReportBuilderPage.tsx`** (new, `/app/report-builder` + `/:id`) — 4 sections: source+columns, filters, group+summarise, preview; visibility Private/Everyone; Save/Delete.
- **`lib/reportPreferences.ts`** (new) — localStorage presets, hidden columns, sticky dates.
- **`routes/index.tsx`** — `/app/reports` → redirects to `/app/analytics`; new `report-builder` route (5 staff roles).

### Mobile changes
- **`(admin)/reports.tsx`** — picker shows **"Bucket · Report"** labels sorted by bucket order; **only inline reports** (Tally/GST/Driver-PDF downloads excluded); optional `allowedKeys` gate; falls back to local labels offline. **No mobile Report Builder / accordion / vehicle-ledger rewrite.**

### API / data changes
- New tables `saved_reports` (spec Json, visibility private/distributor, soft-delete) + `saved_report_runs` (audit).
- `GET /api/reports/catalog` (role-filtered) + generic `GET /api/reports/:reportType` (+`?format=csv`) — 5 staff roles; finance-only for gst-filing-export / gst-reconciliation / gstr-3b-preview.
- Saved-reports CRUD at `/api/saved-reports` (whole router gated to 5 staff roles): list (own + distributor-visible), get, POST create, **PUT/DELETE owner-only**, POST preview, POST `:id/run` (re-validates spec, runs under **caller's** role, logs run).
- **Executor safety:** always injects `distributorId` (never trusts spec) + `deletedAt:null`; no raw SQL, Prisma-only; 50k cap, 10s timeout, 60s cache; grouping by nested field rejected; field-name regex blocks SQL chars.
- **Allowlist:** 6 models (Order/Invoice/PaymentTransaction/CustomerLedgerEntry/Expense/PurchaseEntry); admin/finance/mini-op/super get money fields, **inventory common-only no aggregation**; driver/customer/customer_hq denied (403). `PurchaseEntry.purchaseNumber` deliberately absent (PSHD hidden).
- **Regression baseline:** saved-reports + report-builder + vehicle-ledger + day-close + driver-daily-log test suites.

### Test scenarios

Reports open at Analytics → Reports (`/app/reports` redirects). 5 staff roles see it; **driver/customer/customer_hq ⛔**.

**DISTRIBUTOR_ADMIN (dist-001 GST-OFF and dist-002 GST-ON):**
1. **Accordion:** 7 buckets with count badges; one open at a time; selecting a report auto-expands its parent; clicking open bucket header collapses it.
2. **Daily Book:** Sales Summary (+ chart), Delivery Performance (driver drill + Statement PDF), Vehicle Ledger (§A6 below), Day-Close Summary (sectioned; count-only rows show **— not ₹0**), Daily Sales (per-day + revenue chart + cyl filter), Driver Daily Log (expand driver → per-trip children; On-Time%/Cancel%).
3. **Invoicing & Payments:** CN/DN Registers; **Opening Balance Certificates — narrow the date range and confirm rows STILL show (ignores date filter)**; Payment Method Mix; Rate Variance/Leakage; Outstanding & Aging (31-60/60+ rows red); Payment Collections (`Sale = Paid Earlier + Paid Today + Pending`, has entryDate second range).
4. **Inventory/Customers/Expenses/Corporation/Month-End:** run every report; verify columns/totals/charts; Corporation reports show **no PSHD/FSHD** (OMC refs only); prefer Sharma for GST reports.
5. **Customer Statement:** no customer picked → EmptyState "Select a customer", CSV/PDF disabled; pick customer → running ledger + enabled PDF.
6. **Vehicle Ledger trip attribution:** columns Date|Vehicle|Driver|Trip|Cylinder|Dispatched|Delivered|Returned|Empties Returned|Outstanding; Date/Vehicle/Driver **sticky** on horizontal scroll; `Returned = Dispatched − Delivered`, `Outstanding = Delivered − Empties Returned` (floored at 0); toggle groupBy day↔trip; **TOTAL row** sums; **no Corporation panel / view selector**; godown pickup shows under synthetic GODOWN/"Godown Pickup"; driver+vehicle filters narrow rows.
7. **Customer Profitability:** default AR rate **12%**; worst-margin on top; change to 24% → AR cost ~doubles; 0% → zero; 999 → clamps to 50%.
8. **Sortable/columns/presets/exports:** header sort asc→desc→clear (nulls last, TOTAL pinned); Columns hide 2 (badge "2") — but **CSV still has all columns**; Save filter preset → reload → load restores dates+filters; CSV download `<slug>.csv` with totals; Tally XML + GST Filing xlsx downloads; sticky dates carry across reports; Reset dates restores default.

**FINANCE:** 9. **All 37 entries** incl. finance-only **GST Reconciliation** (godown/B2C-URP/mini-op not flagged), **GSTR-3B Preview** (per-slab + CN/DN adj + net liability), **GST Filing Export**. Corp + Payment Collections identical to admin.

**INVENTORY:** 10. Finance-only trio **absent** (34 entries); Customer Profitability visible. 11. Inventory/Cylinder Rotation/Empties in Transit/Stock Adjustment Audit load. 12. **Report Builder as inventory:** Orders model → "Total Amount" NOT in field list (money hidden); no money field aggregatable; common-field-only spec runs.

**MINI_OPERATOR_ADMIN:** 13. **Tally Export hidden** from sidebar; GST filing/reconciliation/GSTR-3B absent. 14. Builder exposes "Purchases (from OMC)" model → `supplierDocumentNumber` yes, `purchaseNumber` never.

**DRIVER / CUSTOMER / CUSTOMER_HQ:** 15. No Reports nav; `/api/reports/catalog`, `/api/saved-reports`, `/api/saved-reports/preview` all ⛔ 403.

**SUPER_ADMIN:** 16. Select distributor → all 37 visible, scoped to tenant; switch tenant → other tenant's data only.

**Report Builder happy path (admin):** 17. New → Orders → check columns → add filter (Delivery Date preset "This month") → Run preview (20 rows + rowCount+ms) → add group-by Status + Sum of Total Amount → grouped rows → visibility "Everyone" → name → Save (URL → `/:id`) → My Custom Reports shows it with 🏢 → reopen, edit a field, Save, re-run reflects change; a `SavedReportRun` logs on each `/run`.

**Report Builder negative/safety:** 18. Blank filter value → **400 "value is required"** (not 500). 19. Disallowed field for role → 400. 20. Inventory preview with `fields:["totalAmount"]` on Order → 400. 21. Group by `customer.customerName` → 400 "use the FK". 22. No-filter broad query → `meta.capped=true` amber banner / unindexed warning. 23. Corrupt saved spec → `/run` 400 "invalid spec". 24. Field name with quotes/semicolons → zod 400.

**Saved-reports permissions + cross-tenant:** 25. Non-owner PUT/DELETE → 403. 26. Non-owner GET/run a **private** report → 404. 27. Distributor-shared report: user B sees + runs it, **under B's role** (inventory keeps money hidden even if owner is admin). 28. Sharma user cannot GET/run/PUT/DELETE a Bhargava saved report (404); Sharma-built Orders report never returns Bhargava orders.

**Empty-state/edge:** 29. No-data range → "No data…"; builder no-match → "No matching rows…"; Day-Close zero-activity day → sections render with —/0, no crash.

**MOBILE (admin app):** 30. Picker shows "Bucket · Report" sorted by bucket; download-only reports excluded; kill network before catalog loads → falls back to local labels; no mobile Report Builder.

**Regression watch:** OB Certs ignore date filter · null money = — not ₹0 · Vehicle Ledger has no corp panel · mini-op hides Tally · inventory never sees money fields in Builder · `/app/reports` redirects · every old report slug still resolves.

---

## 4. Analytics Overview — Summary / Profit & Stock / Cashflow

**Commit:** `9221f58`.

### What it does (plain)
The Analytics **Overview** tab now has a three-way toggle so the same date-scoped numbers can be read three ways:
- **Summary** — metric cards grouped (Cash / Margin / Cylinders), each date-scoped, click-through to the report it links to, with a raw-data drawer. Every card equals the total on its linked report (guarded by tests — the number can't silently lie).
- **Profit & Stock** — visual flow diagrams on the *same* numbers: a money P&L flow (Revenue → Cost + Margin → Expenses + Net, with %), an aging bar (In-credit → 1–30 → 31–60 → 61–90 → 90+, green→deepening red), a cylinder movement flow (sources → Delivered → returned/available), and a per-SKU table with a totals row.
- **Cashflow** — did the bank actually grow? Cash in (collections + deposits received) vs cash out (paid to Corporation + expenses) = net. **Deposits are treated as refundable (an asset), so they are excluded from P&L** but shown in the cash lens.

### Web changes
- **`AnalyticsPage.tsx`** — Overview sub-view toggle **Summary · Profit & Stock · Cashflow** (internal keys `cards`/`flow`/`cashflow` unchanged).
- **`OverviewFlowDiagram.tsx`** (new) — proportional Sankey diagrams, aging bar, per-SKU table with totals; `OverviewCashflowView` for the cash lens.
- Backend: **`overviewMetricsService.ts`** (new) `getOverviewMetrics(distId, from, to)` → `{ metrics, hasPurchaseData, flow, cashflow }`; **`routes/analytics.ts`** `/overview` + `/overview/raw`.

### Mobile changes
- **None** for this feature (the Overview redesign is web-only). The mobile analytics screens were touched only for date formatting — see §5.

### API / data changes
- Flow metrics summed over the date range (`asOf=range`); snapshot metrics current-state (`asOf=now`). Money flow (revenue/COGS/margin/expenses/net + aging), cylinder flow (per-SKU received/from-godown/delivered/empties), cashflow lens (cash in vs paid-to-Corp + expenses; deposits excluded from P&L).
- **Regression baseline:** `overview-consistency.test.ts` — each card == its report total; flow/snapshot contract; cashflow conservation (cashIn, split sums, net).

### Test scenarios

**DISTRIBUTOR_ADMIN (Bhargava GST-OFF & Sharma GST-ON), FINANCE, INVENTORY** (all reach Analytics → Overview):
1. Overview → **Summary**: cards render grouped; set a date range → values change; note revenue/collected/delivered/etc.
2. Click a card → drill to its linked report (Reports tab preselected). Verify the card value equals the report total for the same range.
3. Open the raw-data drawer on a card → per-row backing data.
4. Toggle **Profit & Stock**: money flow ribbons sum correctly; % labels present; Net = Revenue − Cost − Expenses; aging bar buckets sum to total outstanding and colour green→red; per-SKU table totals row reconciles (e.g. "from godown" column sums as designed).
5. Toggle **Cashflow**: Cash in = collections + deposits received; Cash out = paid to Corporation + expenses; Net = in − out. **Deposits appear in cash-in but NOT in P&L/margin** (cross-check with Summary margin).
6. GST-ON vs GST-OFF: run on both tenants; numbers must tie to the same reports on each tenant (no cross-tenant bleed).
7. **hasPurchaseData=false tenant**: net-margin card hidden (no purchase cost) — confirm no crash, cashflow still renders.
8. Empty range (a date window with no activity): all three views render zeros / empty states, no NaN, no broken ribbons.

**SUPER_ADMIN:** 9. Must select a distributor; repeat 1–5 under dist-001 then dist-002, confirm isolation.
**MINI_OPERATOR_ADMIN:** 10. Sees **Dashboard tab only** — Overview/Reports tabs hidden. ⛔ no Overview.
**DRIVER (web):** 11. Has Analytics in nav but uses mobile; if opened on web, Overview renders read scoped data (low priority).
**CUSTOMER / CUSTOMER_HQ:** 12. ⛔ no Analytics access.

---

## 5. Date standardisation — dd/MM/yyyy everywhere

**Commit:** `a88e27f` (47 files).

### What it does (plain)
Every date **shown** to a user now reads **dd/MM/yyyy** (e.g. `08/08/2026`) and every date-time reads **dd/MM/yyyy, h:mm am/pm**. Before, ~13 mixed formats appeared across the app (`2026-07-12`, `08-07-2026`, `01-Jul-2026`, `7/8/26`…). This is **display-only** — how dates are stored, entered, sent to GST/NIC, exported to Tally, and put in CSV/Excel is unchanged. Null/invalid dates render as `—`.

### Web changes
~28 pages + `DashboardLayout` + `TallySetupPanel` routed through the shared `formatDisplayDate`; `ReportsPage` uses a date-aware `fmtCell` (and also carries the RPT-3 E-Pend column drop, see §7).

### Mobile changes
~14 screens + `theme.ts` use `formatDisplayDate` / `formatDisplayDateTime`.

### API / data changes
- `pdf/pdfLayoutUtils.ts` — `formatDate` + `formatDateCompact` unified to dd/MM/yyyy (invoice/statement PDFs).
- Shared `formatDisplayDate` is **TZ-safe**: bare `YYYY-MM-DD` is parsed by regex (never `new Date(str)`), so no UTC-drift day-shift.
- CI guard `check-display-dates.mjs` bans ad-hoc `toLocaleDateString`/`String(date)`; runs under `pnpm lint`.
- **Regression baseline:** `display-date-format.test.ts` (15 cases); `billing-invoice-pdf.test.ts` updated.

### Test scenarios (run across **web, mobile, Android, iOS**, and **every role**)
1. **View format** — every date on every screen reads dd/MM/yyyy (orders, invoices, payments, ledgers, reports, dashboards, settings, customer portal, HQ portal, driver screens). Spot-check at least: Orders list, Invoice detail, Customer ledger, Reports date columns, Collections, Fleet, Expenses, Deposits.
2. **Date-time format** — timestamps (pending actions, submissions, audit rows) read `dd/MM/yyyy, h:mm am/pm`.
3. **Null dates** — records with no date show `—`, not "Invalid Date" or blank.
4. **Input still works** — every date **picker** (create order delivery date, backdated entry, report filters, payment date) still selects correctly and the value is saved/queried correctly (stored as ISO under the hood). Create an order with a delivery date → reopen → same date shown dd/MM/yyyy.
5. **Midnight IST window (critical)** — between **00:00–05:30 IST**, create an order / payment / assignment with today's date → it must land on **today**, not yesterday. (Anti-pattern #21 — the whole reason for the TZ-safe formatter.)
6. **PDFs** — download invoice PDF, delivery PDF, customer statement (individual + group), supplier/corporation statement → all dates dd/MM/yyyy.
7. **GST unaffected** — on Sharma, generate/inspect an IRN/e-invoice → NIC date fields are still in NIC's required format (NOT dd/MM/yyyy); GST workflow unbroken. (This is the highest-risk area — verify explicitly.)
8. **Tally export unaffected** — export Tally XML → dates still in Tally's expected format.
9. **CSV/Excel export unaffected** — export any report to CSV/Excel → dates in the export are still machine-readable (not necessarily dd/MM/yyyy display strings) so downstream tools parse them.
10. **Android + iOS parity** — repeat 1–4 on both platforms (RN date rendering can differ by locale/OS).

---

## 6. Backdated inventory events + timezone boundaries

**Commit:** `46d57da`. **⚠️ BEHAVIORAL — high impact.**

### What it does (plain)
When an operator records a **backdated order/trip** (a delivery that physically happened earlier, entered after the fact), the system used to write the cylinder movement as a generic `manual_adjustment` event — which every physical-flow report deliberately ignores. So a backdated delivery moved stock **totals** but was **invisible** in Vehicle Ledger, Inventory Movement, Day-Close DELIVERIES, Cylinder Rotation, and Driver Daily Log, and had no trip number (all collapsed into a single "na" bucket).

Now a backdated order/trip emits the **same four events a real delivery does** — `dispatch`, `delivery`, `collection`, `reconciliation_empties_return` — dated on the actual **delivery date**, tagged with **driver name + vehicle number**, with a **trip number** stamped at creation, and the customer's "with-customer" holding updated. It **runs automatically** right after create (operator can't forget the old manual "Apply Adjustment" step). A backfill script repairs already-broken orders.

Secondary TZ fix: the Payments "entry date From" filter parsed the date as UTC midnight, silently dropping payments created 00:00–05:30 IST on the From day — now uses local-TZ boundaries.

### Web / Mobile / API changes
- **API only** (no UI files): `backdatedAdjustmentService.ts` (writes the 4-event chain + vehicle/driver tags + `withCustomerQty`), `backdatedOrderService.ts` (stamps `tripNumber`, auto-applies non-blocking), `backdatedTripService.ts` (applies always, no longer gated on the old checkbox), `paymentService.ts` (local-TZ `entryDateFrom/To`), `shared/schemas` (`tripNumber` optional), `scripts/backfill-backdated-events.ts` (new).
- **Note:** `inventoryService.ts` in this commit also carries adjacent F1/F8 work (defective bucket columns, supplier-ledger spawn) — a separate surface bundled here.

### Test scenarios (DISTRIBUTOR_ADMIN / INVENTORY on Bhargava dist-001, driver Raju + seeded fleet)
1. **Backdated order emits events:** create backdated order (deliveryDate = 3 days ago, driver Raju, seeded vehicle, delivered qty >0 + empties >0). Expect `status=delivered`, `tripNumber=1`, `inventoryAdjustedAt` set; InventoryEvents include dispatch+delivery+collection+reconciliation_empties_return dated 3 days ago with vehicle+driver tags.
2. **Vehicle Ledger attribution:** open Vehicle Ledger for that vehicle, range covering 3 days ago → delivery appears under the correct trip (not "na"); fulls-out + empties-in match. (Was absent before the fix.)
3. **Inventory Movement / Day-Close / Cylinder Rotation:** run for the delivery date → DELIVERIES section + rotation reflect the backdated qty; customer's "with-customer" holding (Cylinder Balances tab) up by `delivered − emptiesReturned`.
4. **Backdated trip auto-applies with checkbox OFF:** create a multi-order backdated trip, driver+vehicle, `tripNumber=2`, do NOT tick `applyInventoryAdjustment`. Expect all orders get `tripNumber=2` + full event chains (behavioral change vs old gated behavior).
5. **Driverless backdated entry:** backdated order with no driver/vehicle → `tripNumber=null` (no orphan trip); stock totals still adjust, no vehicle/driver tag.
6. **Idempotency:** re-run "Apply Adjustment" on an already-applied order ⛔ blocked by `inventoryAdjustedAt`; no duplicate events.
7. **Midnight window (00:00–05:30 IST):** create a backdated order with deliveryDate "yesterday" → events land on the intended day, not one earlier. Also: Payments → entry-date From = today → a payment recorded moments ago in the early-IST window is **included** (was excluded before).
8. **Backfill (staging only):** dry-run `backfill-backdated-events.ts` against pre-fix orders → identifies `manual_adjustment` orders, would rewrite to 4-event shape, no double-apply.

**Regression watch:** the dispatch+delivery **pair** doubles event count — confirm `closingFulls` isn't double-debited; confirm `CustomerInventoryBalance` still reconciles; regression-test incoming-fulls + daily summary independently (bundled F1/F8 code).

---

## 7. Invoice & Delivery-Performance polish (RPT-1/2/3)

**Commit:** `9135e2d`.

### What it does (plain)
- **RPT-1** — the delivery invoice PDF now shows a grey **"empties collected"** summary line under the amount box, so the invoice records cylinders returned.
- **RPT-2** — the **Delivery Performance** report gains an **Empties Split** column and drops the noisy per-customer **E Pend** (pending-empties) lookup.
- **RPT-3** — the full-size report modal is **wider** (`max-w-6xl → max-w-7xl`) so the wider table fits without horizontal scroll.

### Web changes
- `components/ui/Modal.tsx` — `full` size widened to `max-w-7xl`.
- `ReportsPage.tsx` — Delivery Performance E-Pend column dropped (committed with §5 as it also carries date changes).

### API / data changes
- `pdf/invoicePdfService.ts` — empties-collected grey line.
- `reportsService.ts` — Delivery Performance Empties Split; removed pending-empties lookup.
- **Regression baseline:** `driver-statement.test.ts` updated.

### Test scenarios
**DISTRIBUTOR_ADMIN / FINANCE:**
1. Download a delivery invoice PDF where empties were collected → grey "empties collected: N" line appears under the amount; where none collected, verify it's absent or shows 0 as designed.
2. Reports → Delivery Performance → **Empties Split** column present; **E Pend** column gone; totals still correct.
3. Delivery Performance modal opens **wider** — wide table fits without horizontal scroll; Excel export still works and matches on-screen columns.
**DRIVER:** 4. Driver statement PDF unaffected by the removed E-Pend lookup (no regression to driver-facing numbers).

---

## 8. Infra hardening — SSL pinning, CI migrate-deploy, intent-filter dedup, PSHD leak fixes

**Commits:** `a8c9efc` (SSL), `dd39383` (B3/B4), `c356340` (PSHD), `ce6483e` (misc).

### 8a. Mobile SSL certificate pinning (`a8c9efc`) — invisible security hardening
**What:** the mobile app refuses any HTTPS connection to `api.mygaslink.com` unless the cert chain anchors to **Let's Encrypt ISRG root keys** — defeating MITM (captive portals, SSL-inspection proxies, rogue CAs, attacker-installed roots). Done at the OS TLS layer (Android `network_security_config`, iOS `NSPinnedDomains`) via an Expo config plugin, covering all traffic. Pins the 3 ISRG roots (survive LE's 90-day leaf rotations; valid to 2032/2035/2040). **Env-gated: only preview/production builds are pinned — dev & Expo Go are NEVER pinned.** Android has a fail-open expiration (2027-11-01) + CI test 90 days prior. A JS heuristic distinguishes offline vs intercepted via an unpinned CloudFront probe, then shows a blocking screen.
**Files:** `plugins/withSslPinning.js`, `src/lib/pinning.ts`, `src/lib/api.ts` (interceptor), `components/NetworkSecurityScreen.tsx`, `app/_layout.tsx`, `app.json`, `eas.json` (SSL_PINNING=true on preview+production only), `web/public/pinning-status.json` (advisory channel).
**Tests (real device / EAS build — cannot verify from Windows dev):**
1. **Dev build NOT pinned:** Expo Go / dev profile → no `network_security_config.xml`; LAN-IP http API works; sign-in succeeds, no blocking screen.
2. **Pinned build works normally:** preview build over trusted network → sign-in (200/401), lists, images, SSE all work; decode APK → 3 ISRG pins in manifest.
3. **MITM negative:** intercepting proxy in front → TLS refused, zero requests reach impostor; after 2 response-less failures + successful CloudFront probe → full-screen "Secure connection blocked" overlay. Credentials never leave device.
4. **Offline NOT falsely flagged:** airplane mode → probe also fails → **no** blocking screen; normal offline handling.
5. **Retry recovers:** restore network → "Retry connection" → `/health` OK → overlay dismisses.
6. **Incident advisory:** set `pinning-status.json` `pinningAdvisory:"incident"` + message, redeploy web → advisory box renders on blocked device; reset to "ok".
7. **iOS parity (EAS cloud build):** built `Info.plist` has `NSPinnedDomains` for `api.mygaslink.com` with 3 SPKI entries.
8. **Expiration guard:** `sslPinning.test.ts` fails within 90 days of 2027-11-01.
**⚠️ Risk:** a wrong/stale pin set would brick production — verify pins against the live chain before any store release. Never move the API off Let's Encrypt without first shipping an app release with the new root pins (runbook §2d).

### 8b. B3 intent-filter dedup + B4 CI migrate-deploy (`dd39383`)
**What:** B3 — an Expo config plugin collapses duplicate Android App-Links intent filters so `eas update` publishes cleanly (the compiled manifest was always fine; only the EAS JSON-config path was rejected). B4 — CI test step switched from `prisma migrate dev` to `prisma migrate deploy`. **⚠️ Consequence: a push to main now applies pending migrations to production RDS.** Four migrations are pending in this batch (`saved_reports`, `f1_defective_returns`, `f8_supplier_ledger`, `f8v2_corp_ledger`).
**Files:** `plugins/withDedupIntentFilters.js`, `.github/workflows/ci.yml`, `mobile/package.json`, `.claude/launch.json`.
**Tests:**
1. B3: `npx expo config --json | jq '.android.intentFilters | length'` → **1**.
2. B3: `npx expo prebuild --clean --platform android --no-install` then `grep -c 'autoVerify="true"' AndroidManifest.xml` → **1**.
3. B3: `eas update` publishes without "must NOT have duplicate items", no manual strip/restore.
4. B3: tapping an `https://mygaslink.com/...` (and `www.`) link opens the app.
5. B4: CI job runs `db:migrate:prod` → `db:seed` → tests, green on fresh DB.
6. **B4 (critical, staging first):** list the 4 pending migrations, run `prisma migrate deploy` against **staging** RDS, confirm they apply cleanly + idempotently — **only then push to main** (push mutates prod schema).

### 8c. PSHD leak fixes (`c356340`) — mostly cosmetic (display-only)
**What:** "PSHD" is the internal auto-generated `PurchaseEntry.purchaseNumber` — a DB handle, not a real document. The meaningful reference is the OMC's own `supplierDocumentNumber`. The last 3 surfaces still showing the internal number are fixed: mobile Purchases screen, purchase-ledger PDF, Report Builder. Internal number kept only as a non-rendered key; missing OMC ref shows "—". Report Builder drops `purchaseNumber` from **both** client field list and server allowlist.
**Files:** `mobile/(admin)/purchases.tsx`, `api/pdf/purchaseLedgerPdfService.ts`, `api/reportBuilder/allowlist.ts`, `web/ReportBuilderPage.tsx`, guard test `no-internal-refs-corp-ledger.test.ts`.
**Tests (create purchase entries with and without an OMC doc number):**
1. Mobile Purchases list → each entry shows OMC doc number or "—"; **no PSHD string anywhere**.
2. Mobile edit sheet title + Record Payment rows + a11y label → OMC ref or "—"/date, never PSHD.
3. Purchase-ledger PDF → 2nd column header **"Doc No"**; rows show OMC ref or "—"; no `PSHD…` prints.
4. Report Builder (web) → field picker offers **"OMC Document No"**, not "Purchase Number"; run → no internal number.
5. Server allowlist → hand-crafted spec requesting `purchaseNumber` rejected; `supplierDocumentNumber` succeeds.
6. Guard test `no-internal-refs-corp-ledger.test.ts` passes.
**Risk:** confirm a real captured OMC number renders (not just the "—" fallback); confirm no saved report depends on the removed field (would 400).

### 8d. Misc api/web fixes (`ce6483e`)
**What:** triage batch — the headline is the **two-line UTC-date bug** guard (anti-pattern #21): the old CI guard only caught the one-line form; `check-tz-twoline.mjs` now catches the two-statement form (`const d = new Date();` then `d.toISOString().split('T')[0]`). Also a dedicated **contact-form rate limiter** (writes a DB row + sends email per request — previously only the app-wide budget). Plus TZ fixes in tests, a seed-flake fix, F8 supplier auto-seed, and cosmetic web `useMemo` cleanups.
**Files:** `api/customerService.ts` (importOpeningBalances → localTodayISO), `api/scripts/check-tz-twoline.mjs` + `check-tz-patterns.sh`, `api/routes/contact.ts` (contactLimiter: 5/15min prod, 200 otherwise), `api/services/distributorService.ts` (auto-seed suppliers on create/update), test TZ fixes (`driversVehicles.test.ts`, `payment-commitment.test.ts`), `users.test.ts` (seat-flake fix), web `useMemo` cleanups (LoadListDispatchModal, ExpenseCategoriesTab, TallySetupPanel, ExpensesPage, hq/PaymentsPage), `CustomersPage.tsx` (defective ledger badge).
**Tests:**
1. **Contact rate limit (11 rapid submits):** in production-mode API, POST `/api/contact` 11× from one IP → first 5 = 201, 6th+ = **429** `code:'RATE_LIMITED'`; limiter sits before validation; dev/test cap is 200 (suite not throttled).
2. **Opening-balances import date (00:00–05:30 IST):** import → invoice note shows today's local date, not yesterday.
3. **Two-line TZ guard:** `pnpm lint` passes; reintroduce a two-line UTC form → lint fails.
4. **Midnight-window tests:** `payment-commitment.test.ts` + `driversVehicles.test.ts` pass in the 00:00–05:30 IST window (were flaky).
5. **F8 supplier auto-seed:** create a distributor with provider codes (super_admin) → Purchases page shows OMC suppliers pre-seeded; re-save codes → idempotent no dupes.
6. **Web memo cleanups (no visible change):** Load List Dispatch modal, Expense Categories / Tally settings tabs, Expenses page, HQ Payments → render/behave as before, no console warnings.
**Risk:** contact limiter is behavioral for the public form (confirm real users aren't blocked); F8 auto-seed is a new side-effect on distributor create/update (idempotent, failure non-fatal).

---

## 9. Full-regression smoke (run last, all roles)

Automated baseline already green pre-push: **api 2336 · web 30 · mobile 80 (+2 skipped)**; typecheck clean; lint 0 errors (TZ, two-line, display-date, picker guards clean).

Manual smoke per role — log in and confirm no console errors / no blank screens on: Analytics (Dashboard/Overview/Reports), Orders, Inventory (incl. Daily Summary), Customers, Billing & Payments, Collections, Fleet, Expenses, Corporations, Settings — for **super-admin, dist-admin, finance, inventory**; the driver mobile app (orders/trip/offline queue); the customer portal; the customer-HQ portal; and the mini-operator portal.
