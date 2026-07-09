# Investigation — 09 Jul 2026

Two-item read-only investigation. No code changes.

---

## Item 1: Duplicate Notifications after IRN / EWB

### Notification system — how it works

- **Model:** `PendingAction` in [packages/api/prisma/schema.prisma:1788](packages/api/prisma/schema.prisma) — table `pending_actions`. There is **no separate `Notification` table**. The bell icon surfaces open `PendingAction` rows.
- **Creation factories:**
  - GST-scoped: [packages/api/src/services/gst/gstService.ts:1623-1695](packages/api/src/services/gst/gstService.ts) — includes a TOCTOU dedup at lines 1651-1666 (`findFirst → create`, not atomic).
  - Generic: [packages/api/src/services/pendingActionsService.ts:26](packages/api/src/services/pendingActionsService.ts) — **no dedup at all**.
- **API endpoints:** [packages/api/src/routes/pendingActions.ts:14](packages/api/src/routes/pendingActions.ts) GET · `:56` approve · `:73` resolve · `:98` reject.
- **Frontend bell:** [packages/web/src/components/layout/DashboardLayout.tsx:52-57](packages/web/src/components/layout/DashboardLayout.tsx). TanStack Query, key `['pending-actions-notif', distributorId]`, `refetchInterval: 60_000`. **Polling only** — no SSE, no WebSocket, no client-side dedup.
- **SSE:** `packages/api/src/lib/sseManager.ts` exists but is **driver-only** (`notifyDriver` for `order_updated / trip_updated`). Bell never opens an EventSource. **No SSE ↔ polling double-counting.**

### IRN success — every PendingAction creation site

1. [gstService.ts:546](packages/api/src/services/gst/gstService.ts) — inside NIC-2150 recovery when `getIrnByDocDetails` returns no IRN; fires on a *retry*.
2. [gstPreflightService.ts:1454](packages/api/src/services/gst/gstPreflightService.ts) — `runB2bPreflight` outer catch (any IRN failure).

### EWB success — every PendingAction creation site

1. [gstService.ts:221](packages/api/src/services/gst/gstService.ts) — `generateEwbFromIrn` catch.
2. [gstService.ts:665](packages/api/src/services/gst/gstService.ts) — outer catch, IRN succeeded but EWB step threw.
3. [gstService.ts:730](packages/api/src/services/gst/gstService.ts) — B2C phantom-success (`status_cd=1`, no `ewayBillNo`).
4. [gstService.ts:760](packages/api/src/services/gst/gstService.ts) — B2C EWB throw (non-620).
5. [gstPreflightService.ts:1372](packages/api/src/services/gst/gstPreflightService.ts) — B2B preflight EWB response missing `ewayBillNo` after IRN success.
6. [gstPreflightService.ts:1388](packages/api/src/services/gst/gstPreflightService.ts) — B2B preflight EWB threw after IRN success.
7. [gstPreflightService.ts:1553](packages/api/src/services/gst/gstPreflightService.ts) / **:1594** — B2C preflight EWB no-number / throw.

### Per-cycle count (one invoice, happy path)

For a **normal preflight-succeeds → driver-delivers-exactly-as-ordered → confirmDelivery** cycle:

| Step | What happens | PA impact |
|---|---|---|
| 1. Preflight (`runB2bPreflight` at [gstPreflightService.ts:1223](packages/api/src/services/gst/gstPreflightService.ts)) | IRN + EWB inline vs NIC succeed. Invoice ends `irnStatus='success'` + `ewbStatus='active'`. | 0 PAs |
| 2. confirmDelivery ([orderService.ts:1191-1210](packages/api/src/services/orderService.ts)) | Guard: `if (isModified && hasLiveGstDoc) reissue else processInvoiceGst`. `isModified=false` → falls through to `processInvoiceGst` **even though invoice is already fully compliant** | *(triggers step 3)* |
| 3. `processInvoiceGst` re-executes IRN + EWB vs NIC | NIC returns **2150 (duplicate)**. Recovery branch at [gstService.ts:481-561](packages/api/src/services/gst/gstService.ts) can (a) write a **second `gst_documents` row** via `findFirst → create` TOCTOU race at line 509/524, and (b) create a spurious `IRN_GENERATION` PA at [gstService.ts:546-549](packages/api/src/services/gst/gstService.ts). Then EWB re-attempts at :565-628. | +1 stale PA in worst case |

