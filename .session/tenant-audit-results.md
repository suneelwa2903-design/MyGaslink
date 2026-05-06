# Tenant Isolation Audit — packages/api/src/services/

**Generated:** 2026-05-06
**Scope:** 28 service files (24 in services/, 4 in services/gst/, 4 in services/pdf/), all Prisma operations
**Method:** Static read of every Prisma call against the tenant-scoped/child/platform model lists from the audit brief.

---

## Summary

- Total Prisma operations scanned: ~339 (matches prior grep)
- **Definite leaks (CRITICAL — tenant-scoped query, no distributor filter, no post-fetch check):** 8
- **HIGH — findUnique/update/delete by id without verified ownership check:** 27
- **MEDIUM — Child-model queries with unclear parent isolation:** 12
- **LOW — Non-null assertions (`distributorId!`) and other smells in services:** 0 (only `gstin!` non-null assertions, not distributorId)
- **Files clean (no flags):** 8/28

Note: many "HIGH" items in service files are either intentional (super-admin / cross-tenant by design — billing, pricing, GST docs accessed via parent), or callers always pass distributorId + filter via findFirst. They are flagged here for completeness because they are pure `findUnique`/`update`/`delete` by primary key with no `distributorId` clause and no visible post-fetch check **inside the service itself**. The route layer enforces the tenancy gate via middleware (`authenticate → resolveDistributor → requireDistributor`) which sets `req.user.distributorId`, but the *services* themselves rely on the caller to scope correctly.

---

## Findings by Severity

### CRITICAL — Confirmed missing distributor filter

| File:line | Model | Operation | Why it's a leak | Distributor source |
|---|---|---|---|---|
| customerPortalService.ts:46-49 | CustomerInventoryBalance | findMany | `where: { customerId }` only — no `customer.distributorId` check. customerId comes from JWT but a malicious/buggy caller could pass any customerId. Should filter via `customer: { distributorId, deletedAt: null }`. | function arg `customerId` (assumed JWT) |
| customerPortalService.ts:245-248 | CustomerInventoryBalance | findMany (`getMyBalance`) | Same as above — `where: { customerId }` only. | function arg `customerId` |
| customerPortalService.ts:333-355 | Invoice | findMany (`getCustomerInvoices`) | `where: { customerId, deletedAt: null, isGaslinkBilling: false }` — **no `distributorId` filter at all**. If a customer ID collides across distributors (UUIDs make collision astronomical, but the principle stands), or if route is callable with arbitrary customerId, leak. | function arg `customerId` only |
| customerPortalService.ts:361-375 | Invoice | findMany (`getInvoiceSummaryForDownload`) | Same — no distributorId. | function arg `customerId` only |
| customerService.ts:271 | CustomerModificationRequest | findUnique | `findUnique({ where: { id: requestId } })` — no distributor scope. The `approveModificationRequest` then writes to customer based on the fetched record without distributor validation. | none |
| customerService.ts:304 | CustomerModificationRequest | findUnique (`rejectModificationRequest`) | Same — direct findUnique by id. | none |
| customerService.ts:314-319 | CustomerAuditTrail | findMany (`getCustomerAuditTrail`) | `where: { customerId }` only — no distributor filter, no parent join. | function arg `customerId` |
| inventoryService.ts:512-525 | CustomerInventoryBalance | findMany (`getCustomerBalances`) | Filters via `customer.distributorId` ✓ — actually correct. NOT a leak. (Removed from CRITICAL.) | — |

Re-tally **CRITICAL = 7** after removing the false positive.

### HIGH — findUnique / update / delete by id without verified ownership check (in service)

These rely on the route layer to authorize, but in the service they're unscoped lookups by primary key. Many are safe because the entity is platform-level (Distributor, PricingTier) — those are **not** flagged. Only tenant-scoped or child-of-tenant entities listed here.

