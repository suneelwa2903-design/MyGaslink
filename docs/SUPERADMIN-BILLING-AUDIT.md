# Super Admin SaaS Billing — Audit

*Audit date: 2026-06-08 — written ahead of the first real distributor billing event on 2026-06-09.*
*Scope: Platform → Distributor SaaS subscription invoicing (NOT the existing distributor → end-customer LPG invoicing under `Invoice`/`InvoiceItem`).*

---

## Executive Summary

- **A dedicated SaaS billing module DOES exist** as a separate data model: `BillingCycle` + `BillingItem` (Prisma tables `gaslink_billing_cycles` / `gaslink_billing_items`) — properly separated from the LPG-customer `Invoice` model. Routes live at `/api/billing/*` and `/api/pricing/billing-invoice/:cycleId`. PDF generation works.
- **The PDF is GST-shaped but NOT GST-compliant.** Three Rule-46 fields are missing/placeholder: (1) supplier GSTIN is hard-coded as the literal string **"PENDING REGISTRATION"** — meaning the very first invoice you send to a distributor tomorrow will show no supplier GSTIN at all and is unusable for the distributor's ITC; (2) supplier legal name in the PDF is "Re-New GasLink" (the product name), not "GasLink Consulting Solutions" (the registered entity); (3) supplier address is absent from the PDF body. The correct GSTIN (`36ABCFG7518A1ZQ`) lives in the LandingPage footer and Terms of Service page — it is NOT wired into the PDF generator.
- **Invoice numbering is NOT a serial sequence.** The number `GLB-{YYYYMM}-{last-6-of-uuid}` is built at PDF-render time from `cycle.id.slice(-6)` — it has no persistence, no uniqueness constraint, no FY rollover, no per-FY continuity, and the same cycle re-downloaded gives the same number while two cycles in the same month can collide on the last 6 hex chars (~1-in-16M but the bigger problem is GST law requires a *continuous, gapless* serial per FY). `BillingCycle` has no `invoiceNumber` column at all.
- **The UI "Generate Billing" button in `BillingPage.tsx` is broken** — it POSTs `/billing/generate` with an empty body but the Zod validator requires `distributorId`, `periodType`, `periodStartDate`, `periodEndDate`. Today the only working path to generate a cycle is `DistributorDetailPage` (or curl/Postman).
- **No GSTR-1 export, no IRN hook, no credit-note flow, no proration logic.** GSTR-1 has to be hand-prepared from the DB for monthly filing. IRN is acceptable to defer (turnover < ₹5cr) but there is no placeholder/seam for wiring WhiteBooks later. Credit notes for downgrades/refunds are 100% absent — you cannot reverse a paid cycle in the UI today.

**Bottom line: do not generate the first real distributor invoice tomorrow without at minimum fixing the supplier-GSTIN/legal-name placeholder and persisting a serial invoice number. Everything else can ship as P1/P2 backlog.**

---

## Section 1 — Module location & data model

### Files

| Layer | Path | Notes |
|---|---|---|
| Prisma schema | `packages/api/prisma/schema.prisma:1277-1323` | `BillingCycle` + `BillingItem` |
| Prisma schema | `packages/api/prisma/schema.prisma:1327-1351` | `PricingTier` (per-plan catalog) |
| Prisma enums | `packages/api/prisma/schema.prisma:190-225` | `BillingPeriodType`, `BillingStatus`, `BillingItemType` |
| Service (calc) | `packages/api/src/services/billingService.ts` | `generateBillingCycle`, `markBillingPaid`, `suspend*` |
| Service (PDF) | `packages/api/src/services/pdf/billingInvoicePdfService.ts` | `generateBillingInvoicePdf` |
| Route — CRUD | `packages/api/src/routes/billing.ts` | mounted at `/api/billing` (`app.ts:110`) |
| Route — PDF | `packages/api/src/routes/pricing.ts:135-146` | `GET /api/pricing/billing-invoice/:cycleId` |
| Web — list | `packages/web/src/pages/BillingPage.tsx` | super-admin + tenant view |
| Web — detail | `packages/web/src/pages/DistributorDetailPage.tsx:99-118` | PDF download button lives here |
| Web — billing settings | `packages/web/src/pages/SettingsPage.tsx:1404` | second PDF-download caller |
| API tests | `packages/api/src/__tests__/billing.test.ts` | 200 lines; covers auth, generate, list, mark-paid, suspend — no PDF / no GST shape assertions |