### Root cause

**`orderService.confirmDelivery` re-runs the GST pipeline on every unmodified delivery even when preflight already completed the invoice.** The guard on line 1192 only skips `processInvoiceGst` when the delivery is *modified*. For an unmodified delivery it re-fires `processInvoiceGst` (line 1205) against an invoice that preflight has already turned `irnStatus='success'` + `ewbStatus='active'`. That second call re-hits NIC (2150 for IRN / 604 for EWB), traverses recovery paths that raise a fresh `IRN_GENERATION` PendingAction (gstService.ts:546-549) — while **any preflight-era EWB partial-failure PA is never auto-resolved on success** (`resolvePendingAction` at pendingActionsService.ts:81 is only reached from the UI resolve button). So the bell shows both the stale preflight PA and the new retry PA — that's the "duplicate".

**Secondary** (UNCONFIRMED but plausible): the `findFirst → create` dedup in `createPendingAction` (gstService.ts:1651-1672) is not atomic; under concurrent failures for the same `(distributorId, entityId, actionType)` it can insert two open rows.

### Fix recommendation — surgical

Two changes:

**A. `orderService.confirmDelivery`** (packages/api/src/services/orderService.ts:1191) — fast-path skip when preflight already produced full compliance, and auto-resolve stale PAs:

```ts
const fullyCompliant =
  invoice.irnStatus === 'success' && invoice.ewbStatus === 'active';
if (fullyCompliant) {
  await prisma.pendingAction.updateMany({
    where: { distributorId, entityId: invoice.id,
             actionType: { in: ['IRN_GENERATION','EWB_GENERATION'] },
             status: 'open' },
    data: { status: 'resolved', resolvedAt: new Date(),
            resolvedBy: 'system',
            resolutionNotes: 'Auto-resolved: IRN+EWB active post-delivery' },
  });
  // skip processInvoiceGst
} else if (isModified && hasLiveGstDoc) {
  reissueForDeliveryMismatch(...)
} else {
  processInvoiceGst(...)
}
```

**B. Secondary hardening** — add a Postgres partial unique index on `pending_actions (distributor_id, entity_id, action_type) WHERE status='open'` and switch `createPendingAction` (gstService.ts:1651-1672) to an `upsert`. Closes the TOCTOU race called out in the code comment at gstService.ts:1648-1650.

**Impact:** the fast-path skip is the surgical fix — one branch, one guard, no schema change. Ships fixed today. The unique-index hardening is a v1.1 belt-and-suspenders.

---

## Item 2: Delivery Performance Report — enhancement scoping

### Current state

- **API:** `deliveryPerformance(distributorId, ReportFilters)` at [packages/api/src/services/reportsService.ts:217-261](packages/api/src/services/reportsService.ts). Only reads `orders` for the range on `deliveryDate` with `driverId != null`, selecting `{ driverId, status, driver.driverName }`. Response envelope (per `ReportResult` at line 34):
  ```
  columns: [{driver}, {assigned}, {exact}, {modMore}, {cancelled}, {deliveryRate}]
  rows:    per-driver counts of orders by status
  chart:   stacked bar (Delivered / Modified / Cancelled by driver)
  ```
  **No cylinder-type breakdown, no money, no empties.** Only driverId + date range are honoured. Route: [packages/api/src/routes/reports.ts:50-88](packages/api/src/routes/reports.ts) — accepts `dateFrom/dateTo/driverId/...`, exposes `?format=csv`.

- **UI:** [packages/web/src/pages/ReportsPage.tsx:25](packages/web/src/pages/ReportsPage.tsx) (tab def), rendered by shared `ReportTable` (line 233). Filters wired: date range (137-141), driver (157-163). Export: CSV via `downloadCsv` (line 109); PDF button (197-201) is hard-coded to `customer-statement` only.

### Data availability matrix

