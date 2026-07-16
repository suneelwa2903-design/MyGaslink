# Mini-Operator — Scenario Test Results (CP2)

**Date:** 2026-07-16
**Test file:** [packages/api/src/__tests__/mini-operator-scenarios.test.ts](../packages/api/src/__tests__/mini-operator-scenarios.test.ts)
**Result:** ✅ 17 / 17 passing (0 failing)
**Full suite:** 1908 / 1908 passing (baseline 1891, +17 new)
**Format:** Vitest integration tests (real HTTP via supertest, real Postgres via prisma) — so the scenarios also count toward `pnpm test` and are re-run on every CI + local `pnpm test` invocation.

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

## Summary

- **Coverage:** all seven brief scenarios fully exercised.
- **Wire-shape guards:** four (S1.1 response shape, S2.2 purchaseNumber regex, S2.3 InventoryEvent shape, S7.1 orders envelope) — mirroring anti-pattern #9 discipline.
- **Tenant isolation:** exercised in S2.5 (cross-tenant cylinderType), S6.1–6.3 (cross-role + cross-tenant reads).
- **Fail-safe:** the positive allow-list means the mini-operator role starts with zero permissions and only gains what we explicitly grant. If we later forget to add `mini_operator_admin` to a new admin route, the mini-op user sees 403 — not accidental data access.
- **No regressions:** the pre-existing 1891 tests still pass. Total is now 1908.

**Next:** CP2 confirmed clean → Step 7 (web UI) awaits go-ahead.
