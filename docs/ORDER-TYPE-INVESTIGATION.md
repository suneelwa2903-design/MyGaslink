# Order-Type / Proof-of-Delivery Feasibility Report

**Status:** READ-ONLY investigation. No code or DB changes made.
**Scope confirmation:** monorepo layout is `packages/api`, `packages/web`, `packages/mobile`, `packages/shared` (not `apps/*`). All paths below use the real layout.
**Baseline:** `main @ a54d6c8`.
**Relationship to prior doc:** [docs/FEATURE-INVESTIGATION.md](FEATURE-INVESTIGATION.md) Feature B assumed OTP goes to the customer's phone via the customer app. This investigation tests that assumption against the actual order-type model and finds it does **not** hold for the majority of orders — see §7.

---

## 1. Order type model

### Full `Order` model, verbatim ([packages/api/prisma/schema.prisma:816](../packages/api/prisma/schema.prisma:816))

```prisma
model Order {
  id                    String      @id @default(uuid()) @map("order_id")
  orderNumber           String      @unique @map("order_number")
  distributorId         String      @map("distributor_id")
  customerId            String      @map("customer_id")
  driverId              String?     @map("driver_id")
  vehicleId             String?     @map("vehicle_id")
  orderDate             DateTime    @map("order_date") @db.Date
  deliveryDate          DateTime    @map("delivery_date") @db.Date
  status                OrderStatus @default(pending_driver_assignment)
  orderType             OrderType   @default(delivery) @map("order_type")
  // FLOAT-001 (2026-06-17): tagged by the driver mobile walk-in path. Reconciliation
  // sums delivered walk-ins as "sold from float" — depot debit happens at preflight
  // for ordered + manifest-float; whatever float remained at reconcile is credited
  // back via `cancellation_return` events. Default `regular` covers every legacy row.
  orderSource           OrderSource @default(regular) @map("order_source")
  // Customer collects cylinders directly from the godown (no vehicle
  // dispatch, no driver, no EWB). Default false preserves the existing
  // delivery-flow semantics for every legacy row. When true:
  //   - createOrder skips driver assignment and goes straight to pending_delivery
  //   - preflightDispatch + assign-driver are blocked
  //   - processInvoiceGst emits IRN for B2B but SKIPS EWB
  //   - confirmDelivery writes a synthetic dispatch inventory event so
  //     closingFulls debits correctly under INVENTORY_DISPATCH_DEBIT=true
  //   - dashboard inFlight KPI excludes godown rows
  isGodownPickup        Boolean     @default(false) @map("is_godown_pickup")
  // Brief 3: distributor admin enters a delivery that already happened
  // (paper trail / on-demand invoicing). Order lands in `delivered` immediately;
  // orderDate/deliveryDate/deliveredAt are backdated to the entered date while
  // createdAt stays "now" (audit trail). No inventory events, no
  // CustomerInventoryBalance update — by design.
  isBackdated           Boolean     @default(false) @map("is_backdated")
  inventoryAdjustedAt   DateTime?   @map("inventory_adjusted_at")
  totalAmount           Decimal     @default(0) @map("total_amount") @db.Decimal(18, 4)
  poNumber              String?     @map("po_number")
  specialInstructions   String?     @map("special_instructions")
  deliveryLatitude      Float?      @map("delivery_latitude")
  deliveryLongitude     Float?      @map("delivery_longitude")
  deliveryNotes         String?     @map("delivery_notes")
  deliveredAt           DateTime?   @map("delivered_at")
  cancelledAt           DateTime?   @map("cancelled_at")
  cancellationReason    String?     @map("cancellation_reason")
  customerConfirmed     Boolean?    @map("customer_confirmed")
  customerConfirmedAt   DateTime?   @map("customer_confirmed_at")
  customerDisputeReason String?     @map("customer_dispute_reason")
  disputeRaisedAt       DateTime?   @map("dispute_raised_at")
  disputeResolvedAt     DateTime?   @map("dispute_resolved_at")
  disputeResolutionNote String?     @map("dispute_resolution_note")
  disputeReopenedAt     DateTime?   @map("dispute_reopened_at")
  disputeReopenReason   String?     @map("dispute_reopen_reason")
  tripNumber            Int?        @map("trip_number")
  createdAt             DateTime    @default(now()) @map("created_at")
  updatedAt             DateTime    @updatedAt @map("updated_at")
  deletedAt             DateTime?   @map("deleted_at")

  // Relations
  distributor           Distributor           @relation(fields: [distributorId], references: [id])
  customer              Customer              @relation(fields: [customerId], references: [id])
  driver                Driver?               @relation(fields: [driverId], references: [id])
  vehicle               Vehicle?              @relation(fields: [vehicleId], references: [id])
  items                 OrderItem[]
  invoice               Invoice?
  statusLogs            OrderStatusLog[]
  driverAssignments     DriverAssignment[]
  cancelledStockEvents  CancelledStockEvent[]
  cancelledStockEventId String?               @unique @map("cancelled_stock_event_id")
  cancelledStockEvent   CancelledStockEvent?  @relation("TaggedOrder", fields: [cancelledStockEventId], references: [id])
  gstDocuments          GstDocument[]
  paymentCommitments    PaymentCommitment[]

  @@index([distributorId, status, deliveryDate])
  @@index([distributorId, customerId, createdAt(sort: Desc)])
  @@index([driverId, deliveryDate])
  @@map("orders")
}
```

**Crucially: there is NO `createdBy` field on `Order`.** Provenance is only inferable from `orderSource` (regular/walk_in) + `isGodownPickup` + `isBackdated`; there is no column recording "customer self-service vs. staff-on-behalf-of" for regular orders. `OrderStatusLog.changedBy` (schema.prisma:935) records who *changed status*, not who created the order.

### Distinguishing enums ([schema.prisma:55](../packages/api/prisma/schema.prisma:55))