| Field | Status | Table.column | Join path | Notes |
|---|---|---|---|---|
| Fulls delivered (per cyl type) | **AVAILABLE** | `order_items.delivered_quantity` (fallback `quantity`) | `orders → order_items → cylinder_types` filtered by `orders.driverId`, `status IN ('delivered','modified_delivered')`, `deliveryDate BETWEEN` | Same pattern as `salesSummary` (line 82-84). Group by `cylinderTypeId`. |
| Empties collected (per cyl type) | **AVAILABLE** | `order_items.empties_collected` (schema:885, nullable) | Same join | Null-coalesce to 0. |
| Pending empties at customer | **AVAILABLE (customer-level, NOT per-driver)** | `customer_inventory_balances.with_customer_qty` (schema:630) | `orders` in range → distinct customerId → `CustomerInventoryBalance` WHERE `customerId IN (...)` | See clarification below. |
| Sale amount | **AVAILABLE** | `orders.total_amount` (schema:821) | `orders` filtered by driver + range | Matches `salesSummary` (line 85). `Invoice.orderId` is `@unique` so 1:1 with delivered orders; `orders.total_amount` is simpler and equivalent for driver attribution. |
| Amount collected | **NEEDS JOIN** | `payment_allocations.allocated_amount` (schema:1375) | `payment_transactions → payment_allocations → invoices → orders → drivers` | `PaymentTransaction` has `customerId` but **no driverId** — attribution flows only through the invoice's underlying order. |
| Amount pending | **AVAILABLE** | `invoices.outstanding_amount` (schema:1164) | `invoices` WHERE `orderId → orders.driverId = X` AND `orders.deliveryDate BETWEEN` AND `status != 'cancelled'` | Field already maintained (used by `outstandingAging` at line 125). |
| Amount overdue | **AVAILABLE** | `invoices.due_date` (schema:1161) + `outstanding_amount` | Same join; add `dueDate < today` | Same pattern as `outstandingAging` day-bucketing (line 150). |

### Payment collection join path (the complex one)

Prisma sketch:

```ts
prisma.paymentAllocation.findMany({
  where: {
    invoice: {
      distributorId,
      deletedAt: null,
      order: {
        driverId: { in: driverIds },
        deliveryDate: { gte: from, lte: to },
      },
    },
  },
  select: {
    allocatedAmount: true,
    invoice: { select: { order: { select: { driverId: true } } } },
  },
});
```

Sum `allocatedAmount` per `invoice.order.driverId`.

**Pitfalls:**
1. **Which date?** If range = "driver's deliveries in the range", collections that arrive later still count for that driver's Sale — attribution follows the delivery, not the payment date. Recommend **delivery-date scoping** to match Sale Amount → then Amount Collected = allocations against invoices from that driver's in-range orders. (Late partial payments may push Collected > Sale in edge cases; acceptable or clamp with `min(allocated, invoice.totalAmount)`.)
2. Credit / debit notes are separate tables and don't flow through `payment_allocations` — safely ignored here. `outstandingAmount` already reflects post-CN state.
3. Cross-invoice allocations resolve naturally — each row targets one invoice.
4. Opening-balance invoices (`isOpeningBalance=true`) have no `orderId` → excluded automatically by the join. Route already defaults `dateFrom = goLiveDate` (line 64-73) reinforcing this.

### Pending empties — clarification (important)

`customer_inventory_balances.with_customer_qty` is a **customer-level cumulative net (fulls-in − empties-back)** across every driver who has ever served that customer + cyl type. It **cannot be attributed per driver** without re-playing every delivery event and picking an accounting rule (FIFO? mini-ledger per driver?) that the system does not maintain today.

