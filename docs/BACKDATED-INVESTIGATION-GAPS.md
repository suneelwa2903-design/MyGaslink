# Brief 3 (Backdated Order) — Live testing investigation

_Run 2026-06-25 against live dev DB after Suneel created two backdated
orders on dist-002 / Sharma Gas Distributors._

---

## PART 1 — Live DB state for the two test orders

### Order #1 — `OBK-MQSZ70MOYNP` (the user-reported failure case)

Issue date: **2026-06-18**.

```
id                = 2126983c-4ebb-441e-a320-23fed37f4dec
order_number      = OBK-MQSZ70MOYNP            ← random-suffix legacy fallback (GAP 1)
distributor_id    = dist-002
customer_id       = 582c85b8…  (Maruthi Agencies, B2B)
driver_id         = 23f33fbf…  (Kiran Reddy)
vehicle_id        = 03a8bfab…  (KA01-MN-9999)
order_date        = 2026-06-18T00:00:00Z       ← backdated ✓
delivery_date     = 2026-06-18T00:00:00Z       ← backdated ✓
delivered_at      = 2026-06-18T00:00:00Z       ← backdated ✓
status            = delivered
is_godown_pickup  = false
is_backdated      = true                       ← Brief 3 flag set ✓
po_number         = "Test12345"                ← Brief 1 field ✓
total_amount      = 1800
created_at        = 2026-06-25T04:01:57.745Z   ← audit "entered on" ✓
```

### Invoice for order #1

```
id                = e555fc2e-8ff3-41f9-9add-2a130a58d197
invoice_number    = ISHD2627026208             ← structured FY-correct ✓ (issue path)
issue_date        = 2026-06-18T00:00:00Z       ← backdated ✓
due_date          = 2026-07-18T00:00:00Z       ← issueDate+30 ✓
total_amount      = 1800
amount_paid       = 0                          ← NO payment (GAP 2)
outstanding_amount= 1800
status            = issued
irn_status        = success                    ← (eventually, after manual retry)
ewb_status        = active                     ← (after manual retry)
irn               = 1bbc5c3…
ack_no            = 112610253448450
ack_date          = 2026-06-25T04:11:00Z       ← live at NIC ✓
po_number         = "Test12345"                ← Brief 1 snapshot ✓
created_at        = 2026-06-25T04:01:57.782Z
```

### gst_api_logs for invoice #1 — **the smoking gun for GAP 3**

```
apiType                  httpStatus  errorCode  errorMessage     created_at              latency
─────────────────────────────────────────────────────────────────────────────────────────────────
IRN_GENERATE             NULL        NULL       "fetch failed"   04:01:58.127 (auto)     286ms
IRN_GENERATE             200         NULL       NULL             04:11:19.583 (manual)   303ms
EWB_GENERATE_BY_IRN      200         NULL       NULL             04:11:20.254 (manual)   644ms
```

**IRN auto-fire DID run** — 0.4s after the commit. It hit a transient
`"fetch failed"` (no httpStatus, no NIC error code — outbound network
hiccup or DNS blip to `apisandbox.whitebooks.in`). Suneel then clicked
Regenerate at 04:11:19, IRN succeeded, EWB chained in 671ms after.

### Order #2 — `OBK-MQSZIF0R7XH` (same session, control)

Issue date: 2026-06-23. Same customer/driver/vehicle as #1.

```
order_number      = OBK-MQSZIF0R7XH            ← same legacy fallback (GAP 1)
po_number         = NULL
total_amount      = 1800
created_at        = 2026-06-25T04:10:49Z
```

Invoice `ISHD2627026209`:

```
irn_status = success                ← AUTO-FIRED, no manual click
ewb_status = active                 ← AUTO-FIRED via EWB_GENERATE_BY_IRN
irn        = 601a1e3…
ack_no     = 112610253448441
```

gst_api_logs:

```
IRN_GENERATE         200  04:10:50.623  (auto, latency 1.something)
EWB_GENERATE_BY_IRN  200  04:10:51.172  (auto)
```

**Order #2 proves the auto-fire pipeline works end-to-end** when
WhiteBooks is reachable. The "needed manual click" problem is purely
the first call's transient network failure — not a code bug.

### Payments / allocations — empty

```
payment_transactions for Maruthi:                 [] (none in last 4h)
payment_transactions on dist-002 last 4h:         []
payment_allocations for invoice e555fc2e:         []
payment_allocations on dist-002 last 4h:          []
```

