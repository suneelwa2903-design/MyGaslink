# Backdated / On-demand Order+Invoice — Investigation

Pure read-only investigation against `main` @ `4b7e83f` (2026-06-25). Design parameters are LOCKED — this report only surfaces code-level surprises that the design must absorb or work around.

> **Path note** — the brief references `apps/*`. This repo uses `packages/{api,web,mobile,shared}`. All citations below use the real paths.

---

## Task 1 — Invoice number sequencing

### 1.1 — Full allocator logic

`packages/api/src/services/numberingService.ts:30-84` (WI-108).

Format: `<TYPE 1><CODE 3><FY 4><SEQ 6>` = 14 chars (e.g. `ISHD2627000123`).
- `TYPE`: `I` invoice, `R` revision, `C` credit-note, `D` debit-note, `O` order
- `CODE`: distributor's 3-letter `docCode` (validated `/^[A-Z]{3}$/`)
- `FY`: 4 digits, Indian financial year (Apr–Mar) via `getFinancialYear(date)`
- `SEQ`: zero-padded to 6

The counter is `invoiceCounter` keyed by `(distributorId, type, financialYear)`. Allocation is an atomic `upsert(... lastSequence: { increment: 1 })` — Prisma compiles it to `UPDATE ... SET last_sequence = last_sequence + 1 RETURNING`, serialising concurrent allocations.

CRITICAL: per the doc-block comment, the allocator MUST be called inside the same Prisma transaction as the row it numbers, so a rollback frees the number (gapless invariant). `createInvoiceFromOrder` passes `tx` (`invoiceService.ts:167`), `createManualInvoice` passes `tx` (`invoiceService.ts:460`), `createOrder` passes `tx` (`orderService.ts:257`). All compliant.

### 1.2 — Allocator is date-agnostic w.r.t. sort order

The allocator increments the counter for the `(distributor, type, FY)` row regardless of the `date` argument. A backdated invoice raised today gets today's next sequential number (per FY). Confirmed: the only use of `date` is `getFinancialYear(date)` at `numberingService.ts:59`.

### 1.3 — GSTR-1 / CGST Rule 46 compliance

CGST Rule 46(b) requires invoice numbers to be "a consecutive serial number not exceeding sixteen characters … unique for a financial year". Consecutive ≠ date-ordered. Multiple ICAI/CBIC clarifications and every commercial GST software treat date-of-issue and number-of-issue independently — backdated invoices issued today are routinely numbered with today's next sequence. The 14-char format is well under the 16-char NIC cap (loud-fail at `numberingService.ts:77`).

Single guard line that asserts this is intentional: `numberingService.ts:14-16`:
> "MUST be called inside the same transaction as the invoice/order create so a rollback frees the number (gapless)."

Gapless + per-FY-unique = compliant. No code currently asserts date-ordering as a constraint.

### 1.4 — Code assuming `invoiceNumber` correlates with `issueDate`

Grep for `orderBy.*invoiceNumber` returns ZERO hits across `packages/api/src`. Every `orderBy` on Invoice is one of:
- `{ createdAt: 'desc' }` — `invoiceService.ts:96` (admin list)
- `{ issueDate: 'desc' }` — `customerPortalService.ts:791,830`
- `{ issueDate: 'asc' }` — `paymentService.ts:180,791` (oldest-first allocation), `reportsService.ts:185`, `tallyExportService.ts:376,430,460`

NONE of these combine `invoiceNumber` + `issueDate`. **No code today assumes the two correlate.** Out-of-order numbering is safe to ship.

### 1.5 — FY rollover — critical edge case

`createInvoiceFromOrder`: `invoiceService.ts:163-167`:

```ts
const issueDate = new Date();
const invoiceNumber = distributor?.docCode
  ? await allocateNumber(tx, distributorId, 'I', issueDate, distributor.docCode)
  : legacyNumber('INV');
```

`issueDate` and the FY token both derive from `new Date()`. No backdating.

`createManualInvoice`: `invoiceService.ts:460`:

```ts
const invoiceNumber = distributor?.docCode
  ? await allocateNumber(tx, distributorId, 'I', new Date(data.issueDate), distributor.docCode)
  : legacyNumber('INV');
```

**FY is computed from `data.issueDate` (the backdated date).** So a March 31 invoice (FY 2526) created on April 5 (FY 2627) would get `FY=2526` and increment the FY 2526 counter — which has already been closed (last-sequence pinned at the cutover).

**This is the critical cross-FY edge case the design must block.** Two acceptable resolutions:
- (a) The same-month constraint (Task 9) inherently blocks this: April 5 backdating to March 31 crosses the calendar month boundary and is rejected at the Zod layer.
- (b) Add a separate FY-boundary guard in the backdated route's Zod schema — explicit, defence-in-depth.

Recommend (a) — same-month is stricter than same-FY and the documented design constraint, so the FY edge case is automatically handled. But document this dependency explicitly in the spec, because future relaxation of "same calendar month" to "same FY" would reopen the risk.

