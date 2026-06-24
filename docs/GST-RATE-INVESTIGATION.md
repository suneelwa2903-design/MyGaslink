# GST Rate Pipeline Investigation

## PHASE 1 - Data Model

### Current State
- InvoiceItem.gstRate: defaults to 18 (hardcoded)
- Customer: NO gstRateOverride field exists
- GST_RATES constants: { CGST: 0.09, SGST: 0.09, IGST: 0.18 } global

FINDING: GST rates are 100% hardcoded with no per-customer configuration.

## PHASE 2 - Tax Calculation Flow

### createInvoiceFromOrder (line 183)
- Hardcodes: gstRate: 18,
- Uses shared constant: basePrice / (1 + GST_RATES.IGST)

### createManualInvoice (line 363)
- Accepts API input: item.gstRate ?? 18
- ONLY path that supports per-item override

FINDING: createInvoiceFromOrder hardcodes 18. Only createManualInvoice allows override.

## PHASE 3 - IRN WhiteBooks Payload

### buildIrnPayload
- Reads: item.gstRate (per-item)
- Emits: GstRt: item.gstRate to NIC
- NO CHANGES NEEDED for rate override support

## PHASE 4 - PDF Invoice

### computeItems
- Reads: item.gstRate or defaults to 18
- Renders: gstRate on PDF output
- NO CHANGES NEEDED for rate override support

## PHASE 5 - GSTR-1 Tally Export

CRITICAL: Mixed rates (18% + 5%) require SEPARATE rows per rate in GSTR-1 Table 12.
Current code: Single Invoice aggregates cgst/sgst/igst; cannot bucket by item rate.

## PHASE 6 - Customer Fields Today

- NO gstRateOverride field in Customer model
- ZERO UI for rate configuration on forms

## PHASE 7 - Impact Surface

Minimum changes:
1. Add gstRateOverride Float? to Customer model
2. Update createInvoiceFromOrder (4-5 lines)
3. Update createManualInvoice (1-2 lines)
4. Add to shared types
5. Add dropdown to customer forms (web + mobile)
6. Add Zod validation

Files affected: schema.prisma, invoiceService.ts, types, routes, web forms, mobile forms
No changes needed: payloadBuilders.ts, invoicePdfService.ts
Future: GSTR-1 bucketing per rate, Tally voucher splitting

## Summary

Q8a: Hardcoded (18% global, no per-customer config)
Q8b: Minimum 4-6 hours (add field + update services + forms + validation)
Q8c: GSTR-1 requires rate bucketing; Tally requires voucher splitting per rate

---

## PASS 2 FINDINGS

Exhaustive hardcode audit + API/UI surface mapping. Run 2026-06-24.

### Task 1 — Hardcoded GST-related numbers

| File | Line | Pattern | Type | Notes |
|---|---|---|---|---|
| `packages/api/prisma/schema.prisma` | 1199 | `gstRate ... @default(18)` | (b) default | `InvoiceItem.gstRate` schema default. Per-line, the canonical store. |
| `packages/api/src/services/invoiceService.ts` | 183 | `gstRate: 18,` | (b) default | `createInvoiceFromOrder` — every cylinder line. **Primary fix site.** |
| `packages/api/src/services/invoiceService.ts` | 225 | `gstRate: 18,` | (b) default | `createInvoiceFromOrder` — transport-charge line. |
| `packages/api/src/services/invoiceService.ts` | 363 | `item.gstRate ?? 18` | (b) default | `createManualInvoice` fallback when caller omits. **Secondary fix site.** |
| `packages/api/src/services/invoiceService.ts` | 838-839 | `0.18 * 100`, `0.09 * 100` | (a) calc | Fallback calc path — verify branch context. |
| `packages/shared/src/constants/index.ts` | 3-8 | `GST_RATES = { CGST: 0.09, SGST: 0.09, IGST: 0.18, CESS: 0 }` | (f) constant | Global, never customer-scoped. Used by inter-state split logic. |
| `packages/api/src/services/pdf/invoicePdfService.ts` | 59 | `item.gstRate \|\| 18` | (b) defensive default | Reads per-line rate; 18 fallback only if record is malformed. |