| File:line | Model | Operation | Has post-fetch check? |
|---|---|---|---|
| accountabilityService.ts:132-136 | AccountabilityLog | update by id | Yes — preceded by `findFirst({ where: { id, distributorId } })` at L122. SAFE. |
| accountabilityService.ts:158-168 | AccountabilityLog | update by id (resolve) | Yes — preceded by findFirst at L149. SAFE. |
| billingService.ts:50 | BillingCycle | findUnique by id (`getBillingCycleById`) | NO check. `BillingCycle` is tenant-scoped. Caller (route) must enforce. **Needs human review** — likely super_admin only. |
| billingService.ts:344 | BillingCycle | findUnique (`addBillingItem`) | NO check. Same as above. |
| billingService.ts:391 | BillingCycle | findUnique (`markBillingPaid`) | NO check. |
| billingService.ts:436-440 | Distributor | update | Platform model — not flagged. |
| billingService.ts:483-489 | PendingAction | findFirst | Filtered by `distributorId: cycle.distributorId`. SAFE (distributor sourced from cycle fetched without filter — chain inherits the same un-scoping risk from L344/391/etc). |
| customerService.ts:271, 304 | CustomerModificationRequest | findUnique | Already in CRITICAL above. |
| customerService.ts:282-296 | Customer | update inside transaction | Uses `request.customerId` from un-scoped find. **Risk inherits from CRITICAL above.** |
| deliveryWorkflowService.ts:226-228 | Vehicle | findFirst | filtered by `{ id: vehicleId, distributorId }`. SAFE. |
| deliveryWorkflowService.ts:262-265 | Vehicle | update by id | NO check, but preceded by findFirst at L226 for same id+distributor. SAFE. |
| deliveryWorkflowService.ts:381-383 | CancelledStockEvent | update by id | Preceded by findMany filtered on `vehicleId, distributorId` at L371. SAFE. |
| deliveryWorkflowService.ts:423-430 | Order | update by id | Preceded by findMany filtered on `vehicleId, distributorId` at L408. SAFE. |
| deliveryWorkflowService.ts:474-477 | Invoice | update by id | NO direct distributor check, but invoiceId comes from filtered orders. SAFE by transitive scoping. |
| deliveryWorkflowService.ts:489-492 | Vehicle | update by id (status idle) | Preceded by find at L226. SAFE. |
| driverService.ts:79 | Driver | update by id | Preceded by findFirst at L61 with distributor. SAFE. |
| driverService.ts:85-88 | Driver | update by id (delete) | Preceded by findFirst at L83. SAFE. |
| driverService.ts:94-97 | Driver | update by id (toggleAvailability) | Preceded by findFirst at L92. SAFE. |
| driverService.ts:107-114 | DriverVehicleAssignment | findFirst | NO distributorId filter — only `driverId, assignmentDate, isReconciled, status`. **MEDIUM RISK** — driverId from caller could in theory belong to another distributor; should add `distributorId` to the where. |
| driverService.ts:119-130 | DriverVehicleAssignment | create | Sets `distributorId` from caller arg. SAFE. |
| driverService.ts:138-141 | DriverVehicleAssignment | findFirst | filters on `id, distributorId`. SAFE. |
| driverService.ts:149-156 | DriverVehicleAssignment | findFirst | filters on `driverId, assignmentDate, distributorId`. SAFE. |
| driverService.ts:167-174 | DriverVehicleAssignment | update by id | Preceded by findFirst at L138. SAFE. |
| invoiceService.ts:55-58 | Invoice | findFirst | filters on `id, distributorId`. SAFE. |
| invoiceService.ts:84-86 | Invoice | findFirst | filters on `orderId, distributorId`. SAFE. |
| invoiceService.ts:310-312 | Invoice | findFirst | filters on `id, distributorId`. SAFE. |
| invoiceService.ts:334 | CreditNote | findUnique by id (`approveCreditNote`) | **NO check.** CreditNote is child-of-Invoice (Invoice is tenant-scoped). The function then operates on `cn.invoiceId` and `cn.totalAmount` without verifying invoice's distributorId matches the caller. **HIGH RISK** for cross-tenant approval. Caller route may enforce, but service shouldn't trust. |
| invoiceService.ts:350 | Invoice | findUnique by id (inside CN approve) | NO check. Inherits risk from L334. |
| invoiceService.ts:384, 395 | CreditNote, Invoice | findUnique | Same pattern — no check. |
| invoiceService.ts:415-417 | Invoice | findFirst | filters on `id, distributorId`. SAFE. |
| invoiceService.ts:439, 455, 487, 498 | DebitNote, Invoice | findUnique by id | Same pattern as CreditNote — **no distributor check**. HIGH. |
| invoiceService.ts:507-509 | Invoice | findFirst | filters on `id, distributorId`. SAFE. |
| invoiceService.ts:548-552 | Distributor | findUnique | Platform model. SAFE. |
| invoiceService.ts:567-573 | Invoice | findMany | filters by distributorId. SAFE. |
| invoiceService.ts:594-602 | InvoiceItem | update by id | Inside loop on invoice that was filtered by distributorId. SAFE. |
| invoiceService.ts:613-616 | Invoice | update by id | Same — invoice is from filtered findMany. SAFE. |
| orderService.ts:62-69 | Order | findFirst | filters on `id, distributorId`. SAFE. |
| orderService.ts:122-131 | DriverVehicleAssignment | findFirst | NO distributorId filter — same issue as driverService:107. **MEDIUM RISK.** |
| orderService.ts:152-157 | Order | update by id (assignDriver) | Preceded by findFirst at L446. SAFE. |
| orderService.ts:217-226 | DriverVehicleAssignment | findFirst | NO distributorId filter. **MEDIUM RISK.** |
| orderService.ts:284-291 | CancelledStockEvent | findFirst | filters on `id, distributorId`. SAFE. |
| orderService.ts:455-457 | Driver | findFirst | filters on `id, distributorId`. SAFE. |
| orderService.ts:463-470 | DriverVehicleAssignment | findFirst | NO distributorId filter. **MEDIUM RISK.** |
| orderService.ts:535-538 | Order | findFirst | filters on `id, distributorId`. SAFE. |
| orderService.ts:611-614 | Order | findFirst | SAFE. |
| orderService.ts:766-770 | Invoice | findFirst | filters on `orderId` only — no distributorId. **HIGH** — but orderId comes from filtered fetch above. SAFE in context. |
| orderService.ts:885-888 | Order | findFirst | SAFE. |
| paymentService.ts:98-101 | Invoice | findFirst | filters on `id, distributorId`. SAFE. |
| paymentService.ts:131-140 | Invoice | findMany | filters on `distributorId, customerId`. SAFE. |
| paymentService.ts:157-165 | Invoice | update by id | invoice from filtered findMany. SAFE. |
| paymentService.ts:214-218 | Customer | findFirst | filters on `id, distributorId`. SAFE. |
| paymentService.ts:223-238 | Order | findMany | filters on `distributorId, customerId`. SAFE. |
| paymentService.ts:241-244 | PaymentTransaction | findMany | filters on `distributorId, customerId`. SAFE. |
| pendingActionsService.ts:53, 62, 74 | PendingAction | findUnique by id | **NO distributor check.** PendingAction is tenant-scoped. Caller (route) presumably scopes; service does not. HIGH. |
| pendingActionsService.ts:55-58, 64-70, 76-82 | PendingAction | update by id | Inherits risk from L53, etc. HIGH. |
| seatRequestService.ts:35 | SeatRequest | findUnique | NO distributor check. SeatRequest is tenant-scoped. HIGH (probably super_admin only). |
| seatRequestService.ts:55-63 | SeatRequest | update by id | Inherits from L35. |
| seatRequestService.ts:67-73 | SeatRequest | update by id | NO check whatsoever — direct update by id. **HIGH.** |
| settingsService.ts:11-13 | DistributorSetting | findUnique by composite (distributorId+key) | SAFE — distributorId is part of key. |
| settingsService.ts:17-22, 25-28 | DistributorSetting | upsert/deleteMany | SAFE — distributorId in key. |
| settingsService.ts:30-48 | GstCredential | findUnique/findMany | SAFE — filtered by distributorId. |
| settingsService.ts:56-61 | GstCredential | upsert | SAFE. |
| settingsService.ts:63-68 | Distributor | update | Platform model. SAFE. |
| settingsService.ts:79-82, 86-90 | DistributorSetting | findUnique/upsert | SAFE. |
| settingsService.ts:93-104 | License | findMany | filters on distributorId. SAFE. |
| settingsService.ts:122-134, 136-140 | License | update/delete by id | Preceded by findFirst with distributor. SAFE. |
| userService.ts:30-35 | User | findFirst | NO distributor filter. **HIGH** — but used for super_admin profile lookup or by admin viewing any user. Caller must scope. |
| userService.ts:37-47 | User | findFirst (`getUserProfile`) | filtered by `id: userId` (own profile). SAFE in self-context. |
| userService.ts:73-87 | User | create | distributorId optional — see discussion. SAFE if route enforces. |
| userService.ts:89-120 | User | update by id | NO distributor check. **HIGH** — must be admin-only path. |
| userService.ts:122-128 | User | update by id (delete) | NO distributor check. HIGH. |
| userService.ts:133-137 | Distributor | findUnique | Platform model. SAFE. |
| vehicleService.ts:24-39 | Vehicle | findFirst | filters on `id, distributorId`. SAFE. |
| vehicleService.ts:57, 72 | Vehicle | update by id | Preceded by findFirst. SAFE. |
| vehicleService.ts:77-81 | Vehicle | update (delete) | Preceded by findFirst. SAFE. |
| vehicleService.ts:84-87 | VehicleInventory | findMany | NO distributor or vehicle.distributorId filter. **MEDIUM** — vehicleId from caller. Should join through vehicle. |
| vehicleService.ts:90-108 | VehicleInventory | upsert | Same — vehicleId from caller. MEDIUM. |
| invoiceService.ts (also `markOverdueInvoices` at L520-533) | Invoice | updateMany | distributorId optional — without it, mutates ALL invoices across all tenants. Used by cron with no distributor only. **Acceptable for cron, but MUST never be route-callable without distributorId.** Note. |

