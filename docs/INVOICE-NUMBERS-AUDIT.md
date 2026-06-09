# Invoice Numbers Audit — locking the customer-portal mapper

Read-only audit conducted 2026-06-09 to decide the exact formulas the upcoming
customer-portal invoice-detail mapper (Approach A for P0-1) must use, so that
the customer mobile app shows numbers that tie out exactly with the PDF (legal
artifact) and the admin team's own view.

All file:line references are absolute against this repo.

---

## 1. Anti-pattern #16 facts — confirmation / refinement

Anti-pattern #16 in `CLAUDE.md` states `InvoiceItem.unitPrice` is stored
GST-INCLUSIVE end-to-end. This audit confirms it, with one important
clarification on `totalPrice`.

### 1.1 Writer (`packages/api/src/services/invoiceService.ts:152-185`)

```
unitPrice:    GST-INCLUSIVE, BEFORE discount          (line 168)
discountPerUnit: GST-INCLUSIVE                        (line 169)
totalPrice:   GST-INCLUSIVE, AFTER discount
              = (unitPrice − discountPerUnit) × qty   (lines 148-149, 171)
gstRate:      18 when gstEnabled, else 0              (line 170 / 182)
```

The writer also persists `Invoice.cgstValue / sgstValue / igstValue` from a
`totalBaseAmount` that is itself
`Σ ((unitPrice − discountPerUnit) / 1.18) × qty`
(lines 160-161, 225-234). These three GST aggregates are correct relative to
the post-discount, GST-inclusive totals — the bug fixed on 2026-06-01 was
limited to per-line readers, not the aggregates.

### 1.2 What "totalPrice" actually contains — refinement

`InvoiceItem.totalPrice` is **post-discount inclusive line total**, not the
raw `unitPrice × qty` that anti-pattern #16's prose implies. Verified at
`invoiceService.ts:148-171`:

```ts
const effectivePrice = Math.max(toNum(oi.unitPrice) - toNum(oi.discountPerUnit), 0);
const lineTotal = effectivePrice * qty;
...
totalPrice: lineTotal, // GST-inclusive, AFTER discount
```

This matters for the customer-portal mapper. If we surfaced a "lineTotal"
field equal to `unitPrice × quantity`, that would NOT match the PDF column
labelled "Amount" — the PDF Amount column uses `item.totalPrice` from the DB
(`invoicePdfService.ts:425`), which is already post-discount.

### 1.3 The natural "Subtotal" identity holds

`Invoice.totalAmount` = `Σ items[].totalPrice` (= post-discount inclusive grand
total). `cgstValue + sgstValue + igstValue` = aggregate GST.
So:

```
TAXABLE (assessable) = totalAmount − cgstValue − sgstValue − igstValue
```

…holds, in the single-GST-rate world (all current LPG items at 18%). For
mixed-rate invoices (none today on this repo's data, but the schema allows
per-item gstRate), this still holds in *aggregate* because the writer
computes `totalBaseAmount` per item and CGST+SGST+IGST from that sum.

### 1.4 Readers from #16 — confirmed consistent post-2026-06-01

The five readers anti-pattern #16 called out are all consistent now:

| Location | What it does | Status |
|---|---|---|
| `packages/api/src/services/gst/gstService.ts:297-308` | Feeds IRN payload builder for `processInvoiceGst` | OK — passes inclusive, no `/1.18` |
| `packages/api/src/services/gst/gstService.ts:1032-1041` | Same for `processCreditNoteGst` | OK |
| `packages/api/src/services/gst/gstService.ts:1131-1140` | Same for `processDebitNoteGst` | OK |
| `packages/api/src/services/gst/gstPreflightService.ts:996-1006` | Feeds preflight IRN | OK — comment cites anti-pattern #16 |
| `packages/api/src/services/gst/gstReissueService.ts:807-816` | Reissue path | (not re-read in this audit; was cited in the 2026-06-01 fix and CLAUDE.md treats it as fixed) |
| `packages/api/src/services/gst/payloadBuilders.ts:190-247` | Single owner of `/1.18` reversal for IRN | OK — `inclusivePrice = item.unitPrice` |
| `packages/api/src/services/pdf/invoicePdfService.ts:157-206` | PDF `computeItems` | OK — single `/(1+gstRate/100)` |

Conclusion: anti-pattern #16's underlying facts are intact. The customer
mapper can rely on them.

---

## 2. Inventory of invoice display surfaces

