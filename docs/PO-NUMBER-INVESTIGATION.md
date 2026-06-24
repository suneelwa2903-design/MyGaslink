# PO Number on Orders/Invoices — Investigation

> Pure read-only investigation. No code changed. All file paths use the monorepo's real layout: `packages/api`, `packages/web`, `packages/mobile`, `packages/shared`.

## Task 1 — Order model today

Searched `packages/api/prisma/schema.prisma` for: `poNumber`, `purchaseOrder`, `referenceNumber`, `refNo`, `customerRef`, `buyerOrderNo`, `po_no`, `customer_ref`, `buyer_order`. **No matches** on Order, OrderItem, Invoice, or InvoiceItem models.

The Order model (`schema.prisma:782`) carries `orderNumber` (our internal sequence), `orderType`, `orderSource`, `specialInstructions`, `deliveryNotes`, `cancellationReason`, etc. — no buyer-supplied PO/reference field exists:

```prisma
model Order {
  id                    String      @id @default(uuid()) @map("order_id")
  orderNumber           String      @unique @map("order_number")
  ...
  specialInstructions   String?     @map("special_instructions")
  deliveryNotes         String?     @map("delivery_notes")
  ...
}
```

`Invoice` (`schema.prisma:1110`) tracks `invoiceNumber`, `orderId` (1:1 FK back), `irn`, `ackNo`, `customerGstinSnapshot`, `notes` — again no PO field. `InvoiceItem` (`schema.prisma:1199`) is purely line-level (HSN, qty, rate, GST).

The only "reference"-shaped concept anywhere on these tables is `customerGstinSnapshot` — a GSTR-1 snapshot, not a buyer PO.

Hits for the search terms in the wider codebase (`paymentService`, `paymentSubmissionService`, `tallyExportService`, etc.) refer to **payment** references — UPI ref, cheque no, Razorpay payment-id, customerRefetching React variable — none related to a buyer PO on an order.

## Task 2 — Order creation API

`packages/shared/src/schemas/index.ts:184` — `createOrderSchema`:

```ts
export const createOrderSchema = z.object({
  customerId: uuid,
  deliveryDate: dateString,
  specialInstructions: z.string().max(500).optional(),
  items: z.array(orderItemSchema).min(1, 'At least one item is required'),
  orderType: z.enum(['delivery', 'returns_only']).default('delivery').optional(),
  cancelledStockEventId: uuid.optional(),
});
```

`updateOrderSchema` at `:211`:

```ts
export const updateOrderSchema = z.object({
  deliveryDate: dateString.optional(),
  specialInstructions: z.string().max(500).optional(),
  items: z.array(orderItemSchema).min(1).optional(),
});
```

No PO-like field today.

`packages/api/src/services/orderService.ts` — `createOrder` (`:95`), `createOrderFromCancelledStock` (`:420`), `updateOrder` (~`:518`) all accept `specialInstructions` only as a free-text note. No reference/PO field is read or written.

`packages/api/src/services/invoiceService.ts` — `createInvoiceFromOrder` (`:119`) loads the Order and writes a new Invoice/InvoiceItem set from `order.items`. The Order → Invoice column carry-over is `customerId`, `orderId`, GST/tax columns, line items. **No buyer reference field passes through** today.

## Task 3 — Invoice PDF

`packages/api/src/services/pdf/invoicePdfService.ts` — searched for `poNumber`, `purchaseOrder`, `buyerOrder`, `OrdNo`, `reference` (case-insensitive). Matches found:

- `:265` — code comment "quick-glance reference"
- `:905` — `const refText = 'Reference: ${invoice.invoiceNumber}'` (this is the **invoice number** quoted on the payment voucher block, not a buyer PO)

No buyer-PO field is rendered.

### PDF header block — current fields and layout (`drawHeader`, `:225-289`)

Left column (start at `LAYOUT.MARGIN.left`):
- Company name (H2 × 1.5, primary colour, bold)
- `GSTIN: <seller.gstin>` (caption, muted) — only when gstin present

Right column (right-aligned):
- "Tax Invoice" title (H1, primary colour, bold)
- `GST Doc No: <meta.gstDocNo>` (BODY, muted)
- `EWB No: <meta.ewbNo>` (BODY, muted) — only when present

Divider line, then meta-row directly below:
- `Invoice Date: <meta.invoiceDate>` (left)
- `Due Date: <meta.dueDate>` (centre-left, +170px)
- `Payment Terms: <meta.paymentTerms>` (right-aligned)