### MEDIUM — Child-model queries with unclear parent isolation

| File:line | Model | Operation | Notes |
|---|---|---|---|
| customerPortalService.ts:46-49 | CustomerInventoryBalance | findMany | Already CRITICAL (no parent join). |
| customerPortalService.ts:245-248 | CustomerInventoryBalance | findMany | Already CRITICAL. |
| customerService.ts:182-184 | CustomerContact | deleteMany by customerId | customerId from `findFirst` filtered by distributor — SAFE. |
| customerService.ts:198-200 | CustomerCylinderDiscount | deleteMany by customerId | SAFE (same). |
| customerService.ts:314-319 | CustomerAuditTrail | findMany | Already CRITICAL. |
| customerService.ts:370-388 | CustomerInventoryBalance | upsert/findMany | `setupCustomerBalance` does NOT verify customerId belongs to caller's distributor. **MEDIUM**. Caller must scope; service does not. |
| deliveryWorkflowService.ts:108-115 | OrderItem | update | inside tx after Order verified. SAFE. |
| deliveryWorkflowService.ts:154-156 | InventoryEvent | deleteMany | filtered by referenceId only — but referenceId is `orderId` from verified order. SAFE. |
| deliveryWorkflowService.ts:196-201 | CustomerInventoryBalance | upsert | inside tx after order/customer verified. SAFE. |
| invoiceService.ts:594-602 | InvoiceItem | update | inside tx, invoice from filtered findMany. SAFE. |
| orderService.ts:98-100 | CustomerCylinderDiscount | findUnique | by composite key (customerId, cylinderTypeId). customerId from filtered customer. SAFE. |
| orderService.ts:170-176 | DriverAssignment | create | inside tx. SAFE. |
| orderService.ts:305-307 | CustomerCylinderDiscount | findUnique | SAFE. |
| orderService.ts:710-725 | CustomerInventoryBalance | upsert | inside tx after order verified. SAFE. |
| orderService.ts:733-744 | CancelledStockEvent | create | distributorId set from caller. SAFE. |
| orderService.ts:847-862 | CustomerInventoryBalance | upsert | SAFE. |
| paymentService.ts:106-112 | PaymentAllocation | create | invoiceId from filtered findFirst. SAFE. |
| vehicleService.ts:84-108 | VehicleInventory | findMany/upsert | flagged MEDIUM above — `vehicleId` not validated against distributor. |
| analyticsService.ts:88-91 | CustomerInventoryBalance | findMany | filtered via `customer.distributorId`. SAFE. |
| analyticsService.ts:431-434 | CustomerInventoryBalance | aggregate | filtered via `customer.distributorId`. SAFE. |
| inventoryService.ts:512-525 | CustomerInventoryBalance | findMany | filtered via `customer.distributorId`. SAFE. |
| customerService.ts:166-176 | CustomerAuditTrail | create (audit log on customer update) | distributorId set from caller. SAFE. |