### Schema (`BillingCycle`, `BillingItem`)

```prisma
// packages/api/prisma/schema.prisma:1277
model BillingCycle {
  id                 String            @id @default(uuid())
  distributorId      String
  periodType         BillingPeriodType
  periodStartDate    DateTime          @db.Date
  periodEndDate      DateTime          @db.Date
  billingStatus      BillingStatus     @default(pending_generation)
  billingTier        BillingTier
  totalAmountExclGst Decimal           @db.Decimal(18, 4)
  totalGstAmount     Decimal           @db.Decimal(18, 4)
  totalAmountInclGst Decimal           @db.Decimal(18, 4)
  invoiceId          String?  // <-- nullable, never populated by code
  dueDate            DateTime? @db.Date
  suspendDate        DateTime? @db.Date
  // NO invoiceNumber column
  // NO invoiceDate column (uses createdAt implicitly)
  // NO placeOfSupply column
  // NO supplierGstin / sellerState column
  // NO reverseCharge / paymentTerms column
  items              BillingItem[]
}

// packages/api/prisma/schema.prisma:1302
model BillingItem {
  hsnCode          String   @default("998314")  // SAC for "Other support services"
  uom              String   @default("NOS")
  gstRate          Float    @default(18)
  // unit price stored EXCLUSIVE of GST (opposite convention to InvoiceItem
  // — that one is INCLUSIVE per anti-pattern #16). Sound choice for SaaS.
}
```

### Multi-tenant safety

- `billingService.listBillingCycles(distributorId, ...)` always scopes by `distributorId`; super_admin without `X-Distributor-Id` correctly sees all (`billing.ts:16-31`).
- `getBillingCycleById` does its own role-check in the route (`billing.ts:39-41`) — super_admin OR owning distributor only.
- `generateBillingCycle` reads supplier (tier) data from `PricingTier` keyed by `distributor.subscriptionPlan` — no cross-tenant leak.
- **No reuse of the LPG `Invoice` model.** Good — that would have been a multi-tenant disaster.

### Route mount

```ts
// packages/api/src/app.ts:110
app.use('/api/billing', authenticate, resolveDistributor, billingRoutes);
```

