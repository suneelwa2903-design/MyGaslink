# Deposit Ledger — Handoff (2026-07-31)

## Status: DONE end-to-end. Ready to test on Sharma Gas Distributors.

**Backend:** ✅ Schema migration applied, service+route wired, 14 new tests + all 2042 existing tests passing, anti-pattern audit complete.
**Web UI:** ✅ New "+ Cylinder Deposit / Refund" button + modal on customer LedgerTab, new "Dep Given" column with running total.
**PDF:** ✅ New "Deposits Held" summary line + per-cylinder-type breakdown block below Closing Balance. Only renders when non-zero — zero visual change for customers who don't use the feature.
**Pre-existing test failures:** ✅ All 10 fixed (JS Date pitfall in backdated-order + 2 CRLF regex bugs in ledger-pdf-consistency + 7 users.test seat-contamination).

Local dev servers running:
- Web: http://localhost:5173
- API: http://localhost:5000

Test account: `sharma@gasdist.com` / `Gstadmin@123` (dist-002 Sharma Gas Distributors).

---

## What Was Built

### Commit A — Schema + service (backend)

- **Migration** [`20260731000000_deposit_ledger/migration.sql`](../packages/api/prisma/migrations/20260731000000_deposit_ledger/migration.sql) — 2 new `LedgerEntryType` values (`deposit_charged`, `deposit_refunded`), 2 nullable columns on `customer_ledger_entries` (`cylinder_type_id`, `qty_delta`), 1 partial index.
- **Schema** [`schema.prisma`](../packages/api/prisma/schema.prisma) — enum + `CustomerLedgerEntry` model extension + relation back-link on `CylinderType`.
- **Shared types** [`types/index.ts`](../packages/shared/src/types/index.ts) — `depositGiven` on `CustomerLedgerRow`, `depositBreakdown` on `CustomerLedgerResponse.summary`, `deposit_charged` / `deposit_refunded` in `CustomerLedgerRowKind`, deposit fields on `LedgerEntry`.
- **Shared enum** [`enums/index.ts`](../packages/shared/src/enums/index.ts) — 2 new `LedgerEntryType` members.
- **Shared schema** [`schemas/index.ts`](../packages/shared/src/schemas/index.ts) — `createPaymentSchema` accepts optional `deposits[]`, new `refundDepositSchema`.
- **Payment service** [`paymentService.ts`](../packages/api/src/services/paymentService.ts):
  - `CreatePaymentData.deposits[]` — optional per-cylinder-type deposit metadata.
  - When present: emits companion `deposit_charged` ledger row per entry + reduces `CustomerInventoryBalance.withCustomerQty`.
  - Auto-allocation now **reserves the deposit portion** before consuming payment amount into invoices — prevents "exceeds payment amount" error on customers with open invoices.
  - New `refundDeposit()` — cash path (negative `PaymentTransaction`) or credit-note path (`CreditNote` with `reasonCode='D'`). Restores `withCustomerQty`.
  - `processLedgerEntries` — new case branches decrement `Pend E` on deposit_charged, restore on deposit_refunded, accumulate `depositGivenPerType` for summary.
  - `loadCylinderTypeNamesForLedger()` — new preload for the per-type breakdown display.
- **Route** [`routes/payments.ts`](../packages/api/src/routes/payments.ts) — new `POST /api/payments/refund-deposit/:customerId`. Existing `POST /api/payments` now honors `deposits[]` in the body.
- **Anti-pattern #24 fixes** — [`reportsService.customerStatement`](../packages/api/src/services/reportsService.ts) and [`routes/payments.ts /ledger/:customerId`](../packages/api/src/routes/payments.ts): deposit rows explicitly EXCLUDED from customer-account debit/credit running balance (they're metadata, not money) so nothing double-counts.

### Commit B — Web UI

- **`DepositLedgerModal`** in [`CustomersPage.tsx`](../packages/web/src/pages/CustomersPage.tsx) — single modal handles both charge and refund via a mode toggle.
  - Preloads cylinder types + empty-cylinder prices → auto-fills the ₹ amount from `qty × EmptyCylinderPrice`.
  - Refund flow lets operator pick cash-out or credit-note-against-invoice.
  - Wires to `POST /payments` (charge) or `POST /payments/refund-deposit/:customerId` (refund).
  - Invalidates `customer-ledger`, `customer-payments`, `customer-inventory-balances` on success.
