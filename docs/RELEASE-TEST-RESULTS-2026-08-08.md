# Release Test — Execution Results (2026-08-08)

Companion to [RELEASE-TEST-PLAN-2026-08-08.md](RELEASE-TEST-PLAN-2026-08-08.md). I drove the **live dev API** (localhost:5000) against the real dev DB, creating real records you can open on the web UI. Legend: ✅ executed+reconciled · 👁️ you-check-on-UI (record created) · ⚠️ skipped (reason).

## Scorecard
| Feature | Automated result | Key references for your UI check |
|---|---|---|
| §8 F8 Corporation Ledger | ✅ 9/9, reconciled to ₹ | `QA84434-INV-1/DEP-1/PAY-1/CN-1/DN-1` (Sharma→HPCL) |
| §6 Backdated events | ✅ verified (#26 exact) | order `ORD-MSO2JWJ75YQ`, inv `INV-MSO2JWKCYLI` (Bhargava) |
| §1 F1 Defective Returns | ✅ 8/8, reconciled | CN `CN-MSO2LU18HEK` (Bhargava, Spice Garden) |
| §3 Reports (37 catalog) | ✅ 33 render + 2 correct-guards | run each bucket on Sharma |
| §4 Analytics Overview | ✅ 17 metrics + cashflow + flow | Summary / Profit & Stock / Cashflow toggle |
| §5 Dates, §7 RPT-1 PDF, §8 infra | 👁️ your eyes (display/PDF/device) | invoice `INV-MSO2JWKCYLI` PDF for empties line |

Environment: API healthy, DB connected, data preserved. Backend logic separately proven green by the 2,336 automated tests. GST: Sharma dist-002 = **sandbox**, Bhargava dist-001 = **disabled** — no production NIC touched.

---

## §2 — F8 Corporation Ledger ✅ 9/9 PASS · reconciled exactly

Tenant: **Sharma (dist-002) → HPCL**. Run tag **`QA84434`**. Baseline HPCL outstanding ₹1,27,937.09 → after ₹1,40,337.09 (**Δ +12,400.00, matches expected to the rupee**); deposit ₹3,15,000 → ₹3,30,000 (**Δ +15,000, and deposit did NOT inflate outstanding** — separate-pool logic correct).

| # | Scenario | Result | Reference (look up on UI) |
|---|----------|--------|---------------------------|
| F8-1 | Record Incoming Fulls (20 × ₹1180 incl + ₹500 freight, GST 18%) | ✅ PASS | Doc No **`QA84434-INV-1`** · entry `425bf735…` · debit ≈ ₹24,100 |
| F8-2 | Record Deposit invoice (10 × ₹1500, Nil GST) | ✅ PASS | Doc No **`QA84434-DEP-1`** · entry `c89efea5…` · deposit +₹15,000, outstanding unchanged |
| F8-3 | Record Payment ₹10,000 (FIFO auto-allocate) | ✅ PASS | Ref **`QA84434-PAY-1`** · payment `b0ded4c3…` · outstanding −₹10,000 |
| F8-4 | Raise Credit Note ₹2,500 (volume_incentive) | ✅ PASS | CN **`QA84434-CN-1`** · `25d02ed4…` · outstanding −₹2,500, landed-cost CN column +₹2,500 |
| F8-5 | Raise Debit Note ₹800 (short_supply) | ✅ PASS | DN **`QA84434-DN-1`** · `f3e2f19c…` · outstanding +₹800 |
| F8-6 | NEG: CN allocation sum ≠ total → 400 | ✅ PASS | rejected 400 |
| F8-7 | NEG: duplicate CN number → 409 | ✅ PASS | rejected 409 |
| F8-8 | CROSS-TENANT: dist-001 raises CN vs dist-002 OMC → 404 | ✅ PASS | rejected 404 (isolation holds) |
| F8-9 | ROLE GATE: inventory role POST CN → 403 | ✅ PASS | rejected 403 |

### 👁️ You check on the UI (Sharma → **Corporations** → HPCL)
1. The 5 new rows appear in the money ledger with correct Debit/Credit/running Balance, and **Doc No shows the `QA84434-*` references — never an internal PSHD number**.
2. **Deposit** (`QA84434-DEP-1`) shows in the Deposit panel and the Deposit Balance chip (≈₹3,30,000) but is **excluded from Outstanding** (≈₹1,40,337).
3. **Landed Cost panel**: the incoming entry reflects freight +₹500, CN −₹2,500, DN +₹800; footnote should read **GST-EXCLUSIVE** (Sharma is GST sandbox) — verify the per-cyl landed cost stripped the 18% GST.
4. **Statement PDF** (download button): portrait Confidence format, Doc No column = OMC refs only.
5. Summary chips: Outstanding ≈ ₹1,40,337 · Deposit ≈ ₹3,30,000.

*(Note: an earlier partial run left one extra ₹10,000 payment `QA46375-PAY-1` in the HPCL ledger — harmless test data, ignore or delete.)*

---

## §6 — Backdated inventory events ✅ VERIFIED (anti-pattern #26 exact)

Tenant **Bhargava (dist-001)**. Created a backdated delivered order dated **05/08/2026** (driver Raju Kumar, vehicle TS09-CD-5678, trip 1, 10 × 19 KG delivered, 6 empties).

| Reference | What it is |
|---|---|
| **`ORD-MSO2JWJ75YQ`** | the backdated order (status `delivered`, **tripNumber=1**) |
| **`INV-MSO2JWKCYLI`** | its auto-created invoice (₹18,000 = 10 × ₹1,800) |

**Inventory events emitted (verified in DB):** `dispatch` (−10), `delivery` (−10), `collection` (+6), `reconciliation_empties_return` (+6) — **all dated 05/08/2026 (the backdate, not today), all tagged with vehicle TS09-CD-5678 + driver Raju Kumar.** This is exactly the #26 contract (bypass paths must synthesise the full event chain + trip attribution).

### 👁️ You check (Bhargava)
1. **Reports → Vehicle Ledger** (date range incl. 05/08): order shows under **TS09-CD-5678 / trip 1** with Dispatched 10 / Delivered 10 / Empties Returned 6 — **not** the "na" bucket.
2. **Orders** list: `ORD-MSO2JWJ75YQ` present, delivered, dated 05/08/2026 (dd/MM/yyyy).
3. **Inventory → Day-Close / Inventory Movement** for 05/08: the delivery + empties reflected.

---

## §1 — F1 Defective Cylinder Returns ✅ 8/8 PASS · reconciled

Tenant **Bhargava (dist-001)**, source invoice **`INV-MSO2JWKCYLI`** (customer Spice Garden Hotels Ltd).

| # | Scenario | Result | Reference |
|---|----------|--------|-----------|
| F1-0 | Eligible-invoices picker returns minted invoice (<90d) | ✅ PASS | `INV-MSO2JWKCYLI` |
| F1-1 | Capture 2 defective 19 KG → returns cnAmountPreview ₹3,600 | ✅ PASS | defective row `d0f77565` |
| F1-2 | Raise Credit Note | ✅ PASS | **CN `CN-MSO2LU18HEK`** · ₹3,600 |
| F1-L | Ledger split: `credit_note` −₹3,600 (money) + `defective_collected` ₹0 (stock-only) | ✅ PASS | anti-pattern #24 correct |
| F1-I | Inventory: `defective_return_from_customer` −2, summary defective bucket +2, `closingFulls` untouched | ✅ PASS | WI-106 protected |
| F1-N1 | NEG: quantity 0 → 400 | ✅ PASS | |
| F1-N2 | NEG: collectedDate >90 days ago → 400 | ✅ PASS | |
| F1-N3 | CROSS-TENANT: dist-002 customer on dist-001 → 404 | ✅ PASS | isolation holds |
| F1-N5 | ROLE: driver access defective endpoint → 403 | ✅ PASS | |

Per-cyl rate reconciles: `totalPrice/qty` = ₹1,800 → CN = 2 × ₹1,800 = **₹3,600** ✓.

### 👁️ You check (Bhargava → Inventory → Daily Summary)
1. **Defective Return** button shows amber pending badge (there's 1 leftover `collected` row from an earlier run — you'll see it in History as CN-pending).
2. **History tab**: row for CN `CN-MSO2LU18HEK`, status "CN issued", customer Spice Garden Hotels Ltd, 2 × 19 KG, CN Amt ₹3,600.
3. **Daily Summary**: **Defective In +** column shows the captured defectives; Closing Defective bucket populated.
4. **Customer ledger** (Customers → Spice Garden Hotels → ledger, and mobile): the `defective_collected` row shows amount **—** (not ₹0.00) and the CN row reduces the balance by ₹3,600.

---


## §3 — Reports (bucketed catalog) ✅ 33/35 render · 2 correct-guards

Ran every catalog report on Sharma (dist-002), wide date range. All returned 200 with data:

`sales-summary`(48) · `delivery-performance`(77) · `vehicle-ledger`(872) · `day-close-summary`(36) · `daily-sales`(216) · `driver-daily-log`(1793) · `credit-notes-register`(32) · `debit-notes-register`(15) · `opening-balance-certificates-register`(0, ignores date filter) · `payment-method-mix`(8) · `rate-variance-leakage`(14) · `outstanding-aging`(48) · `payment-collections`(94) · `inventory-movement`(80) · `deposit-ledger-by-customer`(30) · `accountability-log-report`(11) · `stock-adjustment-audit-log`(11) · `empties-in-transit`(4) · `cylinder-rotation`(24) · `expense-register`(440) · `driver-vehicle-cost-breakdown`(15) · `expenses-by-category-trend`(21) · `gst-summary`(1853) · `cash-book`(208) · `cashflow-statement`(8) · `gst-reconciliation`(928) · `gstr-3b-preview`(9) · `customer-profitability`(48) · **corp**: `landed-cost-trend`(2) · `statement-register`(3) · `purchase-vs-sale-margin`(2) · `supplier-payment-aging`(1) · `landed-cost-reconciliation`(2)

The 2 non-200s are **correct behavior, not bugs**: `customer-statement` → 400 "customerId required" (needs a customer picked, per design); `delivery-challan-pdf` → download-type (needs PDF format). `tally-export` + `gst-filing-export` skipped (download types).

### 👁️ You check on the UI (Reports tab, Sharma)
Open each of the 7 buckets; confirm accordion (one open at a time), sortable headers, null money renders "—" not ₹0, Vehicle Ledger sticky columns + trip attribution, Opening Balance Certificates ignore the date filter, Customer Profitability AR-rate input (default 12%), CSV export. Corp reports show **no PSHD** internal numbers. GST Reconciliation + GSTR-3B are finance-visible.

## §4 — Analytics Overview ✅ works
`/overview` returns 17 metrics + cashflow (cashIn present) + flow payload. 👁️ Check the **Summary · Profit & Stock · Cashflow** toggle renders; a card value equals its linked report total; cashflow deposits excluded from P&L.

## §5 / §7 / §8 — your eyes (display / PDF / device)
- **§5 Dates** — every date reads dd/MM/yyyy (automated `display-date-format` test passed; CI guard active). Spot-check web + mobile + a PDF.
- **§7 RPT-1** — download the PDF for invoice **`INV-MSO2JWKCYLI`** (has 6 empties collected) → confirm the grey "empties collected" line under the amount box. RPT-2/3: Delivery Performance Empties Split column + wider modal.
- **§8 Infra** — SSL pinning needs a real EAS preview/prod build (not dev); contact-form rate limit (11 rapid submits → 429); PSHD absence on mobile Purchases + purchase-ledger PDF + Report Builder.

---

# FINAL TALLY — everything executed (2026-08-08, round 2)

**Grand total: ~90 scenarios executed via the live API, ALL PASS. Zero bugs.** (Two "fails" during runs were my script's id-parsing; re-verified pass.)

## ✅ DONE — executed & reconciled (with references in your dev DB)

### F8 Corporation Ledger — 21/21 (Sharma → HPCL)
Incoming/Deposit/Payment/CN/DN + reconciled to ₹ (`QA84434-INV-1/DEP-1/PAY-1/CN-1/DN-1`); overpay→Cr, reverse-payment→200, double-reverse→409, reverse-CN→restores, empty-alloc→400, negative→400, payment-0→400, bad-date→400, dup-CN→409, alloc-sum≠total→400, cross-tenant→404, inventory→403, driver→403, customer→403, landed-cost rows returned.

### F1 Defective Returns — 30/30 (Bhargava → Spice Garden)
Capture→CN (`CN-MSO2LU18HEK`), ledger split (defective ₹0 + CN −₹3,600), inventory bucket +2, closingFulls untouched; finance capture+CN (`CN-MSO31OHWB9F`); multi-cyl combined CN (`CN-MSO3KJ0GXNZ`); CN-on-paid-invoice (`CN-MSO3KJ42KB7`); send-to-corp batch (`DR-BATCH-MSO3NDFU`); corp-credit→200 + negative→400; remaining-qty→400, 90-day→400, qty-0→400, missing-fields→400, future-date→400, foreign-invoice→404, foreign-defective-ids→404, cross-tenant-customer→404, url-id∉body→400, cancel-before-CN→200, cancel-again→400; inventory capture-ok, inventory raise-CN→403, inventory cancel→403; driver→403, customer→403.

### Reports + Report Builder — 45 (Sharma + Bhargava)
33 catalog reports render with data; Report Builder: grouped preview, save (`16ab3e08…`, distributor-shared), run, blank-value→400, disallowed-field→400, inventory-money→400, nested-groupby→400, sql-ish-field→400, non-owner GET→404, non-owner PUT→403, finance-runs-shared→200, cross-tenant→404; driver/customer catalog→403, customer preview→403.

### Analytics + Backdated + roles
Overview 17 metrics+cashflow+flow; customer overview→403; backdated order 4-event chain (#26) `ORD-MSO2JWJ75YQ`, driverless→tripNumber null `ORD-MSO3ND65O7N`, re-apply idempotency→409; delivery-performance 77 rows.

## 🔵 NOT DONE — needs your eyes; use THIS reference to complete on the UI

| # | Not-executed (visual/PDF/mobile) | Open this reference on the UI |
|---|---|---|
| 1 | F8 ledger rows / Doc-No-not-PSHD / deposit-panel / landed-cost GST-EXCL footnote / statement PDF | Sharma → **Corporations → HPCL** (refs `QA84434-*`) |
| 2 | F1 History row, Daily Summary Defective columns, customer ledger "—", PDF "Def Ret" row | Bhargava → **Inventory → Daily Summary**; **Customers → Spice Garden**; CN `CN-MSO2LU18HEK` |
| 3 | Invoice PDF grey "empties collected" line | download PDF for **`INV-MSO2JWKCYLI`** (6 empties) |
| 4 | Vehicle Ledger trip attribution (sticky cols, totals) | **Reports → Vehicle Ledger**, find `ORD-MSO2JWJ75YQ` under TS09-CD-5678/trip 1 |
| 5 | Reports accordion, sortable headers, null="—", CSV, OB-certs-ignore-date, Profitability AR-rate | **Analytics → Reports** (each bucket) |
| 6 | Analytics 3-view toggle, card→report drill, deposits-excluded-from-P&L | **Analytics → Overview** |
| 7 | Report Builder web UI (drag/save/share icon) | **/app/report-builder** (saved report `16ab3e08…`) |
| 8 | dd/MM/yyyy on every screen + mobile | spot-check web screens; mobile needs a dev build |
| 9 | Multi-line invoice + paid invoice on UI | `INV-MSO3KIP7MXS` (multi), `INV-MSO3KITT2Z3` (paid) |

## ⚠️ NOT DONE — genuinely can't in this environment (with reason)

| Scenario | Why not | How to complete |
|---|---|---|
| GST B2B/B2C NIC (F1 CN → CRN, dispatch → IRN) | fires **sandbox NIC**; not auto-fired | say "fire the GST sandbox path" and I'll run it |
| Contact-form rate-limit (11→429) | dev cap is **200** (prod cap is 5) | test on production, or I can flip env to prod-mode locally |
| Cumulative-CN guard (CN sum > invoice total) | bounded by remaining-qty guard first | covered by automated test T14 |
| Cross-supplier CN allocation | dist-002 has only **1 OMC** (HPCL) | needs a 2nd OMC seeded |
| Mini-operator scenarios | no mini-op tenant seeded in dev | seed a mini-op tenant |
| SSL pinning, mobile feature screens | need a **dev-client / EAS build** on real hardware | build + install on your device |
| Midnight-IST (00:00–05:30) date tests | time-dependent | check during that window, or fake the clock |