Note: `requireDistributor` is intentionally skipped here (matches CLAUDE.md anti-pattern #3 comment) because super_admin needs the cross-tenant list. Inside the router, per-handler isolation is enforced.

---

## Section 2 — GST compliance (per Rule 46 of CGST Rules)

Reference: PDF generator at `packages/api/src/services/pdf/billingInvoicePdfService.ts` and the `GASLINK` constant block at line **91-99**.

| Rule 46 mandatory field | Present? | Where / why not |
|---|---|---|
| Supplier name | **PARTIAL** | PDF prints `Re-New GasLink` (`billingInvoicePdfService.ts:92`). Should be **`GasLink Consulting Solutions`** (the partnership firm name from LandingPage `:870` and ToS `:39`). |
| Supplier address | **MISSING** | `GASLINK` constant has no `address` field. The PDF never prints `Bachupally, Hyderabad, Telangana – 500090`. |
| Supplier GSTIN | **MISSING / placeholder** | `billingInvoicePdfService.ts:94` literally says `gstin: 'PENDING REGISTRATION'`. The real GSTIN `36ABCFG7518A1ZQ` lives only in `LandingPage.tsx:871` and `TermsOfServicePage.tsx:39`. **This is the single biggest ship-blocker.** Without it the distributor cannot claim ITC. |
| Supplier state code | **MISSING** | No state-code line on PDF; only `GASLINK.state = 'telangana'` used for intra-state comparison. Should print `State: Telangana (36)`. |
| Recipient name | OK | `drawBillTo` prints `dist.businessName || dist.legalName` (`:411`). |
| Recipient GSTIN | OK | `drawBillTo:195` — prints em-dash if absent. Note: an absent GSTIN means B2C-style billing; flag this to super-admin before issuing. |
| Recipient billing address | OK | `:409` builds `address, city, state, pincode`. |
| Place of supply (state code) | **MISSING** | PDF does not call out POS as a labeled field. It is implicit via the buyer state line — but Rule 46 specifically requires "place of supply along with the name of the State, in the case of a supply in the course of inter-State trade or commerce". |
| Invoice serial number | PARTIAL (non-compliant) | See Section 3 — synthetic, non-persistent, no continuity. |
| Invoice date | OK | Computed at PDF render time (`:421` uses `new Date()`). **WARNING:** invoice date should be persisted alongside the cycle so re-downloads don't drift. Today, every re-download of an unpaid cycle would print a different date. |
| HSN / SAC | OK | `BillingItem.hsnCode` defaulted to `998314` in schema (`:1307`). The product spec also mentions `997331` (software licensing) — confirm with CA which is correct for "SaaS for LPG distribution". 998314 ("IT design and development services") is debatable; 997331 ("Licensing services for the right to use computer software") is arguably more accurate for a per-seat SaaS subscription. |
| Description, quantity, unit, rate | OK | Lines 253-263 print description, hsn, qty, unit price. UOM column is missing from the table header (UOM is in the DB at `BillingItem.uom = 'NOS'` but never rendered). |
| Taxable value | OK | Subtotal printed at `:304`. |
| Tax rate + amount | OK | `gstRate` + `lineGstAmount` printed per row. |
| Intra-state CGST+SGST vs inter-state IGST | PARTIAL | `determineIntraState` (`:103-114`) compares supplier state name (`'telangana'`) to buyer state name. **It does NOT compare GSTIN state codes** (the comment even admits this — "GasLink GSTIN is pending"). For a buyer in Andhra Pradesh whose `Distributor.state` was entered as `'Telangana'` by mistake at onboarding, the PDF would emit CGST+SGST when it should emit IGST. The correct check is `gstin.substring(0,2) === '36'` for supplier-Telangana. |
| Total invoice value in figures | OK | `:331` |
| Total invoice value in words | OK | `numberToWords(cycle.totalAmountInclGst)` at `:336`. |
| Reverse charge flag | **MISSING** | Never printed. For SaaS this should print `Reverse Charge: No`. Auditors flag missing RCM disclosure. |
| Signature / digital signature | PARTIAL | Footer at `:378` says "computer-generated invoice. No signature required." — legally acceptable for B2B GST invoices, BUT Rule 46(q) requires a *signature or digital signature of the supplier or authorised representative*. The "computer-generated" disclaimer alone has been challenged; a placeholder image of an authorised signature (or a clear `Authorised Signatory: ____________` line) is safer. |

### Intra/inter-state logic

```ts
// packages/api/src/services/pdf/billingInvoicePdfService.ts:103-114
function determineIntraState(sellerState, buyerGstin, buyerState): boolean {
  const ss = (sellerState ?? '').trim().toLowerCase();
  const bs = (buyerState ?? '').trim().toLowerCase();
  if (ss.length > 0 && bs.length > 0) return ss === bs;
  return false;  // <-- buyer with no state set defaults to IGST. Fine.
}
```

Issues:
- The `buyerGstin` parameter is accepted but never used. Should be the *primary* discriminator: `buyerGstin?.substring(0,2) === '36'` ⇒ intra-state.
- Free-text state comparison is brittle (`'Telangana'` vs `'TELANGANA'` vs `'TS'` vs `'Telengana'` typo).

### Hard-coded GASLINK constant

```ts
// packages/api/src/services/pdf/billingInvoicePdfService.ts:91-99
const GASLINK = {
  name: 'Re-New GasLink',
  tagline: 'SaaS Platform for LPG Distribution Management',
  gstin: 'PENDING REGISTRATION',   // <-- SHIP BLOCKER
  sac: `SAC: ${GASLINK_SAC} - Online Software Services`,
  state: 'telangana',
  email: 'support@mygaslink.com',
  website: 'www.mygaslink.com',
  // NO address, NO legalName, NO stateCode, NO pan
};
```

---

## Section 3 — Invoice numbering

### What the code does

```ts
// packages/api/src/services/pdf/billingInvoicePdfService.ts:402-406
const yyyy = cycle.periodStartDate.getFullYear();
const mm = String(cycle.periodStartDate.getMonth() + 1).padStart(2, '0');
const seq = cycle.id.slice(-6).toUpperCase();
const invoiceNum = `GLB-${yyyy}${mm}-${seq}`;
```

### Findings

| Property | Status | Note |
|---|---|---|
| Persisted in DB | **NO** | `BillingCycle` has no `invoiceNumber` column. Recomputed at every PDF render. |
| Unique | **WEAK** | `slice(-6)` of a UUID has ~16M possible values per period — collision is theoretically possible across cycles in the same month, especially as the customer base grows. |
| Continuous (no gaps) | **NO** | UUID hex is non-monotonic; numbers will appear "random" to a GST officer. Voided / failed cycles cannot be re-issued under the same number. |
| Restarts on April 1 (FY rollover) | **NO** | Series is keyed off the calendar year, not FY. Rule 46 requires the series to be unique per *financial year* (Apr 1 – Mar 31). |
| Strictly increasing per FY | **NO** | UUID-derived; no ordering relationship between consecutive issues. |
| Per-tenant vs platform-wide | Ambiguous | Should be **platform-wide** (the supplier is GasLink, not each distributor) — and the code does effectively produce a global-ish series, but with no actual sequence guarantee. |

### Side-effect

Because the number is regenerated on every download, an invoice PDF sent on 2026-06-09 and re-downloaded on 2026-07-01 prints the **same** number but a **different** invoice date (`new Date()` at `:421`). That mismatch alone is enough for a CA to reject the document.

### Recommendation

Add an `invoiceNumber String? @unique` and `invoiceDate DateTime?` to `BillingCycle`, populate both atomically in `generateBillingCycle` via the existing `InvoiceCounter` table (already used for LPG invoices — `schema.prisma:918-931`) with a new `type = 'gaslink_billing'` row keyed on platform-wide FY.

---

## Section 4 — PDF generation

### Template

- File: `packages/api/src/services/pdf/billingInvoicePdfService.ts` (478 lines, well-structured).
- Engine: `pdfkit` directly (no React-PDF / no HTML template).
- Layout: A4, 1-page typical, theme color `#0a3d62`, zebra-striped table.
- Helpers: `formatMoney`, `formatDate`, `numberToWords`, `drawBox`, `drawTableHeader`, `drawTextBlock` from `pdfLayoutUtils.js` (shared with the LPG invoice PDF).

### Trigger

- API: `GET /api/pricing/billing-invoice/:cycleId` (`packages/api/src/routes/pricing.ts:135-146`), super_admin only.
- Web call sites: `DistributorDetailPage.tsx:108` and `SettingsPage.tsx:1404`. Both use the shared axios client correctly (per CLAUDE.md anti-pattern #5 — passes auth headers).
- **No "Download PDF" button on the main `BillingPage.tsx`** — only super-admin reaches it via the per-distributor detail page or settings.

### Sample PDF in repo

- None. There is no fixture / snapshot test asserting the rendered fields. A `*-payload-shape.test.ts`-style guard (CLAUDE.md anti-pattern #6) would be valuable.

### Fields rendered (cross-checked against Section 2 table)

Present: supplier name, supplier tagline, supplier email, supplier website, supplier SAC, invoice number, invoice date, period, due date, buyer name, buyer GSTIN, buyer phone, buyer address, item rows (#, description, HSN, qty, unit price, GST%, GST amt, total), subtotal, CGST/SGST or IGST split, grand total, amount-in-words, payment-terms block ("Payment due within 7 days... Bank details will be shared separately"), footer.

**Missing**: supplier GSTIN (placeholder string), supplier address, supplier legal name, supplier PAN, supplier state code, place of supply explicit label, UOM column, reverse-charge flag, authorised-signatory placeholder, bank account / UPI details (the PDF says "Bank details will be shared separately" — meaning every invoice needs an accompanying email; this is bad UX and a GST-best-practice miss).

---

## Section 5 — GSTR-1 export

**There is no GSTR-1 export for the SaaS-billing module.**

Searched the entire repo:
- `Grep "GSTR-1|gstr1|gstr_1|GSTR1"` → only hit is `packages/api/scripts/nic-reissue-tool.ts` (mentions GSTR-1 in a *comment* about the LPG NIC re-issue flow — unrelated to SaaS billing).
- No route under `/api/reports`, `/api/billing`, or `/api/pricing` produces a GSTR-1 B2B sheet.
- `packages/web/src/pages/BillingPage.tsx` has no "Export GSTR-1" button.

For tomorrow's first invoice this is **acceptable** (you have one invoice; copy-paste to the GST portal works). It becomes a problem at ~10+ distributors when manual GSTR-1 preparation gets error-prone.

### What would be needed

A `GET /api/billing/gstr1?month=YYYY-MM` route returning either CSV or JSON in the GSTN B2B sheet shape:
`GSTIN/UIN of Recipient, Receiver Name, Invoice Number, Invoice Date, Invoice Value, Place Of Supply, Reverse Charge, Applicable % of Tax Rate, Invoice Type, E-Commerce GSTIN, Rate, Taxable Value, Cess Amount`.

Source data is all there in `BillingCycle` + `BillingItem` + joined `Distributor` — pure read query.

---

## Section 6 — IRN hook

**There is no IRN hook in the SaaS billing module.**

- `Grep "irn|IRN|EwbDtls|whitebooks"` over `billingService.ts` and `billingInvoicePdfService.ts` → **zero matches**.
- The existing IRN infrastructure (`packages/api/src/services/gst/whitebooksClient.ts`, `gstService.ts`, `payloadBuilders.ts`) is wired exclusively to the LPG `Invoice` model. There is no abstraction or interface either could share.
- `BillingCycle` has no `irn`, `irnStatus`, `ackNo`, `ackDate`, or `irnPayload` columns. To wire IRN later you'd need a fresh schema migration + a parallel set of payload builders (because the SaaS invoice payload is structurally similar but NOT identical to the LPG one — SAC instead of HSN, no e-way-bill at all, single line items).
- Acceptable to defer (turnover < ₹5cr threshold), but flag that retrofitting IRN later will be a **WI-sized** piece of work, not a 1-day patch.

### Minimal seam for later

Add nullable `irn`, `irnStatus`, `irnAckNo`, `irnAckDate`, `irnQrCode` columns to `BillingCycle` now, even if unused. That way the PDF template can already include a placeholder QR area and the cost of the eventual switch is reduced.

---

## Section 7 — Edge cases

| Scenario | Status | Notes |
|---|---|---|
| Monthly cycle | OK | `multiplier = 1`, base test case. |
| Quarterly / half-yearly / yearly | OK | `multiplier ∈ {3, 6, 12}` (`billingService.ts:171-174`). Period discount applied via `tier.{quarterlyDiscount, halfYearlyDiscount, yearlyDiscount}` (`:115-120`). |
| Plan upgrade mid-cycle (proration) | **MISSING** | No proration code anywhere. If a distributor upgrades from `business` to `enterprise` on day 15 of a monthly cycle, the existing cycle continues at the old price; the next cycle starts at the new price. No partial-period credit. |
| Plan downgrade mid-cycle | **MISSING** | Same as above. No refund / credit on downgrade. |
| Cancellation / suspension | PARTIAL | `suspendForOverdueBilling` (`:418`) and `markBillingPaid` (`:392`) toggle `billingSuspended`. There is NO "cancel subscription" flow — only "suspend for non-payment". A distributor who voluntarily cancels has to be handled by setting `gaslinkBillingEnabled = false` manually on the `Distributor` row. |
| Payment reversal / chargeback | **MISSING** | `markBillingPaid` is one-way (`billingStatus = 'paid_billing'`). No "un-mark paid" route. Distributor → status `paid_billing` → cannot be reverted via UI or API. |
| Credit note (GST-compliant CN against a billing cycle) | **MISSING** | No `BillingCreditNote` model. No route. No PDF. Cannot legally refund a paid cycle without one (GST requires CN within 30 Sept of next FY for ITC reversal at the recipient end). |
| Period-discount line item | OK | Renders as a negative line (`billingService.ts:296-304`); shows in the PDF table. |
| GST API overage | OK | Adds a line if `gstUsage.totalCalls > gstApiIncluded` (`:255-269`). |
| Extra-seat charges (approved seat requests) | OK | Sums `SeatRequest.pricePerMonth` across approved seats (`:271-288`). |
| Generating two cycles for the same period | OK | Guarded by `findFirst` on `(distributorId, periodStartDate, periodEndDate)` (`:85-92`) — throws 400. |
| Generating a cycle when GasLink billing is disabled | OK | Throws 400 (`:80`). |
| Distributor without `billingTier` | OK | Throws 400 (`:82`). |
| `BillingPage` "Generate Billing" button | **BROKEN** | `BillingPage.tsx:48` does `apiPost('/billing/generate')` with NO body; the API requires 4 fields. **Today this button always errors.** Generation actually works only from `DistributorDetailPage` or curl. |
| Backdated cycle (period in the past) | OK | No date validation in the Zod schema — super-admin can generate for any date range. Useful for catch-up billing; risky for invoice-number ordering. |
| Multi-FY annual cycle (Mar→Feb) | UNTESTED | The FY-rollover question for invoice numbering becomes ambiguous when one cycle spans two FYs. Currently irrelevant because no real cycles exist; relevant once you sell annual plans starting mid-FY. |

---

## Gaps before tomorrow's onboarding

### Ship-blockers (must fix before issuing the first real invoice)

1. **Supplier GSTIN hard-coded as "PENDING REGISTRATION".** Invoice is unusable for distributor ITC.
   - File: `packages/api/src/services/pdf/billingInvoicePdfService.ts:91-99`
   - Fix sketch: replace the `GASLINK` constant with values pulled from env (`GASLINK_GSTIN`, `GASLINK_LEGAL_NAME`, `GASLINK_ADDRESS`, `GASLINK_STATE`, `GASLINK_PAN`, `GASLINK_SAC`), default to the known production values (`36ABCFG7518A1ZQ`, `GasLink Consulting Solutions`, `Bachupally, Hyderabad, Telangana – 500090`, `Telangana`, `ABCFG7518A`, `998314` — or `997331`, confirm with CA). Fail fast at app start in production if `GASLINK_GSTIN` is unset. Same pattern as `validateEnv()` in `config/index.ts`.

2. **Supplier legal name + address absent from the PDF body.** Rule 46(a) violation.
   - Files: `packages/api/src/services/pdf/billingInvoicePdfService.ts:91-99` (GASLINK constant) and `:118-171` (`drawHeader`).
   - Fix sketch: extend `drawHeader` to print `GASLINK.legalName` on line 1, the product/tagline on line 2, full address on lines 3-4, `GSTIN: ...` + `State: Telangana (36)` + `PAN: ...` + `SAC: 998314` on lines 5-7.

3. **Invoice number is not a serial sequence and is recomputed at every PDF render.** Rule 46(b) violation; same cycle re-downloaded later prints the same number but a different `invoiceDate`.
   - Files:
     - `packages/api/prisma/schema.prisma:1277-1300` — add `invoiceNumber String? @unique @map("invoice_number")` and `invoiceDate DateTime? @map("invoice_date") @db.Date`.
     - `packages/api/src/services/billingService.ts:314-328` — inside `generateBillingCycle`, atomically increment `InvoiceCounter` with `type = 'gaslink_billing'` keyed by FY (Apr 1 – Mar 31), produce `GLB-{FY-short}-{padded-seq}` (e.g. `GLB-2627-000001`), persist both.
     - `packages/api/src/services/pdf/billingInvoicePdfService.ts:402-406` — replace synthetic number with `cycle.invoiceNumber` and use `cycle.invoiceDate` instead of `new Date()`.

4. **`BillingPage.tsx` "Generate Billing" button is broken.** It posts an empty body. If super-admin clicks it tomorrow expecting it to work, they hit a 400.
   - File: `packages/web/src/pages/BillingPage.tsx:47-54`.
   - Fix sketch: either (a) remove the button and direct super-admin to the per-distributor flow, or (b) open a modal that collects `distributorId` (dropdown from `/distributors`), `periodType`, `periodStartDate`, `periodEndDate`, then posts. Option (b) is ~30 LOC.

5. **Intra-state vs inter-state determined by free-text state-name comparison, GSTIN ignored.** A distributor row with `state = 'Telangana'` typo'd as `'Telengana'` would silently switch to IGST. With one distributor tomorrow this is recoverable; still a 10-minute fix worth doing now.
   - File: `packages/api/src/services/pdf/billingInvoicePdfService.ts:103-114`.
   - Fix sketch: `return (buyerGstin && supplierGstin) ? buyerGstin.slice(0,2) === supplierGstin.slice(0,2) : ss === bs;`

### Post-launch fixes (acceptable to defer past 2026-06-09)

| # | Item | File hint | Effort |
|---|---|---|---|
| 6 | Add `Reverse Charge: No` line and `Authorised Signatory` placeholder | `billingInvoicePdfService.ts:280-340` | 15 min |
| 7 | Add UOM column to items table | `billingInvoicePdfService.ts:78-87` (COL_DEFS) | 20 min |
| 8 | Add labeled `Place of Supply: {state} ({code})` row above items table | `billingInvoicePdfService.ts:173-206` | 20 min |
| 9 | Confirm HSN/SAC code: 998314 vs 997331 with CA, then change schema default | `schema.prisma:1307` | 5 min code, decision externally-driven |
| 10 | Print bank account / UPI / payment instructions on the PDF instead of "shared separately" | `billingInvoicePdfService.ts:342-367` | 30 min + env vars |
| 11 | GSTR-1 export endpoint + button (CSV in GSTN B2B sheet format) | new file under `routes/billing.ts` | 0.5 day |
| 12 | "Un-mark paid" / payment reversal route + audit log entry | `billingService.ts`, `routes/billing.ts` | 0.5 day |
| 13 | Billing credit note model + flow (`BillingCreditNote` table, route, PDF) | new schema + service + pdf | 1.5 days |
| 14 | Proration on plan upgrade/downgrade mid-cycle | `billingService.ts` + UI flow on plan-change | 1-2 days |
| 15 | Voluntary "Cancel Subscription" flow distinct from "Suspend for overdue" | `billingService.ts:418-442` + UI button | 0.5 day |
| 16 | Nullable IRN columns + WhiteBooks hook (`irn`, `irnStatus`, `ackNo`, `ackDate`, `irnQrCode`) on `BillingCycle` | `schema.prisma:1277-1300` + new payload builder mirroring `gst/payloadBuilders.ts` | 2-3 days when turnover approaches ₹5cr |
| 17 | PDF snapshot test fixture (`gst-saas-invoice-shape.test.ts`) asserting all Rule-46 fields render | `packages/api/src/__tests__/` | 1-2 hours, prevents regressions on this list |
| 18 | Persist `invoiceDate` separately from `createdAt` and let super-admin override for backdated cycles | `schema.prisma:1277` + `billingService.ts:314` | 30 min (subsumed by ship-blocker #3) |

### Suggested order tomorrow morning (≤ 2 hours of work to ship-block-clear)

1. (15 min) Set the four env vars + replace the `GASLINK` constant with env reads — fixes #1 and #2 mechanically.
2. (45 min) Add `invoiceNumber` + `invoiceDate` columns + the `InvoiceCounter` increment in `generateBillingCycle` — fixes #3.
3. (10 min) GSTIN-prefix intra-state check — fixes #5.
4. (20 min) Either disable the BillingPage button or wire up the modal — fixes #4.
5. (15 min) Manually generate the dist-001 cycle via `DistributorDetailPage`, download the PDF, eyeball every Rule-46 field present.
6. (10 min) Send the PDF to a CA / paralegal for a 1-minute Rule-46 lookover before transmitting to the distributor.

Everything in the "post-launch" table can ride backlog as separate WIs.