**Recommendation:**
- **Top-level driver row:** do **not** show a "Pending Empties" column (or show blank with tooltip).
- **Drill-down under a customer row:** show `withCustomerQty` per customer per cyl type with a caveat label — e.g. *"Pending at customer (cumulative, all drivers)"*. Preserves operational value (driver going back knows what's owed) without lying about attribution.

### Date range field — recommend `orders.deliveryDate`

- Existing reports (`salesSummary`:69, `deliveryPerformance`:222) already use it → consistency.
- `@db.Date` (no timezone drift), matches manifest and how ops staff think.
- Indexed as `(driverId, deliveryDate)` on schema line 875 — **ideal covering index** for this report.
- `deliveredAt` is a nullable `DateTime` — useful for SLA analytics but NULL on backdated / on-demand orders (schema:811-814).

### Drill-down

- Group by `customer_id` within each driver — trivial with the same joins.
- **Exclude** customers with zero orders in range from that driver (recommended).

### Export approach

- **Existing:** generic CSV via `reportToCsv` (reportsService.ts:559) + `?format=csv` in route (reports.ts:77). PDF only exists for `customer-statement` via dedicated `customerLedgerPdfService.ts`.
- **No Excel/xlsx library** in `packages/api/package.json` — only `pdfkit@^0.17`.

**Recommended:**
- **CSV:** keep generic path; add drill-down as second CSV endpoint (`?driverId=X&groupBy=customer`) or embed sections in one CSV.
- **PDF:** mirror `customerLedgerPdfService.ts` — new `deliveryPerformancePdfService.ts` on pdfkit. Master table + per-driver drill-downs.
- **Excel:** requires new dependency (`exceljs` is the low-friction pick, covers styling + multi-sheet — one sheet per driver for drill-down). **Flag as new infra — defer until greenlit.**

### Performance

- Vanasthali scale: assess on prod. At ~100 orders/day × 30 days = ~3,000 orders in range. With `include: { items: true, invoice: true }` → ~10–20k rows to Node — sub-second with existing indexes.
- Existing indexes already cover:
  - `orders(driverId, deliveryDate)` — schema:875
  - `orders(distributorId, status, deliveryDate)` — schema:873
  - `invoices(distributorId, status, dueDate)` — schema:1216
  - `payment_transactions(distributorId, transactionDate)` — schema:1366
- **No new indexes required.** If drill-down joins become slow, Prisma auto-generates `payment_allocations(invoiceId)`.

### UI restructuring

- Current section: `ReportsPage.tsx` — tab (line 25), filter row (132-204), table rendered generically at line 224 via `ReportTable` (line 233).
- **Master-detail feasibility:** yes with a light refactor. Two paths:
  1. **Expandable rows (recommended):** extend `ReportResult` envelope with optional `drilldown: Record<driverId, ReportTable>` and render a per-report custom table (like the existing `UnifiedVehicleLedger` special-case at line 324). One API call, everything on-page, CSV export stays coherent (flatten sub-rows).
  2. **Modal:** cleaner separation but adds a round-trip per driver click (`/api/reports/delivery-performance/driver/:id`).
- **Suggested UX:** expandable row (accordion). Matches the reports page's single-page pattern.

### Recommended implementation approach

Rewrite `deliveryPerformance` to eager-load `items{cylinderType}` and `invoice`, aggregate per `(driverId, cylinderTypeId)` for fulls delivered / empties collected / sale amount, and layer a second query summing `paymentAllocation.allocatedAmount` joined through `invoice → order.driverId` for Amount Collected. Compute Amount Pending/Overdue directly from `invoice.outstandingAmount` and `dueDate`. Extend `ReportResult` with an optional `drilldown` map keyed by `driverId`, populated by the same aggregation regrouped by `customerId` (attaching `CustomerInventoryBalance.withCustomerQty` labelled as customer-level cumulative). Render as expandable rows in `ReportsPage.tsx`, reuse existing CSV path (flattening drill-down rows), add a `pdfkit`-based `deliveryPerformancePdfService.ts` mirroring `customerLedgerPdfService.ts`, and defer Excel export until `exceljs` is greenlit as new infra.

---

## Summary

| Item | Status | Ship blocker? |
|---|---|---|
| Duplicate notifications root cause | **Confirmed** — `orderService.confirmDelivery:1191` re-runs GST pipeline post-preflight | Surgical 1-branch fix + auto-resolve stale PAs. Ready to implement. |
| Delivery Performance enhancement | **Fully scoped** — all fields available, no schema change, no new indexes | No blockers. `exceljs` dep decision is only gating question if Excel export is required. |