- **`LedgerTab`** — new "+ Cylinder Deposit / Refund" button (top-right), new "Dep Given" column + running total in tfoot. Ledger rows now skip the deposit rows for Debit/Credit calc (anti-pattern #24 guard).

### Commit C — PDF new summary block + per-type breakdown

- [`customerLedgerPdfService.ts`](../packages/api/src/services/pdf/customerLedgerPdfService.ts):
  - `typeLabel` and `groupTypeLabel` gained `deposit_charged` → "Dep Recv" / `deposit_refunded` → "Dep Refnd" cases.
  - New "Deposits Held" line + per-type breakdown block rendered below Closing Balance. **Only renders when `summary.depositBreakdown` has non-zero entries** — customers without deposits get today's exact PDF unchanged.
  - Existing 12 columns unchanged (no landscape flip needed — the summary block sits below the totals row).

### Bonus — 10 pre-existing test failures fixed

- **`backdated-order.test.ts`** — JS Date `setMonth(-1)` overflow when today = 31st. Fix: anchor date to 15 before subtracting month.
- **`ledger-pdf-consistency.test.ts` (2 tests)** — regexes used `\n\s*\}` and `//.*$` — both broken on Windows CRLF because JS regex `.` doesn't match `\r` (line terminator). Fix: drop `$` anchor from strip regex; use `\s` instead of `\n` in the label boundary.
- **`users.test.ts` (7 tests)** — shared-DB contamination pushed dist-001 past the 8-driver-seat cap. Fix: `beforeAll` bumps `PricingTier.driverSeats` for the tenant's plan; `afterAll` restores to seed value.

---

## How to Test on Sharma Gas Distributors

### Setup (2 minutes)

1. Log in at http://localhost:5173 as `sharma@gasdist.com` / `Gstadmin@123`.
2. **Settings → Cylinder Prices** — set **Empty Cylinder Price for 19 KG = 1950** (if not already). Repeat for 5 KG (e.g. 800) and 47.5 KG (e.g. 4500) if you want to test multi-type breakdown.

### Scenario 1 — Charge a deposit (happy path)

1. **Customers** → pick any customer (e.g. "KINARA GROUP OF HOTELS TEST") → click **View** → **Ledger** tab.
2. Click **`+ Cylinder Deposit / Refund`** (top-right).
3. Mode: **Charge Deposit** (default).
4. **Cylinder Type**: pick `19 KG` — dropdown shows `(₹1950/cyl)` beside the name.
5. **Quantity**: enter `3`. Amount auto-fills to `5850`.
6. **Payment Method**: `Cash` (or `UPI`).
7. Click **Charge Deposit**.

**Expected:**
- Toast: "Deposit charged: 3 × 19 KG"
- Ledger table refreshes with 2 NEW rows:
  - `Payment` badge — `Rs. 5,850.00` in Credit column, running Balance drops by 5,850
  - `Deposit Received` badge (info-blue) — Debit/Credit blank, **Dep Given column = Rs. 5,850**
- Table footer's **Dep Given total = Rs. 5,850**
- Existing running Balance NOT double-counted

### Scenario 2 — PDF check

1. Same customer → click **Download PDF** (top-right of Ledger tab).
2. Open the downloaded PDF.

**Expected:**
- Existing 12-column table unchanged.
- Below `Closing Balance: Rs. XX.XX Dr`, new lines:
  - **`Deposits Held: Rs. 5,850.00`** in bold primary color
  - **`19 KG: 3 × Rs. 1,950.00 = Rs. 5,850.00`** in muted style

### Scenario 3 — Refund via cash

1. Same customer → click **`+ Cylinder Deposit / Refund`**.
2. Mode: **Refund Deposit**.
3. Cylinder Type: `19 KG`, Quantity: `1`, Amount: `1950` (auto-fills).
4. Refund Method: `Cash out (negative payment)`.
5. Payment Method: `Cash`.
6. Click **Refund Deposit**.

**Expected:**
- Toast: "Deposit refunded: 1 × 19 KG"
- Ledger table: 2 new rows appear:
  - `Payment` badge — Rs. 1,950 in **Debit** column (cash went out)
  - `Deposit Refunded` badge (warning-yellow) — Debit/Credit blank, **Dep Given column dropped** by 1,950
- Dep Given now = Rs. 3,900 (was 5,850, minus refund 1,950)
- Customer's `withCustomerQty` for 19 KG rises by 1

### Scenario 4 — Refund cap (guard)

1. Try to refund 10 × 19 KG when only 2 are on deposit.
2. Click Refund Deposit.

**Expected:** toast error: `Cannot refund 10 × 19 KG — customer only has 2 on deposit`.

### Scenario 5 — Multi-type breakdown

1. Charge deposit for `19 KG` × 2 = ₹3,900.
2. Then charge deposit for `5 KG` × 3 = ₹2,400.
3. Download PDF.

**Expected:** breakdown block shows **two lines**, one per type:
```
Deposits Held: Rs. 6,300.00
19 KG: 2 × Rs. 1,950.00 = Rs. 3,900.00
5 KG: 3 × Rs. 800.00 = Rs. 2,400.00
```

### Scenario 6 — Anti-pattern #24 sanity check

After running Scenarios 1-3, on the customer's Ledger tab:
- The `Balance` column (Dr/Cr) should reflect ONLY invoice-vs-payment activity — NOT deposit-charged / deposit-refunded amounts.
- Formula: `Balance = Σ(invoice amountDeltas) - Σ(payment amountDeltas)`. The deposit rows show blank Debit/Credit and don't move the Balance figure.
- Compare with `Dep Given` column — those are the SEPARATE running deposit totals.

If Balance and Dep Given are commingled, that's a regression.

### Scenario 7 — Existing invoice + deposit in one payment

1. Customer has an outstanding invoice (e.g. ₹500).
2. `POST /api/payments` (or via UI Record Payment — the field is only wired in the deposit modal for now):
```bash
curl -X POST http://localhost:5000/api/payments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "<customer-id>",
    "amount": 2450,
    "paymentMethod": "cash",
    "transactionDate": "2026-07-31",
    "deposits": [{"cylinderTypeId": "<19KG-id>", "qty": 1, "amount": 1950}]
  }'
```
**Expected:** 500 ₹ auto-allocated to the outstanding invoice, 1,950 ₹ booked as deposit. Neither over-allocates. Ledger shows: `payment_entry -2450`, `deposit_charged +1950` (with qty 1, cyl 19 KG), and the invoice status updated to `paid`.

---

## Ship-blocker Check

Everything green:
- `pnpm test` — 2042 / 2042 passing
- `pnpm typecheck` (api + web) — clean
- `pnpm lint` (api + web) — 0 errors
- Migration applied to local DB, safe additive (2 nullable cols + 2 enum values + 1 index)
- Existing customer statements without deposits — no visual change (verified: PDF only renders "Deposits Held" block when non-zero)

## Rollback

If anything goes sideways, revert this branch. The migration is additive-only:
- Dropping the columns and enum values will orphan any deposit rows you created (they'd fail to deserialize).
- Preferred rollback path: leave the migration in place, revert the SERVICE code — deposit rows just become inert (no UI, no PDF summary block).

## Follow-ups (Sprint next, NOT in this commit)

1. **Add deposit UI to the main Record Payment modal** (currently the deposit lives in its own modal on the customer LedgerTab). Users recording a mixed payment via `/app/billing-payments` don't yet see the deposit fields. The service already supports it — just wire the UI.
2. **Mobile UI** — the finance/admin mobile app doesn't yet show the Dep Given column or a deposit-recording modal. Web-only for v1.
3. **Opening-deposits CSV import** — mass-seed existing customers with historical refundable deposits at go-live. `POST /api/customers/import/opening-deposits` — CSV shape: `customer_name, cylinder_type, deposit_qty, as_of_date`. Not built yet; recommended for the next distributor onboarding.
4. **Mini-op edge case** — if a mini-operator distributor uses the deposit flow (currently gated as `super_admin | distributor_admin | finance | mini_operator_admin`), the seat cap / on-account credit interactions haven't been end-to-end verified with deposits. Add a spec test if this becomes a real use case.

---

## Files Touched (audit trail)

**API (backend):**
- `packages/api/prisma/schema.prisma`
- `packages/api/prisma/migrations/20260731000000_deposit_ledger/migration.sql` (NEW)
- `packages/api/src/services/paymentService.ts`
- `packages/api/src/services/reportsService.ts`
- `packages/api/src/services/pdf/customerLedgerPdfService.ts`
- `packages/api/src/routes/payments.ts`
- `packages/api/src/__tests__/deposit-ledger.test.ts` (NEW — 14 tests)
- `packages/api/src/__tests__/customer-statement-opening-balance.test.ts` (updated for new summary field)
- `packages/api/src/__tests__/backdated-order.test.ts` (JS Date bug fix)
- `packages/api/src/__tests__/ledger-pdf-consistency.test.ts` (CRLF regex fix ×2)
- `packages/api/src/__tests__/users.test.ts` (seat-quota contamination guard)

**Shared:**
- `packages/shared/src/schemas/index.ts`
- `packages/shared/src/types/index.ts`
- `packages/shared/src/enums/index.ts`

**Web:**
- `packages/web/src/pages/CustomersPage.tsx` (LedgerTab column + DepositLedgerModal)