```prisma
enum OrderStatus {
  pending_driver_assignment
  pending_dispatch
  preflight_in_progress
  pending_delivery
  delivered
  modified_delivered
  cancelled
  returns_only
}

enum OrderType {
  delivery
  returns_only @map("returns_only")
}

enum OrderSource {
  regular
  walk_in @map("walk_in")
}
```

**There is NO dedicated `on_demand` enum/field.** `"on_demand"` exists only as a pseudo-status filter label in the admin Orders UI — under the hood it maps to `isBackdated = true` ([orderService.ts:53-58](../packages/api/src/services/orderService.ts:53)):
```ts
if (filters.status === 'godown_pickup') {
  where.isGodownPickup = true;
} else if (filters.status === 'on_demand') {
  where.isBackdated = true;
} else if (filters.status) {
  where.status = filters.status as $Enums.OrderStatus;
}
```

### Where `isGodownPickup` is SET

- [orderService.ts:248](../packages/api/src/services/orderService.ts:248) — `const isGodownPickup = data.isGodownPickup ?? false;` inside `createOrder`, sourced from request body.
- Request body field accepted **only** on the staff create-order route (`POST /api/orders`, [routes/orders.ts:305-320](../packages/api/src/routes/orders.ts:305), roles `super_admin|distributor_admin|finance|inventory|customer`) via `createOrderSchema`. **NOT in the customer-portal create schema** ([routes/customerPortal.ts:95-110](../packages/api/src/routes/customerPortal.ts:95) — no `isGodownPickup` field defined). A customer can never self-select godown pickup.
- UI toggles: [OrdersPage.tsx:589,593,658](../packages/web/src/pages/OrdersPage.tsx:589) (web RHF checkbox), [(admin)/orders.tsx:1099,1175,1376-1389](../packages/mobile/app/(admin)/orders.tsx:1099) (mobile local `useState`).

### Where `isGodownPickup` is CHECKED

Enumerated in full in §4.

### Walk-in / on-the-go sale vs pre-order — current model

A "walk-in" order (`orderSource='walk_in'`) is created **exclusively by the driver mobile app**, via a dedicated endpoint, and is tied to an **existing** customer record in the tenant (selected from a searchable picker, `GET /customers?search=...`) — **not** a newly-created anonymous walk-up customer:

- Route: `POST /api/drivers/me/orders` ([driversVehicles.ts:867-980](../packages/api/src/routes/driversVehicles.ts:867)), `requireRole('driver')`.
- Preconditions enforced: driver must have an active DVA in `loaded_and_dispatched` today (:894-901), the picked customer must belong to the driver's tenant (:904-910), and requested qty must not exceed `availableFulls` on the vehicle (:912-935, hard block, no bypass).
- Order creation: `createOrder(..., { walkIn: { driverId, vehicleId } })` (:937-948) → in [orderService.ts:259-267](../packages/api/src/services/orderService.ts:259), `driverId`/`vehicleId` are pinned directly from the active DVA (bypassing `customer.preferredDriverId`), status starts at `pending_dispatch`, `orderSource: options?.walkIn ? 'walk_in' : 'regular'` (:303).
- Immediate mid-trip preflight fired synchronously (`preflightAddToTrip`, :952-976) so GST docs are minted before the driver leaves the doorstep.
- Driver can self-cancel their own walk-in (only, and only while `pending_dispatch`/`pending_delivery`) via `DELETE /api/drivers/me/orders/:id` ([driversVehicles.ts:999-1040](../packages/api/src/routes/driversVehicles.ts:999)), gated by three explicit checks: `order.driverId === driver.id`, `order.orderSource === 'walk_in'`, status in `['pending_dispatch','pending_delivery']`.
- Mobile UI: `WalkInOrderModal` in [(driver)/orders.tsx:653-780](../packages/mobile/app/(driver)/orders.tsx:653) — FAB opens modal (:591-618), a **customer picker + single cylinder-type + quantity form**, nothing more. `handleCancelWalkIn` at :138-150 renders the cancel affordance conditionally on `order.orderSource === 'walk_in'` (:333).

A **pre-order** (regular or distributor-created-on-behalf) goes through the ordinary `createOrder` path ([orderService.ts:107-136](../packages/api/src/services/orderService.ts:107)): customer lookup → `preferredDriverId` availability check → `pending_driver_assignment` (unassigned) or `pending_dispatch` (preferred driver available) → admin assigns/dispatches → driver delivers. `orderSource` stays `'regular'` regardless of whether staff or the customer themself created it — **the schema does not distinguish "customer self-placed" from "staff placed on customer's behalf."**

### `backdatedOrderService.ts` / `backdatedTripService.ts`

