# Godown Pickup — Investigation

Investigation date: 2026-06-24. Read-only. No code changed.

Scope: identify the minimum schema + code changes to support customers who physically collect cylinders from the godown ("self-collection"). Per the brief: no vehicle dispatched, no EWB. B2B still needs an IRN (the supply happened). B2C godown pickup needs no GST exchange at all (just an invoice PDF).

---

## Task 1 — Order model + status enums

### `Order` model — `packages/api/prisma/schema.prisma:782-847`

Full field list (only the load-bearing ones called out — see schema for column-level Prisma docs):

| Field | Line | Notes |
|---|---|---|
| `id` | 783 | UUID |
| `orderNumber` | 784 | unique |
| `distributorId` | 785 | tenant FK |
| `customerId` | 786 | |
| `driverId` | 787 | **nullable** — the seam godown pickup naturally exploits |
| `vehicleId` | 788 | **nullable** — same seam |
| `orderDate` | 789 | |
| `deliveryDate` | 790 | required even when no vehicle moves; service queries filter on it |
| `status` | 791 | `OrderStatus` enum (see below) |
| `orderType` | 792 | `delivery` \| `returns_only` |
| `orderSource` | 797 | **`OrderSource` enum: `regular` \| `walk_in`** (FLOAT-001, 2026-06-17) |
| `totalAmount` | 798 | Decimal(18,4) |
| `specialInstructions` | 799 | |
| `deliveryLatitude` / `deliveryLongitude` | 800-801 | for driver pin drop on delivery |
| `deliveryNotes` | 802 | |
| `deliveredAt` | 803 | set at `confirmDelivery` |
| `cancelledAt` / `cancellationReason` | 804-805 | |
| `customerConfirmed` / `customerConfirmedAt` / `customerDisputeReason` | 806-808 | WI-127 dispute lifecycle |
| `disputeRaisedAt` / `disputeResolvedAt` / `disputeResolutionNote` / `disputeReopenedAt` / `disputeReopenReason` | 812-816 | dispute lifecycle |
| `tripNumber` | 823 | nullable; stamped at `transitionToPendingDelivery`; **godown-pickup orders will leave this NULL** |
| `cancelledStockEventId` | 838 | nullable FK to a cancelled-stock event when the order was created from one |

**No existing field that represents fulfillment method / self-collection.** Searched `deliveryType`, `fulfillmentType`, `selfCollection`, `pickup`, `godown`, `collectionMode` across `packages/api/prisma/schema.prisma` and `packages/shared/src` — zero hits at the Order level. The only "godown" fields on the schema are on the `Distributor` model (godown address columns, lines 402-407) — that's the *seller's* warehouse address, not an order flag.

### `OrderStatus` enum — `schema.prisma:55-64` (mirrored at `packages/shared/src/enums/index.ts:67-77` as `OrderStatus`)

```
pending_driver_assignment
pending_dispatch
preflight_in_progress
pending_delivery
delivered
modified_delivered
cancelled
returns_only
```

The state machine for a regular B2B/B2C order today: `pending_driver_assignment → pending_dispatch → preflight_in_progress → pending_delivery → delivered`.

### `OrderType` enum — `schema.prisma:66-69` (mirrored at `packages/shared/src/enums/index.ts:79-82`)

```
delivery
returns_only
```

This is "what kind of order" — not the same axis as "how was it fulfilled". `returns_only` is the empty-cylinder pickup-from-customer flow.

### `OrderSource` enum (FLOAT-001) — `schema.prisma:71-79` (mirrored at `packages/shared/src/enums/index.ts:84-90`)

```
regular           // default — every legacy + advance-booked order
walk_in           // driver mobile walk-in order ONLY
```

Snake_cased `@map` already in place. `orderSource` column lives at `schema.prisma:797`:

```
orderSource OrderSource @default(regular) @map("order_source")
```

Wire type at `packages/shared/src/types/index.ts:298-301`:

```
// FLOAT-001 (2026-06-17): present on every Order returned from the API after
// the migration; optional in the wire type so legacy consumers compile.
// Default value is OrderSource.REGULAR for all pre-existing rows.
orderSource?: OrderSource;
```

**Key observation — `orderSource` is NOT the right field to repurpose.** Its semantics are "who/what created this row" (regular admin/portal/legacy vs. driver-walk-in). `walk_in` carries a load-bearing meaning in the float-stock reconciliation math at `deliveryWorkflowService.ts:735` and `dvaManifestService.ts:347` (sold-from-float aggregation). Overloading `regular`/`walk_in`/`godown_pickup` on the same column conflates fulfillment with provenance and will tangle the float-reconciliation queries. A new boolean is cleaner.

---

## Task 2 — IRN + EWB triggers today

### IRN — TWO call sites

**A. Dispatch-time preflight (the primary B2B IRN path)** — `gstPreflightService.ts:1248-1253`

```ts
const irnResponse = await callWithLog<IrnResponse>(
  distributorId, 'POST',
  `/einvoice/type/GENERATE/version/V1_03?email=${encodeURIComponent(credEmail)}`,
  irnPayload, 'einvoice',
  { apiType: 'IRN_GENERATE', invoiceId, orderId },
);
```

Reached when the dispatch click on the web hits `POST /api/orders/preflight-dispatch` → `preflightDispatch` → `preflightOne` → `runB2bPreflight`. Order status flow: `pending_dispatch → preflight_in_progress → pending_delivery`.

**B. Post-delivery `processInvoiceGst`** — `gstService.ts:330-335`

Reached via `confirmDelivery` → `processInvoiceGst` (non-blocking, fire-and-forget — `orderService.ts:1080`). Only fires when there's no live IRN already (the dispatch path normally produces it). Same `/einvoice/type/GENERATE/version/V1_03` endpoint.

In both paths, an `is B2B` decision IMMEDIATELY surrounds the IRN call:
- `gstPreflightService.ts:838`: `const isB2C = !order.customer?.gstin || order.customer.gstin === 'URP';` then `if (!isB2C) runB2bPreflight(...)` at line 930
- `gstService.ts:246`: `const isB2B = !!invoice.customer?.gstin && invoice.customer.gstin !== 'URP';` then `if (isB2B) { try { ... irnResponse = await callWithLog(...) ... }` at line 325

### EWB — TWO call sites

**A. B2B EWB-after-IRN** — `gstPreflightService.ts:1322-1328`

```ts
const ewbResponse = await callWithLog<EwbResponse>(
  distributorId, 'POST',
  `/ewaybillapi/v1.03/ewayapi/genewaybill?email=${encodeURIComponent(ewbCredEmail)}`,
  ewbPayload, 'ewaybill',
  { apiType: 'EWB_GENERATE_BY_IRN', invoiceId, orderId },
);
```

Sits inside `runB2bPreflight`'s `if (!hasIrnEwb) { try { ... } }` branch — i.e. after IRN succeeds and no inline EWB came back (the expected post-2026-05-15 fix path; anti-pattern #10).

**B. B2C standalone EWB** — `gstPreflightService.ts:1494-1499` (inside `runB2cPreflight`)

```ts
const ewbResponse = await callWithLog<EwbResponse>(
  distributorId, 'POST',
  `/ewaybillapi/v1.03/ewayapi/genewaybill?email=${encodeURIComponent(credEmail)}`,
  ewbPayload, 'ewaybill',
  { apiType: 'EWB_GENERATE_STANDALONE', invoiceId, orderId },
);
```

B2C path skips IRN, borrows the IRN-shaped payload via `buildIrnPayload(...)` purely to feed `buildEwbPayload(...)` — but only fires `genewaybill`, never `/einvoice/type/GENERATE`.

### Existing skip / bypass logic

1. **`distributor.gstMode === 'disabled'`** — `gstPreflightService.ts:894-904`. Skips both IRN and EWB; order goes straight to `pending_delivery` with `mode: 'GST_DISABLED'`. Same gate at `gstService.processInvoiceGst:232`, `gstService.ts:761`, `:1048`, `:1153`, `:1253`.
2. **B2C → skip IRN.** Built into the if-then split at `gstPreflightService.ts:929-938`: B2B branch generates IRN+EWB, B2C branch generates EWB-only.
3. **No vehicle mapping** — `gstPreflightService.ts:193-199` throws `NO_VEHICLE_MAPPING` at the batch level when GST-enabled, no DVA exists. This is the natural "guard rail" we'll have to relax for godown pickup.

### Where the EWB skip should land for `isGodownPickup`

- **In `runB2bPreflight`** (`gstPreflightService.ts:1309-1381`): wrap the `if (!hasIrnEwb)` block with `&& !order.isGodownPickup`. Single line change.
- **In `runB2cPreflight`** (`gstPreflightService.ts:1475-1597`): the whole B2C body is one EWB call wrapped in try/catch — needs to bypass entirely. Either a guard at the top of `runB2cPreflight` that returns success without calling NIC, or a guard at `preflightOne` (`gstPreflightService.ts:935-938`) that routes B2C godown-pickup down a third "no-NIC" branch parallel to the existing `mode: 'GST_DISABLED'` branch above.
- **`distributor.gstMode === 'disabled'` already handles every godown-pickup case for GST-disabled tenants.** The new gate only matters for sandbox/live tenants.

### Where the IRN call would skip on godown pickup

- **B2B godown pickup**: IRN **still fires**. The supply legally happened and the buyer needs the e-invoice. Cite: `gstPreflightService.ts:1247-1253` runs unconditionally inside `runB2bPreflight`; no guard added.
- **B2C godown pickup**: IRN doesn't fire because B2C never fires IRN anyway. Skip the standalone EWB call (the only thing `runB2cPreflight` would have done) and the order is GST-silent.

---

## Task 3 — B2C vs B2B branch today

Decision lives at TWO independent call sites that read the same input (`Customer.gstin`):

1. **`gstPreflightService.ts:838`** — `const isB2C = !order.customer?.gstin || order.customer.gstin === 'URP';`
2. **`gstService.ts:246`** — `const isB2B = !!invoice.customer?.gstin && invoice.customer.gstin !== 'URP';`

The decision is **NOT** read from `Customer.customerType` (the `'B2B' \| 'B2C'` string column at `schema.prisma:543`). Customer.customerType is derived FROM gstin at write time — `customerService.ts:152`:

```
const customerType = data.gstin && data.gstin.length > 0 ? 'B2B' : 'B2C';
```

…and at `:277` for updates and `:825` for the import path. So the two are kept in sync at the write boundary, but the GST flow reads gstin directly. This is fine; either field would work for the branch logic.

### B2C godown pickup → GST flow

- IRN: **already skipped** by the existing B2C branch (runB2cPreflight never calls `/einvoice/type/GENERATE`). No code change.
- EWB: today B2C **DOES** generate a standalone EWB at `gstPreflightService.ts:1494-1499`. With the godown-pickup flag, this must skip too.
- Net: B2C godown pickup → completely skip NIC. Same wire-shape as a GST-disabled tenant. The cleanest implementation is to bounce B2C godown-pickup to the existing `if (distributor.gstMode === 'disabled')` branch at `gstPreflightService.ts:895`, or extract that branch into a `transitionToPendingDeliveryNoGst()` helper and route both cases through it.

### B2B godown pickup → GST flow