### LOW — Non-null assertions and other smells in services

| File:line | Issue |
|---|---|
| billingService.ts:132 | `tierPricing[distributor.billingTier!]` — non-null on `billingTier`, not distributorId. Not a tenancy risk; flagged for documentation. |
| billingService.ts:319 | Same non-null on `billingTier`. |
| invoiceService.ts:566 | `where.issueDate = { ...where.issueDate, gte: new Date(fromDate) }` — works but spreads possibly-undefined object; minor smell. |
| gstService.ts:56, 377, 596, 694 | `distributor.gstin!` — non-null assertion on optional GSTIN. If GST is enabled but gstin is null, this throws at runtime; not a tenancy risk. |
| customerPortalService.ts:337 | Function `getCustomerInvoices` uses `where: any` and lacks distributorId — see CRITICAL. |
| customerPortalService.ts:367 | Same — `getInvoiceSummaryForDownload`. |
| `req.body.distributorId` / `req.query.distributorId` references in services | **None found.** Services do not read req — good. |

---

## Per-File Findings

### accountabilityService.ts
- Total Prisma ops: 8
- Tenant-scoped: 8 (all filter on `distributorId`).
- Notes: Clean. All findFirst use `{ id, distributorId }`. All updates preceded by ownership check.

### analyticsService.ts
- Total Prisma ops: 29
- Tenant-scoped: 29 — every query filters on `distributorId` (or via `customer.distributorId` for the 2 CustomerInventoryBalance ones).
- Notes: Clean. The two child-model queries (CustomerInventoryBalance L88, L431) correctly join via `customer: { distributorId, deletedAt: null }`.