Below header is `drawParties` (Bill From / Bill To boxes) at `:291`.

### Natural placement for a PO field

Two clean options:
1. **Header meta-row** — add a 4th cell: `PO No: <value>` next to / below Invoice Date / Due Date / Payment Terms. Visually consistent with "this invoice's identity at a glance".
2. **Bill To box** — add a `Buyer PO: <value>` line inside the `drawParties` right-hand column. Matches the convention that the PO is buyer-supplied. The Bill To box (`:308` signature) already takes `{ name, gstin, phone, address }` — adding one optional line is structurally trivial.

Recommend option 2 (Bill To box) since PO is buyer-side; option 1 if the brand wants it more prominent.

## Task 4 — NIC IRN schema

### Current `IrnPayload` interface (`payloadBuilders.ts:108-134`)

The interface declares these top-level keys: `Version`, `TranDtls`, `DocDtls`, `SellerDtls`, `BuyerDtls`, `ItemList`, `ValDtls`, `RefDtls?`, `EwbDtls?`.

`RefDtls` is currently shaped only for credit/debit-note linkage:

```ts
RefDtls?: {
  InvRm: string;
  PrecDocDtls: Array<{ InvNo: string; InvDt: string; OthRefNo: string }>;
};
```

`buildIrnPayload` (`:188`) emits `RefDtls` **only when `docType === 'CRN' || 'DBN'`** (`:338-347`). For a normal INV the entire `RefDtls` block is omitted. **No `PoDtls` block is declared or emitted anywhere today.**

### NIC v1.1 field name for buyer's PO

Per the NIC e-invoice v1.1 schema, the buyer's purchase-order reference goes in a top-level optional block:

```
PoDtls: { PoNo: string, PoDt: string }
```

where `PoDt` is `dd/mm/yyyy`. (Note: NIC also defines `RefDtls.DocPerdDtls` for "document period" — for recurring invoices — and `RefDtls.ContrDtls` for contract metadata. Those are NOT the PO carrier.)

**Could not confirm `PoDtls.PoNo` max length from this codebase** (we don't emit it today, so there's no `sanitize(..., N)` call to read off). Per the public NIC e-invoice JSON schema, `PoNo` is typically constrained to 16 chars (same as `DocDtls.No`), and `PoDt` is the standard dd/mm/yyyy date string. **Needs confirmation against the official NIC PDF / WhiteBooks API spec before implementation.**

### Optionality

`PoDtls` is **optional** in NIC v1.1 — leaving it out is the default behaviour every other Indian e-invoicing implementation uses for B2C / unregistered-buyer / no-PO cases.

### Anti-pattern #10 caution

CLAUDE.md anti-pattern #10 explicitly calls out: every new field added to a NIC payload MUST be exercised against the live WhiteBooks sandbox before being marked done. Mocked tests passed for the inline `EwbDtls` work and we still hit a generic 5002 on the first real dispatch. The same risk applies to `PoDtls` — particularly around (a) whether NIC accepts `PoDt` with the same dd/mm/yyyy format as `DocDtls.Dt`, (b) whether sending `PoDtls` with empty strings is rejected vs accepted (we want to omit the whole block when empty, not send `{ PoNo: '', PoDt: '' }`).

## Task 5 — EWB payload

`buildEwbPayload` (`payloadBuilders.ts:427`) and the `EwbPayload` interface (`:374-421`). The fields are:

- `supplyType`, `subSupplyType`, `subSupplyDesc`
- `docType`, `docNo`, `docDate` — these mirror the IRN's `DocDtls` and use **our invoice number** (or order number for dispatch EWB at `gstService.ts:788`), not the buyer PO
- From/To party, transport, vehicle, item list, value details
- `shipToGSTIN` / `dispatchFromGSTIN` (only on transactionType 2/3/4 — anti-pattern #14)

There is **no buyer-PO field on the EWB schema** — NIC's EWB API doesn't carry one. Per NIC EWB v1.03: the only document reference is `docNo` which is the underlying invoice number. The PO trail lives on the IRN side (`PoDtls`) and on the printed invoice; it does not propagate to the EWB.

Confirmed: no change to EWB payload or `buildEwbPayload` is required for PO support.

## Task 6 — Web order form

`packages/web/src/pages/OrdersPage.tsx`. Two create flows live in this single file (regular delivery order and returns-only order — `:1112` is the returns-only modal). For the regular order create modal (`:479` defaults):

```ts
{
  customerId: '',
  deliveryDate: localTodayISO(),
  specialInstructions: '',
}
```

Fields rendered today (in the create modal `:504-580`):
- Customer picker (`CustomerCombobox`, `:512`)
- Delivery Date (date input, `:521`)
- Cylinder items array (cylinder picker × quantity rows)
- Special Instructions textarea (`:577`)

### Order list table columns (`:268-275`)

```
Order # | Customer | Delivery Date | Items | Amount | Driver | Status | Actions
```

Eight columns already. Adding a PO column on the list table would crowd the row; recommend showing PO only in the order detail / drawer (`:617-720`), not the list table — same treatment `specialInstructions` gets today (`:714`).

### Natural placement for PO field

In the create modal, the field belongs after Customer (so the PO conceptually attaches to the buyer's order) and before the cylinder items array — directly above or below Delivery Date. The update modal at `:781` has the same shape and should mirror the placement.

Conditional rendering recommendation: show the PO input only when the selected customer is B2B (see Task 8). The web form already has the selected customer object via `useWatch({ name: 'customerId' })` (`:504`); the existing `CustomerCombobox` payload should include `customerType` so the form can branch.

## Task 7 — Mobile order form

`packages/mobile/app/(admin)/orders.tsx`. Two creates here too — regular order (`:1061`) and returns-only (`:2042`). The regular order screen's state (`:1061-1065`):

```ts
const [customerId, setCustomerId] = useState('');
const [deliveryDate, setDeliveryDate] = useState(getTodayISO());
const [specialInstructions, setSpecialInstructions] = useState('');
```

Fields rendered:
- Customer search + picker (`:1206-1240`)
- Delivery Date (`:1248`)
- Cylinder items (rows of cylinder picker × qty)
- Special Instructions textarea (`:1357`)

`CreateOrderVars` (mobile-local type) at `:47-58` mirrors the same fields plus optional `orderType`. Adding `poNumber?: string` to this type + the create payload at `:1114` is the surface-level change.

There's also an order modify modal (`:2254`) and the customer-portal order create (`packages/mobile/app/(customer)/orders.tsx:25,257`) — the customer side raises orders themselves; whether the customer should be able to enter their own PO is a UX decision (see Task 8).

### Natural placement

After the customer picker block and before delivery date. Match the web layout for parity (CLAUDE.md "iOS track: Android is the parity reference"). Same B2B-only conditional rendering as the web form.

## Task 8 — B2B-only vs all customers

The data model already distinguishes B2B and B2C:

- `Customer.customerType` (`schema.prisma:543`) — `String @default("B2C")`, set to `B2B` only when GSTIN is present.
- Derived at write-time in `customerService.ts:152` — `customerType = data.gstin && data.gstin.length > 0 ? 'B2B' : 'B2C'`.

A buyer PO is structurally a B2B concept — household / commercial walk-in customers (B2C) don't raise internal POs. Sending `PoDtls` on a B2C invoice (where `BuyerDtls.Gstin = 'URP'`, see `payloadBuilders.ts:298`) would also look odd to NIC.

### Recommendation

- **Make the PO column nullable** on the DB (optional `String?` on Order — see Task 9). Don't enforce required-on-write at the schema layer — leaves room for the rare B2B customer who still ships without a PO and avoids a migration headache.
- **In the UI**, show the input **only when the selected customer is B2B**, and treat it as **optional even there** (don't block order creation if the buyer hasn't issued a PO yet). Empty string → store NULL.
- **At the IRN payload layer**, emit `PoDtls` **only when both** (a) the customer is B2B (gstin present) AND (b) `order.poNumber` is non-empty after trim. Omit the entire block otherwise — never send `{ PoNo: '', PoDt: '' }` (anti-pattern #10 — NIC's behaviour on empty-string optional fields is provider-specific and not verified for `PoDtls`).
- **`PoDt`** (the PO's date) — if the buyer doesn't supply a separate date, default it to `order.orderDate`. NIC accepts current/back-dated; future-dated `PoDt` is likely rejected.

## Task 9 — Full impact surface (file list)

The change is structurally additive: one new optional column propagated through the existing Order → Invoice → IRN/PDF chain. Twelve to fourteen files.

**DB / Prisma**
- `packages/api/prisma/schema.prisma` — Order model (~`:782`). Add `poNumber String? @map("po_number")`. Optionally also `poDate DateTime? @map("po_date") @db.Date` if we want to capture the PO's own date separately from `order.orderDate`.
- `packages/api/prisma/migrations/<timestamp>_add_order_po_number/migration.sql` — new migration adding the nullable column(s). No index needed unless we expect to filter orders by PO (probably not in v1).

**Shared types + Zod**
- `packages/shared/src/schemas/index.ts` — `createOrderSchema` (`:184`) + `updateOrderSchema` (`:211`). Add `poNumber: z.string().max(16).optional()` (16 to match NIC `PoNo` constraint — confirm against NIC spec). Same for `poDate: dateString.optional()` if we capture it. Re-export the inferred `CreateOrderInput` / `UpdateOrderInput` automatically.
- `packages/shared/src/types/index.ts` (or wherever `Order` is typed) — add `poNumber?: string | null; poDate?: string | null` to the shared Order DTO.

**API services**
- `packages/api/src/services/orderService.ts` — `createOrder` (`:95`) + `updateOrder` (`:518`) + `createOrderFromCancelledStock` (`:420`). Plumb `poNumber` / `poDate` through the data argument and the `prisma.order.create` / `update` calls. **Critical:** the `updateOrder` allow-list at `:534` must accept the new field — `if (data.poNumber !== undefined) updateData.poNumber = data.poNumber;`.
- `packages/api/src/services/invoiceService.ts` — `createInvoiceFromOrder` (`:119`). Today it reads `order.customer` for GST + state; it must also read `order.poNumber` / `order.poDate` and pass them to the IRN call site. **Decision point:** do we also denormalise `poNumber` onto the Invoice (so the PDF + GSTR-1 export can find it without re-joining to Order)? Recommended yes — same pattern as `customerGstinSnapshot` and `placeOfSupplyCode` (`schema.prisma:1140-1143`), which were snapshotted onto Invoice for the same "historic Order edits don't drift the invoice" reason. If we agree, also add `poNumber String? @map("po_number")` + `poDate DateTime? @map("po_date") @db.Date` to the Invoice model — extends the Prisma migration by two columns.

**GST payload**
- `packages/api/src/services/gst/payloadBuilders.ts` — `InvoiceData` interface (`:57`): add `poNumber?: string; poDate?: Date`. `IrnPayload` interface (`:108`): add `PoDtls?: { PoNo: string; PoDt: string }`. `buildIrnPayload` (`:188`): emit `payload.PoDtls` only when both fields are present and the customer is B2B (the `isB2C` check at `:189` is the gate).
- `packages/api/src/services/gst/gstService.ts` — `processInvoiceGst` and any other site that constructs `InvoiceData` (the `originalDocNumber` flow at `:1110`, `:1210` is CRN/DBN — not PO). Locate every `buildIrnPayload({...})` caller and thread `poNumber` / `poDate` from the loaded invoice or order.
- `packages/api/src/services/gst/gstPreflightService.ts` — `buildInvoiceData` (the IRN data assembler used by dispatch preflight). Same thread-through as `gstService.ts`. The `PreflightOrder` type at `:91` is order-level — needs `poNumber?: string | null` added if the preflight scope is order-side.
- `packages/api/src/services/gst/gstReissueService.ts` — `buildInvoiceDataForIrn` (`:761`). Re-issue must preserve the original PO, so load it from the snapshotted Invoice column (if we go the denormalise route) or re-fetch from Order. Reissues to the same IRN should not change `PoDtls` between cancel and regenerate.

**PDF**
- `packages/api/src/services/pdf/invoicePdfService.ts` — `drawHeader` (`:225`) or `drawParties` (`:291`) depending on placement choice from Task 3. Adds one optional line. The `meta` argument shape on `drawHeader` currently accepts `{ gstDocNo, invoiceDate, dueDate, paymentTerms, ewbNo? }` — extend with `poNumber?` and `poDate?`. The caller composes `meta` from the loaded invoice (~upstream in the same file).

**Order list / detail / invoice list endpoints**
- `packages/api/src/routes/orders.ts` (or wherever the list endpoint lives) — verify the JSON response includes `poNumber` after the Prisma model gains it (Prisma will return it automatically unless an explicit `select` clause filters it out). Add to any explicit `select` clauses.
- `packages/api/src/utils/mappers.ts` — search for order/invoice mappers (e.g. `mapCustomerInvoiceDetail`) and add `poNumber` to whichever DTOs need it for customer-portal parity. CLAUDE.md anti-pattern #17 — every consumer must see the same field name.

**Web UI**
- `packages/web/src/pages/OrdersPage.tsx`:
  - Create modal (`:479-580`) — add `poNumber` to defaults + `<Input {...register('poNumber')} />` in the form, conditional on selected customer's `customerType === 'B2B'`.
  - Update modal (`:746-840`) — same pattern.
  - Order detail / drawer (`:617-720`) — render the PO read-only.
  - Returns-only modal (`:1112-1215`) — typically no PO for returns; skip or include based on UX decision.
  - Optional: add a "PO" filter to the existing filter row.

**Mobile UI**
- `packages/mobile/app/(admin)/orders.tsx`:
  - Regular create (`:1061-1370`) — add `poNumber` state, B2B-conditional input, send in `CreateOrderVars` payload (`:1114`).
  - Returns-only create (`:2042-2225`) — skip per the returns convention.
  - Modify modal (`:2254`) — include if mutable.
  - Order detail card (~`:520-590`) — render the PO line.
- `packages/mobile/app/(customer)/orders.tsx` — customer-side order create (`:25`, `:257`) — UX decision: do we let the customer enter their own PO when self-raising? If yes, mirror the admin form. Probably yes — that's exactly the B2B self-service use case.
- `packages/mobile/app/(driver)/...` — driver delivery screen: should the driver see the customer's PO number when delivering (so they can quote it on the physical delivery note)? Recommend yes — read-only display on the delivery confirmation card. Low-risk additive.

**Customer portal**
- The customer's "My Invoices" screen on web + mobile (`packages/web/src/pages/customer/...` and `packages/mobile/app/(customer)/invoices.tsx`) — render the PO read-only so the customer can reconcile against their internal accounting.

**Tests**
- `packages/api/src/__tests__/order-create.test.ts` (or equivalent) — assert PO round-trips through create → read → update.
- `packages/api/src/__tests__/gst-payload-shape.test.ts` — add B2B positive case (PO present → `PoDtls` block emitted) and negative cases (B2C → omitted; B2B with empty PO → omitted). Anti-pattern #6.
- `packages/api/src/__tests__/invoice-pdf-content.test.ts` (if it exists; otherwise add) — verify PDF contains the PO when set, omits the line when null.
- Wire-shape guard (anti-pattern #9): assert the order GET endpoint returns `poNumber` on the JSON envelope.

## Task 10 — Confidence assessment

**Overall: clean additive.** This is a textbook nullable-column propagation through an existing, well-mapped Order → Invoice → IRN/PDF chain. Roughly 12-14 files, ~150 lines added, no breaking schema changes, no index changes needed unless we want to filter by PO. Backfill is trivial — historic rows are NULL.

**Specific surprise checks:**

1. **Existing Order indexes / uniqueness** — none of the three `@@index` on Order (`schema.prisma:843-845`) touch a column we're adding. No uniqueness constraint on `orderNumber` extends to a hypothetical `poNumber`, and that's correct: two different orders for the same buyer can legitimately reference the same internal PO (a blanket PO across multiple deliveries). Don't unique-constrain it.

2. **NIC `PoDtls` empty-string behaviour — UNVERIFIED.** This is the one real risk. We don't currently emit `PoDtls`, so we have zero codebase data on whether NIC rejects `{ PoNo: '', PoDt: '' }` vs a missing block. **Recommendation: always omit the block when either field is empty after trim.** Anti-pattern #10 says verify against the live WhiteBooks sandbox before marking done — do that with one dist-002 (Sharma) live B2B dispatch carrying a real PO before the WI closes.

3. **PDF header space** — drawHeader (`:230-289`) is currently 4 lines tall (company / GSTIN block on left; Tax Invoice / GST Doc / EWB on right; divider; meta row). The Bill To box (`drawParties`, `:291`) is the better placement — there's vertical room there and the field belongs visually with buyer identity. The header is "tight enough" that adding a 5th line on the right would push the parties row down by ~14px and start eating into per-page subtotals on long invoices (CLAUDE.md mentions per-page subtotals were the most recent layout fix at `46dd612`). Pick Bill To.

4. **Discriminated unions on Order** — none in `packages/shared/src/types`. `OrderType` enum is the only discriminator and it gates `returns_only` vs `delivery` — orthogonal to PO. No exhaustiveness checks need updating.

5. **Reissue + cancel path** — `gstReissueService.ts:761` (`buildInvoiceDataForIrn`) re-builds the IRN payload from the loaded invoice on every reissue. If we denormalise `poNumber` onto Invoice (recommended), reissue preserves it automatically. If we leave it on Order only, reissue still works because the Order-Invoice relation is preserved through cancel + regenerate. Either way: no special handling needed beyond loading the column.

6. **InventoryDispatchDebit flow** — unaffected. The depot debit / float reconciliation flow reads from Order qty + status, nothing PO-related.

**Hidden complexity flags: one.** The `PoDtls` empty-vs-omitted ambiguity at the NIC boundary. Everything else is mechanical plumbing.

---

## Plain-English Summary

### Is there any PO/reference field anywhere today?

**No.** The Order, OrderItem, Invoice, and InvoiceItem models have no buyer-PO or buyer-reference field. `customerGstinSnapshot` on Invoice is a GSTR-1 snapshot (the buyer's own GSTIN at issue time), not a PO. The PDF's "Reference: <invoiceNumber>" line is a self-reference. The IRN payload emits `RefDtls.PrecDocDtls` only for CRN/DBN linkage (`payloadBuilders.ts:338-347`) — never for a buyer PO. The web and mobile order create forms accept only `customerId`, `deliveryDate`, `specialInstructions`, `items` (`createOrderSchema` at `packages/shared/src/schemas/index.ts:184`).

### NIC field name + optionality + max length

- **Block:** `PoDtls` (top-level on the IRN payload, sibling of `DocDtls` and `RefDtls`).
- **Shape:** `{ PoNo: string, PoDt: string }` — `PoDt` is `dd/mm/yyyy`.
- **Optional** per NIC e-invoice v1.1 schema — omit the entire block when no PO.
- **Max length:** `PoNo` is per public NIC documentation typically 16 chars (same as `DocDtls.No`, which is enforced at `payloadBuilders.ts:171-183`). **Not confirmed from code in this repo** — we don't emit `PoDtls` today. Confirm against the NIC PDF / WhiteBooks API spec before locking the Zod max.

### Full file list for implementation

- `packages/api/prisma/schema.prisma` (Order model; optionally Invoice model if we denormalise)
- `packages/api/prisma/migrations/<timestamp>_add_order_po_number/migration.sql`
- `packages/shared/src/schemas/index.ts` (`createOrderSchema`, `updateOrderSchema`)
- `packages/shared/src/types/index.ts` (Order DTO)
- `packages/api/src/services/orderService.ts` (`createOrder`, `updateOrder`, `createOrderFromCancelledStock`)
- `packages/api/src/services/invoiceService.ts` (`createInvoiceFromOrder`)
- `packages/api/src/services/gst/payloadBuilders.ts` (`InvoiceData`, `IrnPayload`, `buildIrnPayload`)
- `packages/api/src/services/gst/gstService.ts` (every `buildIrnPayload` caller)
- `packages/api/src/services/gst/gstPreflightService.ts` (`buildInvoiceData`, `PreflightOrder`)
- `packages/api/src/services/gst/gstReissueService.ts` (`buildInvoiceDataForIrn`)
- `packages/api/src/services/pdf/invoicePdfService.ts` (`drawParties` — Bill To block — preferred)
- `packages/api/src/utils/mappers.ts` (any invoice/order mapper that the customer portal reads)
- `packages/web/src/pages/OrdersPage.tsx` (create modal, update modal, detail drawer)
- `packages/mobile/app/(admin)/orders.tsx` (regular create, modify modal, detail card)
- `packages/mobile/app/(customer)/orders.tsx` (customer self-service create)
- `packages/mobile/app/(customer)/invoices.tsx` (customer invoice display)
- `packages/mobile/app/(driver)/...` (delivery screen — read-only display, low-risk)
- Tests: order round-trip + `gst-payload-shape.test.ts` (`PoDtls` emit/omit cases) + PDF content guard + wire-shape guard

### Estimated complexity

**12-14 files, ~150 lines, clean additive.** One real verification cost: live WhiteBooks sandbox test on dist-002 (Sharma) to confirm NIC accepts our `PoDtls` shape and to lock the empty-string-vs-omit decision (anti-pattern #10).