| # | Surface | File | Endpoint | What it reads | Status |
|---|---|---|---|---|---|
| 1 | **PDF (legal artifact)** | `packages/api/src/services/pdf/invoicePdfService.ts` | direct DB via `prisma.invoice.findFirst` (line 676) | Full schema-native shape with `items`, `customer`, `distributor`, `gstDocuments` | Source of truth |
| 2 | Admin web — Invoices page modal | `packages/web/src/pages/InvoicesPage.tsx` (modal at lines 355-568) | `GET /invoices/:id` (admin) | `items[].{unitPrice,totalPrice,hsnCode,gstRate}`, `cgstValue/sgstValue/igstValue`, `totalAmount` | Functional (uses schema-native names); **no Subtotal row** |
| 3 | Admin web — Billing & Payments page modal | `packages/web/src/pages/BillingPaymentsPage.tsx` (modal ~line 615-700) | Same as #2 | Same as #2 | Functional; same omissions |
| 4 | **Admin mobile — Finance hub invoices** | `packages/mobile/app/(admin)/finance.tsx:35-64, 783-815` | `GET /invoices/:id` (via the list) | Expects `inv.lineItems[].{unitPrice,totalPrice,description}` | **BROKEN** — server returns `items`, not `lineItems`; expanded card shows no rows |
| 5 | **Finance mobile — invoices** | `packages/mobile/app/(finance)/invoices.tsx:156-178, 252-298` | `GET /invoices/:id` | Expects `subtotal`, `cgstAmount`, `sgstAmount`, `lineItems[].amount` | **BROKEN** — Subtotal/CGST/SGST/lineItems all undefined → renders ₹0.00 |
| 6 | **Customer mobile — invoices** (the P0-1 case) | `packages/mobile/app/(customer)/invoices.tsx:23-55, 260-368` | `GET /customer-portal/invoices/:id` | Expects `subtotal`, `cgstAmount`, `sgstAmount`, `igstAmount`, `lineTotal`, `customerName`, `customerGstin`, `billingAddress`, `payments` | **BROKEN** — already diagnosed for P0-1 |
| 7 | Super-admin mobile — billing | `packages/mobile/app/(super-admin)/billing.tsx` | `GET /billing` (platform billing) | Different model — `totalAmountInclGst / totalAmountExclGst` | Out of scope (platform billing, not customer invoices) |
| 8 | NIC IRN payload | `packages/api/src/services/gst/payloadBuilders.ts:190-263` | `POST /einvoice/.../GENERATE` | Items with `UnitPrice` (exclusive), `Discount` (exclusive), `AssAmt`, `TotItemVal`, plus invoice-level `AssVal` / `TotInvVal` | Reference for what NIC sees; not user-facing |
| 9 | NIC EWB payload | `payloadBuilders.ts > buildEwbPayload` | Separate `POST .../genewaybill` | totals reused from IRN | Not user-facing |
| 10 | Credit Note PDF | `packages/api/src/services/pdf/creditNotePdfService.ts` | Not re-read; out of P0-1 scope | — | — |
| 11 | Debit Note PDF | `packages/api/src/services/pdf/debitNotePdfService.ts` | Not re-read; out of P0-1 scope | — | — |
| 12 | Distributor-billing PDF | `packages/api/src/services/pdf/billingInvoicePdfService.ts:302-319` | Platform billing cycles | Labels `Subtotal (excl. GST)`, separate CGST/SGST/IGST rows | Different doc; useful precedent for label wording only |

The headline finding: **three mobile invoice screens (customer, finance, admin)
all silently disagree with both the web modal AND the PDF**, in different
ways. P0-1 fixes the customer one; the other two are separate follow-ups.

---

## 3. PDF deep-dive — labels, formulas, address format

PDF generator: `packages/api/src/services/pdf/invoicePdfService.ts`. This is
the canonical artifact — it's what the customer downloads, what the
authorised signatory line gets signed under, and what tax officers see during
audit. Customer-app numbers MUST tie out to this.

### 3.1 Per-line table

Column definitions (`COL_DEFS`, lines 110-117):

```
#  |  Item  |  Qty  |  Rate  |  GST (total)  |  Amount
```

Per-line math, all in `computeItems` (lines 157-206):

```
gstRate                        = item.gstRate || 18
qty                            = item.quantity
up                             = item.unitPrice         (inclusive, BEFORE discount)
discount                       = item.discountPerUnit   (inclusive)
grossInclusive                 = round2(up × qty)
discountAmt                    = round2(discount × qty)
afterDiscount                  = round2(grossInclusive − discountAmt)
taxable                        = round2(afterDiscount / (1 + gstRate/100))
gstAmt                         = round2(afterDiscount − taxable)

effectiveUnitInclusive         = max(up − discount, 0)
baseRate                       = round2(effectiveUnitInclusive / (1 + gstRate/100))

totalPrice (displayed Amount)  = item.totalPrice || afterDiscount
```

Column semantics on the printed row:

| Column | Value | Inclusive or exclusive? |
|---|---|---|
| **Rate** | `baseRate` = post-discount, GST-EXCLUSIVE per-unit rate | **EXCLUSIVE** |
| **GST (total)** | `gstAmount` = per-line tax | n/a |
| **Amount** | `item.totalPrice` (post-discount INCLUSIVE line total) | **INCLUSIVE** |

So on the PDF, **Rate × Qty + GST = Amount** is the line identity. The Rate
column is *not* `item.unitPrice`. This is important context for the customer
app: showing the raw `unitPrice` in a column labelled "PRICE" is not what the
PDF shows.

A sub-line `Discount: ₹X/unit` is printed below the HSN/GST% caption when
`discountPerUnit > 0` (lines 389-395). The discount itself is GST-inclusive
per unit.

### 3.2 Totals section ("Subtotal:" row)

`drawTotals`, lines 433-491. The row labelled **`Subtotal:`** is NOT a single
number — it's a three-cell row that aligns under the Rate / GST / Amount
columns:

```
Subtotal:    Σ(baseRate × qty)    grandTotal − Σ(baseRate × qty)    grandTotal
              ↑                     ↑                                ↑
              "totalRate"           "totalGst"                       invoice.totalAmount
              (post-discount        (back-derived per-line           (the GST-inclusive
               taxable aggregate)    GST aggregate)                   grand total from DB)
```

`drawTotals:454-470`:

```ts
let totalRate = 0;
for (const item of items) {
  totalRate = round2(totalRate + item.baseRate * item.quantity);
}
const totalGst = round2(grandTotal - totalRate);
```

A second line ("Grand Total:") then re-prints `grandTotal` in larger
typography, followed by "Amount in words" (lines 478-487).

Note: the PDF does NOT print CGST and SGST as separate amounts in the totals
panel — it shows the aggregate `totalGst` only, with per-line CGST/SGST
breakdown printed as an italic sub-line under each item's GST cell when
intra-state (lines 408-419). This is a usability difference from the web /
mobile screens, which DO print CGST / SGST separately.

### 3.3 Stored vs. computed GST values

`generateInvoicePdf:727-730`:

```ts
const storedCgst = invoice.cgstValue || 0;
const storedSgst = invoice.sgstValue || 0;
const storedIgst = invoice.igstValue || 0;
const grandTotal = invoice.totalAmount || 0;
```

These stored values are PASSED to `drawTotals` (line 753) but are **NOT
ACTUALLY USED** inside `drawTotals` — the function ignores its `cgst, sgst,
igst` parameters and re-derives `totalGst = grandTotal − totalRate`. So in
practice, the only DB-stored numbers the totals panel surfaces are
`grandTotal = invoice.totalAmount`. Everything else is recomputed from items.