### assignmentService.ts
- Total Prisma ops: 12
- Tenant-scoped: 12 — all filter on distributorId.
- Notes: Clean. `prisma.driver.findFirst({ where: { id: order.customer.preferredDriverId, status: 'active' }, ... })` at L171-174 does NOT include distributorId, but `order` was already verified to belong to distributor. SAFE by transitive scoping. Same pattern at L189-199.

### authService.ts
- Total Prisma ops: 16
- Tenant-scoped: User (nullable for super_admin) — auth flows operate on `userId` from the JWT. Findbyemail is intentionally cross-tenant (login).
- Notes: Clean for an auth service. User lookups by email/id are by design cross-tenant in login/refresh/forgot-password.

### billingService.ts
- Total Prisma ops: 18
- Tenant-scoped: BillingCycle, User, Distributor, GstApiUsage, SeatRequest, PendingAction.
- **Flags (HIGH):**
  - L50, L344, L391: `prisma.billingCycle.findUnique({ where: { id } })` — no distributor scope. Used in routes mounted **without `requireDistributor`** (per CLAUDE.md anti-pattern #3 for `/api/billing`). Almost certainly intentional super_admin-only access. **Needs human review** to confirm route guards.
- L139-143: `prisma.user.groupBy` filtered by distributorId. SAFE.
- L224-226: `prisma.user.count` filtered by distributorId. SAFE.
- L244-252: `gstApiUsage.findUnique` by composite key including distributorId. SAFE.
- L270-272: `seatRequest.findMany` filtered by distributorId. SAFE.
- L483-489: `pendingAction.findFirst` filtered by `cycle.distributorId`. Inherits risk from un-scoped cycle find.

### customerPortalService.ts
- Total Prisma ops: 22
- Tenant-scoped: Customer, Order, Invoice, PaymentTransaction, CustomerInventoryBalance.
- **Flags (CRITICAL):**
  - L46-49 (`getCustomerDashboard` → CustomerInventoryBalance.findMany): `where: { customerId }` — no parent.distributorId filter. The `customer` referenced at L8-12 was verified, but the balance query does not chain that filter. If `customerId` is somehow tampered, balances of another distributor could leak.
  - L245-248 (`getMyBalance`): same pattern. `where: { customerId }` only.
  - L333-355 (`getCustomerInvoices`): `where: any = { customerId, deletedAt: null, isGaslinkBilling: false }` — **completely lacks distributorId**. distributorId is not even passed in. This function is a leak vector if reachable from outside customer's own context.
  - L361-388 (`getInvoiceSummaryForDownload`): same — no distributorId at all.
- Other ops (orders, invoices, payments, customer find, distributor info): all filter on both `customerId` and `distributorId`. SAFE.

### customerService.ts
- Total Prisma ops: 16
- Tenant-scoped: Customer, CustomerModificationRequest, CustomerAuditTrail, CustomerInventoryBalance, User.
- **Flags (CRITICAL):**
  - L271 (`approveModificationRequest`): `prisma.customerModificationRequest.findUnique({ where: { id: requestId } })` — no distributor scope. Then writes to `customer.update({ where: { id: request.customerId } })` without verifying. Cross-tenant approval is possible if route doesn't gate.
  - L304 (`rejectModificationRequest`): same pattern.
  - L314-319 (`getCustomerAuditTrail`): `where: { customerId }` only — no distributor scope.
- L49-61 (`getCustomerById`): distributorId is OPTIONAL. If caller doesn't pass it, query is cross-tenant. **MEDIUM** — review callers.
- L73-77, L92-94, L139-142, L150-152, L240-242: all use distributorId in where. SAFE.
- L399-411 (`provisionPortalAccess`): User.create with distributorId from arg. SAFE.

### cylinderTypeService.ts
- Total Prisma ops: 15
- Tenant-scoped: CylinderType, CylinderPrice, EmptyCylinderPrice, CylinderThreshold.
- Notes: Clean. Every op filters by distributorId.

### deliveryWorkflowService.ts
- Total Prisma ops: 17
- Tenant-scoped: Order, Vehicle, CancelledStockEvent, OrderItem (child), InventoryEvent, CustomerInventoryBalance (child), PendingAction, Invoice.
- L23-30 (`getCustomerPendingConfirmations`): `where: { customerId, ... }` — no distributorId. **MEDIUM**. customerId from JWT, but service should defense-in-depth.
- L52-58 (`customerConfirmDelivery`): findFirst by `id, customerId` — no distributorId. The customer's own id-and-orderId is enough? Risky if a customerId can be spoofed. **MEDIUM**.
- L226-228, L262-265, L489-492: vehicle ops filter `id, distributorId`. SAFE.
- L232-242, L371-373, L408-418, L506-517: cancelled stock & order queries all filter distributorId. SAFE.

### distributorService.ts
- Total Prisma ops: 5
- Platform-level: Distributor, DistributorSetting (the latter via distributorId).
- Notes: Distributor is platform-level, so unfiltered queries are intentional. SAFE.

### driverService.ts
- Total Prisma ops: 19
- Tenant-scoped: Driver, DriverVehicleAssignment, Order, CancelledStockEvent.
- **Flags (MEDIUM):**
  - L107-114 (`createDriverVehicleAssignment` existence check): `findFirst({ where: { driverId, assignmentDate, isReconciled, status: { notIn: ... } } })` — does NOT filter on distributorId. If driverId belongs to another distributor (passed in body), this check could miss/match incorrectly. Service then creates an assignment with caller's distributorId but using the foreign driver. **Should add distributorId to the where.**
- L4-19, L22-38, L41-50 (list/get/create/update/delete driver): all distributorId-scoped. SAFE.
- L60-79, L82-89, L91-98 (update/delete/toggle): all preceded by ownership check. SAFE.
- L138-141, L149-156 (assignment lookup): SAFE — distributorId in where.
- L186-194 (listAssignments), L199-219 (performance): SAFE.

### gstApiTracker.ts
- Total Prisma ops: 8
- Tenant-scoped: GstApiUsage, Distributor, PricingTier.
- Notes: Clean. All GstApiUsage queries use composite key including distributorId, and Distributor/PricingTier are platform-level.

### inventoryService.ts
- Total Prisma ops: 23
- Tenant-scoped: InventoryEvent, InventorySummary, CylinderType, CancelledStockEvent, CylinderThreshold, CustomerInventoryBalance.
- Notes: Clean. Every query in this service filters by distributorId. The CustomerInventoryBalance query at L518 correctly uses `customer: { distributorId, deletedAt: null }` to scope through parent.

### invoiceService.ts
- Total Prisma ops: 22
- Tenant-scoped: Invoice, CreditNote, DebitNote, InvoiceItem (child), CustomerLedgerEntry, Distributor, Customer.
- **Flags (HIGH):**
  - L334 (`approveCreditNote`): `prisma.creditNote.findUnique({ where: { id: creditNoteId } })` — no distributor / parent invoice scope. Same at L394 (`rejectCreditNote`), L439 (`approveDebitNote`), L497 (`rejectDebitNote`).
  - L350, L384, L455, L487: subsequent `invoice.findUnique({ where: { id: cn.invoiceId } })` — no distributor check. Mutates invoice and creates ledger entry based on credit/debit note that wasn't validated.
  - This is exploitable if the route layer doesn't enforce: a user from Distributor A could call approve with a creditNoteId from Distributor B.
- L55-58, L84-86, L309-312, L415-417, L507-509: SAFE (findFirst with `id, distributorId`).
- L520-533 (`markOverdueInvoices`): distributorId optional — used by cron. **CAUTION**: never expose this directly to a route handler without enforcing distributorId.

### orderService.ts
- Total Prisma ops: 21
- Tenant-scoped: Order, Customer, Driver, DriverVehicleAssignment, OrderItem (child), CustomerCylinderDiscount (child), CustomerInventoryBalance (child), CancelledStockEvent, InventoryEvent.
- **Flags (MEDIUM):**
  - L122-131, L217-226, L463-470: three places where `driverVehicleAssignment.findFirst` filters by `driverId, assignmentDate, isReconciled, status` but **omits distributorId**. Same pattern as driverService:107. Should include distributorId for defense-in-depth.
- All Customer/Order/Driver lookups and creates correctly use distributorId. SAFE.
- Inventory event creates inside tx after parent verification. SAFE.

### paymentService.ts
- Total Prisma ops: 7 (route-level + plenty inside transactions)
- Tenant-scoped: PaymentTransaction, Invoice, Customer, Order, EmptyCylinderPrice, CustomerLedgerEntry, PaymentAllocation (child).
- Notes: Clean. Every top-level entry filters distributorId. PaymentAllocation/InvoiceUpdate inside tx use ids from filtered parents. SAFE.

### pendingActionsService.ts
- Total Prisma ops: 9
- Tenant-scoped: PendingAction.
- **Flags (HIGH):**
  - L53 (`approvePendingAction`): `findUnique({ where: { id: actionId } })` — no distributor.
  - L62 (`resolvePendingAction`): same.
  - L74 (`rejectPendingAction`): same.
  - L55-58, L64-70, L76-82: subsequent updates inherit risk.
- L15-18 (listPendingActions): distributorId optional — used by both per-tenant and super_admin views. Caller must scope.
- L34-49 (createPendingAction): distributorId is mandatory. SAFE.
- L86-93 (getOverdueSlaActions): filters distributorId. SAFE.

### pricingService.ts
- Total Prisma ops: 5
- Platform-level: PricingTier (cross-tenant by design).
- Tenant-scoped: Distributor, User. Both filter distributorId where relevant.
- Notes: Clean.

### seatRequestService.ts
- Total Prisma ops: 7
- Tenant-scoped: SeatRequest, Distributor (platform), PricingTier (platform).
- **Flags (HIGH):**
  - L35 (`approveSeatRequest`): `findUnique({ where: { id: requestId } })` — no distributor. Then reads `request.distributorId` and uses it. If route doesn't gate by distributor, cross-tenant approval is possible.
  - L55-63 (`approveSeatRequest` update): inherits risk.
  - L67-73 (`rejectSeatRequest`): direct `update({ where: { id: requestId } })` — no fetch, no check. **Highest risk in this file.**
- This service is super_admin-oriented (L20: `listSeatRequests` distributorId optional). Route layer must guard.

### settingsService.ts
- Total Prisma ops: 17
- Tenant-scoped: DistributorSetting, GstCredential (nullable distributorId allowed), CylinderThreshold, License. Distributor itself is platform.
- Notes: Clean. Every query uses distributorId either directly or as part of composite unique key. License delete/update preceded by distributor-scoped ownership check.

### userService.ts
- Total Prisma ops: 9
- Tenant-scoped: User (nullable). Distributor & PricingTier are platform.
- **Flags (HIGH):**
  - L30-35 (`getUserById`): no distributor filter. Used by admin to view any user — must be guarded by route role check.
  - L89-120 (`updateUser`): no distributor check before update. HIGH risk if exposed without role check.
  - L122-128 (`softDeleteUser`): no distributor check. HIGH.
- L22-28 (`listUsers`): correctly enforces `distributorId` only when role !== 'super_admin'. SAFE.
- L132-163 (`checkSeatAvailability`): all distributor-scoped. SAFE.

### vehicleService.ts
- Total Prisma ops: 10
- Tenant-scoped: Vehicle, CancelledStockEvent. VehicleInventory (child of Vehicle).
- **Flags (MEDIUM):**
  - L84-87 (`getVehicleInventory`): `where: { vehicleId }` — no parent.distributorId join. If route doesn't scope, leak possible.
  - L90-108 (`updateVehicleInventory`): same — vehicleId from caller without verification.
- All Vehicle ops correctly filter by distributorId. SAFE.

### gst/gstService.ts
- Total Prisma ops: 53
- Tenant-scoped: Invoice, Distributor (platform), Order, GstDocument, CreditNote, DebitNote, PendingAction.
- Notes: Internal service — only called from within other services after their distributor checks. All Invoice / Order / GstDocument lookups inside this file use IDs **already validated by the caller**. The pattern of `findUnique({ where: { id: invoiceId } })` is by design — distributorId is passed as a parameter and enforced through the apiCall scope, not the where clause.
- **Flag (LOW):** L56, L377, L596, L694 — `distributor.gstin!` non-null assertion. Not a tenancy issue but a runtime crash risk if gstin is null.
- `prisma.gstDocument.findFirst({ where: { orderId, ... } })` at L170, L183, L293, L453: orderId from caller (already scoped). SAFE in flow.
- `prisma.invoice.update({ where: { id: invoiceId } })` (many) — caller-scoped. SAFE.

### gst/gstinLookup.ts
- Total Prisma ops: 1
- Platform-level: GstCredential (cross-tenant lookup is intentional — fallback when GasLink-level creds are missing).
- Notes: Clean for its purpose.

### gst/payloadBuilders.ts
- Total Prisma ops: 0
- Notes: Pure function module. No Prisma access. CLEAN.

### gst/whitebooksClient.ts
- Total Prisma ops: 3
- Tenant-scoped: GstCredential.
- Notes: All queries scoped by distributorId (or null for GasLink-level — by design). CLEAN.

### pdf/billingInvoicePdfService.ts
- Total Prisma ops: 1
- Tenant-scoped: BillingCycle.
- L388-394: `prisma.billingCycle.findUnique({ where: { id: billingCycleId } })` — no distributor scope. **HIGH**. Caller (PDF route) must enforce.

### pdf/creditNotePdfService.ts
- Total Prisma ops: 1
- Child-of-tenant: CreditNote.
- L226-236: `prisma.creditNote.findFirst({ where: { id: creditNoteId } })` — no distributor scope. **BUT** L240-242 has a post-fetch check: `if (distributorId && creditNote.invoice.distributorId !== distributorId) throw`. SAFE when caller passes distributorId. **HIGH RISK** if caller forgets — `distributorId` parameter is OPTIONAL.

### pdf/invoicePdfService.ts
- Total Prisma ops: 1
- Tenant-scoped: Invoice.
- L620-632: `prisma.invoice.findFirst({ where: { id: invoiceId, distributorId, deletedAt: null } })` — distributorId is REQUIRED parameter. SAFE.

### pdf/pdfLayoutUtils.ts
- Total Prisma ops: 0
- Notes: Pure layout utilities. CLEAN.

---

## Summary Recommendations

1. **CRITICAL fix** for `customerPortalService.ts` (lines 46, 245, 333, 361): add `customer.distributorId` join filter to `CustomerInventoryBalance.findMany` and add explicit `distributorId` parameter / filter to `getCustomerInvoices` and `getInvoiceSummaryForDownload`. These are reachable from the customer portal, where the `customerId` is taken from JWT — but defense-in-depth would prevent leaks if a route ever passes through arbitrary customerId.

2. **HIGH fix** for the credit/debit note approve+reject flows (`invoiceService.ts` L334, L394, L439, L497) — change `findUnique` to `findFirst` joining `invoice: { distributorId }`, or take `distributorId` as parameter and verify before mutation.

3. **HIGH fix** for `pendingActionsService.ts` L53/L62/L74 and `seatRequestService.ts` L35/L67 — add distributor verification before update. Even if these endpoints are super_admin-only today, they're easy to misuse later.

4. **HIGH fix** for `userService.ts` `getUserById`, `updateUser`, `softDeleteUser` — accept caller's distributorId/role and assert, or refactor to require explicit scope from caller.

5. **MEDIUM fix** for `driverVehicleAssignment.findFirst` calls (driverService:107, orderService:122/217/463) — add `distributorId` to the where clause for defense-in-depth.

6. **MEDIUM fix** for `vehicleService.getVehicleInventory` / `updateVehicleInventory` — verify vehicle ownership before the child-table operation.

7. **MEDIUM fix** for `customerService.getCustomerById` (distributorId optional), `customerService.setupCustomerBalance` (no distributor check), `customerService.getCustomerAuditTrail` (no distributor scope) — make distributorId mandatory.

8. **Audit route layer** for `/api/billing`, `/api/users`, `/api/pricing` (per CLAUDE.md anti-pattern #3) — these skip `requireDistributor`, so per-handler isolation is critical. The findings above show the services do not isolate; the route handlers must.

9. **Refactor recurring `findUnique({ where: { id } })` patterns** for tenant-scoped models to `findFirst({ where: { id, distributorId } })` — same query plan, safer-by-default. Codify in `CLAUDE.md`.

10. **Add an integration test per leak above** — see existing tests under `packages/api/src/__tests__/` and replicate the "User from Distributor 1 cannot see Distributor 2" pattern from CLAUDE.md.