No display strings of the form `"18%"` / `"CGST 9%"` were found hardcoded — PDF labels compute from `item.gstRate`.

### Task 2 — API write-path routes

| Route | File | Schema | Accepts rate? | Service |
|---|---|---|---|---|
| `POST /api/invoices` (manual) | `packages/api/src/routes/invoices.ts:100-107` | inline | **Yes** — `gstRate: z.number().min(0).optional()` per item | `createManualInvoice` |
| `POST /api/customers` | `packages/api/src/routes/customers.ts:250` | `createCustomerSchema` | No | `createCustomer` |
| `PUT /api/customers/:id` | `packages/api/src/routes/customers.ts:271` | `updateCustomerSchema` | No | `updateCustomer` |
| `POST /api/orders` | `packages/api/src/routes/orders.ts` | `createOrderSchema` | No | `createOrder` → `createInvoiceFromOrder` (hardcodes 18) |
| `PUT /api/orders/:id` | `packages/api/src/routes/orders.ts` | `updateOrderSchema` | No | `updateOrder` (→ same path) |

### Task 3 — Customer create/update API surface

`createCustomerSchema` in `packages/shared/src/schemas/index.ts:142-163` accepts:
`customerName, businessName, gstin, phone, email, billingAddressLine1/2, billingCity/State/Pincode, shippingAddressLine1/2, shippingCity/State/Pincode, creditPeriodDays, transportChargePerCylinder, contacts[], cylinderDiscounts[]`.

`updateCustomerSchema:165-169` = `createCustomerSchema.partial()` + optional `status`.

No `gstRate` / `gstRateOverride` / `taxRate` field today. No separate CustomerSettings/Config endpoints for GST.

### Task 4 — Web customer forms

`packages/web/src/pages/CustomersPage.tsx` — single form body reused for create + edit. Uses `createCustomerSchema` resolver (line 397). Renders the 17 fields listed in Task 3. **No GST-rate input, no commented/hidden tax field.**

### Task 5 — Mobile customer screens

- Create: `packages/mobile/app/(admin)/customer-create.tsx` (wraps shared form)
- Edit: `packages/mobile/app/(admin)/customer-detail.tsx`
- Form body: `packages/mobile/src/screens/CustomerForm.tsx:564-701`

Renders: customer name, business name, phone, email, GSTIN (with auto-fetch), billing (4 fields), shipping (5 fields), credit period, contacts, cylinder discounts. **No GST-rate input.**

### Task 6 — Web order creation

`packages/web/src/pages/OrdersPage.tsx` — order items carry only `cylinderTypeId` + `quantity`. No GST-rate input. Rate is decided server-side in `createInvoiceFromOrder` (hardcoded 18).

### Task 7 — Mobile order creation

`packages/mobile/app/(admin)/orders.tsx` — same shape, `cylinderTypeId` + `quantity` only. No GST-rate input.

### Task 8 — Reports + exports referencing GST

| File | What it does | Source of rate |
|---|---|---|
| `packages/api/src/services/reportsService.ts` | Aggregates `cgstValue/sgstValue/igstValue` from `Invoice` | Reads stored values; no recompute |
| `packages/api/src/services/tallyExportService.ts` | Tally voucher export | Reads aggregated `cgstValue` etc. from `Invoice` — **NOT** per-line |
| `packages/api/src/services/pdf/invoicePdfService.ts` | PDF render | Reads per-line `item.gstRate` |
| `packages/api/src/services/gst/payloadBuilders.ts` | IRN/EWB payload | Reads per-line `item.gstRate` |
| Web `BillingPage.tsx`, `BillingPaymentsPage.tsx`, `InvoicesPage.tsx` | Display tax columns | Pass-through from API |

**No live GSTR-1 export** — only a placeholder test (`phase5-gstr1.test.ts`).

### Task 9 — Shared types / Zod

- `Customer` interface (`packages/shared/src/types/index.ts:191-227`): no `gstRateOverride` field.
- `InvoiceItem`: not exported from shared (Prisma model passes through).
- No `CreateCustomerDto`/`UpdateCustomerDto` referencing rate.
- `GST_RATES` constant defined at `packages/shared/src/constants/index.ts:3-8`; imported by services that do the inter-state CGST+SGST vs IGST split.