(This is a subtle PDF code-smell — three unused parameters — but it doesn't
break correctness. It does mean the PDF's "Subtotal" line is a per-item
re-aggregation; tiny rounding offsets from the DB-stored CGST/SGST/IGST are
possible but in the same sub-rupee band as the writer's own rounding.)

### 3.4 Address format

Buyer address (`generateInvoicePdf:700-702`):

```ts
const buyerAddr = cust
  ? [cust.billingAddressLine1, cust.billingAddressLine2, cust.billingCity, cust.billingState, cust.billingPincode]
      .filter(Boolean).join(', ')
  : '—';
```

So the printed buyer address is `addressLine1, addressLine2, city, state, pincode`
joined by `, ` with any null/empty fields silently dropped. Example:

> `Plot 42, Hosur Road, Bommanahalli, Bangalore, Karnataka, 560068`

If `billingAddressLine2` is null, it becomes:

> `Plot 42, Bommanahalli, Bangalore, Karnataka, 560068`

Customer GSTIN on the PDF (lines 705, 325): `cust?.gstin && cust.gstin !== 'URP' ? cust.gstin : null`.
When null, the "Bill To" card prints `GSTIN: —` (an em-dash placeholder) —
the line is **always shown**, just with a dash for URP / null. Buyer name is
`businessName || customerName || 'Customer'` (line 704).

### 3.5 Seller (distributor) panel

Seller address (`generateInvoicePdf:697`):
`[address, city, state, pincode].join(', ')`. GSTIN, phone, and the bold
business name (`businessName || legalName`) are also shown. No
`addressLine2` for distributor in schema.

### 3.6 Intra-state determination

`determineIntraState` (lines 126-138) compares the first two digits of seller
and buyer GSTIN, falling back to seller-state vs buyer-state string match.
Drives whether the GST sub-line shows `CGST X% / SGST Y%` or `IGST Z%`.

---

## 4. Admin web invoice-detail modal — summary

Two near-identical modals exist:

- `packages/web/src/pages/InvoicesPage.tsx > InvoiceDetailModal` (lines 355-568)
- `packages/web/src/pages/BillingPaymentsPage.tsx > InvoiceDetailModal` (lines 611-700+)

Both consume the shared `Invoice` type (`packages/shared/src/types/index.ts:296-333`)
which uses the schema-native names. The page-level list query is
`apiGet<{ invoices: Invoice[]; meta: PaginationMeta }>('/invoices', queryParams)`
(InvoicesPage.tsx:125); the detail modal does NOT refetch — it consumes the
list-row object directly. This means it relies on `listInvoices` (the
list-include) shape, NOT on `getInvoiceById`'s detail shape.

Display behaviour (InvoicesPage.tsx:404-427):

| Element | What it shows | Field |
|---|---|---|
| Table header | `Description | HSN | Qty | Unit Price | GST% | Total` | — |
| Per-line Unit Price | `formatCurrency(item.unitPrice)` (inclusive, BEFORE discount) | `unitPrice` |
| Per-line Total | `formatCurrency(item.totalPrice)` (inclusive, AFTER discount) | `totalPrice` |
| Totals panel | 4-cell grid: **CGST | SGST | IGST | Total Amount** | `cgstValue, sgstValue, igstValue, totalAmount` |

Notable: **the admin web has NO "Subtotal" row.** Customers calling support
saying "what does the PDF's ₹35,593.22 Subtotal refer to?" cannot be
answered by an admin glancing at the web — the web just shows CGST + SGST +
IGST + Total. The PDF surfaces taxable aggregate as `Σ baseRate × qty`; the
web hides it. This is a divergence (see §7).

Also notable: the admin web prints `Unit Price = item.unitPrice` (inclusive,
pre-discount) WITHOUT the discount sub-line that the PDF shows. So an
admin looking at the modal will think the unit rate is one value, but the
PDF will show a different (lower, post-discount, GST-exclusive) "Rate" with
a `Discount: ₹X/unit` annotation. Not a numerical bug — both numbers are
correct — but the labels are inconsistent and the discount becomes invisible
on the web side.

---

## 5. Mobile invoice-detail screens — summary

### 5.1 Customer mobile — `packages/mobile/app/(customer)/invoices.tsx`

Already documented for P0-1. Reads from `GET /customer-portal/invoices/:id`
and expects an `InvoiceDetail` shape (lines 23-55) with fields:

```
subtotal, cgstAmount, sgstAmount, igstAmount, lineTotal (per item),
customerName, customerGstin, billingAddress, payments
```

The API returns `customerPortalService.getMyInvoiceById` (`packages/api/src/services/customerPortalService.ts:498-511`)
piped through `mapInvoice` (`packages/api/src/utils/mappers.ts:183-228`),
which renames `id → invoiceId` and surfaces nested `customer` (if included).
**But `getMyInvoiceById` does NOT include `customer`** — only `items`,
`order`, `paymentAllocations`, `creditNotes`, `debitNotes`. So
`mapped.customer` is undefined, and the UI's `customerName` /
`customerGstin` / `billingAddress` all show blanks. Same for `subtotal` /
`cgstAmount` / `sgstAmount` / `igstAmount` / `lineTotal` — these field names
don't exist in the response (the response has `cgstValue` / `sgstValue` /
`igstValue` / `items[].totalPrice`).