---

## Task 2 — IRN payload date

### 2.1 — `DocDtls.Dt` source

`payloadBuilders.ts:280-284`:

```ts
DocDtls: {
  Typ: data.docType,
  No: truncateDocNumber(data.docNumber),
  Dt: formatDate(data.docDate),
},
```

`data.docDate` is the parameter, NOT `new Date()`. `formatDate` is `format(date, 'dd/MM/yyyy')` via `date-fns` (`payloadBuilders.ts:167-169`).

### 2.2 — Upstream `data.docDate` source

`processInvoiceGst`: `gstService.ts:268-271`:

```ts
const invoiceData = {
  docType: 'INV' as const,
  docNumber: invoice.invoiceNumber,
  docDate: invoice.issueDate,
  ...
```

`data.docDate` ← `invoice.issueDate`, NOT `new Date()`. So if we store `issueDate = June 18` and create the invoice on June 24, the IRN payload's `DocDtls.Dt = "18/06/2026"`. Same applies to `runB2bPreflight` (`gstPreflightService.ts` builds the same shape).

### 2.3 — Confirmation

Yes — `invoice.issueDate = June 18` → IRN `DocDtls.Dt = "18/06/2026"`. The pipeline carries the backdated date through to NIC without re-clamping.

### 2.4 — Date clamping

Grep `gstPreflightService.ts` and `gstService.ts` for `isToday`, `setHours(0,0,0,0)`, `< new Date()`, `new Date() <` returns ZERO hits in those files. **No date-clamping or "must-be-today" validation exists on the GST path.** The pipeline will send whatever `issueDate` you store.

### 2.5 — NIC policy

For sub-₹10cr aggregate-turnover taxpayers, NIC's e-invoice portal has NO hard 24/7-day cap on backdating at the time of writing. (The widely-cited "30-day reporting" cap applies only to taxpayers with AATO ≥ ₹100cr per the Aug-2023 advisory). Vanasthali / Sharma sit well below that threshold.

**Anti-pattern #10 mandates a live sandbox A/B before any production-ready claim** — mock tests will pass for any `Dt` string. Add a dedicated test in `packages/api/src/__tests__/gst-payload-shape.test.ts` for the backdated case (e.g. `docDate = today - 14d`) AND run a paired live sandbox call against `INV-BACKDATED-N` on dist-002 before pilot enable.

---

## Task 3 — EWB for backdated orders

### 3.1 — `buildEwbPayload` required fields

`payloadBuilders.ts:374-421` — type `EwbPayload`. REQUIRED fields:
- `supplyType` (hardcoded 'O'), `subSupplyType` ('1')
- `docType`, `docNo`, `docDate` — inherited from the IRN payload's `DocDtls`
- `fromGstin / fromPincode / fromStateCode / fromTrdName / fromAddr1/2 / fromPlace` — seller
- `toGstin / toPincode / toStateCode / toTrdName / toAddr1/2 / toPlace` — buyer
- `transMode` (default '1' = Road)
- `transDistance` — derived from pincode pair via `getTransDistance` (`payloadBuilders.ts:481-484`)
- `transDocNo` (intentionally empty for own-vehicle — `:545`)
- `transDocDate` (set to `doc.Dt` — same as `DocDtls.Dt` — i.e. the backdated invoice date — `:546`)
- `vehicleNo` (validated against Indian RTO plate regex `/^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{4}$/` at `:463-470` — invalid plates throw before any NIC call)
- `vehicleType` ('R')
- `itemList`, `actFromStateCode`, `actToStateCode`, `transactionType: 1`, `subSupplyDesc`, `totalValue`, `totInvValue`, `cgstValue`, `sgstValue`, `igstValue`, `cessValue`, `cessNonAdvolValue`

Vehicle is REQUIRED (the plate regex would throw on empty string). Driver is NOT directly used in `buildEwbPayload` (the EWB is per-vehicle, not per-driver) — but in our flow the driver-vehicle pairing is the source of truth for which vehicle to use.

### 3.2 — EWB validity — generated TODAY for invoice dated June 18

NIC accepts arbitrary `docDate` on the EWB payload as long as it does not violate an internal "doc must precede EWB generation by ≤N days" rule. There is no published hard cap that's relevant here — the EWB's validity window starts from `generation time`, not `docDate`, and is `24h × ceil(distance / 100km)`. So a 14-day-old invoice generating an EWB today is fine; the EWB just gets a fresh 24h+ window starting today.

Anti-pattern #10 caveat still applies: live sandbox A/B before claiming production-ready.

### 3.3 — "E-Invoice + EWB" path

