# RCM Complete Audit — Vanasthali Gas Service

**Date:** 2026-07-10
**Distributor:** Vanasthali Gas Service (`6a749f20-5a82-4b74-9977-51eac69049f2`)
**Action:** Cancelled + reissued 7 B2B invoices inside the 24-hour NIC window to correct GSTR-1 Table 4B → 4A misclassification.
**Root cause fix:** `RegRev: 'Y'` → `'N'` in [packages/api/src/services/gst/payloadBuilders.ts](../packages/api/src/services/gst/payloadBuilders.ts) — pinned by two new guard assertions in [gst-payload-shape.test.ts](../packages/api/src/__tests__/gst-payload-shape.test.ts).

---

## Section 1 — Full cancel verification table (old IRN + old EWB at NIC)

Live GET calls to WhiteBooks/NIC for each of the 7 old documents.

| # | Original Invoice | Old IRN (first 16) | NIC IRN status | Old EWB No | NIC EWB status | Cancelled At (IST) |
|---|---|---|---|---|---|---|
| 1 | IVGS2627000265 | 9a80e9faf27cd3b5… | **CNL** ✓ | 102482289983 | **CNL** ✓ | 2026-07-10 11:04:47 |
| 2 | IVGS2627000270 | 475671516892b550… | **CNL** ✓ | 162482290011 | **CNL** ✓ | 2026-07-10 11:15:36 |
| 3 | IVGS2627000288 | 824291a33e110a47… | **CNL** ✓ | 172482297015 | **CNL** ✓ | 2026-07-10 11:15:40 |
| 4 | IVGS2627000268 | c71440722a3a322b… | **CNL** ✓ | 102482290000 | **CNL** ✓ | 2026-07-10 11:15:43 |
| 5 | IVGS2627000278 | 44bb19331596b787… | **CNL** ✓ | 192482296980 | **CNL** ✓ | 2026-07-10 11:15:47 |
| 6 | IVGS2627000262 | 2b538884a4c75290… | **CNL** ✓ | 192482289964 | **CNL** ✓ | 2026-07-10 11:15:50 |
| 7 | IVGS2627000277 | 4dc446ac907e15f3… | **CNL** ✓ | 182482296974 | **CNL** ✓ | 2026-07-10 11:15:54 |

**Result: 7/7 old IRN cancelled at NIC. 7/7 old EWB cancelled at NIC.** Permanent NIC-side proof that historical B2B/4B rows are dead.

---

## Section 2 — Full reissue table (new IRN + new EWB at NIC, RegRev decoded from signed JWT)

Live GET calls to NIC + JWT decode of the `SignedInvoice` field on each new IRN.

| # | New Invoice | New IRN (first 16) | NIC IRN status | **RegRev in signed JWT** | New EWB No | NIC EWB status | Valid Till | Buyer | Amount |
|---|---|---|---|---|---|---|---|---|---|
| 1 | IVGS2627000290 | 061b92c2114ab0e2… | **ACT** ✓ | **N** ✓ | 192482668361 | **ACT** ✓ | 11/07/2026 23:59 | SRI VENKATA SAI SWAGRUHA FOODS | ₹3,191 |
| 2 | IVGS2627000291 | 3e3951f46be09053… | **ACT** ✓ | **N** ✓ | 182482681071 | **ACT** ✓ | 11/07/2026 23:59 | SILVER PLATE MULTI CUISINE RESTAURANT | ₹6,382 |
| 3 | IVGS2627000292 | de4538442df59402… | **ACT** ✓ | **N** ✓ | 162482681129 | **ACT** ✓ | 11/07/2026 23:59 | SWAAD KITCHEN | ₹9,573 |
| 4 | IVGS2627000293 | 5ecc3662525e300b… | **ACT** ✓ | **N** ✓ | 182482681183 | **ACT** ✓ | 11/07/2026 23:59 | SHAH GHOUSE HOTEL | ₹31,910 |
| 5 | IVGS2627000294 | 14e0d68f48c6f4bc… | **ACT** ✓ | **N** ✓ | 162482681257 | **ACT** ✓ | 11/07/2026 23:59 | KINARA GROUP OF HOTELS PRIVATE LIMITED | ₹25,528 |
| 6 | IVGS2627000295 | 52f2ff45246d4b7d… | **ACT** ✓ | **N** ✓ | 192482681326 | **ACT** ✓ | 11/07/2026 23:59 | SINDURI HOTELS AND RESORTS PVT LTD | ₹54,247 |
| 7 | IVGS2627000296 | 820b1691502c508e… | **ACT** ✓ | **N** ✓ | 142482681389 | **ACT** ✓ | 11/07/2026 23:59 | KINARA GRAND AS RAO NAGAR | ₹63,820 |

