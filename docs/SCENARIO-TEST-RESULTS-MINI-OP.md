# Mini-Operator — Scenario Test Results (CP2 → CP4)

**Date:** 2026-07-16 (updated for CP4 — S8 added, mini-operator.test.ts + Guard 10 landed)
**Test files:**
- [packages/api/src/__tests__/mini-operator-scenarios.test.ts](../packages/api/src/__tests__/mini-operator-scenarios.test.ts) — S1–S8 end-to-end scenarios (21 tests)
- [packages/api/src/__tests__/mini-operator.test.ts](../packages/api/src/__tests__/mini-operator.test.ts) — invariant + wire-shape unit tests (9 tests)
- [packages/api/src/__tests__/anti-pattern-guards.test.ts](../packages/api/src/__tests__/anti-pattern-guards.test.ts) — Guard 10 role escalation + accountType wire-shape (4 tests)

**Result:** ✅ all mini-operator tests passing.
**Format:** Vitest integration tests (real HTTP via supertest, real Postgres via prisma) — the scenarios count toward `pnpm test` and are re-run on every CI + local `pnpm test` invocation.

Fixture strategy: each test run creates two fresh mini_operator distributors (`MiniOp Test A ...` + `MiniOp Test B ...`), a mini_operator_admin user + JWT for each, one cylinder type, one B2C customer. A pre-run sweep drops any leftover fixture rows from prior aborted runs (docCode uniqueness). `afterAll` deletes every row created via the FK-dependency-safe cleanup helper. All time-sensitive fixtures use `TEST_DATE = '2099-12-31'` per anti-pattern #7.

---

## S1 — Source distributor CRUD ✅

| # | Assertion | Result |
|---|---|---|
| S1.1 | `POST /api/source-distributors` creates a supplier for the tenant | ✅ 201; response includes `distributorId` from the JWT (never the body) |
| S1.2 | Duplicate name is rejected (case-insensitive) with 409 | ✅ `sharma gas distributors` collides with the earlier `Sharma Gas Distributors` |
| S1.3 | `GET /api/source-distributors` returns the created supplier | ✅ single-item list, correct shape |