- **Minimum required user input:** vehicle is required at the payload level (plate regex). Driver is required at the OPERATIONAL level only — distributor needs to know who is associated with that vehicle for record-keeping. From a NIC-payload perspective vehicle alone suffices; from a business perspective the DVA / dispatch flow normally pairs them. **Recommend: surface both as required in the modal Step 2, even though only `vehicle` is structurally needed for the payload.**
- **Where the date goes:** the EWB payload's `docDate` (line `:491`) and `transDocDate` (line `:546`) BOTH carry `doc.Dt` — i.e. the backdated invoice date. There is NO separate `genDate` in the payload (NIC stamps that server-side from when it processes the request). Document this as intended: NIC will know the EWB was generated today but the linked invoice/transport document is backdated.
- **Dashboard confusion:** the EWB validity window starts from generation time, NOT `docDate`. The In-Transit dashboard query at `orders.ts:121-144` keys on `assignmentDate` and `DVA.status='loaded_and_dispatched'`. A backdated order with NO DVA (design says "skip the standard delivery workflow") would not appear in In-Transit, so there's no confusion. But if the EWB is generated against a vehicle/driver pair, a downstream report querying "today's EWBs" would correctly show today as the generation date — confusion is unlikely.

### 3.4 — "E-Invoice Only" path

EWB call is skipped. Downstream code that requires `Invoice.ewbStatus !== 'pending'`:

- `confirmDelivery` (`orderService.ts:781-1098`) — does NOT block on `ewbStatus`. It runs `processInvoiceGst` post-commit if there's no live GST doc yet, else `reissueForDeliveryMismatch` for modified deliveries. For backdated orders, `confirmDelivery` won't be called (no Order in pending_delivery state).
- `gstReissueService` — only triggered for modified delivery. Won't fire for backdated.
- `transitionGuards.ts` — gates DVA / order transitions. Doesn't run for the backdated path because the Order skips dispatch/delivery.

**Net:** "E-Invoice Only" leaves `Invoice.ewbStatus = 'not_attempted'` permanently. Downstream code tolerates this — it's the same state as a GST-disabled tenant. No special handling needed.

---

## Task 4 — `createManualInvoice` vs new function

### 4.1 — Function signature

`invoiceService.ts:352-368`:

```ts
export async function createManualInvoice(
  distributorId: string,
  userId: string,
  data: {
    customerId: string;
    issueDate: string;          // ← user-provided
    dueDate: string;            // ← user-provided
    items: {
      cylinderTypeId?: string;
      description: string;
      hsnCode?: string;
      quantity: number;
      unitPrice: number;        // EXCLUSIVE input (converted to inclusive on persist)
      discountPerUnit?: number;
      gstRate?: number;
    }[];
  }
)
```

### 4.2 — What `createManualInvoice` does NOT do (vs `createInvoiceFromOrder`)

- ❌ No inventory events (no `createInventoryEvent`)
- ❌ No `orderId` linkage (Invoice.orderId stays NULL)
- ❌ No `CustomerInventoryBalance` update
- ❌ No `CancelledStockEvent`
- ❌ No DVA / driver-assignment changes
- ❌ No transport-charge line (the order-driven path adds `HSN 996511`; manual is silent here — distributor must add it explicitly)
- ✅ DOES create `customer_ledger_entry` with `entryDate: new Date(data.issueDate)` — **respects backdated date** (`:495`)
- ✅ DOES auto-trigger `processInvoiceGst` fire-and-forget post-commit (`:510`)

### 4.3 — Does it allow backdated `issueDate`?

YES. The route validator (`routes/invoices.ts:96`) is `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)` — pure format check, no `min` / `max` / today-comparison. The service writes whatever it receives.

### 4.4 — Auto IRN trigger

`invoiceService.ts:508-514`:

```ts
try {
  const { processInvoiceGst } = await import('./gst/gstService.js');
  processInvoiceGst(invoice.id, distributorId).catch(() => {
    // intentionally swallowed — failures land in the invoice's irnStatus
    // / ewbStatus columns and the pending-actions queue
  });
} catch { /* non-blocking */ }
```

Confirmed: fire-and-forget IRN trigger, identical pattern to `confirmDelivery`. Failures surface in `invoice.irnStatus` + pending-actions queue.

### 4.5 — CRITICAL: createManualInvoice currently does NOT pass a vehicle to the IRN path

`processInvoiceGst` reads vehicle via `invoice.order.vehicle` (`gstService.ts:241,440-460`). For a manual invoice, `invoice.orderId IS NULL`, so `invoice.order` is null, so the Step-2 EWB branch (`if (invoice.order?.vehicle)`) is skipped entirely. **EWB is NEVER attempted via `createManualInvoice` today.** B2B IRN fires but EWB doesn't.

For backdated flow this is fine for the "E-Invoice Only" path (matches design). For "E-Invoice + EWB" path, the implementation MUST either:
- (a) Wrap `createManualInvoice` + immediately call `processInvoiceGst`/`generateEwbFromIrn` with the user-selected vehicle, OR
- (b) Create an Order row first (carrying the vehicle), then `createInvoiceFromOrder` (which reads `order.vehicle`), OR
- (c) Extend `createManualInvoice` to accept an optional `{ vehicleNumber }` and plumb it into the GST trigger.

### 4.6 — Reuse / wrap / new — verdict