**Result: 7/7 new IRN active at NIC. 7/7 new EWB active at NIC. 7/7 RegRev='N' cryptographically signed by NIC.** These 7 invoices will land in **GSTR-1 Table 4A (normal B2B)** at next filing, NOT 4B.

Total value re-classified: **₹1,94,651.00**.

---

## Section 3 — Ledger verification (3-entry pattern per customer)

Each buyer's customer_ledger_entries table shows the same clean pattern:

| Date | Type | Δ ₹ | Narration |
|---|---|---|---|
| 2026-07-09 | `invoice_entry` | **+X** | Invoice IVGS_OLD_ for order OVGS… |
| 2026-07-09 | `adjustment`    | **−X** | RCM correction: Invoice IVGS_OLD_ cancelled — reissue below |
| 2026-07-09 | `invoice_entry` | **+X** | Invoice IVGS_NEW_ for order OVGS… — RCM reissue of IVGS_OLD_ |
| **Net** | | **+X** | (unchanged customer receivable, correctly classified) |

### Actual per-customer values

| # | Buyer | Ledger Δ (+/−/+) | Net owed |
|---|---|---|---|
| 1 | SRI VENKATA SAI SWAGRUHA FOODS | +3,191 / −3,191 / +3,191 | **₹3,191** |
| 2 | SILVER PLATE MULTI CUISINE RESTAURANT | +6,382 / −6,382 / +6,382 | **₹6,382** |
| 3 | SWAAD KITCHEN | +9,573 / −9,573 / +9,573 | **₹9,573** |
| 4 | SHAH GHOUSE HOTEL | +31,910 / −31,910 / +31,910 | **₹31,910** |
| 5 | KINARA GROUP OF HOTELS PRIVATE LIMITED | +25,528 / −25,528 / +25,528 | **₹25,528** |
| 6 | SINDURI HOTELS AND RESORTS PVT LTD | +54,247 / −54,247 / +54,247 | **₹54,247** |
| 7 | KINARA GRAND AS RAO NAGAR | +63,820 / −63,820 / +63,820 | **₹63,820** |
| **Total** | | | **₹1,94,651** |

**Zero double-charge across all 7. Running balance invariant. `entry_date` = 2026-07-09 for every row (matches invoice `issue_date`).**

---

## Section 4 — DB state final snapshot (14 rows: 7 old + 7 new)