- **`createBackdatedOrder`** ([backdatedOrderService.ts:39-200](../packages/api/src/services/backdatedOrderService.ts:39)) — single order, `distributor_admin` only ([routes/orders.ts:99-121](../packages/api/src/routes/orders.ts:99), `POST /api/orders/backdated`). Validates issue date is in current calendar month and before today (:49-54). Creates the order **directly at `status: 'delivered'`, `orderType: 'delivery'`, `orderSource: 'regular'`, `isBackdated: true`, `isGodownPickup: false`** (:114-153), with `orderDate=deliveryDate=deliveredAt=issueDate` but `createdAt=now()`. Creates invoice **inside the same transaction** (:165-167), optional payment recorded atomically (:169-178). GST fires fire-and-forget after commit (:187-196). **`confirmDelivery` is never called for this order type** — it is born already delivered.
- **`backdatedTripService.ts`** — bulk version: records N customer deliveries by one driver+vehicle on a past date, one calendar month, sequentially (own transaction per order, so partial failure doesn't roll back others). Same semantics as single backdated (`status='delivered'`, `isBackdated=true`, no inventory events by design — a separate synthetic DVA row is written with `status='reconciled', isReconciled=true`, skipping the state machine entirely since "the trip already happened"). **Difference from single backdated:** ties the paper-trail entry to a `driverId`+`vehicleId`+one shared `assignmentDate` (a real trip context), while single-order backdated leaves `driverId`/`vehicleId` optional/nullable.
- **`backdatedAdjustmentService.ts`** — the follow-up "Apply Adjustment" step an operator clicks to mint the inventory events for a backdated order retroactively, dated on the delivery day (`manual_adjustment` for fulls, `reconciliation_empties_return` for empties), guarded against double-apply via `Order.inventoryAdjustedAt`.

### Grep results (representative, ~60 of the requested run)

```
packages/api/src/routes/driversVehicles.ts:858  // orderSource='walk_in' tied to the active DVA's driver+vehicle
packages/api/src/routes/driversVehicles.ts:937  // 7. Create order via walkIn path (orderSource='walk_in', driver+vehicle pinned)
packages/api/src/routes/driversVehicles.ts:947  { walkIn: { driverId: driver.id, vehicleId: dva.vehicleId } }
packages/api/src/routes/driversVehicles.ts:1022 if (order.orderSource !== 'walk_in') { ... }
packages/api/src/services/analyticsService.ts:81         isGodownPickup: false
packages/api/src/services/backdatedOrderService.ts:119   orderType: 'delivery'
packages/api/src/services/backdatedOrderService.ts:122   isGodownPickup: false
packages/api/src/services/backdatedTripService.ts:202    orderType: 'delivery'
packages/api/src/services/backdatedTripService.ts:205    isGodownPickup: false
packages/api/src/services/deliveryWorkflowService.ts:735-807  (walk-in float reconciliation comments)
packages/api/src/services/gst/gstPreflightService.ts:217,643  isGodownPickup: false
packages/api/src/services/gst/gstPreflightService.ts:1015     if (order.orderSource === 'walk_in') return undefined;
packages/api/src/services/gst/gstService.ts:323          const skipEwb = !!invoice.order?.isGodownPickup;
packages/api/src/services/invoiceService.ts:41,53        order: { select: { id, orderNumber, isGodownPickup } }
packages/api/src/services/orderService.ts:54-58          godown_pickup / on_demand pseudo-status filters
packages/api/src/services/orderService.ts:129,134,248,255-267,303,309,428,647,855,945,1037,1089,1136,1272,1296
packages/api/src/services/pdf/invoicePdfService.ts:94,247,322,771,773,837   (self-collection caption)
packages/api/src/services/reportsService.ts:312-415      (godown bucketed apart in driver aggregation)
```

Mobile walk-in grep hit only **one file**: `packages/mobile/app/(driver)/orders.tsx`. No `onDemand`/`on_demand` string appears anywhere in `packages/mobile`.

---

## 2. Customer app order visibility

**File:** [packages/mobile/app/(customer)/orders.tsx](../packages/mobile/app/(customer)/orders.tsx) (986 lines).

- API call: `useApiQuery<{ orders: Order[] }>(['customer-orders', dateFrom, dateTo], '/customer-portal/orders', { from: dateFrom, to: dateTo })` (:116-120). Default range is the last 30 days (`last30Days()`, :113-114).
- **Query params sent: only `from` and `to`.** No status filter, no order-type filter, no source filter is sent by this screen.
- Full path: `GET /api/customer-portal/orders` (mounted at `/api/customer-portal`).

### `getMyOrders()` — exact WHERE clause ([customerPortalService.ts:162-200](../packages/api/src/services/customerPortalService.ts:162))

```ts
export async function getMyOrders(
  distributorId: string,
  customerId: string,
  filters: { status?: string; page?: number; pageSize?: number; from?: string; to?: string }
) {
  const where: Prisma.OrderWhereInput = { customerId, distributorId, deletedAt: null };
  if (filters.status) {
    const statuses = filters.status.split(',').map((s) => s.trim()).filter(Boolean) as $Enums.OrderStatus[];
    where.status = statuses.length > 1 ? { in: statuses } : statuses[0];
  }
  if (filters.from || filters.to) {
    where.deliveryDate = {};
    if (filters.from) where.deliveryDate.gte = new Date(filters.from);
    if (filters.to) { const toEnd = new Date(filters.to); toEnd.setHours(23,59,59,999); where.deliveryDate.lte = toEnd; }
  }
  ...
  prisma.order.findMany({ where, include: { items: {...}, driver: { select: { driverName: true, phone: true } } }, orderBy: { createdAt: 'desc' }, ... })
```

**There is no filter on `createdBy`, `orderSource`, or `isGodownPickup`/`isBackdated`.** Any order row that has `customerId = <this customer>` and `distributorId = <tenant>` is returned, regardless of how it was created (customer self-service, staff on-behalf, driver walk-in) and regardless of `isGodownPickup`/`isBackdated`.

- **Walk-in orders?** Yes — mechanically, since walk-in orders carry a real, tenant-valid `customerId` (driver must pick an existing customer, [driversVehicles.ts:904-910](../packages/api/src/routes/driversVehicles.ts:904)), they satisfy the WHERE and would appear.
- **Godown-pickup orders?** Yes, same reasoning — `isGodownPickup` is never excluded.
- **Backdated orders?** Yes, if within the requested date range (they land at `status='delivered'` with real `deliveryDate=issueDate`, indistinguishable from a normal delivered order in this query).

**So visibility of the order row itself is not the practical OTP blocker** — the blocker (see §3) is whether the customer has any way to *authenticate into the app in the first place*.

---

## 3. OTP feasibility per order type

### Does the customer-portal API filter by `createdBy`/`source`?

No — confirmed above, `getMyOrders` has no such filter, and `Order` has no `createdBy` column to filter on even if desired.

### Does a walk-in-sale customer have a `User` (portal login) account? Is portal login mandatory or optional?

**Portal login is a fully separate, explicit opt-in action — never automatic.**

- `Customer` ↔ `User`: `Customer.users User[]` ([schema.prisma:612](../packages/api/prisma/schema.prisma:612)) is a plain one-to-many; `User.customerId String?` ([schema.prisma:500](../packages/api/prisma/schema.prisma:500)) is nullable. **A `Customer` can have zero `User` rows and still have orders** — nothing in the schema requires a 1:1 pairing.
- `POST /api/customers` ([routes/customers.ts:255](../packages/api/src/routes/customers.ts:255) → `customerService.createCustomer`, :99-187) creates only the `Customer` row. **No `prisma.user.create` call anywhere in this function.**
- CSV bulk import (`customerService.importCustomers`, :701-850+) only ever calls `prisma.customer.create`/`prisma.customer.update` — **no `User` row is ever created** for imported rows, no matter how many are imported.
- Portal login provisioning is a **distinct, explicit** endpoint: `POST /api/customers/:id/portal-access` ([routes/customers.ts:476-499](../packages/api/src/routes/customers.ts:476)), gated to `super_admin|distributor_admin`, requiring the staff member to type in `{ email, password, firstName, lastName }` for that specific customer. It calls `customerService.provisionPortalAccess()` ([customerService.ts:522-543](../packages/api/src/services/customerService.ts:522)):

```ts
export async function provisionPortalAccess(
  customerId: string, distributorId: string,
  data: { email: string; password: string; firstName: string; lastName: string }
) {
  const { hashPassword } = await import('./authService.js');
  const passwordHash = await hashPassword(data.password);
  return prisma.user.create({
    data: { email: data.email.toLowerCase(), passwordHash, firstName: data.firstName,
            lastName: data.lastName, role: 'customer', distributorId, customerId,
            requiresPasswordReset: true },
    select: { id: true, email: true, role: true },
  });
}
```

**Grep for `portalUser|portal_user|customerUser`:** no hits anywhere in `packages/api/src` — the only related concept is this single `provisionPortalAccess` function/route pair. There is no bulk "invite all customers" flow, no auto-provision-on-first-order, no auto-provision-on-CSV-import flag.

**Conclusion:** a customer whose record was created via CSV import (the common case for onboarding an existing customer base) or via `POST /api/customers` has **zero `User` rows by default**, and stays that way unless a staff member does the separate, per-customer "portal access" action. Placing a walk-in order or a godown-pickup order for that customer does **not** create one.

### OTP feasibility summary table

| Order type | Customer sees order in app (query-level) | Customer typically has portal login (`User` row) | OTP feasible |
|---|---|---|---|
| Regular customer-placed pre-order | Yes (their own order) | **Yes, by construction** — had to be logged in to place it | Yes, IF an OTP display + SMS/WhatsApp channel existed (per prior investigation §B4: it doesn't) |
| Staff-created pre-order for known customer | Yes (matches WHERE) | **No, unless separately provisioned** | Only for the minority with provisioned portal access |
| Driver walk-in (`orderSource='walk_in'`) | Yes (matches WHERE) | **No, unless separately provisioned** (walk-in requires only that the customer *record* exist, not a login) | Same — minority only |
| Godown pickup (`isGodownPickup=true`) | Yes (matches WHERE) | **No, unless separately provisioned** (staff creates it, same as any staff pre-order) | Same — minority only |
| Backdated (single or trip) | Yes, if within date range (matches WHERE) | **No, unless separately provisioned** | Moot anyway — never reaches `confirmDelivery` (§6) |

---

## 4. Godown pickup exclusion

### Grep: `isGodownPickup` in `packages/api/src` (representative)

```
services/orderService.ts:54       where.isGodownPickup = true;                    (admin "Godown Pickup" filter)
services/orderService.ts:123      isGodownPickup?: boolean;                       (createOrder input type)
services/orderService.ts:248      const isGodownPickup = data.isGodownPickup ?? false;
services/orderService.ts:255      if (isGodownPickup) { status = 'pending_delivery'; }   (skip driver/vehicle assignment)
services/orderService.ts:309      isGodownPickup,                                 (persisted on create)
services/orderService.ts:647      if (order.isGodownPickup) { ... }               (cancelOrder — special-cased transition)
services/orderService.ts:945      if (order.isGodownPickup) { ... insufficient-stock gate ... }   (confirmDelivery)
services/orderService.ts:1037     if (order.isGodownPickup) { ... synthetic dispatch event ... }  (confirmDelivery)
services/orderService.ts:1089     if (order.isGodownPickup) { ... synthetic empties-return event ... } (confirmDelivery)
services/orderService.ts:1136     const cancelledStatus = order.isGodownPickup ? 'returned_to_depot' : ...
services/gst/gstPreflightService.ts:217   isGodownPickup: false,   (preflightDispatch eligible-orders filter)
services/gst/gstPreflightService.ts:643   isGodownPickup: false,   (preflightAddToTrip eligible-orders filter)
services/gst/gstService.ts:323    const skipEwb = !!invoice.order?.isGodownPickup;
services/pdf/invoicePdfService.ts:322,771-773,837   (self-collection caption on invoice PDF)
services/analyticsService.ts:81   isGodownPickup: false,   (dashboard "in-flight trucks" KPI excludes godown)
services/reportsService.ts:312-415   (godown-pickup rows bucketed apart in driver-performance aggregation)
```

### Where set on order creation

[orderService.ts:248](../packages/api/src/services/orderService.ts:248) inside `createOrder`, sourced from `data.isGodownPickup` in the request body — only reachable via the **staff** create-order route, never via customer-portal (§1). Web/mobile admin surface it as a checkbox ([OrdersPage.tsx:658](../packages/web/src/pages/OrdersPage.tsx:658), [(admin)/orders.tsx:1099,1376-1389](../packages/mobile/app/(admin)/orders.tsx:1099)).

### Where checked in the delivery flow

1. **Order creation** ([orderService.ts:255-258](../packages/api/src/services/orderService.ts:255)): skips `preferredDriverId` lookup, sets `driverId=null`, `vehicleId=null`, jumps status straight to `pending_delivery` (bypassing `pending_driver_assignment`/`pending_dispatch`).
2. **Preflight/dispatch eligibility** ([gstPreflightService.ts:214-220,640-646](../packages/api/src/services/gst/gstPreflightService.ts:214)): both `preflightDispatch` and `preflightAddToTrip` explicitly filter `isGodownPickup: false` out of their eligible-order queries — godown orders never enter preflight/EWB at all.
3. **GST/EWB generation** ([gstService.ts:318-323](../packages/api/src/services/gst/gstService.ts:318)): `skipEwb = !!invoice.order?.isGodownPickup` — IRN still fires for B2B (the supply happened), but every EWB branch short-circuits, because "no vehicle movement, so no EWB is legally required." Confirms the prior investigation's claim.
4. **`confirmDelivery`** handles it specially (see below).
5. **`cancelOrder`** ([orderService.ts:647](../packages/api/src/services/orderService.ts:647)) — special-cased status transition (no vehicle to un-dispatch).
6. **Dashboard/analytics/reports** — godown rows explicitly excluded from "trucks in-flight" KPI ([analyticsService.ts:75-82](../packages/api/src/services/analyticsService.ts:75)) and bucketed separately in driver-performance aggregation ([reportsService.ts:312-415](../packages/api/src/services/reportsService.ts:312), using a synthetic `GODOWN_PICKUP_DRIVER_ID` sentinel).
7. **Invoice PDF** — a "self-collection" caption replaces the driver/vehicle info ([invoicePdfService.ts:322,771-773,837](../packages/api/src/services/pdf/invoicePdfService.ts:322)).

### Does `confirmDelivery` handle godown pickup differently?

Yes, in three specific places inside the **same** function/transaction used by every other order type ([orderService.ts:833-1260](../packages/api/src/services/orderService.ts:833)):

1. **Pre-transaction insufficient-stock gate** (:940-961) — since godown orders skip preflight (which normally validates depot stock before dispatch), `confirmDelivery` does the check itself: for each item with `deliveredQuantity > 0`, it reads latest `InventorySummary.closingFulls` and throws 400 if insufficient.
2. **Synthetic dispatch inventory event** (:1029-1050) — because no real dispatch event was ever written (preflight skipped), `confirmDelivery` writes one itself (`eventType: 'dispatch', referenceType: 'godown_pickup'`) so `closingFulls` debits correctly.
3. **Synthetic `reconciliation_empties_return` event** (:1077-1102) — because godown pickups never go through a vehicle-return reconciliation, empties collected at pickup would otherwise get stuck in "on vehicle" forever; a synthetic event credits `closingEmpties` immediately.
4. **Cancelled-stock status branching** (:1124-1152) — `cancelledStatus = order.isGodownPickup ? 'returned_to_depot' : order.vehicleId ? 'on_vehicle' : 'pending_return'` — godown short-delivery goes straight to `returned_to_depot` (cylinders never left the depot).

Everything else — Zod contract, idempotency check, invoice-creation-in-tx, transaction boundaries — is **identical** across order types. There is no separate "godown confirm" endpoint.

---

## 5. Current confirm-delivery entry points

### API-side chokepoint

**Single service function**: `orderService.confirmDelivery()` ([orderService.ts:833](../packages/api/src/services/orderService.ts:833)), called from **exactly one route**: [routes/orders.ts:495](../packages/api/src/routes/orders.ts:495) (`POST /api/orders/:id/confirm-delivery`). Every client below hits this one route/function — no parallel code path anywhere in `packages/api/src`.

### Client-side entry points (4 total)

| Site | File:line | Actor |
|---|---|---|
| Driver delivery modal | [packages/mobile/app/(driver)/orders.tsx:109](../packages/mobile/app/(driver)/orders.tsx:109) | Driver, mobile |
| Admin/staff delivery modal (mobile) | [packages/mobile/app/(admin)/orders.tsx:1917](../packages/mobile/app/(admin)/orders.tsx:1917) | Admin/staff, mobile |
| Admin/staff delivery modal (web) | [packages/web/src/pages/OrdersPage.tsx:1626](../packages/web/src/pages/OrdersPage.tsx:1626) | Admin/staff, web |
| Offline queue replay | [packages/mobile/src/services/deliveryQueue.ts:94](../packages/mobile/src/services/deliveryQueue.ts:94) | Driver device, background sync |

### For each entry point — what order types can reach it?

- **Driver mobile** (`(driver)/orders.tsx`): fetches `GET /orders` with `{ status: 'pending_delivery' }` (:92-103) — and the route ([orders.ts:35-66](../packages/api/src/routes/orders.ts:35)) **auto-scopes by `driverId`** when the caller's role is `driver`: `filters.driverId = driver.id` (resolved by phone match), then `listOrders` applies `where.driverId = filters.driverId`. **Godown-pickup orders have `driverId=null` and therefore never match this equality filter — they cannot appear in the driver's order list, period.** Walk-in orders DO appear (their `driverId` is pinned to the creating driver at creation time). Regular pre-orders appear once assigned+dispatched to that driver. Backdated orders never reach `pending_delivery` status (they're born `delivered`), so they never appear here regardless of `driverId`.
- **Admin mobile / web `DeliveryConfirmationModal`**: the "Confirm Delivery" action button is gated **purely on `order.status` — `pending_delivery` or `pending_dispatch`** ([(admin)/orders.tsx:497-499](../packages/mobile/app/(admin)/orders.tsx:497); [OrdersPage.tsx:401-409](../packages/web/src/pages/OrdersPage.tsx:401)), with **no filter on `isGodownPickup`, `orderSource`, or `driverId`**. This is the only UI surface that shows godown-pickup orders reaching a "Confirm Delivery" affordance (since they land in `pending_delivery` with no driver). Both admin surfaces can also confirm regular pre-orders and walk-ins.
- **Offline queue replay** ([deliveryQueue.ts:94](../packages/mobile/src/services/deliveryQueue.ts:94)): re-POSTs whatever was queued by the driver screen while offline — same order-type universe as the driver screen.
- **Returns-only orders** (`orderType: 'returns_only'`) hit the **same** `/confirm-delivery` endpoint on all four entry points; `confirmDelivery` detects `order.orderType === 'returns_only'` at :855 and delegates to `confirmReturnsCollection` ([orderService.ts:1262](../packages/api/src/services/orderService.ts:1262)) with the "delivered qty" field remapped to "collected qty." The web modal even flips its copy accordingly ([OrdersPage.tsx:1610](../packages/web/src/pages/OrdersPage.tsx:1610), `isReturn = order.orderType === OrderType.RETURNS_ONLY`).

**Can godown pickup reach the driver confirm screen?** **No.** It only ever reaches the two admin (web/mobile) confirm-delivery modals, never the driver's screen, because it has no `driverId` to match the driver-scoped query.

---

## 6. Walk-in / on-demand sale creation flow

Consolidated from §1 grep + code walkthrough.

### Grep: `backdatedOrder|onDemandOrder|createOrderOnBehalf|walkIn` in `packages/api/src`

Confirms 3 real concepts exist in code: `backdatedOrder*` (single, `backdatedOrderService.ts`), `backdatedTrip*` (bulk, `backdatedTripService.ts`), and `walkIn` (driver on-route, `orderService.ts` + `driversVehicles.ts`). **No `onDemandOrder` or `createOrderOnBehalf` identifier exists anywhere** — "on-demand" is purely the admin UI's label for `isBackdated` (§1), and "create on behalf" is just the ordinary staff `POST /api/orders` flow with no special naming.

### Admin order-creation screens — fields captured per flow

**`packages/mobile/app/(admin)/orders.tsx` create-order modal (:1076-1181)** and **`packages/web/src/pages/OrdersPage.tsx`** (equivalent RHF form) both call `POST /orders` with:
```ts
{ customerId, deliveryDate, specialInstructions?, poNumber? (B2B-gated), isGodownPickup, items: [{cylinderTypeId, quantity}] }
```
Customer is picked via search against existing customers (`/customers?search=...`), never freeform-created inline. **This IS the "distributor admin creates a pre-order for a known customer" flow** — the closest analog to a walk-in sale that the admin/office UI offers, and it requires the customer to already exist as a record.

**Regular customer self-service** — [(customer)/orders.tsx `CreateOrderVars`, :24-33](../packages/mobile/app/(customer)/orders.tsx:24) → `POST /customer-portal/orders`: `{ deliveryDate, items, promisedDate?, promisedAmount?, acknowledged?, poNumber? }`. No `isGodownPickup` field is even accepted here (confirmed against the Zod schema at [customerPortal.ts:95-110](../packages/api/src/routes/customerPortal.ts:95)).

**Driver walk-in** — `WalkInOrderModal` ([(driver)/orders.tsx:653-780](../packages/mobile/app/(driver)/orders.tsx:653)) → `POST /drivers/me/orders`: `{ customerId (from picker), cylinderTypeId, quantity, deliveryDate (forced to today) }`. Single cylinder type per submission (multi-item not supported in this modal). No PO number, no special instructions, no godown toggle (mutually exclusive with godown pickup by construction — [orderService.ts:255](../packages/api/src/services/orderService.ts:255) `if (isGodownPickup) {...} else if (options?.walkIn) {...}`, an if/else-if chain that makes the two states mutually exclusive at the code level).

**Backdated (single)** — `POST /api/orders/backdated` (`distributor_admin` only): `{ customerId, issueDate, items[{...,emptiesCollected?}], poNumber?, specialInstructions?, driverId?, vehicleId?, payment? }`. Produces `status='delivered'` directly.

**Backdated (bulk trip)** — presumably `POST /api/orders/backdated-trip`: same per-order shape as single backdated, plus a shared `driverId`+`vehicleId`+`assignmentDate` context and a synthetic reconciled DVA row.

### Walk-in flow doc gap — worth flagging

The task prompt referenced a "CLAUDE.md WI-PENDING-PAYMENTS" mention of a "walk-in-order modal and cancel-walk-in flow." **That reference does not actually exist in `CLAUDE.md`** — a case-insensitive grep for `float-001`, `walk.in`, `walk_in` in `CLAUDE.md` returns **zero hits**. The walk-in feature (tagged `FLOAT-001` in code comments, dated 2026-06-17/18) is **entirely undocumented in `CLAUDE.md`** — the feature exists only in inline code comments (`orderService.ts`, `driversVehicles.ts`, `gstPreflightService.ts`, `deliveryWorkflowService.ts`, `dvaManifestService.ts`) and in `(driver)/orders.tsx`. This is a documentation gap worth flagging independently.

End-to-end flow from code (§1):

1. Driver taps FAB → `WalkInOrderModal` opens ([(driver)/orders.tsx:591-618](../packages/mobile/app/(driver)/orders.tsx:591)).
2. Driver searches/picks an **existing** customer, picks one cylinder type + quantity (bounded by `availableFulls` on the truck via `/drivers/me/trip-stock`).
3. Submit → `POST /drivers/me/orders` → server re-validates active DVA + tenant + stock → creates order (`orderSource='walk_in'`, `driverId`/`vehicleId` pinned to the DVA) → immediately fires mid-trip preflight (IRN/EWB) synchronously → returns 201 (full success) or 207 (order saved, GST pending — "contact office" toast).
4. Order now appears in the driver's own `pending_dispatch` initially ([orderService.ts:267](../packages/api/src/services/orderService.ts:267)) — added to the trip mid-route; driver later confirms delivered through the same "Confirm Delivery" modal as any other order on their list ([(driver)/orders.tsx:329-342](../packages/mobile/app/(driver)/orders.tsx:329) renders a driver-only "Cancel" affordance for walk-ins pre-delivery, and the normal delivery flow — items/notes only — for delivery).
5. Cancel path (driver-initiated, pre-delivery only): `handleCancelWalkIn` → confirm dialog → `DELETE /drivers/me/orders/:id` → `cancelOrder()` service call, gated to the order's own driver + `orderSource==='walk_in'` + eligible status.

---

## 7. Explicit summary answers

### A. How many distinct order types exist in code?

Seven practically-distinct combinations, driven by four independent-ish fields (`orderType`, `orderSource`, `isGodownPickup`, `isBackdated`) plus the *creation channel* (which is not itself stored on the row):

| # | Type | Distinguishing field(s) | Created via |
|---|---|---|---|
| 1 | Regular customer-placed pre-order | `orderSource='regular'`, `isGodownPickup=false`, `isBackdated=false`, created by role=`customer` | `POST /api/customer-portal/orders` |
| 2 | Staff-created pre-order for a known customer | Same fields as #1 — **schema cannot distinguish this from #1** (no `createdBy` on `Order`) | `POST /api/orders` (staff roles) |
| 3 | Godown pickup (self-collection) | `isGodownPickup=true` | `POST /api/orders` with `isGodownPickup:true` — staff only; customer-portal schema has no such field |
| 4 | Driver walk-in (on-route sale to an existing customer) | `orderSource='walk_in'` | `POST /api/drivers/me/orders`, driver role only |
| 5 | Backdated single order | `isBackdated=true`, `status` created directly as `delivered` | `POST /api/orders/backdated`, `distributor_admin` only |
| 6 | Backdated bulk trip | Same as #5 + shared driver+vehicle+date + synthetic reconciled DVA | `backdatedTripService.ts` |
| 7 | Returns-only order | `orderType='returns_only'` | `POST /api/orders/returns-only` |

### B. Which order types can reach the driver confirm-delivery screen?

| Type | Reaches driver screen? |
|---|---|
| 1. Regular customer-placed pre-order | **Yes** — once assigned+dispatched to a driver |
| 2. Staff-created pre-order for customer | **Yes** — identical mechanics to #1 |
| 3. Godown pickup | **No** — `driverId=null` by construction; driver's `GET /orders` filters `driverId = <this driver>`, which a null value can never match ([orders.ts:53-66](../packages/api/src/routes/orders.ts:53), [orderService.ts:60-61](../packages/api/src/services/orderService.ts:60)) |
| 4. Driver walk-in | **Yes** — `driverId` is pinned to the creating driver at creation time; designed to appear on that same driver's list |
| 5/6. Backdated (single/trip) | **No** — created directly at `status='delivered'`; never occupies `pending_delivery`/`pending_dispatch` |
| 7. Returns-only | **Yes** — same driver screen, same endpoint, `confirmDelivery` delegates internally to `confirmReturnsCollection` |

### C. For each type that reaches confirm delivery — OTP/photo/signature feasibility

| Type | Customer sees order (query)? | Customer typically has portal login? | OTP feasible? | Photo feasible? | Signature feasible? |
|---|---|---|---|---|---|
| 1. Regular customer-placed pre-order | Yes | **Yes** (had to log in to place it) | Yes *mechanically* — IF a display-OTP + SMS/WhatsApp channel existed (it doesn't) | Yes (driver-side capture, no dependency on customer login) | Yes (same) |
| 2. Staff-created pre-order for customer | Yes | **No** by default (portal access is a separate opt-in per §3) | **No** for the majority — no app, no way to display/receive the OTP | Yes | Yes |
| 4. Driver walk-in | Yes | **No** by default (walk-in only requires the customer *record* exist, not a login) | **No** for the majority | Yes | Yes |
| 7. Returns-only | Yes | Depends on the underlying customer's login state | Same caveat as #1/#2 depending on that customer | Yes | Yes |

Photo and signature are driver-side captures with **no dependency on the customer having an app or login at all** — they are feasible for every order type that reaches a driver/admin confirm screen (their current infeasibility is purely an infra/permission gap per the prior investigation's §B2, not an order-type gap). **OTP is the only proof method that is structurally blocked by order type and customer-login state**, because it requires the customer to (a) have the app, (b) be logged in, (c) see the order, (d) have a code displayed/delivered to them.

### D. Is godown pickup already excluded from the driver confirm-delivery flow, or does it reach that screen and get excluded after?

**Excluded before it ever reaches any screen at all — at the data-fetch level, not the UI level.** There is no explicit "if isGodownPickup, hide from driver" branch anywhere; the exclusion is a structural side-effect of `driverId` being `null` for godown orders (set at [orderService.ts:255-258](../packages/api/src/services/orderService.ts:255), "Skip the entire driver/vehicle/dispatch path... Stay on null driver+vehicle") combined with the driver-role auto-scoping filter in `GET /orders` ([routes/orders.ts:53-66](../packages/api/src/routes/orders.ts:53), `where.driverId = <this driver>`). A godown-pickup order simply never satisfies that WHERE clause for any driver.

Godown pickup instead has its own bypass path entirely: it goes straight from creation to `status='pending_delivery'` with no driver/vehicle/dispatch, and is confirmed exclusively through the **admin/staff** "Confirm Delivery" modals ([OrdersPage.tsx:401-409](../packages/web/src/pages/OrdersPage.tsx:401) / [(admin)/orders.tsx:497-499](../packages/mobile/app/(admin)/orders.tsx:497)), whose trigger condition checks only `order.status`, not `isGodownPickup` or `driverId`. Those admin modals hit the exact same `confirmDelivery` service function as the driver flow (§4), with three godown-specific branches inside it (synthetic dispatch event, synthetic empties-return event, insufficient-stock pre-check) to compensate for the skipped preflight/dispatch pipeline.

### E. Gaps between "walk-in / on-the-go sale" and what the code models

**Confirmed gap:**

1. **There is no true "sell to a stranger on the route" concept.** The only mechanism named "walk-in" in this codebase (`orderSource='walk_in'`, FLOAT-001, 2026-06-17) requires the driver to **search and select an already-existing `Customer` row** ([driversVehicles.ts:904-910](../packages/api/src/routes/driversVehicles.ts:904); `WalkInOrderModal` customer picker, [(driver)/orders.tsx:669-675](../packages/mobile/app/(driver)/orders.tsx:669)). There is **no path anywhere in the driver app to create a brand-new customer record on the spot** — no "new customer" form in `WalkInOrderModal`, no anonymous/cash-sale-without-a-customer-record order type. If a driver encounters a genuine walk-up stranger with no existing account, the current system offers no way to record that sale as a walk-in; office staff would have to create the `Customer` record first (via `POST /api/customers` or CSV import), and even then the driver's app would need that record to already be searchable before the driver could sell to them same-day.

2. So the actual closest analog to "walk-in / on-the-go sale" is: **an existing, known customer who happens not to have a pre-booked order, and the driver (mid-route, with cargo already loaded) creates a same-day order for them** — functionally a same-day pre-order created by the driver instead of an admin, not a true anonymous point-of-sale transaction. This is architecturally identical to "distributor-admin creates a same-day pre-order for a known customer" (order type #2 in §A) except for *who* creates it and that it's pinned to the driver's current DVA.

3. **OTP-to-customer-app is unreachable for the large majority of the customer base as a structural default, not an edge case.** Per §3: `createCustomer` and CSV bulk import — the two dominant ways customer records enter the system — **never** create a `User` login. Portal access is a manual, per-customer, staff-initiated action (`POST /api/customers/:id/portal-access`) requiring the staff member to type a password for the customer. Given that CSV import is explicitly built to onboard an existing customer base from a spreadsheet (`customerService.importCustomers`, phone-based upsert, no email requirement even), the realistic default is: **most `Customer` rows have zero associated `User` rows**, meaning most customers — whether their orders are regular pre-orders, staff-created pre-orders, walk-ins, or godown pickups — have **no app to receive/display an OTP on, independent of whether the order itself would technically be visible to them.** Combined with the fact that no OTP-to-customer-phone channel (SMS/WhatsApp) exists at all today (confirmed unchanged from the prior investigation's §B4 at this same commit — the only OTP infrastructure is `authService.ts` email-based password-reset, tied to `User.email`, not `Customer.phone`), **OTP-as-primary-proof-method is not viable as a general solution**: it would only ever work for the subset of customers who (a) were explicitly given portal access by staff, and (b) place orders through channels that display an OTP on the order card, and (c) have a working, monitored phone number (per the prior investigation's §B5, phone data quality is also unvalidated).

**Photo and signature, captured entirely driver-side, have no such dependency and are the only two of the three proof methods that generalize across all order types that reach a confirm-delivery screen.**

---

## Implications for the proof-of-collection implementation plan

Cross-referencing with [docs/FEATURE-INVESTIGATION.md](FEATURE-INVESTIGATION.md) §B:

1. **Reorder the phased rollout.** The prior doc recommended signature (Phase 1) → photo (Phase 2) → OTP (Phase 3). That order is still correct on infra/App Store grounds, but this investigation surfaces an additional reason for it: **OTP is not merely last-in-line, it is unreachable for the majority of orders without prerequisite work** — either (a) a bulk "invite all customers to portal" campaign, or (b) an OTP-via-SMS/WhatsApp channel that bypasses the app entirely and delivers directly to `Customer.phone`. Option (b) is preferable operationally (works without portal login) but doesn't sidestep the `Customer.phone` data-quality problem (prior doc §B5).

2. **Signature and photo apply uniformly across all 4 confirm-delivery-reachable order types** (regular pre-order, staff-created pre-order, driver walk-in, returns-only). No per-order-type gating logic needed for either — they're driver-side captures.

3. **Godown pickup needs a separate design decision.** It reaches confirm-delivery via the **admin web + admin mobile** modals, never the driver screen. If proof-of-collection is bolted onto the driver screen only, godown pickup would silently be excluded. Two options:
   - (a) **Exclude godown pickup from proof entirely** — the customer is physically at the depot, staff can rely on physical presence and any counter-side proof (paper ledger sign-off). Simplest.
   - (b) **Extend the admin confirm-delivery modals** to include signature capture too (photo makes less sense at a depot counter but possible). More work; also introduces the "signature pad on desktop web via mouse/trackpad or touch device" UX question that the driver mobile flow doesn't have.
   Recommend (a) for v1: exclude godown pickup, revisit if a distributor asks.

4. **Backdated orders are moot.** They never reach `confirmDelivery` — they're born `delivered`. Proof-of-collection is not applicable by definition (the delivery already happened, possibly weeks ago, before the record was entered). No gating needed either — the code path just isn't exercised.

5. **Returns-only orders** hit `confirmDelivery` → `confirmReturnsCollection`. Whether proof applies depends on business decision — "return the empties" is arguably worth signature/photo evidence (accountability for count) but not OTP (no delivery in the outbound sense). Punt this decision to product; the code shape allows signature/photo to work here without change.

6. **Walk-in orders are the strongest photo/signature use case.** No pre-booking, no invoice-first workflow — the driver is physically at the customer's location with cash changing hands. Signature capture there directly addresses "did the driver actually deliver and collect payment" auditability. OTP is worst-fit here (customer picked from a spreadsheet, most likely no portal login).

7. **Documentation debt worth flagging separately:** the FLOAT-001 walk-in feature has zero mentions in `CLAUDE.md`. Given its scope (new order source, mid-trip preflight, float-vs-DVA reconciliation, driver-only cancel path) this is a gap that should be closed regardless of proof-of-collection work.