**Recommend (b) — wrap.** Build a new service `createBackdatedOrder(distributorId, userId, data)` that:
1. Creates `Order` row with `status='delivered'`, `deliveryDate=issueDate`, `deliveredAt=now()`, `driverId/vehicleId` only if EWB path selected.
2. Inside the SAME `prisma.$transaction`, calls `createInvoiceFromOrder(tx, orderId, distributorId, userId)` — this already handles `Invoice.orderId` linkage, customer ledger, IRN auto-trigger, and reads `order.vehicle` for the EWB step.
3. Optionally creates an atomic Payment via `createPaymentInTx(tx, ...)`.

Rationale:
- `createInvoiceFromOrder` is the more battle-tested path; `createManualInvoice` is essentially unused in production today (the manual invoice UI is dormant).
- Reading the vehicle from `Order.vehicle` matches the existing IRN/EWB flow exactly — no new code paths in `processInvoiceGst`.
- The customer ledger uses `entryDate: issueDate` — already correct.
- One change needed: `createInvoiceFromOrder` currently sets `const issueDate = new Date();` at `:163`. For the backdated wrapper we need either (i) to pass `issueDate` as a parameter (signature change, all 4 callers must absorb it), or (ii) to set `Order.deliveryDate = backdatedDate` and have `createInvoiceFromOrder` derive `issueDate` from `Order.deliveryDate` instead of `new Date()`. (i) is cleaner; (ii) silently changes existing semantics.

Cleanest: add a new optional 4th parameter to `createInvoiceFromOrder`: `options?: { issueDateOverride?: Date }`. Default behaviour preserved; the wrapper passes through.

### 4.7 — Duplicate-invoice risk

`createInvoiceFromOrder:139-142`:

```ts
const existing = await tx.invoice.findFirst({
  where: { orderId, distributorId, deletedAt: null },
});
if (existing) throw new InvoiceError('Invoice already exists for this order', 400);
```

Dedup guard EXISTS. Plus `Invoice.orderId @unique` at schema level (`schema.prisma:1115`). **Safe** — a later `confirmDelivery` against the same `Order.id` cannot create a second invoice; it would throw (and that throw is caught + swallowed by the post-commit GST trigger at `orderService.ts:1024-1027`).

But: the design says backdated orders SKIP the delivery workflow entirely. The wrapper should set `Order.status='delivered'` immediately so `confirmDelivery` would reject anyway (it requires `status IN (pending_delivery, pending_dispatch)` per `orderService.ts:839`). Double safety.

---

## Task 5 — Inventory skip implications

### 5.1 — No inventory events

Confirmed by design. `createInvoiceFromOrder` does NOT touch inventory; only `confirmDelivery` does (`orderService.ts:952-999`). If the wrapper bypasses `confirmDelivery`, no inventory events are written.

`recalculateSummariesFromDate` runs only when an inventory event is created (called inside `confirmDelivery` at `:1052`). For backdated invoices with no events, no recalc is triggered — correct per design.

### 5.2 — Assertions flagging "Order exists but no inventory event"

Grep across `packages/api/src/services` for such cron / pending-action / assertion logic returns no obvious hit. The pending-actions service handles GST + payment-commitment items, not inventory-orphan detection. The `dvaRollFallback` only repairs DVA state, not Order state.

A backdated `Order` with `status='delivered'`, `deliveredAt=now()`, and no inventory event will sit happily in the DB. Admin handles stock manually per design.

### 5.3 — `CustomerInventoryBalance` update path

`customerInventoryBalance.upsert` is called in `confirmDelivery` (`orderService.ts:983-998`) — keyed by inventory delivery semantics, not invoice. Backdated invoice without inventory event → customer cylinder balance UNCHANGED. Intentional per design.

### 5.4 — Dashboard KPI date field