**Zero rows.** The user reports they entered a payment in the modal,
but it never reached the DB. The order WAS created — so payment was
silently dropped before reaching `createPaymentInTx`.

### Inventory events — empty (as designed)

```
inventory_events for OBK-MQSZ70MOYNP:  []
inventory_events for OBK-MQSZIF0R7XH:  []
```

**Brief 3 design — no auto inventory writes.** ✓

---

## PART 2 — Three GAPS identified

### GAP 1 — Order number uses random fallback instead of `allocateNumber`

**Root cause:** [packages/api/src/services/backdatedOrderService.ts:99](../packages/api/src/services/backdatedOrderService.ts#L99)

```ts
// Inside the $transaction:
orderNumber: `OBK-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase(),
```

This was a typo — I wrote a one-shot random fallback instead of calling the
structured allocator the rest of the system uses.

**The canonical pattern** lives in [orderService.ts:278-280](../packages/api/src/services/orderService.ts#L278):

```ts
const orderNumber = distributor?.docCode
  ? await allocateNumber(tx, distributorId, 'O', deliveryDate, distributor.docCode)
  : legacyOrderNumber('ORD');
```

For dist-002 (`docCode='SHD'`), the resulting format is `OSHD<FY><6-digit-seq>` — e.g. `OSHD2627000748`. Same `'O'` allocator counter as a normal order — the FY is derived from the **issueDate** so a backdated order in June lands in FY 2627 (Apr 2026 – Mar 2027) regardless of when it was entered.

### GAP 2 — Payment dropped by Zod schema-strip in the web form

**Root cause:** [packages/web/src/pages/OrdersPage.tsx:902](../packages/web/src/pages/OrdersPage.tsx#L902)

```ts
const onSubmit = handleSubmit((data) => {
  const payload: BackdatedOrderInput = {
    ...
    payment: data.recordPayment && data.payment?.amount ? data.payment : undefined,
    //       ^^^^^^^^^^^^^^^^^^^^
    //       always undefined — see below
  };
  mutation.mutate(payload);
});
```

`recordPayment` is a UI-only toggle. It's registered in the form
(`{...register('recordPayment')}`) but NOT in `backdatedOrderSchema`.

The form uses `zodResolver(backdatedOrderSchema)`. `zodResolver` runs
the schema's `.parse(...)` before invoking the submit handler — and
Zod's default behaviour is to **strip unknown keys**. So
`data.recordPayment` is always `undefined` in `handleSubmit`, regardless
of whether the checkbox is checked.

`undefined && anything === undefined && anything === undefined` → the
ternary always resolves to `undefined`. The backend never sees a
`payment` field; `createPaymentInTx` is never called.

**Server-side and Zod schema are blameless** — the payment block in
[backdatedOrderService.ts](../packages/api/src/services/backdatedOrderService.ts)
runs correctly when `data.payment` is provided. The verification test
`records payment in same transaction when payment provided` proves
this end-to-end. The bug is purely in the web payload construction.

### GAP 3 — IRN auto-fire DID work; first attempt hit a transient NIC outage

**Root cause:** **NOT a code bug.** [backdatedOrderService.ts:161-167](../packages/api/src/services/backdatedOrderService.ts#L161)
correctly imports + calls `processInvoiceGst` post-commit using the
exact same fire-and-forget pattern as
[orderService.ts:1203-1207](../packages/api/src/services/orderService.ts#L1203):

```ts
try {
  const { processInvoiceGst } = await import('./gst/gstService.js');
  processInvoiceGst(result.invoice.id, distributorId).catch((err) => {
    logger.warn('Backdated GST processing failed (non-blocking)', { ... });
  });
} catch { /* non-blocking */ }
```

Confirmed by Order #2 (`OBK-MQSZIF0R7XH`): IRN+EWB both fired automatically
and succeeded with no manual intervention. The Order #1 retry was needed
because WhiteBooks returned `"fetch failed"` on the very first call —
a network/DNS hiccup against `apisandbox.whitebooks.in`. The system
handled it correctly: it logged the failure to `gst_api_logs`,
created a Pending Action, and the operator clicked Regenerate to retry.

That said, while no fix is needed for the auto-fire pipeline, the
**user-facing UX gap is real**: when the first IRN attempt fails
transiently, the operator has to chase down the Pending Action manually.
Same problem exists for normal `confirmDelivery` and is not in this
brief's scope.

---

## PART 3 — Fixes

### FIX 1 — Order number

In [backdatedOrderService.ts](../packages/api/src/services/backdatedOrderService.ts):

1. Read `distributor.docCode` at the top of the function (already loaded
   in `createInvoiceFromOrder` but not yet at the outer service level).
2. Inside the `$transaction`, replace the random-fallback line with the
   canonical `allocateNumber(tx, distributorId, 'O', issueDate, docCode)`
   call — falling back to `legacyOrderNumber('ORD')` only when `docCode`
   is missing (mirrors `createOrder`).

### FIX 2 — Payment

In [OrdersPage.tsx](../packages/web/src/pages/OrdersPage.tsx):

Use the live form value via `watch('recordPayment')` (captured outside
the submit handler — `recordPayment` was already being watched for the
conditional render). The submit handler reads the local `recordPayment`
variable, not `data.recordPayment`.

### FIX 3 — IRN auto-fire

No code change. The retry-on-transient-failure UX gap is a separate
concern not in this brief's scope. Documented above.

---

## PART 5 — Inventory adjustment auto-entry investigation

### 5.1 — Existing Inventory page tabs

[packages/web/src/pages/InventoryPage.tsx](../packages/web/src/pages/InventoryPage.tsx)
exposes these tabs (line ~283):

- `daily` — Daily Summary (closing balances per cylinder type)
- `depot` — Depot History (timeline)
- `onboarding` — Onboarding stock
- `forecast` — AI Demand Forecast
- `customer` — Customer Balances
- `reconciliation` — Vehicle Return

The "Adjust Stock" affordance is a button on the `daily` tab header
(line 309). It opens a modal that posts to `/api/inventory/manual-adjustment`.

### 5.2 — Existing adjustment API

Route: [POST /api/inventory/manual-adjustment](../packages/api/src/routes/inventory.ts#L131)
- Roles: `super_admin | distributor_admin | finance | inventory`
- Validator: `manualAdjustmentSchema`
- Service: `inventoryService.recordManualAdjustment`
- Writes: a single `InventoryEvent { eventType: 'manual_adjustment',
   fullsChange OR emptiesChange, eventDate }`
- Companion `GET /manual-adjustments` for the Adjustment History tab
  (line 151), supports CSV export.

So we already have:
- A flexible `manual_adjustment` event type that supports either bucket
- A history-list endpoint with pagination + CSV
- Service-side `recalculateSummariesFromDate` is invoked after each
  adjustment commit

### 5.3 — `recalculateSummariesFromDate` walkthrough

[inventoryService.ts:233](../packages/api/src/services/inventoryService.ts#L233):
- Finds all distinct `eventDate` values in `inventory_events`
  >= `fromDate` for that `(distributor, cylinder type)` pair
- Adds in any existing `inventory_summaries` rows >= `fromDate` whose
  `isLocked = false`
- Builds a sorted set of dates, then walks them rebuilding each day's
  opening = previous day's closing carry-forward

**Verdict:** writing a `dispatch` event for 2026-06-18 will:
1. recompute the 2026-06-18 summary correctly (closingFulls −= qty)
2. cascade forward through 2026-06-19, …, 2026-06-25 — each day's
   opening picks up the prior day's recalculated closing

**Constraint:** any day where `isLocked = true` is excluded from the
existing-summary set. If the operator already pressed **Lock Day** on
the backdated date (or any day between then and now), the carry-forward
chain BREAKS at that day. The Inventory page already exposes a Lock Day
button on `daily` (visible in line 309 area). The implementation MUST
either:
  a) refuse to apply adjustments where any day in the range is locked, or
  b) unlock automatically (heavy-handed — needs a separate UX prompt)

I recommend (a) with a clear error and a link to unlock manually.

### 5.4 — Schema for "adjustment applied"

Two options:

**Option A** — new boolean on Order:
```prisma
inventoryAdjustedAt  DateTime?  @map("inventory_adjusted_at")
```
Pros: minimal schema; one query `WHERE is_backdated = true AND
inventory_adjusted_at IS NULL` lists pending entries; double-adjustment
is a single nullable-timestamp check.
Cons: doesn't capture WHO adjusted, or whether multiple partial
adjustments happened.

**Option B** — new table `BackdatedInventoryAdjustment`:
```
order_id, distributor_id, applied_at, applied_by_user_id,
events_written_count, notes
```
Pros: full audit trail, supports the future case where a manager wants
to retract/redo, captures the entered-by user.
Cons: more surface to maintain; over-engineered for a flag.

**Recommendation:** Option A + an audit row written via the existing
`order_status_log` table (`oldStatus='delivered'`,
`newStatus='delivered'`, `notes='Inventory adjustment applied by <userId>'`).
That gives us the timestamp + the user without a new table. Standard
multi-tenant rules apply: every read/write must scope on
`distributorId` (anti-pattern #1).

### 5.5 — Impact surface

**Backend:**
- New endpoint `POST /api/orders/:id/apply-inventory-adjustment`
  (distributor_admin + inventory roles)
- Service `applyBackdatedInventoryAdjustment(distributorId, userId, orderId)`:
  1. Load order, assert `isBackdated=true`, `status='delivered'`,
     `inventoryAdjustedAt IS NULL`, and tenant scope
  2. For each item: write a `dispatch` event (fullsChange = −qty,
     referenceType='backdated_inventory_adjustment',
     eventDate = order.deliveryDate)
  3. If `emptiesCollected > 0` for the item: also write a
     `reconciliation_empties_return` event (emptiesChange = +collected,
     referenceType='backdated_inventory_adjustment', same eventDate)
     — mirrors the godown synthetic-event fix from Brief 2
  4. Flip `order.inventoryAdjustedAt = now()`
  5. Call `recalculateSummariesFromDate(distributorId, ctId, deliveryDate)`
     for each unique cylinder type
  6. All inside one `$transaction`

- New endpoint `GET /api/orders/backdated/pending-adjustments` returning
  the list to drive the new UI tab; same shape as the existing
  `mapOrders` output plus a flat `pendingItemsCount`.

**Frontend:**
- New tab on Inventory page: `Backdated Adjustments`
- Two sub-views: `Pending` (orders awaiting adjustment) and `History`
  (reuses the existing manual-adjustments list filtered by
  `referenceType='backdated_inventory_adjustment'`)
- Per-row "Apply Adjustment" button (confirmation modal — shows the
  exact events that will be written before commit)

**Gates needed:**
- 409 if `inventoryAdjustedAt IS NOT NULL` (double-apply attempt)
- 409 if any inventory summary between `deliveryDate` and today has
  `isLocked = true` — point operator at the Lock Day UI
- 400 if order is cancelled / `deletedAt IS NOT NULL`

### 5.6 — Edge cases

- **Double-adjustment:** the new `inventoryAdjustedAt` timestamp is the
  hard guard. Endpoint must check it before the transaction starts (and
  the unique-ish read inside the tx will also reject the second
  concurrent call because of the WHERE clause).
- **Zero empties collected:** the new endpoint should NOT write a
  `reconciliation_empties_return` event when `emptiesCollected = 0`
  (or null). Mirrors what godown confirmDelivery already does at
  [orderService.ts:1054](../packages/api/src/services/orderService.ts#L1054).
- **Order cancelled after inventory adjusted:** the cancel path must
  REVERSE the events. Simplest: when cancelling a backdated+adjusted
  order, write `manual_adjustment` events for `+fulls, −emptiesReturned`
  with `referenceType='backdated_inventory_reversal'` and re-call
  `recalculateSummariesFromDate`. Defer the implementation; the
  v1 implementation can simply block cancellation with a 409 and a
  "remove the adjustment first" workflow.
- **Backdated date is older than the most recent Lock Day:** as in 5.3
  — block with a clear error.

### 5.7 — Recommended scope split

Phase 1 (next implementation brief):
- `Order.inventoryAdjustedAt` migration + service + route
- Pending-adjustments query
- Backdated Adjustments tab on Inventory page (Pending sub-view + Apply)
- Locked-day guard
- 8 tests

Phase 2 (deferred):
- History sub-view filtered by `referenceType='backdated_inventory_adjustment'`
- Reverse-on-cancel workflow
- CSV export of pending adjustments

---

## Summary

| Gap | Real bug? | Fix scope |
|-----|-----------|-----------|
| 1 — Order number | YES (typo) | 2 lines in backdatedOrderService.ts |
| 2 — Payment dropped | YES (Zod-strip) | 1 line in web OrdersPage.tsx onSubmit |
| 3 — IRN auto-fire | NO (transient NIC outage) | none |

Comprehensive E2E verification script in `packages/api/scripts/verify-brief3.ts`
will be added as part of this commit and re-run after the fixes to
prove all green.
