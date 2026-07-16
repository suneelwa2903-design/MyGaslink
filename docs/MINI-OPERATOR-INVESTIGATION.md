# Mini-Operator Feature — Codebase Impact Investigation

**Scope:** Read-only assessment before adding a "mini-operator" account type to MyGasLink.
**Date:** 2026-07-16
**Author:** Claude Code investigation session (no code/DB changes made)

Design decisions inherited from the pre-brief:
- New `Distributor.accountType` field: `distributor` | `mini_operator`
- New `UserRole` value: `mini_operator_admin`
- Same login, same JWT, same tenant tables — no new isolation model
- Mobile is primary surface; reuse `(admin)` route group with a filtered sidebar
- No GST / IRN / EWB for mini-operators
- New: purchase entry workflow, per-distributor source-distributor list
- Free-text driver name + notes on orders
- Plain invoices only (no IRN/EWB/QR)

---

## Section 1 — UserRole enum impact

### Current state
- Prisma enum ([schema.prisma:14](../packages/api/prisma/schema.prisma#L14)) — 7 values: `super_admin`, `distributor_admin`, `finance`, `inventory`, `driver`, `customer`, `customer_hq`.
- Shared enum ([enums/index.ts:3](../packages/shared/src/enums/index.ts#L3)) — 7 values matching the Prisma names.
- Latest addition (`customer_hq`) landed 2026-07-15 — great reference for the additive pattern we need.

### Files that reference roles today
- **API sources:** 185 files under `packages/api/src/`. High-touch: `middleware/auth.ts` (`requireRole`), every route file, most services, and the two large tests `rolePermissions.test.ts` + `anti-pattern-guards.test.ts`.
- **Web sources:** 39 files. High-touch: `components/layout/Sidebar.tsx`, `routes/ProtectedRoute.tsx`, `routes/index.tsx`, `stores/authStore.ts`, `pages/LoginPage.tsx`.
- **Mobile sources:** 89 files. High-touch: `app/index.tsx` (role switch), every `_layout.tsx` under a route group, `src/stores/authStore.ts`.

### Files that MUST be touched to add `mini_operator_admin`

**Required updates (additive):**
1. `packages/api/prisma/schema.prisma` — add value to `enum UserRole`
2. `packages/api/prisma/migrations/<new>/migration.sql` — add value via `ALTER TYPE`
3. `packages/shared/src/enums/index.ts` — add `MINI_OPERATOR_ADMIN = 'mini_operator_admin'`
4. `packages/api/src/middleware/auth.ts` — `requireRole` already accepts unknown strings; only needs a `super_admin` bypass check (already there) and a `resolveDistributor` update to recognise the new role as tenant-scoped
5. `packages/api/prisma/seed.ts` — new seed user for testing
6. `packages/web/src/components/layout/Sidebar.tsx` — add `miniOperatorMenuItems` array following the `hqMenuItems` pattern; extend the `menuItems = isHq ? … : isCustomer ? … : adminMenuItems` ternary
7. `packages/web/src/routes/ProtectedRoute.tsx` — add fallback branch for the new role (currently: customer → `/app/customer/dashboard`, customer_hq → `/hq`, else → `/app/analytics`)
8. `packages/web/src/routes/index.tsx` — register mini-operator routes (mostly re-uses existing admin pages with a role gate)
9. `packages/mobile/app/index.tsx` — extend `switch (user.role)` with a `case 'mini_operator_admin'` → `/(admin)/dashboard`
10. `packages/api/src/__tests__/rolePermissions.test.ts` — add `loginAsMiniOperatorAdmin` helper and pass/fail rows for every gated endpoint
11. `packages/api/src/__tests__/helpers.ts` — add `loginAsMiniOperatorAdmin` fixture

**Optional (nice-to-have) touches:**
- Every `requireRole('super_admin', 'distributor_admin', 'finance', 'inventory')` call site (~30 sites across route files) may need `'mini_operator_admin'` appended so mini-operator admins can hit the endpoint. This is safer done PER ROUTE than by a `mini_operator_admin` role-wildcard.
- Analytics dashboards / reports that enumerate roles (search: `Object.values(UserRole)`) — none found in the scan, so this is a non-issue.

### Complexity classification
- **Additive-only in 90% of sites.** Most role checks use `requireRole('admin', 'finance', …)` — a positive allow-list. Adding a new role at the DB + enum level and NOT adding it to those allow-lists produces the right behaviour by default (mini-operator lacks the permission).
- **The risk sites are the negative checks** (`role !== 'customer'`, `role !== 'customer_hq'`) — those must be updated to also exclude mini-operator where relevant. `customer_hq` guards were added recently and are a good grep reference.

---

## Section 2 — Distributor model impact

### Current `Distributor` model ([schema.prisma:388-511](../packages/api/prisma/schema.prisma#L388))
No `accountType` field exists today. Confirmed by grep — 0 hits for `accountType|account_type|AccountType` in the schema.

The model already carries `subscriptionPlan`, `billingTier`, `billingSuspended`, `gaslinkBillingEnabled`, `gstMode`, `isTestTenant`, `docCode`, Razorpay fields, etc. — plenty of prior art for optional discriminator fields.

### Changes needed

**Prisma schema ([schema.prisma:388-511](../packages/api/prisma/schema.prisma#L388)):**
```prisma
enum AccountType {
  distributor
  mini_operator
}

model Distributor {
  // ... existing fields ...
  accountType AccountType @default(distributor) @map("account_type")
  // ... existing fields ...
}
```

**Migration:** `ALTER TABLE distributors ADD COLUMN account_type … DEFAULT 'distributor' NOT NULL;` — safe against existing rows because of `DEFAULT`.

**`distributorSelect` ([distributorService.ts:4-56](../packages/api/src/services/distributorService.ts#L4)):** add `accountType: true,`

**`createDistributor` param type ([distributorService.ts:109-138](../packages/api/src/services/distributorService.ts#L109)):** add `accountType?: 'distributor' | 'mini_operator'`; pass through to `prisma.distributor.create` `data`.

**`updateDistributor` param type ([distributorService.ts:180-225](../packages/api/src/services/distributorService.ts#L180)):** add `accountType` (super-admin only mutation — same pattern as `isTestTenant` and `razorpayEnabled` in the same file).

**Shared schemas (`packages/shared/src/schemas/index.ts`):**
- `createDistributorSchema` + `updateDistributorSchema` need `accountType: z.enum(['distributor', 'mini_operator']).optional()`.

**Route ([routes/distributors.ts:93](../packages/api/src/routes/distributors.ts#L93)):**
- Wire the new schema; strip `accountType` for non-super-admin PUT callers (mirror the `isTestTenant` / `razorpayEnabled` strip pattern at [distributorService.ts:217-224](../packages/api/src/services/distributorService.ts#L217)).

**Super Admin UI ([DistributorsPage.tsx:222-479](../packages/web/src/pages/DistributorsPage.tsx#L222)):**
- The form uses `zodResolver(isEdit ? updateDistributorSchema : createDistributorSchema)` and enumerates form fields inline. Add a `<Select>` for "Account Type" with options `Distributor` (default) and `Mini-Operator`. Two impacts:
  - When `accountType='mini_operator'`, some existing fields (bank details, godown address, GST fields) may be hidden or de-required. Confirm during implementation whether we tighten or leave as-is.
  - Billing tier defaults may change — mini-operator plan is `₹1,999/month` per the requirements.

**Nothing else in the schema needs to change** for accountType alone. Every downstream table already scopes by `distributorId` — mini-operator rows land in the same tables as regular distributor rows.

---

## Section 3 — GST guard assessment

### Every GST call gates on `distributor.gstMode`

Grep hit 40+ call sites in `packages/api/src/services/`. Pattern is uniform:
```ts
const distributor = await prisma.distributor.findUnique({ ..., select: { gstMode: true, ... } });
if (!distributor || distributor.gstMode === 'disabled') { /* short-circuit */ }
```

Verified at (representative sample):
- [gstService.ts:229-232](../packages/api/src/services/gst/gstService.ts#L229) — `processInvoiceGst`
- [gstService.ts:777-779](../packages/api/src/services/gst/gstService.ts#L777) — `cancelIrn`
- [gstService.ts:1067-1069](../packages/api/src/services/gst/gstService.ts#L1067) — `processCreditNoteGst`
- [gstService.ts:1172-1174](../packages/api/src/services/gst/gstService.ts#L1172) — `processDebitNoteGst`
- [gstReissueService.ts:101-106](../packages/api/src/services/gst/gstReissueService.ts#L101) — `reissueGst`
- [gstPreflightService.ts:166-193](../packages/api/src/services/gst/gstPreflightService.ts#L166) — `runB2bPreflight`
- [gstPreflightService.ts:534-573](../packages/api/src/services/gst/gstPreflightService.ts#L534) — `runB2cPreflight`
- [invoiceService.ts:900-902](../packages/api/src/services/invoiceService.ts#L900) — `attachIrnMetadata`
- [invoiceService.ts:173](../packages/api/src/services/invoiceService.ts#L173) — `gstEnabled` boolean in `createInvoiceFromOrder`

### Verdict — **YES, `gstMode='disabled'` is sufficient**

Every path that could hit WhiteBooks / NIC / IRN / EWB short-circuits when `gstMode='disabled'`. No additional role-based guard is needed for mini-operators.

**But:** we should still make it a hard invariant that `Distributor.accountType='mini_operator'` implies `gstMode='disabled'`.
- Enforce at write time in `updateDistributor` — reject transitions of `gstMode` to `sandbox` / `live` when `accountType='mini_operator'`.
- Enforce at the Super Admin UI — hide/disable the GST mode selector for mini-operators.
- Enforce in the GST activation route ([routes/adminGstActivation.ts:37-108](../packages/api/src/routes/adminGstActivation.ts#L37)) — reject activation when `accountType='mini_operator'`.

This is a **defence-in-depth** measure — the primary guard is already `gstMode`; the accountType invariant just prevents a super-admin from accidentally flipping a mini-operator into GST mode via the settings page.

---

## Section 4 — Plain invoice + PDF status

### Invoice creation ([invoiceService.ts:150-262](../packages/api/src/services/invoiceService.ts#L150))
`createInvoiceFromOrder` already has a clean `gstEnabled` branch:
- `gstEnabled = distributor.gstMode === 'sandbox' || 'live'`
- When `false`: no GST breakup, `gstRate=0`, `taxableValue=lineTotal`, `unitPrice/totalPrice/discountPerUnit` written as-is (no `/1.18` inversion).
- Invoice number allocation ([invoiceService.ts:187-194](../packages/api/src/services/invoiceService.ts#L187)) — uses structured `I<CODE><FY><SEQ>` when `docCode` is set, else legacy random. Works identically for mini-operators.

### PDF rendering ([invoicePdfService.ts:634-657](../packages/api/src/services/pdf/invoicePdfService.ts#L634))
`drawComplianceSection` has an early return:
```ts
const hasIrn = !!irn;
const hasEwb = !!ewbNo;
if (!hasIrn && !hasEwb) return 0;
```
When neither IRN nor EWB exists, the entire "e-Documents" section (IRN card, EWB card, QR code, ack details) is skipped — the PDF renders with items table + tax summary + payment details + terms only.

### Verdict — **Works today with `gstMode='disabled'`, no code changes needed for plain invoices**

Both the invoice-item write path and the PDF render path already handle the disabled-GST case gracefully. Mini-operators will get plain invoices "for free" once `accountType` gates them into `gstMode='disabled'`.

**Confirm during implementation:**
- Invoice item ordering / formatting is identical between GST-enabled and disabled paths — should double-check the PDF against a Sharma (GST-live) invoice side-by-side to make sure nothing looks visually "missing" for a mini-operator.
- The tax summary block on the PDF renders `CGST/SGST/IGST = 0` for disabled tenants — check if we want to hide those rows entirely for mini-operators (small UX polish, not a blocker).

---

## Section 5 — Order model gaps

### Current `Order` model ([schema.prisma:918-1014](../packages/api/prisma/schema.prisma#L918))
Already has:
- `driverId String? @map("driver_id")` — FK (nullable)
- `vehicleId String? @map("vehicle_id")` — FK (nullable)
- `specialInstructions String? @map("special_instructions")` — free-text at order time
- `deliveryNotes String? @map("delivery_notes")` — free-text at delivery time
- `deliveryLatitude/Longitude` — captured at delivery
- `poNumber` — buyer's PO (B2B, max 16 chars per NIC PoDtls cap)

Does NOT have:
- **`driverNameFreeText`** — a free-text driver name for mini-operators who don't have Driver records. Needs to be added.

### `createOrderSchema` ([shared/schemas/index.ts:226-243](../packages/shared/src/schemas/index.ts#L226))
Currently accepts:
- `customerId, deliveryDate, items[]`
- `specialInstructions.max(500).optional()`
- `poNumber.max(16).optional()`
- `isGodownPickup.default(false)`
- `orderType.enum(['delivery', 'returns_only']).default('delivery')`
- `cancelledStockEventId.optional()`

No `driverName` free-text field. Note lines 493 and 510 in the same file show `driverName.max(100).optional()` — those are for different schemas (backdated order + reconciliation flow), not the primary `createOrderSchema`.

### Changes needed
1. Add `driverNameFreeText String? @map("driver_name_free_text")` to `Order` model.
2. Add `driverNameFreeText: z.string().max(100).optional()` to `createOrderSchema` in shared.
3. Wire through `orderService.createOrder` — pass value into `prisma.order.create` `data`.
4. Add `driverNameFreeText` to the mobile order-create form in `packages/mobile/app/(admin)/orders.tsx`.
5. Add to the web order-create modal in `packages/web/src/pages/OrdersPage.tsx`.
6. Add to the Order response mapper (`packages/api/src/utils/mappers.ts`) so the field flows out to the UI on order detail.
7. Add to PDF rendering — trip-sheet PDF + invoice PDF may want to show the driver name in the header.

**Naming note:** we should use `driverNameFreeText` (or similar) to distinguish from the future `driverId → driver.driverName` relation. Prevents anti-pattern #17 (naming drift between adjacent surfaces).

### Notes field for mini-operators
`Order.deliveryNotes` already covers "notes at delivery time" and `Order.specialInstructions` covers "notes at order time". Both are already surfaced in the UI. **No new notes field needed** — mini-operators can use these.

---

## Section 6 — Purchase entry + source distributor + opening stock

### Existing purchase concept — **NONE**
Grep for `purchase | Purchase | stockIn | InventoryPurchase` in `packages/api/src/` returned only:
- `invoicePdfService.ts` + `payloadBuilders.ts` — references to buyer's PURCHASE ORDER number (unrelated concept, from customer PO on invoice)
- No `PurchaseEntry`, `SourceDistributor`, `StockIn` model in schema

**Confirmed: no existing purchase entry model. New models required.**

### Opening stock — **ALREADY EXISTS**

- `POST /api/inventory/initial-balance` ([routes/inventory.ts:117-156](../packages/api/src/routes/inventory.ts#L117))
- Accepts `entries[]: { cylinderTypeId, openingFulls, openingEmpties }` with optional `eventDate` + `replaceExisting`
- Backed by `inventoryService.recordInitialBalance` ([inventoryService.ts:427-560](../packages/api/src/services/inventoryService.ts#L427))
- Writes `initial_balance` inventory events (rich existing enum value)
- Handles conflict: 409 `OPENING_STOCK_CONFLICT` with per-type current values so the UI can prompt "Replace 19KG opening 30 → 50?"
- Rich UX already: admin web has an "Opening Stock" modal; onboarding checklist tracks `opening_stock` completion ([customerService.ts:1258](../packages/api/src/services/customerService.ts#L1258))

**Reuse verdict:** Mini-operators can use the EXISTING `/api/inventory/initial-balance` endpoint verbatim. No changes required except:
- Add `mini_operator_admin` to the `requireRole` allowlist on the route ([inventory.ts:118](../packages/api/src/routes/inventory.ts#L118))
- Add the endpoint call to the mobile inventory screen (currently web-only). See Section 9 for the mobile inventory reuse pattern.

### Purchase entry — new models

Two new tables + one enum value. Proposed shape:

```prisma
model SourceDistributor {
  id            String   @id @default(uuid()) @map("source_distributor_id")
  distributorId String   @map("distributor_id")           // owning mini-operator
  name          String                                     // free-text supplier name
  isActive      Boolean  @default(true) @map("is_active")
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  distributor   Distributor @relation(fields: [distributorId], references: [id])
  purchases     PurchaseEntry[]

  @@unique([distributorId, name])
  @@index([distributorId, isActive])
  @@map("source_distributors")
}

model PurchaseEntry {
  id                    String   @id @default(uuid()) @map("purchase_entry_id")
  distributorId         String   @map("distributor_id")
  sourceDistributorId   String?  @map("source_distributor_id")     // FK, nullable in case source list is empty
  sourceDistributorName String   @map("source_distributor_name")    // denormalised — same pattern as customerNameSnapshot on Invoice
  purchaseDate          DateTime @map("purchase_date") @db.Date
  entryNumber           String   @unique @map("entry_number")       // structured "P<CODE><FY><SEQ>" via existing allocateNumber
  notes                 String?
  createdBy             String   @map("created_by")
  createdAt             DateTime @default(now()) @map("created_at")
  updatedAt             DateTime @updatedAt @map("updated_at")
  deletedAt             DateTime? @map("deleted_at")

  distributor       Distributor        @relation(fields: [distributorId], references: [id])
  sourceDistributor SourceDistributor? @relation(fields: [sourceDistributorId], references: [id])
  items             PurchaseEntryItem[]

  @@index([distributorId, purchaseDate(sort: Desc)])
  @@map("purchase_entries")
}

model PurchaseEntryItem {
  id                 String   @id @default(uuid()) @map("purchase_entry_item_id")
  purchaseEntryId    String   @map("purchase_entry_id")
  cylinderTypeId     String   @map("cylinder_type_id")
  fullsReceived      Int      @default(0) @map("fulls_received")
  emptiesGivenOut    Int      @default(0) @map("empties_given_out")
  createdAt          DateTime @default(now()) @map("created_at")

  purchaseEntry PurchaseEntry @relation(fields: [purchaseEntryId], references: [id])
  cylinderType  CylinderType  @relation(fields: [cylinderTypeId], references: [id])

  @@map("purchase_entry_items")
}
```

**Two-tier design rationale:**
- `PurchaseEntry` is the HEADER (audit row — who bought when, from whom, at what document ref).
- `PurchaseEntryItem` is the per-cylinder-type row.
- Each `PurchaseEntryItem` triggers 2 `InventoryEvent` writes at commit time:
  - `incoming_fulls` with `fullsChange = fullsReceived`, `referenceId = purchaseEntryId`
  - `outgoing_empties` with `emptiesChange = -emptiesGivenOut`, `referenceId = purchaseEntryId`
- Both events already have `documentType/documentNumber` slots so PDF re-renders trace back to the purchase entry cleanly.

**No new InventoryEventType enum values needed** — `incoming_fulls` and `outgoing_empties` already exist ([schema.prisma:166-167](../packages/api/prisma/schema.prisma#L166)) and are used by the current "Incoming Fulls / Outgoing Empties" modals in the admin inventory screen (referenced at [inventoryService.ts:28](../packages/api/src/services/inventoryService.ts#L28)).

**Numbering:** reuse `allocateNumber(tx, distributorId, 'P', purchaseDate, docCode)` — the existing numbering service supports arbitrary document types via the single-letter prefix ([invoiceService.ts:187-194](../packages/api/src/services/invoiceService.ts#L187)).

---

## Section 7 — Mobile routing approach

### Current `app/index.tsx` role switch ([app/index.tsx:19-50](../packages/mobile/app/index.tsx#L19))
```ts
switch (user.role) {
  case 'customer':             router.replace('/(customer)/dashboard'); break;
  case 'driver':               router.replace('/(driver)/orders'); break;
  case 'super_admin':          router.replace('/(super-admin)/dashboard'); break;
  case 'distributor_admin':    router.replace('/(admin)/dashboard'); break;
  case 'inventory':            router.replace('/(inventory)/analytics'); break;
  case 'finance':              router.replace('/(finance)/dashboard'); break;
  case 'customer_hq':          router.replace('/(hq)'); break;
  default:                     router.replace('/(auth)/login');
}
```

### `(admin)/_layout.tsx` current tab set ([packages/mobile/app/(admin)/_layout.tsx](../packages/mobile/app/(admin)/_layout.tsx))
9 visible tabs (STAGE-H expanded): Dashboard, Orders, Billing (finance.tsx), Inventory, Reports, Customers, Fleet, Collections, More. Plus 5 hidden screens routable via `router.push`: pending-actions, customer-detail, customer-create, profile, pending-payments.

### Reference: `(hq)` route group ([packages/mobile/app/(hq)/_layout.tsx](../packages/mobile/app/(hq)/_layout.tsx), [index.tsx](../packages/mobile/app/(hq)/index.tsx))
`(hq)` is a **separate route group** with its own `<Stack>` — used because HQ is web-only in v1 and just shows a "please use web" fallback. Not a good reference for mini-operator (which needs the same screens as admin).

### Recommendation — **Route through `(admin)` with a tab filter**

Rationale:
- Mini-operators need the SAME screens the admin sees for Dashboard, Orders, Inventory, Customers.
- They need the SAME dispatch modals, order forms, customer detail views — reusing avoids fork/drift.
- The `_layout.tsx` `<Tabs.Screen>` config supports conditional rendering — we can hide Fleet, Collections, Reports for mini-operator by wrapping the tab entries in `{isMiniOperator ? null : <Tabs.Screen … />}`.

**Implementation sketch:**
1. `app/index.tsx` — add `case 'mini_operator_admin': router.replace('/(admin)/dashboard'); break;`
2. `app/(admin)/_layout.tsx` — read `user.role` from `useAuthStore`, compute `isMiniOperator = role === 'mini_operator_admin'`. Wrap Fleet, Collections, Reports, and (fine)/finance-adjacent tabs in a `!isMiniOperator &&` guard.
3. Screens that mini-operators MUST NOT see (Trip management, Preflight modals, GST-related sections) — the underlying components already gate on `distributor.gstMode` and `orderType`, so those parts of the UI auto-hide. Confirm this per screen during implementation.
4. NEW: add a "Purchase" tab (or route it under Inventory as a sub-view — recommended, keeps tab count sane).

**Alternative:** create a separate `(mini)` route group.
- **Pro:** cleaner separation, no runtime tab filtering.
- **Con:** duplicates ~15 admin screens, high drift risk, doubles the surface to keep in feature parity.
- **Verdict:** NOT recommended. The tab-filter approach costs one extra prop; the route-group approach costs a maintenance tax on every future admin feature.

**User-approved decision:** filter within `(admin)`, per the pre-brief's Option A.

---

## Section 8 — Web sidebar approach

### Current pattern ([Sidebar.tsx:41-247](../packages/web/src/components/layout/Sidebar.tsx#L41))
Three menu arrays defined at module scope:
- `adminMenuItems` — 13 items with `roles: UserRole[]` allowlist
- `hqMenuItems` — 7 items, all `roles: [UserRole.CUSTOMER_HQ]` (added 2026-07-15)
- `customerMenuItems` — 5 items

Selection at [Sidebar.tsx:269](../packages/web/src/components/layout/Sidebar.tsx#L269):
```ts
const menuItems = isHq ? hqMenuItems : isCustomer ? customerMenuItems : adminMenuItems;
```

Visibility filter at [Sidebar.tsx:288-292](../packages/web/src/components/layout/Sidebar.tsx#L288):
```ts
const visibleItems = menuItems.filter((item) => {
  if (!userRole) return false;
  if (userRole === UserRole.SUPER_ADMIN) return true;
  return item.roles.includes(userRole);
});
```

### Recommendation — **Follow the `hqMenuItems` pattern exactly**

Add `miniOperatorMenuItems`:
```ts
const miniOperatorMenuItems: MenuItem[] = [
  { label: 'Dashboard',           path: '/app/analytics',        icon: HiOutlineChartBar,            roles: [UserRole.MINI_OPERATOR_ADMIN] },
  { label: 'Orders',              path: '/app/orders',           icon: HiOutlineClipboardDocumentList, roles: [UserRole.MINI_OPERATOR_ADMIN] },
  { label: 'Inventory',           path: '/app/inventory',        icon: HiOutlineCube,                roles: [UserRole.MINI_OPERATOR_ADMIN] },
  { label: 'Customers',           path: '/app/customers',        icon: HiOutlineUsers,               roles: [UserRole.MINI_OPERATOR_ADMIN] },
  { label: 'Billing & Payments',  path: '/app/billing-payments', icon: HiOutlineBanknotes,           roles: [UserRole.MINI_OPERATOR_ADMIN] },
  { label: 'Settings',            path: '/app/settings',         icon: HiOutlineCog6Tooth,           roles: [UserRole.MINI_OPERATOR_ADMIN] },
];
```

Update selector at [Sidebar.tsx:269](../packages/web/src/components/layout/Sidebar.tsx#L269):
```ts
const isMiniOperator = userRole === UserRole.MINI_OPERATOR_ADMIN;
const menuItems = isHq
  ? hqMenuItems
  : isCustomer
    ? customerMenuItems
    : isMiniOperator
      ? miniOperatorMenuItems
      : adminMenuItems;
```

### `ProtectedRoute.tsx` changes ([routes/ProtectedRoute.tsx:58-72](../packages/web/src/routes/ProtectedRoute.tsx#L58))
Extend the fallback map:
```ts
const fallback =
  userRole === UserRole.CUSTOMER            ? '/app/customer/dashboard'
  : userRole === UserRole.CUSTOMER_HQ       ? '/hq'
  : userRole === UserRole.MINI_OPERATOR_ADMIN ? '/app/analytics'  // or '/app/orders'
  : '/app/analytics';
```

### `routes/index.tsx` changes
Verify every route that mini-operator SHOULD access has `allowedRoles` inclusive of `MINI_OPERATOR_ADMIN`. Routes to explicitly EXCLUDE mini-operator from:
- `/app/fleet`, `/app/collections`, `/app/reports`
- `/app/distributors`, `/app/provider-catalog`, `/app/health`, `/app/deletion-requests` (super-admin-only anyway)
- Any GST-related settings sub-tabs

### Screens that need per-role sub-view logic
- `/app/settings` — hide GST tab, hide Razorpay tab, hide Delivery-Verification section for mini-operators. Purchase entries + Source distributors get NEW tabs under Settings (or under Inventory — see implementation-time discussion).
- `/app/inventory` — surface purchase-entry creation as a primary action. Already houses the initial-balance modal.
- `/app/orders` — hide Preflight / Trip / Assign-driver buttons; show "Driver name" free-text field.
- `/app/billing-payments` — hide GST columns (IRN status, EWB status).

---

## Section 9 — Inventory infrastructure reuse

### Current infrastructure

**`InventoryEvent` model ([schema.prisma:1624-1656](../packages/api/prisma/schema.prisma#L1624)):** Rich columns already:
- `fullsChange`, `emptiesChange`, `eventDate`
- `referenceId`, `referenceType`, `documentType`, `documentNumber`, `documentDate`
- `vehicleNumber`, `driverName` (free-text field on the EVENT — already exists)
- `amount`, `condition` (good/defective), `authorizationRef`, `notes`, `createdBy`

**`InventorySummary` model ([schema.prisma:1658-1687](../packages/api/prisma/schema.prisma#L1658)):** Daily rollup with `openingFulls`, `openingEmpties`, `incomingFulls`, `outgoingEmpties`, `deliveredQty`, `dispatchedQty`, `collectedEmpties`, `emptiesReturnedVerified`, `cancelledStockQty`, `manualAdjustment`, `closingFulls`, `closingEmpties`. Roll-forward from previous day.

**`InventoryEventType` enum ([schema.prisma:165-178](../packages/api/prisma/schema.prisma#L165)):** 12 values — `incoming_fulls`, `outgoing_empties`, `delivery`, `collection`, `manual_adjustment`, `cancellation`, `cancellation_return`, `initial_balance`, `write_off`, `returns_collection`, `dispatch`, `reconciliation_empties_return`.

**`createInventoryEvent()` service ([inventoryService.ts:12-58](../packages/api/src/services/inventoryService.ts#L12)):** The SINGLE write path for all inventory changes. Every consumer goes through this. Idempotent-safe when used inside a `prisma.$transaction`.

**`computeSummaryForDate()` service ([inventoryService.ts:64-220](../packages/api/src/services/inventoryService.ts#L64)):** Event-sourced rollup that produces the InventorySummary row from InventoryEvent rows. Handles all 12 event types with dedicated switch cases.

### Reuse verdict — **100% reuse, zero new inventory event model**

Mini-operator flows map cleanly onto existing event types:

| Mini-operator flow | Event type | fullsChange | emptiesChange |
|--------------------|------------|-------------|---------------|
| Opening stock | `initial_balance` | +openingFulls | +openingEmpties |
| Purchase — fulls in | `incoming_fulls` | +fullsReceived | 0 |
| Purchase — empties out | `outgoing_empties` | 0 | −emptiesGivenOut |
| Order delivered | `delivery` | −deliveredQty | +collectedEmpties |
| Manual correction | `manual_adjustment` | ±adjustment | ±adjustment |

`computeSummaryForDate` already handles all five. The mini-operator gets closing stock rollup for free.

### Small additions
1. **PurchaseEntry → InventoryEvent bridge** — in the new purchase-entry service, wrap the header+items write and the per-item `createInventoryEvent` calls in a single `prisma.$transaction`. Pattern lifted from `runB2bPreflight` at [gstPreflightService.ts:328-380](../packages/api/src/services/gst/gstPreflightService.ts#L328) which similarly writes events inside a service transaction.
2. **Reference tracking** — populate `referenceId = purchaseEntryId, referenceType = 'purchase_entry'` so downstream reports can join event → purchase entry cleanly.
3. **Document number** — set `documentType = 'purchase_entry', documentNumber = entryNumber` so audit logs surface a human-readable entry number.

### Web/Mobile UI reuse
- Existing admin inventory screens ([web/src/pages/InventoryPage.tsx](../packages/web/src/pages/InventoryPage.tsx), [mobile/app/(admin)/inventory.tsx](../packages/mobile/app/(admin)/inventory.tsx)) already have "Incoming Fulls" and "Outgoing Empties" modals. Confirm during implementation whether the existing modals are a natural container for purchase-entry entry — i.e. does it feel better to (a) reuse those modals with a "source distributor" dropdown added, or (b) add a NEW "Purchase Entry" primary action that combines both fulls-in + empties-out in one form. Recommendation: (b) — matches the mini-operator's mental model ("I bought a load from Sharma today") and produces one PurchaseEntry header row instead of two disconnected events.

---

## Section 10 — Regression risk assessment

### Top 10 highest-risk files (ranked by impact × likelihood)

| # | File | Risk | Change type | Notes |
|---|------|------|-------------|-------|
| 1 | `packages/api/prisma/schema.prisma` | HIGH | additive | Enum + model changes. Migration must default `accountType='distributor'` for all existing rows. Any drift between the Prisma enum name and the shared TS enum name is anti-pattern #9 — will silently break wire shapes on the affected consumer. |
| 2 | `packages/shared/src/enums/index.ts` | HIGH | additive | Must stay 1:1 with the Prisma enum. If the string values don't match (e.g. Prisma emits `mini_operator_admin` but shared says `MINI_OPERATOR_ADMIN` — different **string values**) every JWT-based role check breaks. |
| 3 | `packages/api/src/middleware/auth.ts` | HIGH | additive+ | `requireRole` at line 133 already auto-passes super_admin (line 140). Adding `mini_operator_admin` to allow-lists is per-endpoint. `resolveDistributor` needs to treat the new role as tenant-scoped (currently super_admin is the only cross-tenant role). |
| 4 | `packages/api/src/__tests__/rolePermissions.test.ts` | HIGH | additive | Exhaustive matrix. Adding a role means adding pass/fail rows for every gated endpoint (~15 rows in the existing test). CI will fail loudly if omitted — good. |
| 5 | `packages/api/src/services/distributorService.ts` | MEDIUM | modifying | `distributorSelect`, `createDistributor` param type, `updateDistributor` param type. If `accountType` is missed in `distributorSelect`, downstream code reading it becomes undefined and all conditionals evaluate to false (anti-pattern #9 territory). |
| 6 | `packages/web/src/components/layout/Sidebar.tsx` | MEDIUM | additive | Add `miniOperatorMenuItems` + selector branch. Low-risk if we follow the `hqMenuItems` pattern verbatim. |
| 7 | `packages/web/src/routes/ProtectedRoute.tsx` | MEDIUM | modifying | Update fallback map to include mini-operator. Missing this means a mini-operator user without a valid `allowedRoles` match lands on `/app/analytics` — which they may not have permission to see, causing an infinite bounce. |
| 8 | `packages/mobile/app/index.tsx` | MEDIUM | additive | Add `case 'mini_operator_admin'`. Missing this drops the user into `/(auth)/login` via the default branch — silent failure. |
| 9 | `packages/mobile/app/(admin)/_layout.tsx` | MEDIUM | modifying | Conditional tab rendering. If the role check goes wrong direction (`!isMiniOperator` vs `isMiniOperator`), tabs disappear for the wrong users — high-visibility regression. |
| 10 | `packages/api/src/routes/inventory.ts` | LOW | additive | Add `mini_operator_admin` to the `requireRole` allowlist for opening-balance + manual-adjustment routes. Missed → mini-operator sees 403 on inventory ops. |

### Middleware / route allow-list check
`requireRole` in [middleware/auth.ts:133-145](../packages/api/src/middleware/auth.ts#L133) — clean pattern, does not deny unknown roles (positive allowlist). Adding a new UserRole enum value to the Prisma schema without updating any `requireRole` call sites means the new role has **zero permissions** by default — correct fail-safe. This dramatically de-risks the rollout: if we forget to add mini-operator to a permission list, they see 403, not silent access to something they shouldn't have.

### Test enumeration risk
- `Object.values(UserRole)` — 0 hits in the codebase. No exhaustive enumeration to update.
- `all.*roles` / `roles.*all` — 0 test hits (matches were the string "all" appearing in test descriptions, not role enumeration).
- Test-only role enumeration lives in `rolePermissions.test.ts` and `helpers.ts` (login helpers) — both will fail CI loudly if we don't add the new role. Good.

### Billing query risk
- `billingService.ts` gates on `subscriptionPlan` and `billingTier` — orthogonal to `accountType`. New mini-operator plan (`₹1,999/month`) needs a new `SubscriptionPlan` enum value (or reuse an existing tier with a comment). The mini-operator's billing does NOT branch on `accountType`, so `billingService.ts` needs at most one new plan / tier value.

### Migration risk
- Adding a new enum value to Postgres via `ALTER TYPE … ADD VALUE …` is a single-statement DDL and safe. Adding a new column with a `DEFAULT` value backfills atomically.
- **Trap:** the `DEFAULT 'distributor'` must be applied at the DB level, not just Prisma-side. Prisma migrations do this by default via `ALTER TABLE … ADD COLUMN … DEFAULT 'distributor' NOT NULL;` — verify the generated migration SQL before applying.

---

## Summary — build order recommendation

If we approve the design, the safest build order is:

1. **Schema layer** — Prisma `UserRole` enum + `AccountType` enum + `Distributor.accountType` + `SourceDistributor` + `PurchaseEntry` + `PurchaseEntryItem` + `Order.driverNameFreeText`. One migration.
2. **Shared layer** — `UserRole.MINI_OPERATOR_ADMIN`, `AccountType`, extended `createDistributorSchema` / `updateDistributorSchema` / `createOrderSchema`, new `purchaseEntrySchema` + `sourceDistributorSchema`.
3. **API layer** — `distributorService` updates + new `purchaseEntryService` + new `sourceDistributorService` + routes. Extend `orderService` for `driverNameFreeText`. Update `requireRole` allowlists on inventory + orders + customers routes.
4. **Test layer** — Extend `rolePermissions.test.ts` matrix. Add wire-shape guards for the new response fields (anti-pattern #9 discipline). Add integration tests for purchase-entry → inventory-event bridge.
5. **Web layer** — Sidebar `miniOperatorMenuItems`, `ProtectedRoute` fallback, Settings tabs (Purchase Entries + Source Distributors + Companies), new `PurchaseEntriesPage.tsx`.
6. **Mobile layer** — `app/index.tsx` role switch, `(admin)/_layout.tsx` conditional tabs, purchase-entry modal on inventory screen, driver-name-free-text field on order create form.

**Blocking design questions to resolve before build:**

1. **Purchase entry number format** — Confirm `P<CODE><FY><SEQ>` reuses the `invoiceCounters` machinery (or does purchase entry need its own counter table)?
2. **`SourceDistributor` — global or per-tenant?** — Assumed per-tenant based on the requirements ("mini-operator lists distributors they buy from"). Confirm at implementation time.
3. **Billing plan for mini-operator** — Is there a new `SubscriptionPlan` enum value (e.g. `mini_operator_v1`) or does it reuse an existing tier?
4. **LPG company selection** — the requirements say "mini-operator selects one or more LPG companies (HPCL/BPCL/IOCL)" and cylinder types auto-populate. This maps to the existing `ProviderCatalog*` tables ([schema.prisma:836-870](../packages/api/prisma/schema.prisma#L836) — CylinderType.providerCatalogId). Confirm the setup flow: does the super-admin pick the companies at mini-operator creation, or does the mini-operator pick them during onboarding?
5. **Order status simplification** — mini-operators have no dispatch/trip flow. Orders should go straight from `pending_driver_assignment` (or a new simpler status) to `delivered`. Confirm we're comfortable adding a new short-circuit path in `orderService.createOrder` that skips the driver-assignment status when `accountType='mini_operator'`.

Investigation complete. No code or DB changes made.