`analyticsService.ts > getDashboardStats:10-89`:
- `ordersToday` counts `Order.orderDate` (= today)
- `deliveredToday` counts `Order.deliveredAt` (= today's deliveries)
- `revenueToday` aggregates `Order.totalAmount` filtered by `deliveredAt` in [today, tomorrow)

**For a backdated Order with `orderDate=now()` but `deliveredAt=now()` and `deliveryDate=backdatedDate`:**
- `ordersToday` ↑ by 1
- `deliveredToday` ↑ by 1
- `revenueToday` ↑ by `Order.totalAmount` — REVENUE LANDS TODAY, NOT ON THE BACKDATED DATE.

**This is a behavioural decision the design must take:** if a backdated invoice for `June 18` is created on `June 24`, should "today's revenue" include it? Options:
- Set `Order.deliveredAt = backdatedDate` instead of `now()` → revenue lands in the historical bucket; today's dashboard is unaffected
- Set `Order.deliveredAt = now()` → revenue appears in today's KPIs (what feels like "I billed someone today")

`getRevenueTrends:314-338` uses `Invoice.issueDate` for monthly grouping — so monthly trends ARE backdate-aware regardless of which `deliveredAt` is chosen.

**Recommendation:** set `Order.deliveredAt = backdatedDate` AND `Order.orderDate = backdatedDate`. The Order represents a real-world delivery that already happened — its provenance date is the backdated date, not today. The "today I did escape-hatch work" telemetry is captured in `Order.createdAt` / `Invoice.createdAt` / `customerLedgerEntry.createdAt` for audit purposes.

⚠️ **NEEDS DESIGN DECISION** — this is the single behavioural fork to confirm with the user.

---

## Task 6 — Order status flow

### 6.1 / 6.2 — `OrderStatus` enum

`packages/shared/src/enums/index.ts:68-77`:

```ts
PENDING_DRIVER_ASSIGNMENT = 'pending_driver_assignment',
PENDING_DISPATCH = 'pending_dispatch',
PREFLIGHT_IN_PROGRESS = 'preflight_in_progress',
PENDING_DELIVERY = 'pending_delivery',
DELIVERED = 'delivered',
MODIFIED_DELIVERED = 'modified_delivered',
CANCELLED = 'cancelled',
RETURNS_ONLY = 'returns_only',
```

### 6.3 — Recommend Option A: `status='delivered'` immediately

A backdated order semantically IS a delivered order — the supply already happened. `delivered` is the cleanest match.

Checks:
- `createInvoiceFromOrder:134-136` requires `status IN (delivered, modified_delivered)` — Option A passes.
- Dashboard `deliveredToday` query (`analyticsService.ts:24-30`) filters by `deliveredAt` window AND `status IN (delivered, modified_delivered)` — works.
- `confirmDelivery` rejects already-delivered orders via the idempotency check at `:819-836` — safe (can't double-confirm).

### 6.4 — `pending_dispatch / pending_delivery` queries

`getDashboardStats:39-52`:
- `pendingDispatch` = `status IN (pending_driver_assignment, pending_dispatch)` — Option A NOT counted. ✅
- `inFlight` = `status='pending_delivery'` — Option A NOT counted. ✅

If we chose Option C (briefly pending_delivery), there's a window of dashboard pollution between Order create and the in-tx confirmDelivery. NOT worth the cost.

### 6.5 — Verdict

**Option A** (`status='delivered'` from creation). Cleanest, no new enum value (B avoids a migration), no transient bad state (C avoids a window).

Option B (new `backdated` status) adds a migration + every consumer of `OrderStatus` (the web + mobile lists, role-based status filters, status badge colour maps) must absorb it. Not worth the complexity for a single escape-hatch path. Stick with Option A.

---

## Task 7 — Payment handling

### 7.1 — `createPayment` / `createPaymentInTx`

`paymentService.ts:102-250`. `createPaymentInTx` accepts a `Prisma.TransactionClient` and the standard `CreatePaymentData` shape. It:
- Validates customer-distributor scope inside `tx` (`:109-112`)
- Allocates against invoices either manually or oldest-first (auto)
- Writes `payment_transaction` row, `payment_allocation` rows, updates invoice `outstanding/amountPaid/status`, writes `customer_ledger_entry`

Allocation `findFirst` reads `Invoice` rows that exist at the time of the call — so the invoice MUST exist first (or be created inside the same tx earlier).

### 7.2 — Atomic Order → Invoice → Payment

Yes. Pattern:

```ts
return prisma.$transaction(async (tx) => {
  const order = await tx.order.create({ ... status: 'delivered' ... });
  const invoice = await createInvoiceFromOrder(tx, order.id, distributorId, userId);
  if (data.payment) {
    await createPaymentInTx(tx, distributorId, userId, {
      customerId: data.customerId,
      amount: data.payment.amount,
      paymentMethod: data.payment.method,
      referenceNumber: data.payment.referenceNumber,
      transactionDate: data.payment.transactionDate ?? data.issueDate,
      allocations: [{ invoiceId: invoice.id, amount: data.payment.amount }],
    });
  }
  return { order, invoice };
});
```

All three roll back on any failure.

Caveat: `createInvoiceFromOrder` fires `processInvoiceGst` async post-commit; we'd want to do the same here (outside the tx). The wrapper has to do it because `createInvoiceFromOrder` ONLY fires IRN from `confirmDelivery`'s post-commit block (`orderService.ts:1056-1085`) — NOT internally. **Wrapper responsibility: post-commit, dispatch IRN (+EWB if vehicle attached) the same way `confirmDelivery` does.**

### 7.3 — Payment date vs invoice date

`PaymentTransaction.transactionDate` is independent of `Invoice.issueDate`. The customer may pay today against an invoice dated June 18. Allowed by schema.

The ledger entry stamps `entryDate: new Date(data.transactionDate)` (`paymentService.ts:240`) — so the payment ledger line lives on the payment date, the invoice ledger line lives on the invoice date. Correct.

### 7.4 — Customer ledger uses `transactionDate`

Confirmed — `paymentService.ts:240`: `entryDate: new Date(data.transactionDate)`. NOT `createdAt`. ✅

---

## Task 8 — GSTR-1 and Tally

### 8.1 — GSTR-1 (future)

Not yet built. Phase 5 columns on Invoice (`schema.prisma:1140-1143`) are present and being populated at write time: `taxableValue`, `placeOfSupplyCode`, `reverseCharge`, `customerGstinSnapshot`. When the GSTR-1 export ships, the period-grouping MUST use `Invoice.issueDate`, not `createdAt` — same convention as Tally below.

### 8.2 — Tally

`tallyExportService.ts` doc-block:
> "Sales — one per Invoice (issueDate in [from, to], not deleted)"

All four export branches (Sales, Receipt, Credit Note, Debit Note) filter and orderBy `issueDate` (`tallyExportService.ts:339, 376, 430, 460`). The voucher `<DATE>` tag (`:149`) uses `tallyDate(v.date)` where `v.date = inv.issueDate / cn.issueDate / dn.issueDate / payment.transactionDate` (`:491, 545, 585`).

Payments use `transactionDate` (not `issueDate`) at `tallyExportService.ts` Receipt branch — independent path.

### 8.3 — Confirmed

A backdated Invoice (issueDate=June 18, createdAt=June 24) lands in the June Tally export AND would land in the June GSTR-1 period. Both correct.

⚠️ Subtle note: `tallyDate` uses `getUTCFullYear/getUTCMonth/getUTCDate` (`tallyExportService.ts:75-79`). For a June 18 IST `@db.Date` value stored at midnight local, the UTC date might be June 17 in some boundary cases. This is anti-pattern #21 in a different guise — flagged but out of scope for THIS WI. Pre-existing.

---

## Task 9 — Same-month date validation

### 9.1 — Where the check lives

**Recommend: BOTH layers.**
- Zod (route layer): early UI feedback, declarative.
- Service layer: defence in depth for cron / scripts / future programmatic callers.

### 9.2 — Local-TZ requirement

Per anti-pattern #21, `new Date().toISOString().split('T')[0].slice(0,7)` is BANNED — it returns UTC and silently fails between 18:30 UTC and 23:59 UTC (00:00–05:30 IST). Use:

```ts
const now = new Date();
const currentYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const inputYM = data.issueDate.slice(0, 7); // 'YYYY-MM'
if (inputYM !== currentYM) throw new Error('Backdated date must be within the current calendar month.');
```

Reference: `packages/api/src/__tests__/helpers.ts > today()` and `localTodayISO` from `@gaslink/shared` (used in `routes/orders.ts:127`).

CI guard `packages/api/scripts/check-tz-patterns.sh` will block any reintroduction of `toISOString().split('T')[0]`.

### 9.3 — Error message

> "Backdated date must be within the current calendar month."

Plus a UI-side preventive: the date picker should `min={firstDayOfCurrentMonth}` and `max={today}`.

### 9.4 — Existing date-range patterns to mirror

`createOrderSchema` in `packages/shared/src/schemas/` — `deliveryDate` is parsed via Zod. Mirror its approach.

---

## Task 10 — Role guard

### 10.1 — Existing role gate on `POST /api/orders`

`routes/orders.ts:225`:

```ts
requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'customer')
```

Broad. Includes `customer` (the customer portal posts orders via this route).

### 10.2 / 10.3 — Recommend: separate route

**`POST /api/orders/backdated` with `requireRole('distributor_admin')` ONLY** (super_admin should NOT have it — super_admin shouldn't be raising backdated invoices on behalf of distributors as a routine operation; if they need to, they can role-switch).

Reasons:
- Cleaner permissions audit (one route = one role)
- Cannot accidentally backdate a regular order (no body-flag path)
- Mirrors existing patterns: `POST /api/orders/returns-only` (`routes/orders.ts:72`), `POST /api/orders/from-cancelled-stock` (`:90`), `POST /api/invoices/manual` (`routes/invoices.ts:92`) — all use this "separate route per escape-hatch" idiom
- No collision: grep across `routes/orders.ts` shows no existing `/backdated` route.

⚠️ Route ordering: register `POST /api/orders/backdated` BEFORE `POST /api/orders/:id` (if any) but the existing file has `POST /` not `POST /:id`, so no collision risk on POST.

---

## Task 11 — Gap analysis vs standard workflow

| Area | Standard delivery | Backdated order | Status |
|---|---|---|---|
| Invoice number series | sequential allocator | next today's number, FY from issueDate | ✅ auto (FY edge case covered by same-month rule) |
| IRN (B2B) | auto-trigger after invoice | auto-trigger same way, `DocDtls.Dt = issueDate` | ✅ auto (verify on live sandbox per anti-pattern #10) |
| EWB | always for B2B/B2C URP | optional via two-step modal | ⚠️ needs flag — wrapper passes `vehicleId` to Order so `processInvoiceGst` sees `invoice.order.vehicle` |
| Inventory dispatch event | written by preflight | not written | 🚫 N/A by design |
| Inventory delivery event | written by `confirmDelivery` `orderService.ts:952-999` | not written | 🚫 N/A by design |
| `CustomerInventoryBalance` | updated from delivery event `orderService.ts:983-998` | unchanged | 🚫 N/A (admin handles) |
| `InventorySummary` recalc | triggered by events `orderService.ts:1052` | not triggered | 🚫 N/A |
| Driver assignment | required for dispatch | optional (required if EWB) | ⚠️ needs flag — wrapper conditionally sets `Order.driverId` |
| DVA lifecycle | full flow | none | 🚫 N/A (Order created in `delivered` state, never touches DVA) |
| Vehicle reconciliation | required | not applicable | 🚫 N/A |
| Payment | post-delivery | optional, atomic with invoice via `createPaymentInTx` | ⚠️ needs path (wrapper accepts optional `payment` block) |
| GSTR-1 export | groups by `issueDate` (Phase 5 schema) | groups by `issueDate` | ✅ auto |
| Tally export | groups by `issueDate` `tallyExportService.ts:7,353,491` | groups by `issueDate` | ✅ auto |
| Customer ledger | `entryDate = issueDate` `invoiceService.ts:341,495` | `entryDate = issueDate` | ✅ auto |
| Dashboard KPIs | by date | `revenueToday` keyed on `deliveredAt`, `revenueTrends` on `issueDate` | ⚠️ needs decision — see Task 5.4 (recommend `Order.deliveredAt = issueDate`) |
| Driver app visibility | shows assigned orders | hidden (no driver assigned OR driver assigned but Order is `delivered`) | ✅ auto — driver app `/api/orders` filters by `driverId` and the driver dashboard only surfaces in-flight orders |

---

## Plain-English summary

### A. Invoice number out-of-sequence — GSTR-1 safe?

**YES.** CGST Rule 46(b) requires consecutive serial numbering per FY — not date-ordered. The numbering allocator (`packages/api/src/services/numberingService.ts:44`) increments a counter per `(distributor, type, FY)` atomically; the `date` parameter is consulted only for the FY token. No `orderBy: { invoiceNumber }` exists in the API codebase — every consumer sorts by `issueDate` or `createdAt`. Out-of-order numbering is safe.

### B. IRN with backdated date — NIC accepts?

**Code-side: yes** — `payloadBuilders.ts:280` puts `data.docDate` (= `invoice.issueDate`) into `DocDtls.Dt`, no clamping anywhere on the GST path. **NIC-side: yes per published policy** — no hard cap for sub-₹10cr AATO taxpayers (the 30-day cap applies only ≥ ₹100cr). **Anti-pattern #10 requires a live sandbox A/B before claiming production-ready**: backdate a test invoice by 7 / 14 / 28 days and confirm the IRN issues cleanly.

### C. `createManualInvoice` — reuse, wrap, or new function?

**WRAP — but wrap `createInvoiceFromOrder`, not `createManualInvoice`.** Build `createBackdatedOrder(distributorId, userId, data)` that:
1. Creates an Order row (`status='delivered'`, `deliveryDate=issueDate`, `deliveredAt=issueDate`, optional `driverId/vehicleId`)
2. Calls `createInvoiceFromOrder(tx, order.id, ...)` inside the same `$transaction`
3. Optionally calls `createPaymentInTx(tx, ...)`
4. Post-commit, dispatches `processInvoiceGst` (matching `confirmDelivery`'s pattern at `orderService.ts:1056-1085`)

The required tweak: add `issueDateOverride?: Date` to `createInvoiceFromOrder`'s signature — currently hardcoded `const issueDate = new Date();` at `invoiceService.ts:163`. The 4 existing callers (`confirmDelivery`, the test fixtures, and 2 reissue paths) absorb the default.

`createManualInvoice` is NOT a good fit because (i) `Invoice.orderId` stays NULL, breaking the `invoice.order.vehicle` read used by the EWB path (`gstService.ts:440`), (ii) it accepts EXCLUSIVE input prices while the order-driven path uses INCLUSIVE (per anti-pattern #16 the storage convention is INCLUSIVE — `createManualInvoice` has its own converter, fine for its own callers but a divergent contract from the rest of the system).

### D. Inventory skip — what the admin must manually handle

- **Stock levels**: no `inventory_events` written → `InventorySummary` not decremented. Admin must adjust depot stock via the existing inventory adjustment flow.
- **Customer cylinder balance**: `CustomerInventoryBalance.withCustomerQty` UNCHANGED. If the backdated delivery was a real physical delivery, the admin should bump this manually via the customer cylinder-balance editor.
- **Cancelled-stock events**: none. Not applicable for backdated flow.
- **Empties collection**: not tracked. If empties were physically collected, separate flow.

These are all design-intended.

### E. Two-step modal — confirmed fields

- **Path 1 — "E-Invoice + EWB"**: `customerId`, `issueDate` (backdated, same calendar month), `dueDate` (derive from `creditPeriodDays`), `items[{cylinderTypeId, quantity}]` (driver-derived prices via `getEffectivePrice`), `driverId` (required), `vehicleId` (required — plate regex enforces validity), `payment?` (optional)
- **Path 2 — "E-Invoice Only"**: `customerId`, `issueDate`, `dueDate`, `items[...]`, `driverId?` (optional), `vehicleId?` (optional), `payment?` (optional)

For B2C customers, both paths skip IRN (per design). Path 1 still attempts EWB if vehicle is provided.

### F. Full file list for implementation

**API (`packages/api/`):**
- `src/services/orderService.ts` — add `createBackdatedOrder` (or new file `backdatedOrderService.ts`)
- `src/services/invoiceService.ts` — add `issueDateOverride?: Date` parameter to `createInvoiceFromOrder` (line 119-347)
- `src/routes/orders.ts` — register `POST /api/orders/backdated` with `requireRole('distributor_admin')`
- `packages/shared/src/schemas/orders.ts` (or wherever order schemas live) — add `backdatedOrderSchema` with same-month check
- `src/__tests__/backdated-order.test.ts` — new test file: same-month rejection, FY-boundary rejection, status transitions, `Invoice.orderId` linkage, ledger date, dashboard KPI bucketing, multi-tenant isolation
- `src/__tests__/gst-payload-shape.test.ts` — add backdated-`DocDtls.Dt` assertion (anti-pattern #10 mock guard)
- `scripts/diag-backdated-irn.ts` — new live-sandbox A/B harness for the anti-pattern #10 verification gate

**Web (`packages/web/`):**
- `src/pages/OrdersPage.tsx` or new `BackdatedOrderModal.tsx` — two-step modal (E-Invoice + EWB vs E-Invoice Only, then customer/items/payment/driver+vehicle if applicable)
- `src/hooks/orders.ts` (or wherever the existing order mutations live) — `useCreateBackdatedOrder` hook, invalidates `['orders']`, `['invoices']`, `['analytics', 'dashboard']`, `['payments']` per anti-pattern #18

**Mobile (`packages/mobile/`):**
- NONE for v1.0. Backdated is a `distributor_admin` desktop workflow — mobile distributor_admin app is feature-complete enough at v1.0; this can be a v1.1 mobile add-on.

### G. Estimated complexity

| Bucket | File count | Effort |
|---|---|---|
| API service + signature change | 2 | small |
| API route + shared schema | 2 | tiny |
| API tests (incl. live-sandbox harness) | 3 | small |
| Web modal + hook | 2 | medium (2-step modal with conditional step 2) |
| **Total** | **9 files** | **small-to-medium** — ~2 days of code, ~1 day of test + live sandbox verification |

No DB migration required (Order/Invoice schemas as-is support the flow).

### H. Open risks the design surfaces

1. **Anti-pattern #10 — live-sandbox verification gate for backdated `DocDtls.Dt`.** Mock tests will pass for any `Dt`. WhiteBooks sandbox MUST be exercised with a 7/14/28-day-old `issueDate` against dist-002 (Sharma) BEFORE the WI is marked done. Capture raw NIC response in the WI summary.
2. **Anti-pattern #11 — failure logging on backdated IRN.** `apiCall()` already writes every IRN attempt to `gst_api_logs` regardless of outcome (per CLAUDE.md #11 fix). Confirm the new path inherits this for free (it does, via `callWithLog`).
3. **Anti-pattern #12 — status overwrite if EWB fails on a backdated `+ EWB` path.** `processInvoiceGst` has the `irnPersisted` guard (`gstService.ts:324`) — backdated path inherits this safely.
4. **FY-boundary edge case (Task 1.5).** Same-month rule blocks April-creates-March, so safe transitively. Document the dependency.
5. **Dashboard `revenueToday` bucketing (Task 5.4).** Behavioural decision: should backdated revenue show in today's KPI or in the historical bucket? Recommend historical (`Order.deliveredAt = backdatedDate`) — needs user confirmation.
6. **`createInvoiceFromOrder` signature change** ripples to 4 callers. Default value preserves behaviour but every caller's tests should be re-run.
7. **Dormant `createManualInvoice` divergence.** This investigation revealed `createManualInvoice` cannot trigger EWB because `Invoice.orderId IS NULL` and `processInvoiceGst` reads `invoice.order.vehicle`. Not blocking this WI, but worth a sweep — if `createManualInvoice` is genuinely dormant, it's tech debt; if any future UI activates it for a GST-LIVE tenant, EWB will silently never fire.
8. **DVA query pollution.** None — backdated orders have no `driverVehicleAssignment` row and don't appear in `/orders/in-transit`. Risk zero.
9. **Customer-portal visibility.** Not in design scope, but worth noting: the customer portal lists invoices via `customerPortalService.ts:791` ordered by `issueDate desc`. A backdated invoice for `customerId` will surface in the customer's history at its backdated position — semantically correct, but the customer may see "where did this come from?" Suggest a sentinel in `Invoice.notes` (`Manually backdated by {admin} on {createdAt}`) for the View modal.
