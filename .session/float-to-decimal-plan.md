# Float → Decimal Migration Plan (WI-006)

**Status:** PLAN — execution deferred to a dedicated session
**Generated:** 2026-05-06
**Scope:** 35 monetary fields (out of 49 total `Float` fields in `schema.prisma`)
**Estimated effort:** 4-8 hours of careful surgery
**Risk:** High blast radius — touches every monetary calculation in the API and serialization to the web.

## Why this is deferred

Float / IEEE 754 double precision causes rounding drift in money math. Decimal (Postgres `NUMERIC`, Prisma `Decimal`) is the correct type. **However**, executing this migration safely requires:

1. Rewriting every monetary expression in ~10 services from `a + b` (number) to `a.add(b)` (Decimal).
2. Updating mappers/serialization — Prisma serializes Decimal as a string (`"1234.56"`), not a number, so the web client side breaks unless we explicitly convert to number at the API boundary or update the web.
3. All test fixtures + assertions that compare exact numeric values will break.
4. Zod schemas in `packages/shared/src/schemas` need to accept either string-decimals or numbers, with a custom transformer.
5. PDF rendering (PDFKit) needs `.toNumber()` at the last moment.

A half-finished migration where some calculations are Float-arithmetic on Decimal values, or where the web silently parses strings as `NaN`, is **strictly worse** than the current all-Float state.

`work_items.json` has WI-006 marked `blocksLaunch: false`, so this is correctly classified as post-launch hardening. Full execution wants its own session with no other concurrent work.

## Field Inventory

### Migrate to Decimal (35 fields)

| Model | Field | Line | Notes |
|---|---|---|---|
| CustomerCylinderDiscount | `discountPerUnit` | 483 | per-cylinder discount (₹) |
| CustomerLedgerEntry | `amountDelta` | 551 | signed ledger entry |
| CylinderPrice | `price` | 598 | cylinder price (₹) |
| EmptyCylinderPrice | `emptyCylinderPrice` | 613 | empty deposit price (₹) |
| Order | `totalAmount` | 650 | sum of items |
| OrderItem | `unitPrice` | 692 | line unit price |
| OrderItem | `discountPerUnit` | 693 | line discount |
| OrderItem | `totalPrice` | 694 | line total |
| Invoice | `totalAmount` | 834 | invoice total |
| Invoice | `amountPaid` | 835 | accumulated payments |
| Invoice | `outstandingAmount` | 836 | total - amountPaid |
| Invoice | `cgstValue` | 843 | CGST tax amount |
| Invoice | `sgstValue` | 844 | SGST tax amount |
| Invoice | `igstValue` | 845 | IGST tax amount |
| InvoiceItem | `unitPrice` | 876 | |
| InvoiceItem | `discountPerUnit` | 877 | |
| InvoiceItem | `totalPrice` | 879 | |
| CreditNote | `totalAmount` | 891 | |
| DebitNote | `totalAmount` | 910 | |
| PaymentTransaction | `amount` | 931 | |
| PaymentAllocation | `allocatedAmount` | 955 | |
| BillingCycle | `totalAmountExclGst` | 1122 | |
| BillingCycle | `totalGstAmount` | 1123 | |
| BillingCycle | `totalAmountInclGst` | 1124 | |
| BillingItem | `unitPriceExclGst` | 1147 | |
| BillingItem | `discountAmount` | 1149 | |
| BillingItem | `lineTotalExclGst` | 1150 | |
| BillingItem | `lineGstAmount` | 1151 | |
| BillingItem | `lineTotalInclGst` | 1152 | |
| PricingTier | `monthlyPrice` | 1169 | |
| PricingTier | `extraSeatPriceAdmin` | 1178 | |
| PricingTier | `extraSeatPriceDriver` | 1179 | |
| PricingTier | `customerPortalPrice` | 1180 | |
| PricingTier | `gstApiOveragePrice` | 1181 | |
| SeatRequest | `pricePerMonth` | 1221 | nullable |
| AccountabilityLog | `costAmount` | 1276 | |

### Keep as Float (14 fields — non-monetary)

| Model | Field | Reason |
|---|---|---|
| Distributor | `latitude`, `longitude`, `godownLatitude`, `godownLongitude` | GPS coordinates |
| Order | `deliveryLatitude`, `deliveryLongitude` | GPS coordinates |
| CylinderType | `capacity` | KG (physical weight) |
| InvoiceItem | `gstRate` | percentage (0/5/12/18/28) |
| BillingItem | `gstRate` | percentage |
| PricingTier | `quarterlyDiscount`, `halfYearlyDiscount`, `yearlyDiscount` | percentages (0-100) |
| ProviderCatalogCylinderType | `weight` | KG (physical) |