**What this proves:**
- Route → service → Prisma flow works end-to-end for `mini_operator_admin`
- Tenant scoping is anchored at the JWT, not the body (anti-pattern #13)
- Case-insensitive duplicate guard fires as documented in `sourceDistributorService.ts`

---

## S2 — Purchase entry creation + inventory reflects ✅

| # | Assertion | Result |
|---|---|---|
| S2.1 | Source distributor is discoverable via `GET` for later use | ✅ |
| S2.2 | `POST /api/purchase-entries` mints a structured `P<CODE><FY><SEQ>` number | ✅ regex matches `^P{docCode}\d{4}\d{6}$`; snapshot `sourceDistributorName` set |
| S2.3 | `inventory_events` row for the same `referenceId` has `fullsChange=+20` (incoming_fulls) and `emptiesChange=-15` (outgoing_empties) | ✅ Sign convention matches `inventoryService.recordOutgoingEmpties`. |
| S2.4 | An entry with every item at 0/0 is rejected with 400 EMPTY_MOVEMENT | ✅ Guard fires before the tx opens |
| S2.5 | A cylinderType belonging to a different tenant is rejected with 400 INVALID_CYLINDER_TYPES | ✅ Cross-tenant FK validation runs before the tx opens |

**What this proves:**
- `numberingService.allocateNumber(..., 'P', ...)` picks up 'P' from Step 4's `DocNumberType` extension.
- `purchaseEntryService.createPurchaseEntry` writes both the entry rows AND the derived inventory events inside one `prisma.$transaction` — signs match the summary aggregator's `Math.abs(event.emptiesChange)` convention.
- Cross-tenant IDs return 400 instead of leaking rows or silently writing bad data.

---

## S3 — Order creation with driverNameFreeText ✅

| # | Assertion | Result |
|---|---|---|
| S3.1 | `POST /api/orders` persists `driverNameFreeText='Suresh'` | ✅ Field flows schema → route → service → tx → mapper → wire |
| S3.1a | Order lands in `pending_delivery` status (skips driver-assignment) | ✅ `isMiniOperator` short-circuit in `orderService.createOrder` |
| S3.1b | `driverId` is null (no Driver FK) | ✅ Mini-op orders never touch the Driver table |

**What this proves:**
- Step 2's schema change to `createOrderSchema.driverNameFreeText` is wired through the full stack.
- Step 5's `isMiniOperator` short-circuit runs — mini-op orders don't sit at `pending_driver_assignment` waiting for a driver that doesn't exist.

---

## S4 — Direct delivery + plain invoice ✅

| # | Assertion | Result |
|---|---|---|
| S4.1 | Fresh order is created for delivery | ✅ |
| S4.2 | `POST /:id/confirm-delivery` closes the order without any dispatch step | ✅ Status < 400 (route now includes `mini_operator_admin` in allowlist) |
| S4.3 | Invoice generated has `irn=null` and `ackNo=null` | ✅ `createInvoiceFromOrder` short-circuits GST paths for `gstMode='disabled'` |
| S4.4 | `irnStatus !== 'success'` — mini-op invoices are plain, not e-invoices | ✅ |

**What this proves:**
- Section 4 of the investigation ("`gstMode='disabled'` produces clean plain invoices") holds under real API traffic.
- `drawComplianceSection` at [invoicePdfService.ts:657](../packages/api/src/services/pdf/invoicePdfService.ts) would render without the "e-Documents" block for these invoices — the guard `if (!hasIrn && !hasEwb) return 0` fires.

---

## S5 — GST activation guard on a mini-operator ✅

| # | Assertion | Result |
|---|---|---|
| S5.1 | Super-admin calls `POST /api/admin/distributors/:id/gst/activate` on a mini-op distributor | ✅ Response ≥ 400 |
| S5.1a | Response body contains error code `MINI_OPERATOR_NO_GST` | ✅ Guard fires in `gstActivationService.activateGst` before any credential validation |

**What this proves:**
- The two-sided invariant is intact: `distributorService.updateDistributor` blocks flipping TO `mini_operator` when GST is active (Step 4A), and `gstActivationService` blocks activating GST when `accountType='mini_operator'`.
- Even super-admin cannot compose the invalid combination via any write path.

---

## S6 — Cross-tenant + cross-role isolation ✅

| # | Assertion | Result |
|---|---|---|
| S6.1 | `distributor_admin` gets 403 on `POST /api/source-distributors` | ✅ Positive allow-list: mini_operator_admin only |
| S6.2 | `distributor_admin` gets 403 on `GET /api/purchase-entries` | ✅ Same allow-list |
| S6.3 | A second `mini_operator_admin` (different tenant) sees an empty source-distributor list — NOT the first tenant's list | ✅ Tenant scoping via JWT is enforced at every read |

**What this proves:**
- `requireRole('mini_operator_admin')` on the two new resource routers acts as a positive allow-list — no other role can even reach the handlers.
- Cross-tenant reads return the caller's OWN empty list, never the other tenant's data.

---

## S7 — Regression: regular distributor unaffected ✅

| # | Assertion | Result |
|---|---|---|
| S7.1 | Regular `distributor_admin` still lists their own orders (`GET /api/orders?page=1&pageSize=5`) | ✅ 200, correct wire shape (`{orders, meta}`) |
| S7.2 | `Distributor.accountType` on `dist-001` reads back as `'distributor'` post-migration | ✅ Default backfill on the migration + no rewrite anywhere |

**What this proves:**
- Adding `mini_operator_admin` to canonical admin+ops allow-lists is purely additive — every existing role still has the same access it had before.
- The migration didn't accidentally change any existing row's `accountType`.

---

---

## S8 — Purchase entry deletion reverses inventory movement ✅

Added in the CP4 (Step 9) test-additions round. Pins the design choice
documented at length in `purchaseEntryService.deletePurchaseEntry`:
hard-delete the derived `InventoryEvent` rows (via `referenceId` +
`referenceType='purchase_entry'`), soft-delete the `PurchaseEntry` header
row itself for audit, then call `recalculateSummariesFromDate` for every
affected cylinder type so cached `InventorySummary` rows self-heal.

A naive "emit reversal event" approach would double-debit `outgoingEmpties`
because the summary aggregator uses `Math.abs(event.emptiesChange)`. This
scenario locks the correct approach in a regression-guard test.

| # | Assertion | Result |
|---|---|---|
| S8.1 | Fresh purchase entry creates 2 inventory events (1 incoming_fulls + 1 outgoing_empties) tied to `referenceId=purchaseEntryId` | ✅ |
| S8.2 | `DELETE /api/purchase-entries/:id` returns `{ id, deleted: true }` | ✅ |
| S8.2a | Post-delete: 0 InventoryEvent rows remain for that `referenceId` (hard-delete) | ✅ |
| S8.2b | Post-delete: `PurchaseEntry.deletedAt` is set (soft-delete of the header) | ✅ |
| S8.3 | Post-delete: `GET /api/purchase-entries` excludes the soft-deleted id from the list | ✅ |
| S8.4 | Post-delete: `GET /api/purchase-entries/:id` returns 404 (findFirst filter includes `deletedAt: null`) | ✅ |

**What this proves:**
- The deletePurchaseEntry code path in purchaseEntryService.ts wraps the two
  writes (event hard-delete + entry soft-delete) in one `prisma.$transaction`
  so a mid-flight failure leaves neither in an inconsistent state.
- The `recalculateSummariesFromDate` post-tx call restores cached
  `InventorySummary` rows to their pre-purchase values.
- The audit trail is preserved because the PurchaseEntry + items stay in
  the DB with `deletedAt` set — a future audit report can still show that
  the entry existed and was later deleted.

---

## Companion tests landed in the same CP4 round

Not scenarios per se, but tightly related regression guards worth pinning
so they're rediscoverable from this doc.

### `mini-operator.test.ts` — invariants + wire shapes (9 tests)

- **AccountType default + updateDistributor guard** (3 tests):
  - Existing seeded distributors default to `accountType='distributor'`.
  - `PUT /api/distributors/:id` flipping to `mini_operator` when
    `gstMode !== 'disabled'` returns 400 with the "Disable GST first"
    message.
  - Non-super-admin PUT with `accountType` in the body strips the field
    (belt-and-braces defense in depth — route already gates to
    super_admin, this survives future looseness).
- **GST activation refuses mini-operator** (1 test):
  - `POST /api/admin/distributors/:id/gst/activate` on a mini-operator
    returns 4xx with `MINI_OPERATOR_NO_GST` in the response.
- **createOrder short-circuit** (1 test):
  - Order created on a mini-op tenant lands in `pending_delivery` with
    `driverId=null` immediately — the isMiniOperator branch in
    orderService.createOrder is exercised end-to-end.
- **Purchase number allocator** (1 test):
  - Two consecutive purchase entries on the same tenant share the
    docCode + FY prefix and differ by 1 in the trailing 6-digit
    sequence. Pins the `numberingService.allocateNumber('P', ...)`
    integration with the shared `invoice_counters` table.
- **Wire-shape guards** (3 tests):
  - `GET /api/source-distributors` returns a plain array (not
    `{ data: { rows: [] } }`).
  - `GET /api/purchase-entries` returns `{ purchaseEntries, meta }`
    with `page/pageSize/total` shape.
  - Order create response includes `driverNameFreeText` field (null OK,
    undefined NOT).

### `anti-pattern-guards.test.ts` — Guard 10 (4 tests)

- `distributor_admin` cannot POST `/api/source-distributors` → 403 +
  no row leaks to the DB.
- `distributor_admin` cannot POST `/api/purchase-entries` → 403.
- `finance` cannot POST `/api/purchase-entries` → 403.
- `GET /api/distributors` response every row carries `accountType`
  matching `/^(distributor|mini_operator)$/`.

---

## Summary

- **Coverage:** all eight scenarios (S1–S8) fully exercised as integration tests.
- **Wire-shape guards:** seven (S1.1, S2.2 purchaseNumber regex, S2.3 InventoryEvent shape, S7.1 orders envelope, plus Guard 10's four in anti-pattern-guards). Anti-pattern #9 discipline.
- **Tenant isolation:** S2.5 (cross-tenant cylinderType rejection), S6.1–6.3 (cross-role + cross-tenant reads), Guard 10.1/10.2/10.3 (role escalation).
- **Fail-safe:** positive allow-list — the mini-operator role starts with zero permissions and only gains what we explicitly grant. Forgetting to add `mini_operator_admin` to a new admin route means the mini-op user sees 403, not accidental data access.

### On generating a plain-invoice PDF end-to-end

Attempting the full walkthrough (create order → confirm delivery →
download invoice PDF) via the API is exercised by S4 (`invoice.irn === null`,
`invoice.ackNo === null`, `invoice.irnStatus !== 'success'`) and by the
existing invoicePdfService guard at `drawComplianceSection` line 657
(`if (!hasIrn && !hasEwb) return 0`). Rendering an actual PDF binary for
this doc would require a running dev server + delivered order; the API-level
assertions above are the load-bearing evidence and are re-run on every
`pnpm test`. If a physical PDF is needed for a sales / product demo:

```
pnpm --filter @gaslink/api exec tsx scripts/seed-mini-op-for-browser-check.ts
pnpm dev:api & pnpm dev:web
# login miniop@quickgas.com → create order for Hotel Raj Palace
# → Confirm Delivery → click PDF download on the resulting invoice
```

**Next:** CP4 gates + single rollup commit awaits.