### Task 10 — Tests pinning the rate (~44 sites)

All in `packages/api/src/__tests__/`:

- `anti-pattern-guards.test.ts:490`
- `credit-debit-note-amount.test.ts:124`
- `customer-portal.test.ts:876, 911, 983`
- `customer-statement-opening-balance.test.ts:311-312`
- `gst-b2c-urp-investigation.test.ts:78, 258`
- `gst-inclusive-unit-price.test.ts:223`
- `gst-payload-shape.test.ts:68, 165-193` (8 hits — explicit fixtures)
- `gst-reissue-2278.test.ts:134`
- `gst-reissue-inclusive-total.test.ts:149`
- `gst-reissue-zero-qty-and-transport.test.ts:247, 259, 426`
- `gst-reissue.test.ts:150, 718`
- `invoice-pdf-rate-reconciles.test.ts:59, 146`
- `numberingService.test.ts:139, 162, 172, 187`
- `opening-balance-certificate-pdf.test.ts:124, 176`
- `pdf-narration-truncation.test.ts:113`
- `phase5-gstr1.test.ts:107`
- `phase6-mobile-parity.test.ts:69`
- `tally-export.test.ts:112`
- `transport-charge-invoice.test.ts:93, 119-120`

All are fixtures asserting current-default behaviour. None hard-block adding the override — they will pass unchanged as long as the default (no override) still produces 18. New tests are needed for the 5% override path, but the existing 44 don't need rewriting.

### Confidence Assessment

**Verdict: no surprises. The implementation surface is exactly as Pass 1 implied — possibly slightly smaller.**

If we add `Customer.gstRateOverride Float?`, thread it through `createInvoiceFromOrder` (lines 183 + 225) and `createManualInvoice` (line 363 fallback), and surface a control in the web + mobile customer forms (and shared Zod schema), the rate WILL flow correctly through:

- PDF rendering — reads `InvoiceItem.gstRate`, no change.
- IRN payload (`payloadBuilders.ts`) — reads `InvoiceItem.gstRate`, no change.
- EWB payload — reads `InvoiceItem.gstRate`, no change.
- `reportsService.ts` — reads stored `cgstValue`/`sgstValue`/`igstValue`, which are computed AT INVOICE WRITE from per-line `gstRate × taxableValue` and persisted; no change.

Places that will STILL be wrong / incomplete after the minimum change:

1. **`tallyExportService.ts`** — reads aggregated `Invoice.cgstValue` etc., not per-line. A mixed-rate invoice (one 18% line + one 5% line) cannot be split into "CGST Output @ 18%" vs "CGST Output @ 5%" Tally ledgers from the aggregate. **Acceptable for v1** if every customer's invoices are single-rate (i.e. all of customer X's lines use the override). **Breaks** the moment one invoice mixes rates — which the current data model allows. Recommend: enforce single-rate-per-invoice at write time, OR defer Tally fix to the rate-bucketing WI.
2. **GSTR-1 export** — not built yet. Must group by HSN×rate per NIC Table 12. Future WI.
3. **`GST_RATES` constant** in `packages/shared/src/constants/index.ts` — still used for the inter-state CGST/SGST vs IGST split. The constant is fine (it encodes the 9+9=18 relationship), but if we go to 5% intra-state we need 2.5+2.5; if to 5% inter-state we need IGST 5. The split logic must read the per-line rate, halve for intra-state, use whole for inter-state — not read from the constant. Worth auditing whoever consumes `GST_RATES` today.
4. **Validation** — no Zod rule restricts `gstRateOverride` to {5, 18}. Free-form `z.number()` will let bad data through. Add an enum or `.refine()`.

Bottom line: 3 service touchpoints + 1 schema field + 2 forms + 1 Zod schema + 1 shared type covers the "rate flows correctly into invoices, PDFs, IRN, EWB" pipeline. Tally + GSTR-1 are pre-existing gaps documented in CLAUDE.md, not new ones introduced by this change.