## Migration Steps

### Step 1 — Schema (1 commit)
- Edit `packages/api/prisma/schema.prisma`: change the 35 fields above from `Float` → `Decimal @db.Decimal(18, 2)` (or `(18, 4)` for line totals where rounding matters).
- Generate migration:
  ```
  pnpm --filter @gaslink/api exec prisma migrate dev \
    --name monetary_fields_float_to_decimal --create-only
  ```
  Use `--create-only` to inspect SQL before applying. Verify the migration uses `ALTER COLUMN ... TYPE NUMERIC(18,2) USING ...::NUMERIC(18,2)` rather than dropping and re-adding (which would lose data).
- Apply: `prisma migrate dev` (without `--create-only`).
- `prisma generate` to refresh the client (`Decimal` becomes `Decimal` from `@prisma/client/runtime/library`).

### Step 2 — Services (3-5 commits, one per cluster)
Order by dependency. After each cluster, run `pnpm typecheck` + `pnpm test`.

**Cluster A — invoiceService.ts + paymentService.ts**
The hottest path. Look for every `a + b`, `a - b`, `a * b`, `Math.round`, `.reduce((s, x) => s + x.amount, 0)`. Replace with `Decimal.add/sub/mul`. Replace `Math.round(x * 100) / 100` with `x.toDecimalPlaces(2)`.

**Cluster B — billingService.ts + pricingService.ts + seatRequestService.ts**
Same shape, different table. Watch for `tier.monthlyPrice * count` patterns.

**Cluster C — orderService.ts + customerService.ts (ledger)**
Fewer monetary ops but heavily integrated with invoice creation.

**Cluster D — gst/payloadBuilders.ts + gst/gstService.ts**
WhiteBooks API expects numbers — `.toNumber()` at the boundary. Verify CGST/SGST/IGST math is penny-perfect.

**Cluster E — pdf/* services**
PDFKit needs numbers. `.toNumber()` at the very last moment, after all math is done.

### Step 3 — Mappers (1 commit)
`packages/api/src/utils/mappers.ts`: add a helper that converts every Decimal field on a row to `number` (or `string`) for JSON serialization. Decision needed: **number** is simpler (existing web code keeps working) but loses precision for very large values; **string** is correct but breaks every web `formatCurrency()` call.

Recommended: serialize as **number** at the API boundary because (a) all our amounts fit in `Number.MAX_SAFE_INTEGER`, (b) the web formats with locale anyway, (c) zero web-side changes needed.

### Step 4 — Zod schemas (1 commit)
`packages/shared/src/schemas/index.ts`: replace `z.number()` for monetary inputs with a transformer that accepts `string | number` and outputs Decimal-serializable.

### Step 5 — Tests (1 commit)
Existing tests (especially `billing.test.ts` mark-paid, `payments.test.ts` partial/full payment) compare exact numbers. With number-at-boundary serialization, they should still pass — but verify:
- `billing.test.ts` invoice total = sum of items
- `payments.test.ts` outstanding = total - paid (penny-perfect)
- `gst-invoicing.test.ts` cgstValue + sgstValue ≈ totalAmount * gstRate / 100

### Step 6 — Web side (defer or 1 commit)
If we go with **number-at-boundary** serialization: no web changes needed.
If we go with **string-at-boundary**: every `formatCurrency()` call needs to parse the string first.

### Step 7 — Verification scenarios (no commit, manual check)
After all steps, manually verify the four scenarios called out in the task:
1. Invoice total = sum of line items (no rounding drift)
2. GST amount = base × rate (penny perfect — try an invoice with 18% on ₹1234.56)
3. Payment allocations sum to payment.amount
4. Credit note reduces invoice.outstandingAmount correctly

## Why this isn't WI-006 done

This document is the plan. WI-006 stays `pending` until a dedicated session executes the steps and ships the migration. When that happens, the executor should:

1. Branch off of master (NOT this worktree's branch — too much else here).
2. Work the steps above sequentially with green tests after each cluster.
3. Land as a series of commits, NOT one huge commit.
4. Smoke-test the manual verification scenarios with real data before merging.

## Appendix: Why I'm not doing this in the current session

- Mid-session context budget remaining is finite; one wrong step in this migration silently corrupts every billing calculation until someone notices the drift.
- Other tasks in this session (Batch B/C tests, EAS readiness, pre-launch checklist) deliver real value with bounded risk; this migration trades a bounded-but-large risk for a precision improvement that is **not** a launch blocker per WI-006's `blocksLaunch: false`.
- The plan above is the actual deliverable for now: an executable, reviewable spec a future session (or a different engineer) can pick up cold.