```
+----------------+------------+-----------+-----------+-----------+-------------------------+--------------+-------------+----------------------------------------+----------+
| invoice_number | issue_date |  status   |    irn    |    ewb    |       deleted_at        | total_amount | outstanding |                 buyer                  |   vis    |
+----------------+------------+-----------+-----------+-----------+-------------------------+--------------+-------------+----------------------------------------+----------+
| IVGS2627000262 | 2026-07-09 | cancelled | cancelled | cancelled | 2026-07-10 05:45:50.769 |    54247.00 |    54247.00 | SINDURI HOTELS AND RESORTS PVT LTD     | SOFT-DEL |
| IVGS2627000265 | 2026-07-09 | cancelled | cancelled | cancelled | 2026-07-10 05:34:47.441 |     3191.00 |     3191.00 | SRI VENKATA SAI SWAGRUHA FOODS         | SOFT-DEL |
| IVGS2627000268 | 2026-07-09 | cancelled | cancelled | cancelled | 2026-07-10 05:45:43.751 |    31910.00 |    31910.00 | SHAH GHOUSE HOTEL                      | SOFT-DEL |
| IVGS2627000270 | 2026-07-09 | cancelled | cancelled | cancelled | 2026-07-10 05:45:36.820 |     6382.00 |     6382.00 | SILVER PLATE MULTI CUISINE RESTAURANT  | SOFT-DEL |
| IVGS2627000277 | 2026-07-09 | cancelled | cancelled | cancelled | 2026-07-10 05:45:54.222 |    63820.00 |    63820.00 | KINARA GRAND AS RAO NAGAR              | SOFT-DEL |
| IVGS2627000278 | 2026-07-09 | cancelled | cancelled | cancelled | 2026-07-10 05:45:47.302 |    25528.00 |    25528.00 | KINARA GROUP OF HOTELS PRIVATE LIMITED | SOFT-DEL |
| IVGS2627000288 | 2026-07-09 | cancelled | cancelled | cancelled | 2026-07-10 05:45:40.266 |     9573.00 |     9573.00 | SWAAD KITCHEN                          | SOFT-DEL |
| IVGS2627000290 | 2026-07-09 | issued    | success   | active    |                         |     3191.00 |     3191.00 | SRI VENKATA SAI SWAGRUHA FOODS         | LIVE     |
| IVGS2627000291 | 2026-07-09 | issued    | success   | active    |                         |     6382.00 |     6382.00 | SILVER PLATE MULTI CUISINE RESTAURANT  | LIVE     |
| IVGS2627000292 | 2026-07-09 | issued    | success   | active    |                         |     9573.00 |     9573.00 | SWAAD KITCHEN                          | LIVE     |
| IVGS2627000293 | 2026-07-09 | issued    | success   | active    |                         |    31910.00 |    31910.00 | SHAH GHOUSE HOTEL                      | LIVE     |
| IVGS2627000294 | 2026-07-09 | issued    | success   | active    |                         |    25528.00 |    25528.00 | KINARA GROUP OF HOTELS PRIVATE LIMITED | LIVE     |
| IVGS2627000295 | 2026-07-09 | issued    | success   | active    |                         |    54247.00 |    54247.00 | SINDURI HOTELS AND RESORTS PVT LTD     | LIVE     |
| IVGS2627000296 | 2026-07-09 | issued    | success   | active    |                         |    63820.00 |    63820.00 | KINARA GRAND AS RAO NAGAR              | LIVE     |
+----------------+------------+-----------+-----------+-----------+-------------------------+--------------+-------------+----------------------------------------+----------+
```

- **All 7 OLD invoices**: `status=cancelled`, `irn_status=cancelled`, `ewb_status=cancelled`, `deleted_at` set → **SOFT-DEL** (excluded from every "live invoices" query).
- **All 7 NEW invoices**: `status=issued`, `irn_status=success`, `ewb_status=active`, `deleted_at=NULL`, `issue_date=2026-07-09` → **LIVE**.
- **Sum of LIVE outstanding: ₹1,94,651** — matches original total exactly.
- **Sum of SOFT-DEL outstanding: ₹1,94,651** — carried forward from originals but excluded by every reporting view (`deleted_at IS NULL AND status != 'cancelled'`).

---

## Section 5 — Pending GSTR-1 Table 9A amendment list

Vanasthali B2B invoices with `RegRev='Y'` in NIC payloads that are OUTSIDE the 24h cancel window. These CANNOT be cancel-and-reissued (NIC cancel not permitted after 24h + buyer already holds valid IRN/EWB documents). They must be reclassified via **GSTR-1 Table 9A amendment** on the GST portal at next monthly filing.

### Totals

**58 invoices | ₹13,75,174.00 taxable value | ₹2,09,772.24 GST | Return period: 2026-07 (July 2026)**

### Per-buyer subtotals