- IRN: **still fires** — `runB2bPreflight` line 1247-1253. No guard added; the supply legally happened.
- EWB: skip both the inline EWB (already not emitted since the 2026-05-15 fix — anti-pattern #10) AND the standalone follow-up at line 1322-1328.

Concretely the diff inside `runB2bPreflight` is approximately:

```ts
// At line 1309 today:
if (!hasIrnEwb) {
  // ... EWB-by-IRN call ...
}
// becomes:
if (!hasIrnEwb && !order.isGodownPickup) {
  // ... EWB-by-IRN call ...
}
```

Plus a tweak inside `transitionToPendingDelivery` and `buildDispatchCtx` to not assume a `vehicleNumber` (today required at `runB2bPreflight:1318-1322` for `buildEwbPayload`; with the godown-pickup gate above that EWB call is skipped, so the requirement disappears for godown-pickup orders).

---

## Task 4 — Driver dispatch flow

### Driver assignment lifecycle

1. **Order create** — `orderService.createOrder` (`orderService.ts:99-321`). If `customer.preferredDriverId` is set AND there's a `dispatch_ready` DVA for that driver on the delivery date with `isReconciled=false`, the order is auto-assigned and lands in `pending_dispatch` (lines 236-253). Otherwise it lands in `pending_driver_assignment` with `driverId=null`.
2. **Manual driver assignment** — `POST /api/orders/:id/assign-driver` → `orderService.assignDriver` (`routes/orders.ts:283-298`). Flips status from `pending_driver_assignment` → `pending_dispatch`.
3. **DriverVehicleAssignment (DVA)** lifecycle — `schema.prisma:950-995`. Statuses: `dispatch_ready → loaded_and_dispatched → returned_inventory → reconciled` (+ `cancelled`). Transitions emitted by:
   - `dispatch_ready → loaded_and_dispatched`: at `gstPreflightService.ts:438` when `tripStarted = (failed===0 && succeeded>0) || isFloatOnlyDispatch`. SSE emit follows at `:451-454`.
   - `loaded_and_dispatched → returned_inventory`: `deliveryWorkflowService.markVehicleReturned`.
   - `returned_inventory → reconciled` (+ `isReconciled=true`, `dispatch_ready`): `deliveryWorkflowService.confirmVehicleReconciliation` (this is the WI-100 Gap A transition — anti-pattern #19 was originally surfaced by this not emitting `trip_updated`).
4. **`confirmDelivery`** (`orderService.ts:781-1098`) — terminal write per order. Sets status to `delivered` / `modified_delivered`, writes inventory `delivery` event (`:954-966`), writes `collection` event for empties (`:967-979`), creates the invoice via `createInvoiceFromOrder` (`:1024`), fires `processInvoiceGst` non-blocking (`:1080`), emits SSE `order_updated` to the driver (`:1091-1094`).

### Godown-pickup design choice: A vs. B

**Option A** — skip driver assignment entirely; godown-pickup order goes `pending_driver_assignment` → SKIP → `delivered` when admin/finance confirms pickup.

The Order model already supports this: `driverId` and `vehicleId` are nullable (`schema.prisma:787-788`). The natural mapping:

- Order create: if `isGodownPickup=true`, set `status='pending_delivery'` directly (skip both `pending_driver_assignment` and `pending_dispatch`), leave `driverId=null, vehicleId=null, tripNumber=null`.
- "Confirm pickup" reuses the existing `POST /api/orders/:id/confirm-delivery` endpoint at `routes/orders.ts:407-422` — the request body shape (items with delivered quantities + empties collected) maps 1:1 to godown pickup ("I'm physically handing over X cylinders and taking back Y empties").
- `confirmDelivery` at `orderService.ts:839` currently demands `['pending_delivery', 'pending_dispatch'].includes(order.status)` — `pending_delivery` is acceptable, so godown-pickup orders can use this endpoint as-is.

**Option B** — invent a synthetic "godown driver" / "godown vehicle" so DVA infrastructure works untouched.

Requires creating non-physical Driver and Vehicle rows per tenant + extra rules to keep them out of fleet rosters / driver-performance reports. Higher carrying cost. Reject.

**Recommendation: Option A.** Cleaner with the existing nullable-driver design, no synthetic data, no test fixtures pollution.

The one consequence: **`isGodownPickup` orders should NEVER hit `preflightDispatch` / `preflightAddToTrip`**. Both functions query orders by `status: 'pending_dispatch'` (`gstPreflightService.ts:211`, `:633`) — if Option A puts godown-pickup orders straight to `pending_delivery`, they're naturally excluded. Defense in depth: add an `isGodownPickup: false` filter to the preflight query just in case a future code path assigns a godown-pickup order to a driver by mistake.

### Delivery-confirmation endpoint

`POST /api/orders/:id/confirm-delivery` → `routes/orders.ts:408` → `orderService.confirmDelivery` at `orderService.ts:781`. Updates per-item delivered/empties, writes status, writes inventory `delivery` + `collection` events at the order's `deliveryDate`, creates the invoice via `createInvoiceFromOrder`, fires `processInvoiceGst` (non-blocking). Re-usable for godown pickup with no modification — the only difference is that no preceding dispatch ran, so no `dispatch` inventory event exists for the orders being delivered, so depot stock is debited only once at `confirmDelivery` (which is exactly the right behaviour for self-collection).

---

## Task 5 — Inventory deduction trigger

Today the depot fulls debit happens at one of two points depending on the dispatch-debit flag (`INVENTORY_DISPATCH_DEBIT`):

- **Flag ON** (production today per CLAUDE.md current state): `dispatch` event at preflight time, inside `transitionToPendingDelivery` — `gstPreflightService.ts:1054-1068`. Negative `fullsChange` per item at the moment cylinders leave the depot onto the vehicle. Then `delivery` event at `confirmDelivery` — `orderService.ts:954-966`. But the `delivery` event has `fullsChange: -item.deliveredQuantity` and `emptiesChange: 0` — wait, that's also a debit. Let me re-read.

  Re-checking: `orderService.ts:958` writes `fullsChange: -item.deliveredQuantity` regardless of whether dispatch already debited. Cross-referencing `deliveryWorkflowService.ts` and the recalculation flow at `recalculateSummariesFromDate` (called at `orderService.ts:1052`) — when dispatch-debit is ON, the summary recompute aggregates `dispatch` events into `dispatchedQty` and `delivery` events into `deliveredQty` (`schema.prisma` `InventorySummary` columns 1444-1445). `closing_fulls` reflects net stock, so the double-debit is real at the event-row level and is resolved at the summary recompute. Bug #2 (commit fc12e04) and Bug #6 (commit referenced in `buildDispatchCtx`) are the live evidence of this double-debit being a real concern, fixed for walk-in orders by `buildDispatchCtx` returning undefined.

- **Flag OFF**: depot stock is debited ONLY at `confirmDelivery` via the `delivery` inventory event.

### For godown pickup

The order never gets a `dispatch` event because it never goes through preflight (Option A above). The `delivery` event at `confirmDelivery` is the single depot-debit, written at `orderService.ts:954-966`. This is correct: the cylinder physically left the godown when the customer collected it, which is the same moment the admin/finance user runs the confirm-pickup action.

`vehicleNumber` on the inventory event will be `null` (`vehicleNumber` field is optional in `createInventoryEvent` — `schema.prisma:1414`). The downstream `recalculateSummariesFromDate` aggregates events without filtering on `vehicleNumber` for the `delivered_qty` column — verified by reading the column docstring at `schema.prisma:1444` (`deliveredQty Int @default(0) @map("delivered_qty")` — no vehicle scoping).

`customerInventoryBalance.withCustomerQty` increment at `orderService.ts:995-997` is independent of vehicle and works untouched.

### `CancelledStockEvent` for partial pickup

If a customer picks up fewer than ordered (e.g. ordered 5, took 4), today's confirmDelivery writes a `CancelledStockEvent` at `orderService.ts:1004-1018`:

```ts
status: order.vehicleId ? 'on_vehicle' : 'pending_return',
```

For godown pickup `order.vehicleId` is null, so `status='pending_return'` — which is the right behaviour (the unsold cylinder stays at the godown). The reconciliation flow (`confirmVehicleReconciliation` in `deliveryWorkflowService.ts`) is vehicle-scoped, so godown-pickup cancelled stock won't be swept into a trip reconciliation by mistake. Worth a smoke-test, not a code change.

---

## Task 6 — Web order form

`packages/web/src/pages/OrdersPage.tsx` — total 2096 lines. The `CreateOrderModal` lives at `:463-588`. Fields rendered today:

1. **Customer** (CustomerSearchInput, `:509-515`) — required, search-by-name picker.
2. **Delivery Date** (`:517-523`) — date input, defaults to `localTodayISO()`.
3. **Order Items** (`:525-572`) — array of `{ cylinderTypeId, quantity }`. Add / remove rows.
4. **Special Instructions** (`:574-579`) — free text.

Submit hits `apiPost('/orders', data)` (`:490`) which posts to `POST /api/orders`.

The form uses `createOrderSchema` from `@gaslink/shared` (`packages/shared/src/schemas/index.ts:184-191`). To add a Godown Pickup toggle:

- **UI placement** — between "Delivery Date" and "Order Items" makes the most sense semantically. The Godown Pickup toggle answers "how will the customer receive these cylinders" — that's a sibling to delivery date, not buried with items.
- **Driver assignment is NOT part of the create flow today** — auto-assignment happens server-side at `orderService.ts:236-253` if a `preferredDriverId` + valid DVA exist; otherwise the order lands in `pending_driver_assignment` and a separate "Assign Driver" action takes over. So the create modal doesn't have a driver picker to hide. Cleaner.
- **The visual cue** when Godown Pickup is checked: show a small info pill "No driver / no vehicle — customer collects from godown".

Other consumers of `createOrderSchema` to keep in sync:
- `packages/web/src/pages/CustomersPage.tsx` (1 place via `quick-new-order` workflow per CLAUDE.md memory, not load-bearing here)
- Mobile admin (next task)
- API route validation at `routes/orders.ts:226`.

---

## Task 7 — Mobile order form

`packages/mobile/app/(admin)/orders.tsx` — total 3206 lines. `CreateOrderModal` lives at `:1044-1390`. Fields:

1. **Customer** (`:1152-1242`) — picker modal with search.
2. **Delivery Date** (`:1247-1251`) — date input.
3. **Order Items** (`:1262-1346`) — array, cylinder type chip picker + quantity.
4. **Special Instructions** (`:1348-1370`) — text input.

Submit at `:1099-1122` hits `useApiMutation('post', '/orders', ...)` with the same body shape as the web form.

Recommended placement: same as web — a `<Switch>` row between "Delivery Date" and "Order Items", labeled "Godown Pickup (customer self-collects)". When ON, show a small native banner "No driver will be assigned; admin must confirm pickup."

Also there's a "Returns Order" modal at `:2024-2230` and a "Modify Order" modal at `:2235` — both reuse field structure. **Returns-only orders** (`orderType='returns_only`) are empty-cylinder pickup-FROM-customer, semantically different from godown pickup (cylinders moving from customer to depot vs. depot to customer). Don't conflate.

---

## Task 8 — Driver app

### Driver order list source

- `GET /api/orders?driverId=<self>` — `routes/orders.ts:30-69`. The driver-role auto-scoping at `:48-61` reads `Driver` by `(distributorId, phone)` and stamps `filters.driverId = driver.id`. A godown-pickup order with `driverId=null` will NOT match this filter — naturally excluded.
- `GET /api/drivers/me/active-trip` — `driversVehicles.ts` (used by the driver mobile dashboard to find the current DVA and its orders). Orders are joined via `driverId` + `deliveryDate` + `tripNumber` — again, godown-pickup orders are naturally excluded.
- `POST /api/drivers/me/orders` (walk-in) — `driversVehicles.ts:867-940` — creates orders tagged `walk_in`, tied to the driver's active DVA. Unrelated to godown pickup; the godown-pickup flag would never be set from this path.

**No additional filter needed.** The naturally-null `driverId` on a godown-pickup order keeps it out of every driver query. Defense in depth: an explicit `isGodownPickup: false` filter on the driver order endpoints is cheap insurance against a future bug where a godown-pickup order accidentally gets a `driverId`.

### SSE events

`order_updated` SSE emit at `orderService.ts:1091-1094` is gated on `if (order.driverId)`. Godown-pickup orders with null driver naturally skip the driver SSE. **For the customer**, no SSE infrastructure exists today (per CLAUDE.md push-notifications is v1.1). The customer learns about delivery status by re-fetching their order list. Acceptable for v1.

---

## Task 9 — Customer app / portal

### Customer order detail

- Web customer portal (no separate file found — likely the `(customer)` mobile app and the web `/customer/*` routes pulled from the same service).
- Mobile customer orders: `packages/mobile/app/(customer)/orders.tsx` — uses `order.deliveryDate`, `order.driverName`, `order.driverPhone` for the in-flight UI (`:552-565`). For a godown-pickup order, `driverName` will be null so that block naturally collapses. We should add a small badge / label on the order card: "Godown Pickup" so the customer remembers they need to physically come.

### Action by customer

Out of scope for v1. The "I picked up" confirmation is an admin/finance action via the existing confirm-delivery endpoint — same as a normal order's "I delivered" action by the driver. A future v1.1 could add a "Confirm pickup at counter" button that lets the customer self-confirm via the portal.

Customer-portal service `getMyOrders` at `packages/api/src/services/customerPortalService.ts:156` reads orders by `customerId` — no filter on driverId or vehicleId. Godown-pickup orders surface naturally. Recommended add to the response DTO: `isGodownPickup` boolean so the customer UI can render the badge.

---

## Task 10 — Reports + reconciliation

### Driver performance report

`packages/api/src/services/analyticsService.ts:283-308`:

```ts
const drivers = await prisma.driver.findMany({ where: { distributorId, deletedAt: null, ...(driverId ? { id: driverId } : {}) }, ... });
for (const driver of drivers) {
  const [total, delivered, cancelled] = await Promise.all([
    prisma.order.count({ where: { ...where, driverId: driver.id } }),
    prisma.order.count({ where: { ...where, driverId: driver.id, status: { in: ['delivered', 'modified_delivered'] } } }),
    ...
  ]);
```

Counts orders with a non-null `driverId`. **Godown-pickup orders have `driverId=null`** so they're already excluded from the driver performance report. No change needed.

### Vehicle utilization

Reports that group by `vehicleId` will naturally exclude godown-pickup orders for the same reason (`Order.vehicleId` is null). No change.

### Order volume / revenue

`packages/api/src/services/reportsService.ts` and the dashboard analytics — order count and revenue are aggregated by `distributorId` + `deliveryDate` without filtering on `driverId` / `vehicleId`. Godown pickup is **included** here, which is correct (revenue still happened, the cylinder still moved out).

### Daily reconciliation

`confirmVehicleReconciliation` in `deliveryWorkflowService.ts` is vehicle-scoped and only acts on orders with a `vehicleId`. Godown-pickup orders are skipped naturally.

### Tally export

`tallyExportService.ts` (per CLAUDE.md anti-pattern #23) is driven by `payment_transactions` and `invoices` — agnostic to driver/vehicle. Godown-pickup invoices flow through as normal sales vouchers. Correct.

### GSTR-1 export

Phase 5 GSTR-1 columns on `Invoice` (taxableValue, placeOfSupplyCode, etc., `schema.prisma:1140-1143`) are filled at invoice-create time, no dependency on driver/vehicle. Correct.

---

## Task 11 — Full impact surface (file list)

| # | File | Function / route | What changes | Size |
|---|---|---|---|---|
| 1 | `packages/api/prisma/schema.prisma` | `Order` model (~line 782) | Add `isGodownPickup Boolean @default(false) @map("is_godown_pickup")` | tiny |
| 2 | `packages/api/prisma/migrations/<new>/migration.sql` | new migration | `ALTER TABLE orders ADD COLUMN is_godown_pickup BOOLEAN NOT NULL DEFAULT false;` + index optional | tiny |
| 3 | `packages/shared/src/types/index.ts` | `Order` type (~line 286-310) | Add `isGodownPickup: boolean;` | tiny |
| 4 | `packages/shared/src/schemas/index.ts` | `createOrderSchema` (line 184) | Add `isGodownPickup: z.boolean().default(false).optional()` | tiny |
| 5 | `packages/api/src/services/orderService.ts` | `createOrder` (line 99-321) | If `data.isGodownPickup`: skip preferredDriverId lookup, set `driverId=null, vehicleId=null, status='pending_delivery'`. Stamp `isGodownPickup` on the create. | small |
| 6 | `packages/api/src/services/orderService.ts` | `confirmDelivery` (line 781-1098) | Allow `status='pending_delivery'` already supported. No change needed (the function already handles `vehicleId=null` for cancelled-stock at line 1015). | tiny |
| 7 | `packages/api/src/services/gst/gstPreflightService.ts` | `preflightOne` (~line 805) | Add `if (order.isGodownPickup) throw PreflightError('Godown-pickup orders do not dispatch', 'GODOWN_PICKUP', 400);` — defense in depth. | tiny |
| 8 | `packages/api/src/services/gst/gstPreflightService.ts` | order-list `where` (line 206, 632) | Add `isGodownPickup: false` filter so a godown-pickup order can never accidentally enter a dispatch batch. | tiny |
| 9 | `packages/api/src/services/gst/gstService.ts` | `processInvoiceGst` (line 226) | At line 232 or 246: extend the B2B branch with `if (isB2B && !order.isGodownPickup) { ... }` for EWB only. **Keep IRN running for B2B godown.** For B2C godown, the function already no-ops (B2C never enters the IRN branch). Same gate at `recoverEwbFromIrn` if applicable. | small |
| 10 | `packages/api/src/services/gst/gstService.ts` | EWB generation in the post-delivery path | At the `generateEwbFromIrn` site (line 443) or its caller: skip when `order.isGodownPickup`. | small |
| 11 | `packages/api/src/services/gst/gstReissueService.ts` | reissue flow | Read whether the invoice is godown-pickup; skip EWB cancel + regenerate steps. IRN cancel/regen still applies for B2B godown. | small |
| 12 | `packages/api/src/services/invoiceService.ts` | `createInvoiceFromOrder` (line 119-) | No change to math — totals/GST same. Optionally surface a note line "Godown Pickup — buyer collected" for the PDF reader's eye. | tiny |
| 13 | `packages/api/src/services/pdf/invoicePdfService.ts` | PDF template | Add an "Self-collection — no vehicle" line to the PDF header when the order is godown-pickup. Optional but useful for clarity. | tiny |
| 14 | `packages/api/src/routes/orders.ts` | POST `/orders` (line 224) | No code change — `createOrderSchema` validation already covers. The `assign-driver` route at line 283 should 400 with a friendly message if called on a godown-pickup order. | tiny |
| 15 | `packages/api/src/utils/mappers.ts` | `mapOrder` | Include `isGodownPickup` in the wire payload. | tiny |
| 16 | `packages/api/src/services/customerPortalService.ts` | `getMyOrders` / `getMyOrderById` | Include `isGodownPickup` in customer-portal DTO. | tiny |
| 17 | `packages/web/src/pages/OrdersPage.tsx` | `CreateOrderModal` (line 463) | Add Godown Pickup checkbox between Delivery Date and Order Items. Show info banner when ON. | small |
| 18 | `packages/web/src/pages/OrdersPage.tsx` | Order detail / list rendering | Show "Godown Pickup" badge on order card + detail modal. Hide assign-driver action for godown-pickup orders. | small |
| 19 | `packages/mobile/app/(admin)/orders.tsx` | `CreateOrderModal` (line 1044) | Same — add Switch, info banner. | small |
| 20 | `packages/mobile/app/(admin)/orders.tsx` | Order list card + detail | Show Godown Pickup badge. | small |
| 21 | `packages/mobile/app/(finance)/orders.tsx` (if exists) | Finance views | Surface "Godown Pickup" tag if finance sees the orders | tiny |
| 22 | `packages/mobile/app/(customer)/orders.tsx` | Customer order detail (~line 552-565) | Replace the "Driver: ..." block with "Pickup from godown" when `isGodownPickup`. | tiny |
| 23 | `packages/web/src/customer/OrdersPage.tsx` (if exists) | Web customer portal | Same as #22 for the web customer view. | tiny |
| 24 | TanStack Query invalidation | (anti-pattern #18) at the create site | `useApiMutation` already invalidates `['admin-orders']` (mobile line 1072) / `['orders']` (web line 493). No additional keys needed unless we add a separate `['godown-orders']` view, which I don't recommend in v1. | tiny |
| 25 | `packages/api/src/__tests__/<new>/godown-pickup.test.ts` | new integration tests | Cover: create with flag, confirm-delivery without driver, IRN-only B2B path, no-NIC B2C path, GST-disabled path, preflight refusal (defense in depth), inventory event count (single `delivery` event, no `dispatch` event), driver order-list exclusion. | medium |
| 26 | Anti-pattern-guards test | `packages/api/src/__tests__/anti-pattern-guards.test.ts` | Add wire-shape assertion that `isGodownPickup` is on the Order response (anti-pattern #9). | tiny |

**Total: ~26 touch points.** ~5 are medium (test file + the gst service edits), the rest are tiny/small.

---

## Task 12 — Confidence assessment

This is a **clean additive change** with one structural risk worth flagging.

**OrderStatus state machine**: the existing `pending_driver_assignment → pending_dispatch → preflight_in_progress → pending_delivery → delivered` machine has no transition that strictly requires a driver / vehicle / dispatch — confirmDelivery accepts `pending_delivery` directly (`orderService.ts:839`). Option A (skip dispatch entirely; order starts at `pending_delivery`) reuses every existing endpoint without adding a new status. ✅

**Anti-pattern #10 — NIC sandbox A/B for IRN-without-EWB**: at the WhiteBooks / NIC API level there is **no protocol coupling** between IRN and EWB — they're independent endpoints (`/einvoice/type/GENERATE/version/V1_03` and `/ewaybillapi/v1.03/ewayapi/genewaybill`). Today's B2C flow already exercises EWB-without-IRN (`runB2cPreflight`) and there are ~10+ live successes on that path. The inverse — IRN-without-EWB — is structurally the same: we just don't make the second call. Per the EWB cancellation lore (anti-pattern #20, sourced from einvoice6.gst.gov.in / ClearTax / Masters India / LogiTax), the EWB depends on the IRN, not the other way around. **However, the production reality bears a verification step**: WhiteBooks' GENERATE response sometimes returns an inline EWB even when we don't request one (`gstPreflightService.ts:1262` and `gstService.ts:370` both branch on `hasIrnEwb`). For godown pickup we need to ensure that branch ALSO no-ops the EWB persistence (don't write `ewbStatus='active'` to the invoice if the operation logically has no EWB). One A/B run in sandbox against dist-002 (Sharma GST-LIVE test tenant) is prudent — generate an IRN for a godown-pickup invoice, confirm the response doesn't carry an unwanted inline EWB, AND confirm GSTR-1 auto-populates without an EWB row. ~30-min verification, not a blocker.

**Anti-pattern #19 — SSE event cohesion**: when the godown-pickup order completes (confirmDelivery), the existing SSE emit `notifyDriver(order.driverId, ...)` at `orderService.ts:1091` is null-gated on `driverId`. Naturally skipped. **No customer-facing SSE exists today** (push notifications are v1.1). The customer learns about the status flip via TanStack Query refetch on their orders screen — acceptable for v1, but worth a note in the spec that we explicitly chose not to add customer SSE here.

**Anti-pattern #18 — TanStack Query invalidation**: the create mutation already invalidates the orders list (web `['orders']`, mobile `['admin-orders']`). No new server-state-derived keys are introduced. If we add a "Godown Pickups" filter view, that view should use a query key derived from the same underlying endpoint with a filter param — same key, no extra invalidation needed.

**Uniqueness / index conflicts**: none. The new column is a non-keyed boolean. No new index strictly required, but a partial index `CREATE INDEX ... ON orders (distributor_id, is_godown_pickup) WHERE is_godown_pickup = true;` would speed up the "list godown pickups for today" view if we add one — tiny, optional, can be deferred.

**Hidden surprise — payment-commitment gate**: `orderService.ts:127` runs `computeCustomerOverdue` and blocks the order create if the customer has open commitments at escalation level 3. Godown-pickup orders should remain subject to this gate (a customer with overdue balance shouldn't be allowed to walk into the godown either). Currently the gate runs before the walk-in detection, so it'll apply to godown-pickup orders too — verify in test #1.

**Hidden surprise — stock gate**: `gstPreflightService.ts:856-892` runs an INSUFFICIENT_STOCK check at preflight time (against `inventorySummary.closingFulls`). For godown pickup, this check fires AT confirmDelivery instead — but `confirmDelivery` has no such gate today; `delivery` events can drive `closing_fulls` negative (`orderService.ts:954-966` writes the negative without checking availability). For godown pickup, the admin doing the confirm-pickup is staring at the cylinder in question, so the gate is empirically met — but if we want symmetry with the dispatch path's stock check, we should add the same `INSUFFICIENT_STOCK` check inside `confirmDelivery` when the order is godown-pickup. Surfaces as a **WI-followup** rather than a v1 blocker.

---

## Plain-English Summary

### Minimum flag needed

A new **`Order.isGodownPickup` boolean** column, default false. **DO NOT** repurpose `Order.orderSource` — the FLOAT-001 enum values `regular` / `walk_in` carry float-reconciliation semantics (sold-from-float aggregation at `deliveryWorkflowService.ts:735` and `dvaManifestService.ts:347`), and overloading a third value `godown_pickup` would tangle two orthogonal concerns (provenance vs. fulfillment method). A clean boolean is the right shape.

### Does the status flow need a new status?

No. Godown-pickup orders enter `pending_delivery` directly at create time (skipping `pending_driver_assignment` and `pending_dispatch`) and use the existing `POST /api/orders/:id/confirm-delivery` endpoint to flip to `delivered`. `confirmDelivery` already accepts `pending_delivery` (`orderService.ts:839`).

### B2C IRN skip

Already handled by the existing B2C branch — `runB2cPreflight` at `gstPreflightService.ts:1456` never calls `/einvoice/type/GENERATE`, and `processInvoiceGst` skips IRN when `isB2B === false` (`gstService.ts:246, 325`). No new code needed for B2C IRN skip; we only need to additionally skip the EWB call for B2C godown pickup.

### B2B IRN without EWB — NIC sandbox A/B needed?

Strictly no — NIC's IRN and EWB endpoints are independent and we already exercise EWB-without-IRN on the B2C path with no protocol issues. But **one 30-min sandbox verification is prudent**: generate an IRN for a B2B godown-pickup invoice against dist-002 (Sharma GST-LIVE) and confirm (a) the response doesn't auto-return a phantom inline EWB we'd accidentally persist, and (b) GSTR-1 export rows look correct without an EWB row. Document the result in the WI spec.

### Full file list

26 touch points (see Task 11 table). Concentrated in: schema + migration + shared types (4 tiny), order service create + confirmDelivery + preflight guards (4 small), GST service skips (3 small), web order modal (2 small), mobile order modal (2 small), customer surfaces (2 tiny), tests (1 medium), wire-shape guard (1 tiny), plus 7 minor touch-ups.

### Estimated complexity per file

- **Tiny (≤10 LOC)**: 17 files — schema column add, migration, shared type, schema, mapper, customer-portal DTO, route 400 guard, finance/customer mobile cards, PDF nicety, anti-pattern guard test
- **Small (10-50 LOC)**: 8 files — orderService.createOrder branch, gstService skip, gstReissueService skip, gstPreflightService refuse-guard + filter, web modal toggle + badge, mobile modal toggle + badge, customer mobile cell, possibly the `(finance)/orders.tsx` surface
- **Medium (50-200 LOC)**: 1 file — the new integration test file covering the 8 scenarios in Task 11 row #25

Total bench estimate: **1 dev-day for the backend + tests, 0.5 dev-day for the web UI, 0.5 dev-day for the mobile UI, 0.5 dev-day for verification and sandbox A/B = 2.5 dev-days end to end.**

### Gotchas / compliance risks

1. **IRN-without-EWB legality**: NIC permits IRN with no follow-up EWB, but the e-invoice will sit on the portal as a "no movement" transaction. For GSTR-1 reporting this is fine (the supply happened — the buyer reports the inward supply too); for audit / NIC dashboard the transaction will look like an "incomplete" entry visually. Confirm acceptable with the distributor's accountant before pilot. (Anti-pattern #10 verification gate.)
2. **Inventory stock gate**: `confirmDelivery` doesn't have the same `INSUFFICIENT_STOCK` check that `preflightDispatch` does. Godown pickup bypasses the check today. Add the gate inside `confirmDelivery` when `isGodownPickup=true` for parity (followup, not blocker).
3. **Customer-confirms-pickup is admin-driven for v1**: the customer doesn't self-confirm. Spec needs to be clear about who clicks the button (admin / finance / inventory — same roles that have `confirmDelivery` access today per `routes/orders.ts:409`).
4. **Driver app exclusion is by null-driverId, not by an explicit filter**: defense in depth — add `isGodownPickup: false` filter on the driver-orders queries even though it's redundant today.
5. **Anti-pattern #19 — SSE customer event**: godown-pickup completion doesn't fire any customer SSE today (none exist). Explicitly note this in the spec so the v1.1 push-notifications WI knows to include godown-pickup completion as a notification trigger.
6. **Payment-commitment / overdue gate still applies** to godown-pickup orders — verify in tests. A customer with overdue balance walking into the godown should hit the same escalation flow as one placing an admin-created order.

---

## TRANSACTION AUDIT

*Appended 2026-06-25 — deep write-map of the standard B2B delivery lifecycle and per-step delta for an `Order.isGodownPickup=true` flow. Every write claim cites the line where it lives. Read-only investigation; no code changed.*

### Task 1 — Standard delivery write map

#### Step A — Order creation
Trace: `orderService.createOrder` ([packages/api/src/services/orderService.ts:95-321](packages/api/src/services/orderService.ts)).

Pre-tx reads (no writes):
1. `customer.findFirst` — gate on `stopSupply`, pull `preferredDriverId`, `transportChargePerCylinder` (line 116).
2. `computeCustomerOverdue` — runs the FIFO formula reading `Order` + `PaymentTransaction` + opening-balance `Invoice` (line 127, delegated to [paymentService.ts:756](packages/api/src/services/paymentService.ts)).
3. Per-item `getEffectivePrice` + `customerCylinderDiscount.findUnique` (lines 200-218).
4. Preferred-driver DVA lookup: `driverVehicleAssignment.findFirst` where `status='dispatch_ready' AND isReconciled=false AND driver.availableToday=true` (line 237). Sets `status='pending_dispatch'` and stamps `driverId`/`vehicleId` when an active DVA is found; otherwise `status='pending_driver_assignment'`, `driverId=null`, `vehicleId=null` (lines 222-253).

Tx writes (`prisma.$transaction`, lines 255-320):

| Table | Write | Key fields |
|---|---|---|
| `Order` | INSERT | `orderNumber`, `distributorId`, `customerId`, `driverId`, `vehicleId`, `orderDate=now()`, `deliveryDate`, `status`, `orderSource` ('regular' or 'walk_in'), `totalAmount`, `specialInstructions` |
| `OrderItem` | INSERT (per item, nested create) | `cylinderTypeId`, `quantity`, `unitPrice` (GST-inclusive), `discountPerUnit`, `totalPrice` |
| `OrderStatusLog` | INSERT | `orderId`, `oldStatus='new'`, `newStatus=<initial status>`, `changedBy`, `notes='Order created'` (line 280) |
| `PaymentCommitment` | INSERT — ONLY if `commitmentToCreate !== null` (overdue path) | `customerId`, `orderId`, `escalationLevel`, `overdueAmountSnapshot`, `promisedDate?`, `promisedAmount?`, `status='open'`, `acknowledged`, `createdBy` (lines 292-305) |
| `DriverAssignment` | INSERT — ONLY if `driverId !== null` (preferred driver matched) | `orderId`, `driverId`, `assignedBy` (line 310) |
| `PendingAction` | INSERT (outside tx) — ONLY on escalationLevel=3 with no grant | `actionType='OVERDUE_ORDER_OVERRIDE'`, `severity='high'`, `requiresApproval=true` (lines 156-162) |

**Inventory events**: NONE at order creation. Stock is reserved only at dispatch.
**Customer balance updates**: NONE at order creation.
**DVA created**: NO — DVA is created upstream via Fleet → Vehicle Mapping (`assignmentService`), not here. Order assignment merely references it.
**SSE events**: NONE emitted on createOrder. (Driver SSE fires only at explicit `assignDriver` line 681 and `confirmDelivery` line 1091.)

#### Step B — Driver assignment
Trace: `orderService.assignDriver` ([orderService.ts:593-687](packages/api/src/services/orderService.ts)) and `bulkAssignDriver` ([:689-707](packages/api/src/services/orderService.ts) — loop wrapper around `assignDriver`).

Pre-tx guards (lines 599-641):
- Order must be in `pending_driver_assignment` or `pending_dispatch`.
- Driver must be `status='active'`.
- A confirmed `DriverVehicleAssignment` for `(driverId, distributorId, assignmentDate=order.deliveryDate)` with `status: { not: 'cancelled' }` MUST exist; the vehicle is taken FROM the mapping (line 620). `data.vehicleId` is rejected if it doesn't match.

Tx writes (`prisma.$transaction`, lines 643-674):

| Table | Write | Key fields |
|---|---|---|
| `Order` | UPDATE | `driverId`, `vehicleId`, `status='pending_dispatch'` |
| `OrderStatusLog` | INSERT | `oldStatus`, `newStatus='pending_dispatch'`, `changedBy`, `notes='Driver <name> assigned'` |
| `DriverAssignment` | INSERT | `orderId`, `driverId`, `assignedBy=userId` |

**DVA status field**: NOT modified at this step. DVA was created at value `dispatch_ready` (default), `isReconciled=false`, `tripNumber=1`. It stays that way until preflight.
**SSE event**: `notifyDriver(driverId, { type: 'order_assigned', payload: { orderId } })` AFTER the tx commits (line 681).
**Load manifest skeleton**: NOT created here. Manifest is opt-in admin-driven via `dvaManifestService.createOrUpdateManifest`; if used at all, it's invoked separately when admin sets float quantities BEFORE preflight (precondition: DVA.status='dispatch_ready' — see [dvaManifestService.ts:78](packages/api/src/services/dvaManifestService.ts)).

#### Step C — Preflight dispatch
Trace: `gstPreflightService.preflightDispatch` ([gstPreflightService.ts:155-496](packages/api/src/services/gst/gstPreflightService.ts)) → per-order `preflightOne` ([:805-957](packages/api/src/services/gst/gstPreflightService.ts)) → `runB2bPreflight` ([:1210+](packages/api/src/services/gst/gstPreflightService.ts)) or `runB2cPreflight`.

**Pre-loop top-level writes**:

| Table | Write | Condition | Cite |
|---|---|---|---|
| `DriverVehicleAssignment` | UPDATE — trip-state clear (`tripNumber: { increment: 1 }` IF "needsTripBumpHere", `status='dispatch_ready'`, null timestamps, `isReconciled=false`) | `shouldClearTripState` (post-reconcile re-dispatch OR loaded_and_dispatched with 0 in-flight) | :282-305 |
| `InventoryEvent` | INSERT per manifest row (`eventType='dispatch'`, `fullsChange=-floatQty`, `referenceType='dva_load_manifest'`, `referenceId=manifestRow.id`) | `hasManifest && isDispatchDebitEnabled(distributorId)` | :348-367 |

**Per-order writes inside `preflightOne` → `transitionToPendingDelivery`** ([:1018-1071](packages/api/src/services/gst/gstPreflightService.ts)):

Lock acquisition (atomic):

```
prisma.order.updateMany where: { id, status: 'pending_dispatch' } data: { status: 'preflight_in_progress' }
```
([:821-824](packages/api/src/services/gst/gstPreflightService.ts) — race-safe; loser returns ALREADY_IN_PREFLIGHT).

INSUFFICIENT_STOCK gate (lines 856-892): reads `InventorySummary.closingFulls` for the latest summary; calls `revertToPendingDispatch` + `createPendingAction('DISPATCH_PREFLIGHT')` on shortfall. NO inventory event written on revert.

`ensureDraftInvoice` ([:1085-1137](packages/api/src/services/gst/gstPreflightService.ts)): if no invoice exists, temporarily flips Order.status to 'delivered' inside a sub-tx, calls `createInvoiceFromOrder`, restores prior status. The invoice is created at the ordered quantities (delivered=ordered).

| Table | Write | Pre-state | Post-state |
|---|---|---|---|
| `Invoice` | INSERT (via `createInvoiceFromOrder`) — see Step D for the field map | none | `status='issued'`, `irnStatus='not_required'` (default), `ewbStatus='not_required'` (default), `outstandingAmount=totalAmount`, `amountPaid=0`, `dueDate=now()+creditPeriodDays` |
| `InvoiceItem` | INSERT per delivered line | none | full snapshot — `unitPrice` inclusive, `discountPerUnit`, `gstRate`, `totalPrice`, `taxableValue` |
| `CustomerLedgerEntry` | INSERT (inside `createInvoiceFromOrder`) | none | `entryType='invoice_entry'`, `invoiceId`, `amountDelta=+totalAmount`, `narration='Invoice <number>'` (see invoiceService.ts further down) |

For each B2B order in `runB2bPreflight` ([:1210+](packages/api/src/services/gst/gstPreflightService.ts), partial trace above): 

| Step | Table | Write | Cite |
|---|---|---|---|
| IRN | external API (`POST /einvoice/type/GENERATE/version/V1_03`) | n/a | :1248 |
| IRN persist | `Invoice` | UPDATE { irn, ackNo, ackDate, irnStatus='success', ewbStatus='active' (if inline-EWB present) } | :1271-1280 |
| IRN persist | `GstDocument` | upsertLatestGstDocument — write requestPayload + responsePayload as JSON | :1285-1299 |
| IRN log | `GstApiLog` (via `callWithLog` → `writeApiLog`) | INSERT — `apiType='IRN_GENERATE'`, `requestPayload`, `responsePayload`, `httpStatus`, `latencyMs` (BOTH success AND failure — anti-pattern #11) | :1248 + `apiLogger.ts` |
| EWB (separate call) | external API (`POST /ewaybillapi/v1.03/ewayapi/genewaybill`) | n/a | further down in runB2bPreflight |
| EWB persist | `Invoice` | UPDATE { ewb, ewbDate, ewbValidTill, ewbStatus='active' } | (mirror of IRN block) |
| EWB persist | `GstDocument` | upsert — adds ewbNo/ewbDate/ewbValidTill | (mirror) |
| EWB log | `GstApiLog` | INSERT — `apiType='EWB_GENERATE'` | (mirror) |
| End-of-order | `Order` | UPDATE `status='pending_delivery'` + stamp `tripNumber` (atomic with status change via `transitionToPendingDelivery`) | :1033-1039 |
| End-of-order | `OrderStatusLog` | INSERT — oldStatus='preflight_in_progress' → newStatus='pending_delivery' | :1040-1048 |
| End-of-order — DISPATCH DEBIT | `InventoryEvent` | INSERT per item, `eventType='dispatch'`, `fullsChange=-quantity`, `referenceType='order'`, `referenceId=orderId` — ONLY when `isDispatchDebitEnabled(distributorId) && dispatchCtx` (regular order on first dispatch path, NOT walk-in, NOT Add-to-Trip) | :1053-1069 |

`buildDispatchCtx` ([:981-1016](packages/api/src/services/gst/gstPreflightService.ts)) is the decision point: returns `undefined` (skip per-order dispatch event) when `order.orderSource === 'walk_in'` OR `isAddToTrip`; otherwise returns the context that writes the per-order `dispatch` inventory event.

**Failure path / status persistence**: an `irnPersisted` flag at :1245 + :1283 protects against anti-pattern #12 — if a downstream EWB write throws, the outer catch must NOT overwrite `irnStatus='success'` back to `'failed'`.

**Post-loop top-level writes**:

| Table | Write | Condition | Cite |
|---|---|---|---|
| `InventorySummary` | UPSERT for every cylinder type just dispatched (via `recalculateSummariesFromDate(distributorId, ctId, targetDate)`) | `isDispatchDebitEnabled(distributorId)` | :393-414 |
| `DriverVehicleAssignment` | UPDATE `{ dispatchedAt: new Date() }` | `succeeded > 0 || isFloatOnlyDispatch` | :422-426 |
| `DriverVehicleAssignment` | UPDATE `{ status: 'loaded_and_dispatched' }` | `tripStarted` (failed===0 && succeeded>0) OR `isFloatOnlyDispatch` | :435-439 |
| `Vehicle` | UPDATE `{ status: 'dispatched' }` | same as above + mapping.vehicleId present | :441-446 |
| `DriverVehicleAssignment` | UPDATE `{ tripSheetNo, tripSheetGeneratedAt }` | ewbNumbers.length >= 2 (consolidated EWB success) | :471-474 |
| `GstApiLog` | INSERT — apiType='CONSOLIDATED_EWB' (success and failure) | always on attempted gencewb | (callWithLog inside generateConsolidatedEwb) |
| `PendingAction` | INSERT — actionType='CONSOLIDATED_EWB_FAILED', severity='low' | gencewb threw | :481-487 |

**SSE events**:
- `notifyDriver(driverId, { type: 'trip_updated', payload: { dvaId } })` AFTER status flip ([:451-454](packages/api/src/services/gst/gstPreflightService.ts)).

**TanStack Query keys the consumer depends on** (anti-pattern #18/#19):
- `['driver-active-trip']` — driver `_layout` invalidates on `trip_updated` event ([(driver)/_layout.tsx:65](packages/mobile/app/(driver)/_layout.tsx))
- `['order-list']`, `['order', orderId]` on the order screens after dispatch.

#### Step D — Delivery confirmation
Trace: `orderService.confirmDelivery` ([orderService.ts:781-1098](packages/api/src/services/orderService.ts)).

Pre-tx guards (lines 792-895):
1. Routes returns-only orders to `confirmReturnsCollection` (line 803).
2. Idempotency: duplicate confirmation with identical qty returns existing order (no-op); mismatch → 409 (lines 819-836).
3. Order must be in `pending_delivery` OR `pending_dispatch` (line 839).
4. WI-087 vehicle-return gate: if `order.vehicleId` is set AND the vehicle is in `status='returned'` → 409 (lines 847-857). **Critical for the godown-pickup delta — this guard reads vehicleId; vehicleId=null bypasses the check entirely.**
5. Per-item bounds check — delivered ≤ ordered (lines 869-886).
6. Determines `isModified` / `newStatus` (lines 891-895) — `modified_delivered` if any line under-delivered.

Tx writes (`prisma.$transaction`, lines 897-1048):

| Table | Write | Per item / once | Cite |
|---|---|---|---|
| `OrderItem` | UPDATE — `deliveredQuantity`, `emptiesCollected` | per item | :902-908 |
| `Order` | UPDATE — `status` (delivered|modified_delivered), `totalAmount` (recomputed from delivered qty), `deliveredAt=now()`, `deliveryLatitude`, `deliveryLongitude`, `deliveryNotes` | once | :927-938 |
| `OrderStatusLog` | INSERT — oldStatus → newStatus | once | :940-948 |
| `InventoryEvent` | INSERT — `eventType='delivery'`, `fullsChange=-deliveredQty`, `emptiesChange=0`, `referenceType='order'`, `referenceId=orderId`, `eventDate=order.deliveryDate` | per item with deliveredQty > 0 | :953-966 |
| `InventoryEvent` | INSERT — `eventType='collection'`, `fullsChange=0`, `emptiesChange=+emptiesCollected`, `referenceType='order'`, `referenceId=orderId` | per item with emptiesCollected > 0 | :967-980 |
| `CustomerInventoryBalance` | UPSERT — create or `withCustomerQty: { increment: deliveredQuantity - emptiesCollected }` | per item | :983-998 |
| `CancelledStockEvent` | INSERT — `quantity=ordered-delivered`, `status: order.vehicleId ? 'on_vehicle' : 'pending_return'` | per item when delivered < ordered | :1002-1019 |
| `Invoice` (+ `InvoiceItem` + `CustomerLedgerEntry`) | INSERT via `createInvoiceFromOrder` — non-blocking try/catch | once, ONLY IF no invoice already exists | :1022-1027 |

**Invoice creation — invoice-was-not-created-at-preflight path**: `createInvoiceFromOrder` ([invoiceService.ts:119](packages/api/src/services/invoiceService.ts)) writes:
- `Invoice` — `invoiceNumber`, `distributorId`, `customerId`, `orderId`, `issueDate=now()`, `dueDate=now()+creditDays`, `totalAmount`, `taxableValue`, `cgstValue`/`sgstValue`/`igstValue` (when gstEnabled), `outstandingAmount=totalAmount`, `amountPaid=0`, `status='issued'`, `irnStatus='not_required'`/`pending`, `ewbStatus='not_required'`/`pending`
- `InvoiceItem` — one per delivered cylinder line + transport-charge line
- `CustomerLedgerEntry` — `entryType='invoice_entry'`, `amountDelta=+totalAmount`
- BUT — when invoice already exists (preflight path), this whole branch is skipped (`existing` check at :139-142 throws InvoiceError which is then swallowed by the outer try/catch).

**Outside the tx**:
- `recalculateSummariesFromDate(distributorId, cylinderTypeId, order.deliveryDate)` for each item ([:1051-1053](packages/api/src/services/orderService.ts)) — rebuilds the per-day summary so closing balances are visible. Anti-pattern #9 footnote: this runs AFTER the tx commits.
- GST post-delivery: either `reissueForDeliveryMismatch` (if invoice has live IRN/EWB and isModified) or `processInvoiceGst` (post-delivery GST trigger for non-preflight flows). Both fire-and-forget ([:1057-1085](packages/api/src/services/orderService.ts)).
- `notifyDriver(order.driverId, { type: 'order_updated', payload: { orderId, status: 'delivered' } })` — ONLY when `order.driverId !== null` ([:1090-1095](packages/api/src/services/orderService.ts)). **Direct hit for godown-pickup delta — null driverId means NO SSE.**

**Payment record**: NEVER auto-created on delivery. Payment is independent — see Step F.

**Customer cylinder balance write**: `withCustomerQty += deliveredQuantity - emptiesCollected`. Other CIB fields (`pendingReturns`, `missingQty`) are NOT touched here.

**SSE events**: `notifyDriver` only — no admin/customer/finance events emitted from `confirmDelivery`.

#### Step E — Vehicle return + reconciliation
Trace: `deliveryWorkflowService` ([packages/api/src/services/deliveryWorkflowService.ts](packages/api/src/services/deliveryWorkflowService.ts)).

The vehicle-return signal is a separate API call (driver app or admin Inventory page). That call flips `Vehicle.status='returned'` BEFORE reconciliation runs. (Found by inference — code path is in `deliveryWorkflowService.markVehicleReturned` / similar; the WI-087 confirmDelivery gate at orderService.ts:847-857 enforces "can't confirm-delivery once status=returned".)

`confirmVehicleReconciliation` ([:407-1002](packages/api/src/services/deliveryWorkflowService.ts)) is the main reconciliation entry. Lookups:

Pre-condition: `data.physicalStockConfirmed === true`. On `false`, only a `PendingAction` (actionType='STOCK_MISMATCH', severity='critical') is written and the function returns ([:419-434](packages/api/src/services/deliveryWorkflowService.ts)).

Pre-validation: ([:473-548](packages/api/src/services/deliveryWorkflowService.ts)) — empties verified ≤ collected on this trip; throws 400 on overage.

Writes:

**Step 1 — cancelled stock return** ([:550-594](packages/api/src/services/deliveryWorkflowService.ts)):

| Table | Write | Per | Cite |
|---|---|---|---|
| `CancelledStockEvent` | UPDATE — `status='returned_to_depot'`, `returnedDate=now()`, `reconciledBy=userId` | per CSE on this vehicle with status in ('on_vehicle','pending_return') | :558-563 |
| `InventoryEvent` | INSERT — `eventType='cancellation_return'`, `fullsChange=+cs.quantity`, `eventDate=cs.cancellationDate` (NOT now() — pin to trip day) | per CSE | :575-586 |
| `InventorySummary` | UPSERT via `recalculateSummariesFromDate(distributorId, ct, cs.cancellationDate)` | per cylinder type | :590 |

**Step 2 — undelivered orders cancelled** ([:596-728](packages/api/src/services/deliveryWorkflowService.ts)): queries orders where `vehicleId=vehicleId AND distributorId AND status IN ('pending_delivery','pending_dispatch')`. **For godown-pickup with vehicleId=null this query NEVER matches — confirmed safe by design.**

Per matched order:

| Table | Write | Cite |
|---|---|---|
| `Order` | UPDATE — `status='cancelled'`, `cancelledAt`, `cancellationReason='Vehicle reconciliation - order not delivered'` | :612-619 |
| `OrderStatusLog` | INSERT — newStatus='cancelled' | :621-629 |
| `CancelledStockEvent` | INSERT, then UPDATE same row to `returned_to_depot` (atomic invariant) — ONLY when `wasDispatched` (status ∈ {pending_delivery, preflight_in_progress, modified_delivered}) | :655-670 |
| `InventoryEvent` | INSERT — `eventType='cancellation_return'`, `eventDate=order.deliveryDate` | per item | :677-688 |
| `Invoice` | UPDATE — `status='cancelled'`, `deletedAt=now()` (soft delete) | :716-718 |
| External | `cancelIrn` if `irnStatus='success'` | :712-714 |

**Step 2.5 — float credit-back** ([:730-886](packages/api/src/services/deliveryWorkflowService.ts), FLOAT-001): only when `isDispatchDebitEnabled`. Finds DVA for vehicle, walks manifest rows with floatQty>0, computes `unsoldFloat = floatQty - soldFromFloat` where `soldFromFloat` = sum of quantities of orders on this trip that DID NOT have a per-order dispatch event written. Writes `InventoryEvent { eventType='cancellation_return', referenceType='dva_load_manifest', eventDate=tripDva.assignmentDate }` per manifest row.

**Step 3 — vehicle + DVA finalisation** ([:888-988](packages/api/src/services/deliveryWorkflowService.ts)):

| Table | Write | Cite |
|---|---|---|
| `Vehicle` | UPDATE — `status='idle'` | :889-891 |
| `DriverVehicleAssignment` | UPDATE — `status='dispatch_ready'`, `reconciledAt=now()`, `isReconciled=true`, `tripNumber: { increment: 1 }` (WI-100 Gap A + Bug #7) | :907-937 |
| SSE | `notifyDriver(reconcileDva.driverId, { type: 'trip_updated', payload: { dvaId } })` | :950-953 |
| `ReconciliationEmptiesReturned` + `InventoryEvent` (`reconciliation_empties_return`) | INSERT per supervisor-verified entry, anchored to DVA | :966-988 |

`recalculation_pending` surface (`getVehiclesPendingReconciliation` at [:1077](packages/api/src/services/deliveryWorkflowService.ts)) filters `vehicle.status='returned'`. **Godown-pickup orders have vehicleId=null → never reach any vehicle status → never surface here. Safe by design.**

`aggregateActiveTripCollections` ([:1015-1071](packages/api/src/services/deliveryWorkflowService.ts)) joins by `vehicleId` AND `tripNumber`. Godown-pickup orders carry vehicleId=null + tripNumber=null → never aggregated.

`Order.tripNumber` is null for godown-pickup orders (set only by `transitionToPendingDelivery` during preflight which is SKIPPED for godown).

#### Step F — Payment collection
Trace: `paymentService.createPayment` ([paymentService.ts:257-263](packages/api/src/services/paymentService.ts)) → `createPaymentInTx` ([:102-250](packages/api/src/services/paymentService.ts)).

Tx writes:

| Table | Write | Cite |
|---|---|---|
| `PaymentTransaction` | INSERT — `customerId`, `amount`, `paymentMethod`, `referenceNumber`, `transactionDate`, `allocationStatus='unallocated'`, `receivedBy`, `razorpay*` ids | :114-128 |
| `PaymentAllocation` | INSERT — one per `alloc` (manual) OR auto-allocate FIFO against outstanding invoices oldest-first | :147-153 (manual) and :188-194 (auto) |
| `Invoice` | UPDATE — `outstandingAmount`, `amountPaid`, `status='paid' / 'partially_paid'`, `closedAt` | :158-166 (manual) and :198-206 (auto) |
| `PaymentTransaction` | UPDATE — `allocationStatus='fully_allocated' / 'partially_allocated' / 'unallocated'` | :220-229 |
| `CustomerLedgerEntry` | INSERT — `entryType='payment_entry'`, `amountDelta=-amount`, `narration='Payment received via <method>'` | :231-243 |

**Independent of delivery flow** — confirmed. Payment is a separate API call (`POST /api/payments`). Godown-pickup orders use the same path with no changes.

**`Customer.outstandingAmount` denormalised field**: searched — Customer has no such field; outstanding is always derived via aggregation over `Invoice.outstandingAmount` (header metrics at analyticsService.ts:96-102) OR via the FIFO formula `computeCustomerOverdue` at [paymentService.ts:756-835](packages/api/src/services/paymentService.ts).

---

### Task 2 — Godown pickup: per-step delta vs standard

#### Step A — Order creation
**Delta: minimal.** Still creates Order + OrderItem identically. New decisions in the order-creation branch:
- The form/payload carries `isGodownPickup=true`. Per the implementation choice in the existing 477-line investigation (Option A), the service must SKIP the preferred-driver DVA lookup (lines 222-253) and set `driverId=null, vehicleId=null, status='pending_delivery'` directly. NO `DriverAssignment` row created (the `if (driverId) { ... DriverAssignment }` block at orderService.ts:309 naturally skips when driverId is null).
- `OrderStatusLog` line 280 still writes — `oldStatus='new' → newStatus='pending_delivery'` (one log line, no intermediate states).
- Payment-commitment + overdue gate at lines 127-190: APPLIES UNCHANGED. A customer walking into the godown with overdue balance still hits escalation level 1/2/3. Verified in the existing investigation row #6.

#### Step B — Driver assignment
**Delta: ENTIRE STEP SKIPPED.** Godown-pickup orders are never in `pending_driver_assignment` or `pending_dispatch`, so `assignDriver` never runs.

Downstream call sites that assume a DVA exists and would break IF a future caller mistakenly tried to assignDriver to a godown order:
1. The status gate at orderService.ts:603 (`!['pending_driver_assignment', 'pending_dispatch'].includes(order.status)`) hard-blocks it — defence in depth.
2. The mapping lookup at :620 would 400 if no DVA — also safe.
3. No additional protection needed UNLESS an explicit Add-to-Trip / re-assignment surface is exposed for godown orders. The existing investigation's Task 11 row #25 covered this.

#### Step C — Preflight dispatch
**Delta: ENTIRE STEP SKIPPED for the order.**

Direct consequences:
- `Invoice` is NOT created at preflight time. `ensureDraftInvoice` never runs. Invoice creation happens at `confirmDelivery` via the `createInvoiceFromOrder` non-blocking try/catch (orderService.ts:1022-1027) — same as a GST-disabled tenant or a pre-WI-035 flow.
- `Invoice.irn`, `Invoice.ackNo`, `Invoice.ackDate`, `Invoice.ewb`, `Invoice.ewbDate`, `Invoice.ewbValidTill`, `Invoice.signedQr` stay NULL.
- `Invoice.irnStatus` / `Invoice.ewbStatus`: stay at the createInvoiceFromOrder default — `not_required` for GST-disabled tenants. **For B2B godown pickup the existing investigation already noted (Task 6) the post-delivery `processInvoiceGst` trigger fires from `confirmDelivery` (orderService.ts:1078-1083) and DOES generate the IRN — but with NO `EwbDtls`, satisfying the "B2B godown still needs IRN, no EWB" rule. No code change needed beyond gating the EWB generation in the IRN path.**
- `GstDocument` row — written from `processInvoiceGst` (post-delivery), not preflight. Existing `gstService.processInvoiceGst` path is the documented one.
- `GstApiLog` rows: present for whatever NIC calls happen via `processInvoiceGst`.
- `DriverVehicleAssignment`: never touched on a godown order (no driver, no vehicle).
- `Vehicle`: never status='dispatched'.
- `InventoryEvent` of `eventType='dispatch'`: **NEVER WRITTEN** for a godown order. Critical implication:

  Under the `INVENTORY_DISPATCH_DEBIT=true` flag (current production state per CLAUDE.md), `closingFulls = openingFulls + incomingFulls - dispatchedQty + returnedQty + manualAdjustment` ([inventoryService.ts:203-204](packages/api/src/services/inventoryService.ts)). With no `dispatch` event, `dispatchedQty=0` for godown rows. The `delivery` event written at confirmDelivery contributes to `deliveredQty` (used only by the OFF-flag formula). Under the ON flag, `delivery` events do NOT drive `closingFulls`.

  **THIS IS THE CRITICAL GAP**: a godown pickup under `INVENTORY_DISPATCH_DEBIT=true` would NEVER debit `closingFulls`. The cylinder physically left the depot, but the inventory closingFulls stays inflated by the godown-pickup quantity FOREVER until manual adjustment.

  Fix needed (see Task 3 / Gap Table): the godown-pickup `confirmDelivery` must ALSO write a `dispatch` inventory event (eventDate=deliveryDate, fullsChange=-deliveredQty, referenceType='order') in addition to the existing `delivery` event. OR — preferred — godown-pickup writes a single `dispatch` event with referenceType='godown_pickup' that closes the books in one stroke; `delivery` is unnecessary because there's no on-vehicle stage.

#### Step D — Delivery confirmation
**Delta: invoice creation happens HERE (not preflight). `confirmDelivery` assumptions to revisit:**

1. **WI-087 vehicle-return gate** (orderService.ts:847-857): reads `order.vehicleId`. Godown vehicleId=null → guard SKIPPED. Correct (no vehicle to be returned).
2. **`isModified` branch / `reissueForDeliveryMismatch`** (orderService.ts:1067): for a godown B2B order with IRN already present (if a pre-delivery IRN flow existed), this would trigger reissue. Today nothing creates the pre-delivery IRN for godown orders, so `hasLiveGstDoc=false` → falls through to the regular `processInvoiceGst` post-delivery path. **Safe.**
3. **SSE driver notify** (orderService.ts:1090-1095): `if (order.driverId)` already guards against null. Godown driverId=null → NO SSE emitted. **Documented in existing investigation Task 4 / Anti-pattern #19 note.**
4. **InventoryEvent 'delivery' event** (orderService.ts:953-966): WRITES with fullsChange=-deliveredQty. Under DISPATCH_DEBIT=ON, this does NOT drive closingFulls (see deep gap above). Under DISPATCH_DEBIT=OFF, the `closingFulls = openingFulls + incomingFulls - deliveredQty + cancelledStockQty + manualAdjustment` formula picks it up — so OFF-flag tenants are correct; ON-flag tenants leak.
5. **Insufficient-stock gate**: the preflight INSUFFICIENT_STOCK guard at gstPreflightService.ts:856-892 is SKIPPED. `confirmDelivery` has no equivalent. Defect carry-over noted in the original investigation's "Gotchas" #2 — godown pickup can drive closingFulls negative under current code. Needs the gate added inside `confirmDelivery` when `isGodownPickup=true`.

#### Step E — Vehicle return + reconciliation
**Delta: ENTIRE STEP SKIPPED for godown orders by design.**

- `confirmVehicleReconciliation` queries undelivered orders by `vehicleId=vehicleId` ([:597-602](packages/api/src/services/deliveryWorkflowService.ts)). Godown orders carry vehicleId=null → never matched. SAFE.
- `aggregateActiveTripCollections` filters by `vehicleId` + `tripNumber` ([:1024-1027](packages/api/src/services/deliveryWorkflowService.ts)). Godown rows excluded. SAFE.
- `getVehiclesPendingReconciliation` ([:1077](packages/api/src/services/deliveryWorkflowService.ts)) filters by `vehicle.status='returned'`. No vehicle → no surface. SAFE.
- `dvaManifestService.getManifestForDVA` is never invoked for godown orders (no DVA). SAFE.

#### Step F — Payment collection
**Delta: NONE.** `paymentService.createPayment` is order-agnostic — works against `Invoice.outstandingAmount`. Same path for both flows.

---

### Task 3 — InventorySummary deep dive

`recalculateSummariesFromDate` ([inventoryService.ts:233-309](packages/api/src/services/inventoryService.ts)) is the rebuild driver. Per (`distributorId`, `cylinderTypeId`, `summaryDate`), it calls `computeSummaryForDate` ([:64-227](packages/api/src/services/inventoryService.ts)) and UPSERTs the result into `InventorySummary`.

**Columns written** (from the return shape at :213-226):

| Column | Source | Notes |
|---|---|---|
| `openingFulls` | prev-day `closingFulls` | carry-forward |
| `openingEmpties` | prev-day `closingEmpties` | carry-forward |
| `incomingFulls` | Σ `incoming_fulls.fullsChange` | corporation refills |
| `outgoingEmpties` | Σ `|outgoing_empties.emptiesChange|` | corporation returns |
| `deliveredQty` | Σ `|delivery.fullsChange|` | display-only when DISPATCH_DEBIT=ON |
| `dispatchedQty` | Σ `|dispatch.fullsChange|` | WI-106; ONLY produced when DISPATCH_DEBIT=ON |
| `collectedEmpties` | Σ (`collection.emptiesChange` + `returns_collection.emptiesChange`) | audit only; doesn't drive closingEmpties |
| `emptiesReturnedVerified` | Σ `reconciliation_empties_return.emptiesChange` | supervisor count |
| `cancelledStockQty` | Σ (`cancellation.fullsChange` + `cancellation_return.fullsChange`) | |
| `manualAdjustment` | Σ (`manual_adjustment.fullsChange` + `initial_balance.fullsChange` + `write_off.fullsChange`) | |
| `closingFulls` | DISPATCH_DEBIT=ON: `openingFulls + incomingFulls - dispatchedQty + returnedQty + manualAdjustment`; OFF: `openingFulls + incomingFulls - deliveredQty + cancelledStockQty + manualAdjustment` | the formula switch on the flag |
| `closingEmpties` | `openingEmpties + emptiesReturnedVerified + initialEmpties + manualEmpties - outgoingEmpties` | |

The `dispatchedQty` column is fed by `dispatch` events. **For godown pickup under DISPATCH_DEBIT=ON, no dispatch event is produced today — so dispatchedQty for that order is 0, closingFulls is never debited, and dashboard / reports / inventory tab will show inflated stock until manually adjusted.**

**Readers of `dispatchedQty` as a headline number**:
- `reportsService.inventoryMovement` ([reportsService.ts:271-279](packages/api/src/services/reportsService.ts)) — column key `dispatched: s.dispatchedQty` rendered in the Inventory Movement report's "Dispatched" column. Godown pickup days under DISPATCH_DEBIT=ON would show artificially low Dispatched figures vs the true depot outflow.
- Web/mobile inventory tab — InventorySummary is consumed widely; locations include `(admin)/inventory.tsx` (mobile) and `InventoryPage` (web). Either reads `dispatchedQty` or `deliveredQty` to label the "cylinders out" column. Needs explicit pass: when DISPATCH_DEBIT=ON, both surfaces show `dispatchedQty`; godown pickup would be invisible there.

**Other readers of `InventorySummary`** (grep `prisma.inventorySummary.findFirst|findMany`):
- `gstPreflightService.ts:868` — INSUFFICIENT_STOCK gate reads `closingFulls`. With godown pickup not debiting closingFulls, the gate would see inflated stock and approve dispatches that physically can't be fulfilled.
- `analyticsService.ts` (header metrics) — does NOT read InventorySummary directly; reads CustomerInventoryBalance + Invoice aggregates.
- `dashboardService` / `inventoryService.checkThresholds` — `checkThresholds` reads `InventorySummary.closingFulls` to drive the "below warning level" count. Godown pickup not debiting closingFulls means thresholds are silent until manual adjustment.

**Verdict on InventorySummary needing a new column**: NO new column needed. The existing `dispatchedQty` is the right slot — the fix is to write a `dispatch` event from `confirmDelivery` when `isGodownPickup=true`. `manualAdjustment` could cover it as a workaround but pollutes the audit trail (would look like an inventory team intervention, not a customer pickup). The right design is a new event type `godown_pickup` OR re-use `dispatch` with `referenceType='godown_pickup'` (recommended — adds zero new types).

---

### Task 4 — CustomerInventoryBalance

Schema ([packages/api/prisma/schema.prisma:533](packages/api/prisma/schema.prisma)): `withCustomerQty`, `pendingReturns`, `missingQty`.

**Write sites** (grep `customerInventoryBalance` for `.upsert|.update|.create`):
1. `orderService.confirmDelivery` ([:983-998](packages/api/src/services/orderService.ts)) — upsert, `withCustomerQty: increment(deliveredQuantity - emptiesCollected)` on delivery.
2. `orderService.confirmReturnsCollection` ([:1172-1187](packages/api/src/services/orderService.ts)) — upsert, `withCustomerQty: decrement(collectedQuantity)` on returns-only order completion.
3. `customerService.setupCustomerBalance` + `customerService.importEmptyBalances` — onboarding seed writes (already noted in CLAUDE.md "Open Items").

**Trigger**: ONLY delivery + returns events. **NOT dispatch.** So godown-pickup orders write here correctly at `confirmDelivery` (delivery event still fires, increments `withCustomerQty` by deliveredQty). **No bug here for godown pickup — the increment-on-delivery / decrement-on-returns model net-zero balances even when dispatch is omitted.**

No code path increments on dispatch and decrements on delivery, so the "net to zero for godown" risk identified in the audit scope DOES NOT exist. **CIB is safe.**

---

### Task 5 — DVA reconciliation queries

`confirmVehicleReconciliation` WHERE clauses (filtered list):

| Lookup | Filter |
|---|---|
| Pre-check pending orders | `vehicleId=vehicleId AND distributorId AND status IN ('pending_delivery','pending_dispatch') AND deletedAt=null` ([:438-444](packages/api/src/services/deliveryWorkflowService.ts)) |
| Cancelled stock to return | `vehicleId=vehicleId AND distributorId AND status IN ('on_vehicle','pending_return')` ([:551-553](packages/api/src/services/deliveryWorkflowService.ts)) |
| Undelivered orders to cancel | Same as pre-check ([:597-602](packages/api/src/services/deliveryWorkflowService.ts)) |
| `tripDva` lookup for float credit | `vehicleId AND distributorId AND assignmentDate=startOfUtcDay() AND status≠'cancelled'`, order by tripNumber desc ([:751-755](packages/api/src/services/deliveryWorkflowService.ts)) |
| `reconcileDva` for finalisation | Same shape, order by tripNumber desc ([:896-905](packages/api/src/services/deliveryWorkflowService.ts)) |

**Every query keys on vehicleId.** Godown-pickup orders have vehicleId=null → never matched → never accidentally included in reconciliation aggregations. **Safe by design.**

`dvaManifestService.getManifestForDVA` ([:8](packages/api/src/services/dvaManifestService.ts)) — reads manifest by `dvaId`. Godown orders have no DVA → never queried. SAFE.

`getAvailableFullsForDriver` (mentioned in dvaManifestService docstring) — keyed on (driver, cylinderType). Godown orders have driverId=null → excluded. SAFE.

`recalculation_pending` DVA endpoint (`getVehiclesPendingReconciliation` at [:1077](packages/api/src/services/deliveryWorkflowService.ts)) — filters `vehicle.status='returned'`. Godown orders are vehicleId=null; never touch vehicle status. SAFE.

**Verdict: no DVA / reconciliation surface leaks godown-pickup orders into trip aggregates.** Defence in depth (an explicit `isGodownPickup: false` filter on these queries) is cheap and recommended but not strictly required.

---

### Task 6 — Financial reports

Every export in `reportsService.ts` keyed against godown-pickup behaviour:

| Report | Function | Date field | Filter | Godown-pickup impact |
|---|---|---|---|---|
| Sales Summary | `salesSummary` ([:63-110](packages/api/src/services/reportsService.ts)) | `deliveryDate` | `status IN ('delivered','modified_delivered')` | **CORRECT** — godown rows are `delivered`; they appear in customer rows + day series + totals. Revenue + qty + order count are reported correctly. |
| Outstanding Aging | `outstandingAging` ([:120-177](packages/api/src/services/reportsService.ts)) | `issueDate` | `outstandingAmount > 0` | **CORRECT** — invoice-only; godown invoices participate identically. |
| GST Summary | `gstSummary` ([:180-214](packages/api/src/services/reportsService.ts)) | `issueDate` | `status ≠ 'cancelled'` | **CORRECT** — invoice-level CGST/SGST/IGST aggregates. B2B godown invoice still has tax breakup. |
| Delivery Performance | `deliveryPerformance` ([:217-261](packages/api/src/services/reportsService.ts)) | `deliveryDate` | **`driverId: { not: null }`** | **EXCLUDED CORRECTLY** — `driverId IS NOT NULL` filter at :221 skips godown rows. **By design**: godown pickup is not a "driver performance" row. The driver column on the dashboard naturally excludes godown. NO change needed. |
| Inventory Movement | `inventoryMovement` ([:264-289](packages/api/src/services/reportsService.ts)) | `summaryDate` | per cylinder type | **WRONG under DISPATCH_DEBIT=ON** — reads `s.dispatchedQty`. Godown pickup never writes a dispatch event today; the "Dispatched" column under-reports by the godown qty. The "Delivered" column reads `s.deliveredQty` which IS written, so under DISPATCH_DEBIT=OFF the closing balance still closes. Under ON, the report is wrong. Fix lives upstream — write a dispatch event at godown confirmDelivery. |
| Customer Statement | `customerStatement` ([:300-380](packages/api/src/services/reportsService.ts)) | ledger `entryDate` | per customerId | **CORRECT** — reads `CustomerLedgerEntry` which is written by `createInvoiceFromOrder` regardless of order source. Godown invoices appear identically. |
| Vehicle Ledger | `vehicleLedger` ([:383-558](packages/api/src/services/reportsService.ts)) | per-event | groups by vehicleId | **EXCLUDED CORRECTLY** — godown events carry vehicleId=null so they land in the "—" bucket. If a per-vehicle filter is applied (`f.vehicleId`), the godown rows skip the report. NO change needed unless the user wants a separate "Godown direct" pseudo-vehicle line; that's a UX call, not a correctness issue. |

`analyticsService.getHeaderMetrics` ([:94-150](packages/api/src/services/analyticsService.ts)): reads invoice aggregates + payment aggregates + customer balances. All shared with godown pickup. CORRECT.

`tallyExportService` ([:1-80](packages/api/src/services/tallyExportService.ts)): emits Sales vouchers per Invoice, Receipt per PaymentTransaction. Godown invoices participate identically. CORRECT.

**Reports needing an explicit `isGodownPickup` filter**: NONE for correctness. `inventoryMovement` is wrong but the fix is upstream (write the dispatch event). Optional: add a column to Sales Summary to break out godown vs delivery counts — UX, not correctness.

---

### Task 7 — Distributor dashboard KPIs

`analyticsService.getDashboardStats` ([:10-89](packages/api/src/services/analyticsService.ts)) returns:

| KPI | Source | Date field | Filter | Godown-pickup behaviour | Correct? |
|---|---|---|---|---|---|
| `ordersToday` | `order.count` | `orderDate` | `distributorId AND deletedAt=null` | godown orders counted | YES |
| `deliveredToday` | `order.count` | `deliveredAt` | `status IN ('delivered','modified_delivered')` | godown orders counted on confirmDelivery | YES |
| `revenueToday` | `order.aggregate _sum totalAmount` | `deliveredAt` | same | godown revenue counted | YES |
| `pendingDispatch` | `order.count` | n/a | `status IN ('pending_driver_assignment','pending_dispatch')` | **godown orders are in `pending_delivery` — EXCLUDED, correct** | YES |
| `inFlight` | `order.count` | n/a | `status='pending_delivery'` | **GODOWN ORDERS LEAK IN.** A godown order sits in `pending_delivery` until customer pickup. Under current code it's indistinguishable from a truck-loaded delivery awaiting drop-off, inflating the "In Flight" KPI. | **NO** |
| `overdueInvoices` | `invoice.count` | n/a | `status='overdue'` | godown invoices participate | YES |
| `totalOutstanding` | `invoice.aggregate _sum outstandingAmount` | n/a | `outstandingAmount > 0` | godown invoices participate | YES |
| `inventoryAlerts` | `checkThresholds(distributorId).length` | n/a | reads `InventorySummary.closingFulls` | **WRONG under DISPATCH_DEBIT=ON.** Thresholds silent on godown pickup until manual adjust. Fix is upstream (write dispatch event). | NO under ON |
| `pendingActions` | `pendingAction.count` | n/a | `status IN ('open','in_progress')` | godown irrelevant | YES |
| `totalCustomers` | `customer.count` | n/a | base | irrelevant | YES |

**KPI labels that conflate dispatch vs delivery**:
- `inFlight` — the label currently means "dispatched, awaiting delivery". Under godown-pickup, a more accurate split is needed:
  - "On vehicle (in flight)" = `status='pending_delivery' AND vehicleId IS NOT NULL`
  - "Godown awaiting pickup" = `status='pending_delivery' AND isGodownPickup=true`
  Either fix needs `isGodownPickup` filter at analyticsService.ts:48-52.
- `pendingDispatch` — naturally excludes godown (godown is pre-set to `pending_delivery`); no change needed.
- "Cylinders dispatched today" — NOT currently a KPI in `getDashboardStats`. If added later, must filter by inventory `dispatchedQty` event source — godown won't appear (correctly, because no truck dispatch happened).
- "Cylinders delivered today" — NOT currently a dashboard KPI; if added, godown should be included (uses `delivery` event source which IS written).

---

### Gap Table

| Area | Standard delivery writes | Godown pickup writes | Gap | Fix needed? |
|---|---|---|---|---|
| `Order` row | driverId, vehicleId, tripNumber stamped at preflight | driverId=null, vehicleId=null, tripNumber=null, status='pending_delivery' from creation | None — by design (Option A) | Service branch on `isGodownPickup` at createOrder |
| `DriverAssignment` row | INSERTed when assigning driver | none | None — naturally skipped by `if (driverId)` guard | Defence-in-depth filter optional |
| `DriverVehicleAssignment` (DVA) | Trip lifecycle on the row | not touched | None | none |
| `InventoryEvent` 'dispatch' | Written at preflight per item under DISPATCH_DEBIT=ON | **NOT written** | **CRITICAL leak** — closingFulls never debited | YES — write dispatch event from confirmDelivery when isGodownPickup AND DISPATCH_DEBIT=ON |
| `InventoryEvent` 'delivery' | Written at confirmDelivery per item | Written identically | None | none |
| `InventoryEvent` 'collection' | Written at confirmDelivery per item | Written identically | None | none |
| `CustomerInventoryBalance.withCustomerQty` | Incremented at confirmDelivery | Incremented identically | None | none |
| `Invoice` row | Created at preflight OR confirmDelivery | Created at confirmDelivery (post-delivery path) | None | none (B2B post-delivery IRN trigger handles GST) |
| `Invoice.irn/ewb*` fields | Set at preflight | irn set by post-delivery `processInvoiceGst`; ewb stays not_required | None | Gate EWB generation to skip when isGodownPickup |
| `GstDocument` row | upsert at IRN/EWB persist | upsert via processInvoiceGst on IRN only | None | none |
| `GstApiLog` | IRN + EWB + consolidated EWB | IRN only (B2B); none (B2C) | None | none |
| `CancelledStockEvent` | Written by reconciliation OR partial delivery on order with vehicleId | Partial delivery path could write with status='pending_return' (vehicleId=null) | Minor: status='pending_return' will never roll to 'returned_to_depot' automatically | Minor: confirmDelivery's CSE creation at orderService.ts:1006-1017 must skip CSE entirely when isGodownPickup (no truck = no on-vehicle stock); or keep with status='returned_to_depot' direct |
| `CustomerLedgerEntry` invoice_entry | Created with invoice | Same | None | none |
| `OrderStatusLog` | Multiple steps (new → pending_dispatch → preflight_in_progress → pending_delivery → delivered) | new → pending_delivery → delivered (two log rows) | None — fewer rows is fine | none |
| `Vehicle.status` lifecycle | idle → dispatched → returned → idle | not touched | None | none |
| Reconciliation aggregates (`confirmVehicleReconciliation`, `aggregateActiveTripCollections`) | godown excluded by vehicleId=null filter | godown not present | None | optional explicit filter for clarity |
| `InventorySummary.dispatchedQty` (UI: Inventory Movement report, mobile inventory tab, thresholds) | Reflects truck dispatch | **Not reflected** | Same as 'dispatch' event gap | YES — fix upstream |
| `InventorySummary.deliveredQty` | Reflects deliveries | Reflects godown identically | None | none |
| Dashboard `inFlight` KPI | Counts trucks in transit | **Counts godown awaiting pickup too** | Misleading | YES — analyticsService.ts:48 filter `isGodownPickup: false` OR split into 2 KPIs |
| Dashboard `inventoryAlerts` | Threshold count from closingFulls | Stale until manual adjust (upstream gap) | Same as dispatch event gap | YES — fix upstream |
| `Sales Summary` report | godown included | godown included | None | none |
| `Delivery Performance` report | godown excluded (`driverId: not null`) | godown excluded | None | none (correct) |
| `Inventory Movement` report | Truck dispatch shown | Godown not shown in Dispatched column (under ON) | Same as upstream gap | fixed by upstream fix |
| Vehicle Ledger report | per-vehicle | godown rows have vehicleId=null → land in '—' bucket | None | optional pseudo-vehicle "Godown direct" line (UX, not correctness) |
| Tally export | invoices + payments | godown invoices + payments participate | None | none |
| SSE `notifyDriver` | `order_assigned`, `order_updated`, `trip_updated` events | NONE (driverId=null) | By design — no driver app to notify | none (v1.1 push-notifications WI to add customer SSE for godown completion) |
| Customer overdue gate | applies | applies | None | none |
| INSUFFICIENT_STOCK gate | Runs at preflight | **NEVER RUNS** — confirmDelivery has no equivalent | Stock can go negative on godown pickup | YES — add gate inside confirmDelivery when isGodownPickup=true (existing investigation Gotcha #2) |