UI table header (line 286-292): `ITEM | QTY | PRICE | GST | TOTAL`.
"PRICE" maps to `item.unitPrice`; "TOTAL" maps to `item.lineTotal` (which
the API doesn't return → ₹0.00).

UI summary (lines 326-369): "Subtotal | CGST | (SGST or IGST) | Total |
Paid | Outstanding". All four top numbers blank.

### 5.2 Finance mobile — `packages/mobile/app/(finance)/invoices.tsx`

Same general bug, different field names. Local `InvoiceDetailData`
(lines 156-178) expects:

```
lineItems[].{cylinderTypeName, quantity, unitPrice, gstRate, amount}
subtotal, cgstAmount, sgstAmount, totalAmount, amountPaid, outstandingAmount
```

The API endpoint is `GET /invoices/:id` (line 195), backed by
`invoiceService.getInvoiceById` → `detailInvoiceInclude`
(`packages/api/src/services/invoiceService.ts:26-33`). Returns
`items` (NOT `lineItems`), with per-item `totalPrice` (NOT `amount`), and
invoice-level `cgstValue` / `sgstValue` (NOT `cgstAmount` / `sgstAmount`).
Result: same silent ₹0.00 + empty line-items in production.

Confirmed by inspection — neither the customer nor finance screen tests
have a guard that asserts the API actually returns the field name the UI
type expects (this is exactly anti-pattern #9 from CLAUDE.md). The UI
silently absorbs the missing fields.

### 5.3 Admin mobile finance hub — `packages/mobile/app/(admin)/finance.tsx`

Same general bug, third variant. Local `InvoiceLineItem` (lines 35-40)
declares `description / quantity / unitPrice / totalPrice` — the PER-ITEM
field names that DO match the schema. But the invoice-level wrapper at
lines 53-64 declares `lineItems?: InvoiceLineItem[]`, and the render reads
`inv.lineItems` (line 787). The API returns `items`, not `lineItems`. So
the expanded card just never shows any rows.

Admin mobile has NO Subtotal / CGST / SGST breakdown — only `Total / Paid /
Outstanding` (lines 818-836). So at least it's not surfacing wrong tax
numbers — but it's also not showing the GST split, which is a real
shortcoming for an admin tool.

### 5.4 Customer-portal service field gaps for the customer screen

What the customer screen needs but `getMyInvoiceById`'s current Prisma
include does not provide:

| Field the UI needs | Where it should come from | Currently in include? |
|---|---|---|
| `customerName`, `customerGstin`, `billingAddress*` | `customer` relation | **No** — needs `customer: { select: { customerName, gstin, billingAddressLine1, billingAddressLine2, billingCity, billingState, billingPincode } }` |
| `payments[]` (paymentId, amount, method, etc.) | `paymentAllocations.payment` relation | **Yes** but currently `payment: { select: { paymentMethod, referenceNumber, transactionDate } }`. The allocation's allocated amount and the payment id need passing through too |
| Per-line GST-exclusive taxable | derivable from `unitPrice / gstRate / discountPerUnit / quantity` (matches PDF formula) | — |
| Invoice-level subtotal | derivable from `totalAmount − cgstValue − sgstValue − igstValue` | — |

---

## 6. Schema scan for pre-computed totals

`packages/api/prisma/schema.prisma` — no matches for `subtotal`, `taxableValue`,
`assessableValue`, `lineSubtotal`, `subTotal`, `subTotalValue`, or any
similar precomputed-taxable column on the `Invoice` or `InvoiceItem` models.

Confirmed by `Invoice` model definition at `schema.prisma:933-981` and
`InvoiceItem` at `schema.prisma:1008-1024`. The only money columns on
`Invoice` are `totalAmount`, `amountPaid`, `outstandingAmount`, `cgstValue`,
`sgstValue`, `igstValue`. The only money columns on `InvoiceItem` are
`unitPrice`, `discountPerUnit`, `totalPrice`.

**Implication:** the customer mapper must DERIVE the subtotal. There is no
column to read it from. (And we don't want to add one — it would just
become another column that drifts out of sync with `totalAmount`.)

---

## 7. Cross-view comparison

| View | Subtotal label | Subtotal formula | Per-line "Total" | Per-line "Rate" / "Price" col | GST labels | Address format |
|---|---|---|---|---|---|---|
| **PDF (canonical)** | `Subtotal:` (3-cell row spanning Rate/GST/Amount columns) | `Σ(baseRate × qty)` where `baseRate = (unitPrice − discount) / (1 + gstRate/100)` | `item.totalPrice` (post-discount inclusive) | `baseRate` (post-discount, EXCLUSIVE) + `Discount: ₹X/unit` sub-line | Per-line CGST/SGST italic sub-line in intra-state; totals row shows aggregated `totalGst` only | `addressLine1, addressLine2, city, state, pincode` joined by `, ` (nulls dropped); GSTIN always shown, `—` for URP/null |
| Admin web (Invoices & Billing) | **No Subtotal row** | n/a | `item.totalPrice` | `item.unitPrice` (inclusive, PRE-discount, no discount sub-line) | 4-cell grid `CGST / SGST / IGST / Total Amount` (all from DB) | Not shown in modal |
| Admin mobile (finance.tsx) | **BROKEN** (`lineItems` undefined) | n/a | n/a | n/a | No CGST/SGST split — only Total/Paid/Outstanding | Not shown |
| Finance mobile | "Subtotal" (₹0.00) | expects `invoice.subtotal` (not returned by API) | expects `item.amount` (₹0.00, field undefined) | expects `item.unitPrice` (renders correctly only if items existed; but `lineItems` is `undefined`) | "CGST / SGST / Total" — both blank | Not shown |
| Customer mobile | "Subtotal" (₹0.00) | expects `invoice.subtotal` | expects `item.lineTotal` (₹0.00, field undefined) | expects `item.unitPrice` (would render inclusive pre-discount if items existed) | "CGST / (SGST or IGST) / Total" — all blank | Single-line `invoice.billingAddress`, blank today |
| NIC IRN payload | invoice-level `AssVal` (exclusive aggregate) | `Σ AssAmt` where `AssAmt = (TotAmt − Discount)` and `TotAmt = exclusivePrice × qty` | Per-item `AssAmt` (exclusive, post-discount) + `TotItemVal` (inclusive) | `UnitPrice` field = exclusive | Per-item `CgstAmt`/`SgstAmt`/`IgstAmt`; invoice-level `CgstVal/SgstVal/IgstVal` | Separate `Addr1/Addr2/Loc/Stcd/Pin` structured fields |

### 7.1 Divergences flagged

**D1. Admin web does not show Subtotal; the PDF does.**
A customer asking "what is the ₹35,593.22 Subtotal on my invoice PDF?"
cannot be answered by an admin opening the web modal — there's no equivalent
field there. Severity: low (informational; the admin has CGST/SGST and
Total). But surfaces as a UX gap.

**D2. Admin web shows pre-discount Unit Price; PDF shows post-discount,
GST-EXCLUSIVE Rate with a `Discount: ₹X/unit` annotation.**
An admin reading "Unit Price ₹2,500" in the web vs "Rate ₹2,118.64" on the
PDF for the same row will be confused. This is a labels / UX issue, not a
math bug. Severity: medium (real customer-support landmine, but already in
prod for months).

**D3. Three mobile invoice-detail screens are independently broken** in
slightly different ways (D-customer / D-finance / D-admin). The customer one
is P0-1; the other two are separate follow-ups. Severity: P0-1 for the
customer; high for finance (finance staff currently cannot see invoice
totals from the mobile app at all); medium for admin (no GST split, but
basic Total/Paid/Outstanding work).

**D4. Customer mobile UI table column labelled "PRICE" maps to `unitPrice`,
but the PDF's equivalent column is "Rate" and shows POST-DISCOUNT,
GST-EXCLUSIVE base.** Even after P0-1 wires up the API field correctly,
showing the raw `unitPrice` (inclusive, pre-discount) under a column
labelled "PRICE" will still not match what the same row's "Rate" column
shows on the PDF that the customer downloads. See §8 recommendation 3.

**D5. PDF passes `storedCgst/storedSgst/storedIgst` parameters to
`drawTotals` but the function never uses them** (it re-derives from items).
Minor code-smell; not a bug. Worth filing as a low-priority cleanup but
NOT part of P0-1.

---

## 8. Locked recommendations for the customer-portal mapper

These are the formulas the upcoming Approach A mapper (in
`customerPortalService.ts > getMyInvoiceById` or a separate
`packages/api/src/utils/mappers.ts > mapCustomerInvoiceDetail`) should use.

### 8.1 Subtotal formula — **CHOOSE (a): pure deduction**

```ts
subtotal = totalAmount − cgstValue − sgstValue − igstValue
```

Rationale:

1. **Matches the PDF "Subtotal:" row to within sub-rupee rounding.** The
   PDF computes `Σ baseRate × qty`; the writer stored
   `cgstValue + sgstValue + igstValue = totalBaseAmount × 0.18`. These
   differ only by per-item-vs-aggregate rounding (cents at most). For the
   customer's tie-out it's indistinguishable.
2. **Single source of truth: the DB-stored aggregates.** Option (c) would
   re-derive per-line and accumulate, which means the customer-app number
   could drift from the DB-stored CGST/SGST/IGST after any rounding-edge
   case. Option (a) guarantees that
   `subtotal + cgstAmount + sgstAmount + igstAmount = totalAmount`
   exactly, by construction.
3. **Survives mixed GST rates.** For an invoice with items at 5% and 18%
   simultaneously (not current, but allowed by schema), option (b) needs
   a weighted average and option (c) needs per-item math. Option (a) just
   works.
4. **Robust to the GST-DISABLED mode.** For a distributor with
   `gstMode = DISABLED`, the writer sets `cgstValue = sgstValue =
   igstValue = 0`, so option (a) gives `subtotal = totalAmount`, which is
   correct (no GST, no separate taxable). Options (b) and (c) would have
   to special-case `gstRate = 0` to avoid divide-by-one weirdness.
5. **Free for the API to compute.** No per-item iteration needed.

### 8.2 `lineTotal` semantic — **INCLUSIVE (post-discount), i.e. `item.totalPrice`**

Map `lineTotal = item.totalPrice` (the schema-native field).

Rationale: the PDF's "Amount" column = `item.totalPrice` (`invoicePdfService.ts:425`).
That is the number a customer compares against. The web modal's "Total"
column = same. So the customer mobile's column labelled "TOTAL" should
likewise show this inclusive post-discount value.

### 8.3 `unitPrice` semantic — **INCLUSIVE pre-discount, i.e. raw `item.unitPrice`**

Map `unitPrice = item.unitPrice` (the schema-native field).

…BUT this exposes divergence D4 with the PDF. There are two acceptable
resolutions, in priority order:

**Option (i) — preferred for P0-1:** keep mapping `unitPrice = item.unitPrice`
(inclusive pre-discount), but change the customer mobile UI's column label
from `"PRICE"` to `"UNIT PRICE"` and add a small "incl. GST" caption under
the table, so the customer is told what kind of number they're looking at.
The PDF's "Rate" column is `(unitPrice − discount) / 1.18` — that's a
different concept. Surface both numbers (the PDF row breakdown on download,
the inclusive line summary in the app) instead of trying to make them
visually identical.

**Option (ii) — out-of-scope for P0-1:** add a discount column or a
`discountPerUnit` field to the mapper, plus optionally a derived
`taxableUnitPrice = baseRate`. That gets closer to PDF parity but expands
the UI scope and risks a fresh round of cross-team debates over what to
label things. Defer to a follow-up.

For P0-1, ship option (i): map `item.unitPrice` raw, relabel the column.

### 8.4 Address format — **PDF-identical**

```ts
billingAddress = [
  customer.billingAddressLine1,
  customer.billingAddressLine2,
  customer.billingCity,
  customer.billingState,
  customer.billingPincode,
].filter(Boolean).join(', ')
```

Example string: `Plot 42, Hosur Road, Bommanahalli, Bangalore, Karnataka, 560068`.

When `billingAddressLine2` is null: `Plot 42, Bommanahalli, Bangalore, Karnataka, 560068`.

When the entire address is null: empty string. The customer UI already
guards `{invoiceDetail.billingAddress && (...)}` (`invoices.tsx:272`), so an
empty string just hides the line — fine.

### 8.5 `customerGstin` display behaviour — **always-sent field, UI guards rendering**

Map `customerGstin = customer.gstin && customer.gstin !== 'URP' ? customer.gstin : null`
(matches PDF `generateInvoicePdf:705`).

The customer mobile UI already guards `{invoiceDetail.customerGstin && (...)}`
(`invoices.tsx:267`), so a null hides the line. Matches PDF semantics for
the customer's own view, where seeing "GSTIN: —" for their own URP invoice
would be noise.

Note: the PDF DOES show `GSTIN: —` for URP. That's reasonable for an
auditor / tax-office view but odd in a customer-facing app. The customer
already knows they don't have a GSTIN. The recommended behaviour (hide-when-null)
is therefore intentionally a tiny divergence from the PDF, justified by the
audience: PDFs go to auditors, the app screen goes to the customer.

### 8.6 Customer-facing field naming — **adopt the customer mobile's "customer-friendly" names**

This is the Approach A decision the audit was scoped to support.

| Wire field (mapper output) | Source on the model | Semantic |
|---|---|---|
| `customerName` | `customer.businessName \|\| customer.customerName` | matches PDF buyer name (`generateInvoicePdf:704`) |
| `customerGstin` | per §8.5 | nullable |
| `billingAddress` | per §8.4 | single-line, may be empty |
| `subtotal` | per §8.1 | INCLUSIVE-of-nothing, i.e. assessable / taxable aggregate |
| `cgstAmount` | `invoice.cgstValue` | renamed only |
| `sgstAmount` | `invoice.sgstValue` | renamed only |
| `igstAmount` | `invoice.igstValue` | renamed only |
| `totalAmount` | `invoice.totalAmount` | unchanged |
| `amountPaid` | `invoice.amountPaid` | unchanged |
| `outstandingAmount` | `invoice.outstandingAmount` | unchanged |
| `items[].unitPrice` | `item.unitPrice` (inclusive, pre-discount) | per §8.3 |
| `items[].gstRate` | `item.gstRate` | unchanged |
| `items[].lineTotal` | `item.totalPrice` (inclusive, post-discount) | per §8.2 |
| `items[].cylinderTypeName` | `item.cylinderType?.typeName \|\| item.description` | matches PDF item name |
| `payments[]` | flatten `paymentAllocations[].payment` plus `paymentAllocations.allocatedAmount` | see §5.4 |

For the `payments[]` array, the customer UI uses `{paymentId, amount,
transactionDate, paymentMethod, referenceNumber}`. The natural mapping:

```ts
payments = invoice.paymentAllocations.map(a => ({
  paymentId: a.payment.id,
  amount: Number(a.allocatedAmount),   // amount applied to THIS invoice
  transactionDate: a.payment.transactionDate,
  paymentMethod: a.payment.paymentMethod,
  referenceNumber: a.payment.referenceNumber,
}))
```

This requires expanding the `getMyInvoiceById` Prisma include's
`paymentAllocations.payment.select` to also pick `id`. Today it's
`select: { paymentMethod, referenceNumber, transactionDate }` only
(`customerPortalService.ts:505`).

### 8.7 Add the missing Prisma include

The customer mapper above needs:

```ts
customer: {
  select: {
    customerName: true,
    businessName: true,
    gstin: true,
    billingAddressLine1: true,
    billingAddressLine2: true,
    billingCity: true,
    billingState: true,
    billingPincode: true,
  },
},
paymentAllocations: {
  include: {
    payment: {
      select: {
        id: true,             // ← currently missing
        paymentMethod: true,
        referenceNumber: true,
        transactionDate: true,
      },
    },
  },
},
```

Add this to `customerPortalService.getMyInvoiceById:498-511`. The
`distributorId` scoping already exists in the outer `where` (line 500) —
adding includes does not weaken tenant isolation.

### 8.8 Guard test — add one for P0-1

Per CLAUDE.md anti-pattern #9: every API route that the web/mobile types as
object T must actually return shape T. A 4-line vitest guard near
`packages/api/src/__tests__/customer-portal-*.test.ts` asserting:

```ts
expect(res.body.data).toHaveProperty('subtotal');
expect(res.body.data).toHaveProperty('cgstAmount');
expect(res.body.data).toHaveProperty('items.0.lineTotal');
expect(res.body.data).toHaveProperty('customerName');
expect(res.body.data).toHaveProperty('billingAddress');
```

…is cheap insurance against the next regression of this shape.

---

## 9. Orthogonal follow-ups (NOT part of P0-1)

These are separate findings the audit surfaced. Listing them here so they
don't get bundled into P0-1, but also don't get lost.

**F-1. Finance mobile invoice detail is silently broken.** Same shape of
bug as the customer one. `(finance)/invoices.tsx:156-178` declares
`subtotal`, `cgstAmount`, `sgstAmount`, `lineItems[].amount` — none of
these exist in the `GET /invoices/:id` response. Finance staff currently
see ₹0.00 for every breakdown. Fix path: either mirror the customer mapper
on the admin `/invoices/:id` route (Approach A everywhere) OR change the
mobile screen to read the schema-native names (Approach B for this one).
Owner choice.

**F-2. Admin mobile finance hub line items are silently broken.**
`(admin)/finance.tsx:53,787` reads `inv.lineItems`; server returns
`inv.items`. Trivially fixable on the mobile side.

**F-3. Admin web modals omit Subtotal.** Mid-priority UX gap.

**F-4. Admin web modals show pre-discount inclusive `unitPrice` as "Unit
Price" without a discount annotation,** while the PDF shows post-discount
exclusive `baseRate` as "Rate" plus a `Discount` sub-line. Not a math bug,
but admins reading both will get confused. Either add a discount column to
the web modal, or relabel "Unit Price" → "Unit Price (incl. GST)" with a
tooltip explaining the divergence from the PDF "Rate".

**F-5. `drawTotals` ignores its `cgst`, `sgst`, `igst` parameters.**
(`invoicePdfService.ts:436-491`). Dead params; remove them. Cleanup only.

**F-6. No anti-pattern #9 guard tests on the customer or admin invoice
detail routes today.** Add the cheap shape-assertions in §8.8 and one
equivalent for `/invoices/:id` (currently the implicit contract is
`{cgstValue, sgstValue, igstValue, items}` but nothing enforces it).

---

## 10. Open questions for Suneel

**Q1. Customer mobile UI table column header — "PRICE" or "UNIT PRICE (incl. GST)"?**
The audit recommends relabelling per §8.3 / D4 to reduce
PDF-vs-app confusion. Confirm wording. If you prefer to also surface a
discount column for parity with the PDF, that's option (ii) in §8.3 — a
slightly larger change.

**Q2. Should the customer screen show `GSTIN: —` for URP customers, or hide
the line entirely?** §8.5 recommends hide-when-null on the assumption the
customer already knows. PDF shows `—`. Confirm UI choice.

**Q3. For F-1 / F-2 (finance and admin mobile screens), prefer the
Approach-A fix (rename API to match UI) or the Approach-B fix (rename UI to
match API)?** These two screens use the ADMIN `/invoices/:id` endpoint which
is consumed by the web (correctly) using the schema-native names. Changing
that endpoint's shape would break the web. So for F-1 / F-2 the only
realistic path is Approach B (fix the mobile screens), unless we add a new
"admin-friendly" endpoint or response variant. Confirm direction.

**Q4. Mixed-rate invoices (e.g. 5% + 18% items on the same invoice).** Not
present in current production data, but schema allows. Subtotal-formula (a)
in §8.1 still works in aggregate but cannot break down "5%-bucket taxable"
from "18%-bucket taxable" on the UI. The PDF doesn't either — it shows one
aggregate. If you ever need that split for tax reporting, it's a separate
schema column. Note for the record; no action for P0-1.