| Buyer | GSTIN | Invoices | Billed (₹) | GST (₹) |
|---|---|---:|---:|---:|
| KINARA GROUP OF HOTELS PRIVATE LIMITED | 36AALCS0630E1ZM | 10 | 2,61,662.00 | 39,914.52 |
| SHAH GHOUSE HOTEL | 36EMEPM0985A1Z5 | 8 | 2,68,044.00 | 40,888.06 |
| SILVER PLATE MULTI CUISINE RESTAURANT | 36AEMFS5401H1ZY | 8 | 73,393.00 | 11,195.52 |
| SRI VENKATA SAI SWAGRUHA FOODS | 36AEYFS5782F1Z6 | 8 | 76,584.00 | 11,682.30 |
| SWAAD KITCHEN | 36AFCFS7563K1ZG | 8 | 86,157.00 | 13,142.58 |
| SAMEEKSHA HOSPITALITY | 36AFIFS7974Q1ZR | 3 | 2,04,140.00 | 31,140.02 |
| MAHARAJA FOODS | 36AEYPV1051Q1ZH | 3 | 35,101.00 | 5,354.40 |
| MALABAR GOLD LIMITED | 36AADCM9043R1ZS | 3 | 9,573.00 | 1,460.28 |
| SANGAM HOTEL | 36AEQFS2216C1Z5 | 2 | 1,91,397.00 | 29,196.14 |
| SRI BALAJI FOODS | 36ALZPK6071H1ZH | 2 | 31,910.00 | 4,867.64 |
| JOYALUKKAS INDIA LIMITED | 36AABCJ1087G1ZO | 1 | 6,382.00 | 973.52 |
| KINARA GRAND AS RAO NAGAR | 36AALCS0630E1ZM | 1 | 76,584.00 | 11,682.30 |
| SINDURI HOTELS AND RESORTS PVT LTD | 36AAJCS8144B1ZD | 1 | 54,247.00 | 8,274.96 |
| **Total** | — | **58** | **13,75,174.00** | **2,09,772.24** |

### Per-invoice detail

Full per-invoice list is in **[docs/RCM-FINAL-REPORT.xlsx](RCM-FINAL-REPORT.xlsx)**, Sheet 2 "Pending GSTR-1 Table 9A Amendment". Each row carries:
`period | invoice_number | irn | issue_date | buyer | gstin | taxable | cgst | sgst | total_gst | total | Action Required`

**Action Required for every row: "Move 4B → 4A in GSTR-1 Table 9A for 2026-07 return".**

### How to run the amendment

1. Log into the GST portal → GSTR-1 for return period **July 2026**.
2. Open **Table 9A — Amended B2B Invoices**.
3. For each of the 58 invoices in Sheet 2: enter the original invoice number, and edit the **"Reverse Charge"** field from **"Yes" (Y)** to **"No" (N)**. Save.
4. GSTN reclassifies the record from Table 4B to Table 4A silently. No IRN cancel. No credit note. No buyer coordination required for the filing itself.
5. Inform buyers so their CAs don't panic-file based on the pre-amendment 4B view: "Please expect your July GSTR-2B to move these X invoices from 4B (Reverse Charge) to 4A (Normal B2B). We had a classification error that has been corrected. Do NOT self-deposit tax — we already collected CGST+SGST on the invoice."

Estimated portal time: ~5 min per invoice × 58 = ~5 hours (batchable per buyer for efficiency).

---

## Housekeeping / final gates

| Check | Result |
|---|---|
| Full test suite (1790 tests, 159 files) | ✅ pass |
| `git diff --name-only` (only 2 files) | ✅ payloadBuilders.ts + gst-payload-shape.test.ts |
| Prod EC2 `payloadBuilders.ts` restored to committed HEAD (`RegRev: 'Y'`) | ✅ restored |
| Prod EC2 `/tmp/pm2.json` (contained creds) removed | ✅ removed after each SSH block |
| Prod EC2 scripts (`rcm-reissue-*`, `rcm-full-audit.ts`, `rcm-verify-smoketest.ts`, `verify-regrev-sandbox.ts`) | 🧹 cleanup pending — see final push commit |

---

## What the pushed commit contains

**Commit:** `fix(gst): set RegRev='N' for all IRN payloads + guard test`

**Files changed:**
- `packages/api/src/services/gst/payloadBuilders.ts` — RegRev 'Y' → 'N' + doc comment referencing this incident
- `packages/api/src/__tests__/gst-payload-shape.test.ts` — restored guard assertion (B2B + B2C both pin RegRev='N')

**Nothing else in the commit.** Scripts are dev-side probes, uncommitted.

Once merged and deployed, every NEW IRN Vanasthali (and every other distributor) generates will carry `RegRev='N'` at the wire — landing correctly under GSTR-1 Table 4A from day one.
