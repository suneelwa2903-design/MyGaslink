# Re-New GasLink — Testing Progress Tracker

> **HOW TO USE THIS FILE**
> - This is the single source of truth for testing progress across all sessions
> - Update `Pass/Fail/Bug` and `Notes` after each test
> - At the start of any Claude session, say: **"read docs/TESTING_PROGRESS.md and continue testing"**
> - Detail is in `docs/E2E_Testing_Guide.xlsx` — this file is the running status summary

**Last Updated:** 2026-05-20
**Baseline Commit:** `a72b25e` (2026-03-28)
**Latest Commits:** `8aae463` (WI-084 IRN retry guard + cancel token refresh + trip sheet redesign), `a29b64d` (WI-083a2 gaps), `0471a29` (same-token-on-retry guard)
**Git Branch:** master

---

## Legend
- ✅ Pass
- ❌ Fail (see Notes)
- 🚧 Bug filed (fix pending)
- ⏭ Skipped (reason in Notes)
- ⬜ Not tested yet

---

## Overall Progress

| Category | Total | ✅ Pass | ❌ Fail | 🚧 Bug | ⬜ Pending |
|----------|-------|---------|---------|--------|-----------|
| Navigation Smoke (7 roles) | 55 | 0 | 0 | 0 | 55 |
| Role-Based Access | 52 | 0 | 0 | 0 | 52 |
| Orders Tests | 22 | 0 | 0 | 0 | 22 |
| Inventory Tests | 18 | 0 | 0 | 0 | 18 |
| Customer Tests | 17 | 0 | 0 | 0 | 17 |
| Billing Tests | 26 | 0 | 0 | 0 | 26 |
| Fleet Tests | 11 | 0 | 0 | 0 | 11 |
| Settings Tests | 17 | 0 | 0 | 0 | 17 |
| Workflow: Order→Payment | 47 | 0 | 0 | 0 | 47 |
| Workflow: Inventory Cycle | 14 | 0 | 0 | 0 | 14 |
| Customer Portal | 18 | 0 | 0 | 0 | 18 |
| Negative & Edge Cases | 30 | 0 | 0 | 0 | 30 |
| **TOTAL** | **327** | **0** | **0** | **0** | **327** |

---

## Test Credentials

| Role | Email | Password | Distributor |
|------|-------|----------|-------------|
| Super Admin | admin@mygaslink.com | Admin@123 | All (platform-level) |
| Dist Admin (GST OFF) | bhargava@gasagency.com | Distadmin@123 | Bhargava Gas Agency |
| Dist Admin (GST ON) | sharma@gasdist.com | Gstadmin@123 | Sharma Gas Distributors |
| Finance | finance@gasagency.com | Finance@123 | Bhargava Gas Agency |
| Inventory | inventory@gasagency.com | Inventory@123 | Bhargava Gas Agency |
| Driver | raju@gasagency.com | Driver@123 | Bhargava Gas Agency |
| Customer | royal@kitchen.com | Customer@123 | Bhargava Gas Agency |

---

## Phase 1 — Navigation Smoke Test (START HERE)
_Goal: Verify every page loads for every role. ~30 min. No deep testing yet._

### Step 1 — Super Admin (admin@mygaslink.com)

| # | Screen | URL | Result | Notes |
|---|--------|-----|--------|-------|
| 1.1 | Login | /login | ⬜ | |
| 1.2 | Analytics Dashboard | /app/analytics | ⬜ | |
| 1.3 | Orders | /app/orders | ⬜ | |
| 1.4 | Inventory | /app/inventory | ⬜ | |
| 1.5 | Customers | /app/customers | ⬜ | |
| 1.6 | Billing & Payments | /app/billing-payments | ⬜ | |
| 1.7 | Fleet | /app/fleet | ⬜ | |
| 1.8 | Collections | /app/collections | ⬜ | |
| 1.9 | Settings | /app/settings | ⬜ | |
| 1.10 | Distributors | /app/distributors | ⬜ | |
| 1.11 | Provider Catalog | /app/provider-catalog | ⬜ | |
| 1.12 | Health Monitoring | /app/health | ⬜ | |

### Step 2 — Dist Admin GST OFF (bhargava@gasagency.com)

| # | Screen | URL | Result | Notes |
|---|--------|-----|--------|-------|
| 2.1 | Login | /login | ⬜ | |
| 2.2 | Analytics Dashboard | /app/analytics | ⬜ | |
| 2.3 | Orders | /app/orders | ⬜ | |
| 2.4 | Inventory | /app/inventory | ⬜ | |
| 2.5 | Customers | /app/customers | ⬜ | |
| 2.6 | Billing & Payments | /app/billing-payments | ⬜ | No GST columns expected |
| 2.7 | Fleet | /app/fleet | ⬜ | |
| 2.8 | Collections | /app/collections | ⬜ | |
| 2.9 | Settings | /app/settings | ⬜ | GST tab shows "disabled" |
| 2.10 | Distributors (BLOCKED) | /app/distributors | ⬜ | Should 403/redirect |
| 2.11 | Provider Catalog (BLOCKED) | /app/provider-catalog | ⬜ | Should 403/redirect |
| 2.12 | Health (BLOCKED) | /app/health | ⬜ | Should 403/redirect |

### Step 3 — Dist Admin GST ON (sharma@gasdist.com)

| # | Screen | URL | Result | Notes |
|---|--------|-----|--------|-------|
| 3.1 | Login | /login | ⬜ | |
| 3.2 | Analytics Dashboard | /app/analytics | ⬜ | |
| 3.3 | Orders | /app/orders | ⬜ | May be empty |
| 3.4 | Inventory | /app/inventory | ⬜ | |
| 3.5 | Customers | /app/customers | ⬜ | 3 GST customers |
| 3.6 | Billing & Payments | /app/billing-payments | ⬜ | GST columns visible |
| 3.7 | Fleet | /app/fleet | ⬜ | 1 driver, 1 vehicle |
| 3.8 | Collections | /app/collections | ⬜ | |
| 3.9 | Settings | /app/settings | ⬜ | GST tab shows sandbox config |

### Step 4 — Finance (finance@gasagency.com)

| # | Screen | URL | Result | Notes |
|---|--------|-----|--------|-------|
| 4.1 | Login | /login | ⬜ | |
| 4.2 | Analytics Dashboard | /app/analytics | ⬜ | |
| 4.3 | Billing & Payments | /app/billing-payments | ⬜ | |
| 4.4 | Collections | /app/collections | ⬜ | |
| 4.5 | Orders (BLOCKED) | /app/orders | ⬜ | Should 403/redirect |
| 4.6 | Inventory (BLOCKED) | /app/inventory | ⬜ | Should 403/redirect |
| 4.7 | Customers (BLOCKED) | /app/customers | ⬜ | Should 403/redirect |
| 4.8 | Fleet (BLOCKED) | /app/fleet | ⬜ | Should 403/redirect |
| 4.9 | Settings (BLOCKED) | /app/settings | ⬜ | Should 403/redirect |

### Step 5 — Inventory (inventory@gasagency.com)

| # | Screen | URL | Result | Notes |
|---|--------|-----|--------|-------|
| 5.1 | Login | /login | ⬜ | |
| 5.2 | Analytics Dashboard | /app/analytics | ⬜ | |
| 5.3 | Orders | /app/orders | ⬜ | |
| 5.4 | Inventory | /app/inventory | ⬜ | Full access |
| 5.5 | Fleet | /app/fleet | ⬜ | |
| 5.6 | Customers (BLOCKED) | /app/customers | ⬜ | Should 403/redirect |
| 5.7 | Billing (BLOCKED) | /app/billing-payments | ⬜ | Should 403/redirect |
| 5.8 | Settings (BLOCKED) | /app/settings | ⬜ | Should 403/redirect |

### Step 6 — Driver (raju@gasagency.com)

| # | Screen | URL | Result | Notes |
|---|--------|-----|--------|-------|
| 6.1 | Login | /login | ⬜ | |
| 6.2 | Analytics Dashboard | /app/analytics | ⬜ | Driver view |
| 6.3 | Orders | /app/orders | ⬜ | Assigned orders only |
| 6.4 | Inventory (BLOCKED) | /app/inventory | ⬜ | Should 403/redirect |
| 6.5 | Customers (BLOCKED) | /app/customers | ⬜ | Should 403/redirect |
| 6.6 | Billing (BLOCKED) | /app/billing-payments | ⬜ | Should 403/redirect |
| 6.7 | Fleet (BLOCKED) | /app/fleet | ⬜ | Should 403/redirect |
| 6.8 | Settings (BLOCKED) | /app/settings | ⬜ | Should 403/redirect |

### Step 7 — Customer (royal@kitchen.com)

| # | Screen | URL | Result | Notes |
|---|--------|-----|--------|-------|
| 7.1 | Login | /login | ⬜ | Should redirect to /app/customer/dashboard |
| 7.2 | Customer Dashboard | /app/customer/dashboard | ⬜ | |
| 7.3 | Customer Orders | /app/customer/orders | ⬜ | |
| 7.4 | Customer Invoices | /app/customer/invoices | ⬜ | |
| 7.5 | Customer Payments | /app/customer/payments | ⬜ | |
| 7.6 | Customer Account | /app/customer/account | ⬜ | |
| 7.7 | Admin Dashboard (BLOCKED) | /app/analytics | ⬜ | Should redirect to customer portal |
| 7.8 | Admin Orders (BLOCKED) | /app/orders | ⬜ | Should 403/redirect |

---

## Phase 2 — E2E Tests by Module

> Run these after Phase 1 smoke test passes. Refer to `docs/E2E_Testing_Guide.xlsx` for exact steps.

### Role-Based Access (RA-001 to RA-052)
_Status: 0/52 — ⬜ Not started_

| Range | Role | Result | Notes |
|-------|------|--------|-------|
| RA-001 to RA-013 | Super Admin | ⬜ | |
| RA-014 to RA-025 | Dist Admin | ⬜ | |
| RA-026 to RA-034 | Finance | ⬜ | |
| RA-035 to RA-041 | Inventory | ⬜ | |
| RA-042 to RA-046 | Driver | ⬜ | |
| RA-047 to RA-052 | Customer | ⬜ | |

### Orders (FO-001 to FO-022)
_Status: 0/22 — ⬜ Not started_

| Test ID | Case | Result | Notes |
|---------|------|--------|-------|
| FO-001 | Create order - single item | ⬜ | |
| FO-002 | Create order - multiple items | ⬜ | |
| FO-003 | Create order - no customer | ⬜ | |
| FO-004 | Create order - no items | ⬜ | |
| FO-005 | Create order - past date | ⬜ | |
| FO-006 | Create order - stopped customer | ⬜ | |
| FO-007 | Edit order - change date | ⬜ | |
| FO-008 | Edit order - modify items | ⬜ | |
| FO-009 | Edit delivered order | ⬜ | |
| FO-010 | Assign driver | ⬜ | |
| FO-011 | Bulk assign driver | ⬜ | |
| FO-012 | Cancel before dispatch | ⬜ | |
| FO-013 | Cancel after dispatch | ⬜ | |
| FO-014 | Delivery - full qty | ⬜ | |
| FO-015 | Delivery - partial qty | ⬜ | |
| FO-016 | Delivery - with empties | ⬜ | |
| FO-017 | Returns-only order | ⬜ | |
| FO-018 | Confirm returns | ⬜ | |
| FO-019 | Filter by status | ⬜ | |
| FO-020 | Filter by date range | ⬜ | |
| FO-021 | Pagination | ⬜ | |
| FO-022 | Search by keyword | ⬜ | |

### Inventory (FI-001 to FI-018)
_Status: 0/18 — ⬜ Not started_

| Test ID | Case | Result | Notes |
|---------|------|--------|-------|
| FI-001 | View daily summary | ⬜ | |
| FI-002 | Navigate dates | ⬜ | |
| FI-003 | Record incoming fulls | ⬜ | |
| FI-004 | Record outgoing empties | ⬜ | |
| FI-005 | Manual adjustment | ⬜ | |
| FI-006 | Lock day | ⬜ | |
| FI-007 | Unlock day | ⬜ | |
| FI-008 | Add on locked day | ⬜ | |
| FI-009 | Depot history | ⬜ | |
| FI-010 | View cancelled stock | ⬜ | |
| FI-011 | Return cancelled stock | ⬜ | |
| FI-012 | View forecast | ⬜ | |
| FI-013 | Customer balances | ⬜ | |
| FI-014 | Reconciliation pending | ⬜ | |
| FI-015 | Reconcile - confirm | ⬜ | |
| FI-016 | Reconcile - mismatch | ⬜ | |
| FI-017 | Critical alert | ⬜ | |
| FI-018 | Warning alert | ⬜ | |

### Customers (FC-001 to FC-017)
_Status: 0/17 — ⬜ Not started_

| Test ID | Case | Result | Notes |
|---------|------|--------|-------|
| FC-001 | Create - all fields | ⬜ | |
| FC-002 | Create - min fields | ⬜ | |
| FC-003 | Create - duplicate phone | ⬜ | |
| FC-004 | Edit customer | ⬜ | |
| FC-005 | Stop supply | ⬜ | |
| FC-006 | Resume supply | ⬜ | |
| FC-007 | Detail - Orders tab | ⬜ | |
| FC-008 | Detail - Invoices tab | ⬜ | |
| FC-009 | Detail - Payments tab | ⬜ | |
| FC-010 | Detail - Inventory tab | ⬜ | |
| FC-011 | Detail - Ledger tab | ⬜ | |
| FC-012 | Search by name | ⬜ | |
| FC-013 | Filter by status | ⬜ | |
| FC-014 | Provision portal | ⬜ | |
| FC-015 | Modification request | ⬜ | |
| FC-016 | Approve modification | ⬜ | |
| FC-017 | Reject modification | ⬜ | |

### Billing (FB-001 to FB-026)
_Status: 0/26 — ⬜ Not started_

| Test ID | Case | Result | Notes |
|---------|------|--------|-------|
| FB-001 | View invoices list | ⬜ | |
| FB-002 | Filter by status | ⬜ | |
| FB-003 | Filter by IRN status | ⬜ | |
| FB-004 | Filter by date range | ⬜ | |
| FB-005 | Invoice detail | ⬜ | |
| FB-006 | Download PDF | ✅ | Fixed 2026-04-07: was saving JSON error as .pdf (missing X-Distributor-Id header) |
| FB-007 | Payment - cash | ⬜ | |
| FB-008 | Payment - UPI | ⬜ | |
| FB-009 | Payment - bank transfer | ⬜ | |
| FB-010 | Payment - cheque | ⬜ | |
| FB-011 | Partial payment | ⬜ | |
| FB-012 | Auto-allocate | ⬜ | |
| FB-013 | Manual allocate | ⬜ | |
| FB-014 | Create credit note | ⬜ | |
| FB-015 | Approve credit note | ⬜ | |
| FB-016 | Reject credit note | ⬜ | |
| FB-017 | Download CN PDF | ⬜ | |
| FB-018 | Create debit note | ⬜ | |
| FB-019 | Approve debit note | ⬜ | |
| FB-020 | Reject debit note | ⬜ | |
| FB-021 | Generate GST (IRN) | ⬜ | |
| FB-022 | Cancel IRN | ⬜ | |
| FB-023 | Generate EWB | ⬜ | |
| FB-024 | Cancel EWB | ⬜ | |
| FB-025 | Regenerate invoice | ⬜ | |
| FB-026 | Mark overdue | ⬜ | |

### Fleet (FF-001 to FF-011)
_Status: 0/11 — ⬜ Not started_

| Test ID | Case | Result | Notes |
|---------|------|--------|-------|
| FF-001 | Create driver | ⬜ | |
| FF-002 | Edit driver | ⬜ | |
| FF-003 | Delete driver | ⬜ | |
| FF-004 | Toggle availability | ⬜ | |
| FF-005 | Create vehicle | ⬜ | |
| FF-006 | Edit vehicle | ⬜ | |
| FF-007 | Delete vehicle | ⬜ | |
| FF-008 | Create assignment | ⬜ | |
| FF-009 | Update assignment | ⬜ | |
| FF-010 | Driver performance | ⬜ | |
| FF-011 | Vehicle inventory | ⬜ | |

### Settings (FS-001 to FS-017)
_Status: 1/17 — 1 Fixed_

| Test ID | Case | Result | Notes |
|---------|------|--------|-------|
| FS-001 | General - SLA hours | ⬜ | |
| FS-002 | GST - credentials | ⬜ | |
| FS-003 | GST - enable | ⬜ | |
| FS-004 | GST - disable | ⬜ | |
| FS-005 | GST - mode change | ⬜ | |
| FS-006 | Prices - add | ⬜ | |
| FS-007 | Prices - edit | ⬜ | |
| FS-008 | Thresholds - critical | ✅ | Bug fixed 2026-03-28: auto-populate from cylinder types |
| FS-009 | Thresholds - warning | ✅ | Same fix |
| FS-010 | Users - create Finance | ⬜ | |
| FS-011 | Users - create Inventory | ⬜ | |
| FS-012 | Users - create Driver | ⬜ | |
| FS-013 | Users - edit | ⬜ | |
| FS-014 | Users - delete | ⬜ | |
| FS-015 | Users - reset password | ⬜ | |
| FS-016 | Licenses - view | ⬜ | |
| FS-017 | Billing - view | ⬜ | |

### Workflow: Order → Payment (WF-001 to WF-047)
_Status: 0/47 — ⬜ Not started_

| Range | Scenario | Result | Notes |
|-------|----------|--------|-------|
| WF-001 to WF-008 | Happy Path (GST OFF) | ⬜ | Full order → invoice → payment |
| WF-009 to WF-014 | GST ON B2B Inter-state | ⬜ | IRN generation included |
| WF-015 to WF-018 | GST ON B2C Intra-state | ⬜ | |
| WF-019 to WF-020 | Partial Delivery | ⬜ | |
| WF-021+ | (remaining workflow tests) | ⬜ | |

### Workflow: Inventory Cycle (WI-001 to WI-014)
_Status: 0/14 — ⬜ Not started_

### Customer Portal (CP-001 to CP-018)
_Status: 0/18 — ⬜ Not started_

### Negative & Edge Cases (NE-001 to NE-030)
_Status: 0/30 — ⬜ Not started_

---

## Phase 3 — Mobile Testing (Expo Go)

| Platform | Screen Group | Result | Notes |
|----------|-------------|--------|-------|
| Android/iOS | Auth (login, forgot password) | ⬜ | |
| Android/iOS | Admin: dashboard, orders, inventory, finance, more | ⬜ | |
| Android/iOS | Driver: orders, trip, inventory, analytics | ⬜ | |
| Android/iOS | Finance: dashboard, invoices, payments, collections | ⬜ | |
| Android/iOS | Inventory: all 9 screens | ⬜ | |
| Android/iOS | Customer: dashboard, orders, invoices, payments, account | ⬜ | |
| Android/iOS | Super Admin: all screens | ⬜ | |

---

## Phase 4 — API Integration Tests

| Test File | Status | Notes |
|-----------|--------|-------|
| auth.test.ts | ✅ | 94/94 pass (2026-04-07) |
| inventory.test.ts | ✅ | 94/94 pass (2026-04-07) |
| gst-invoicing.test.ts | ✅ | 94/94 pass (2026-04-07) — sandbox mode only |
| gst-toggle.test.ts | ✅ | 94/94 pass (2026-04-07) — was 93/94, fixed super admin test |
| customer-portal.test.ts | ✅ | 94/94 pass (2026-04-07) |
| workflow.test.ts | ✅ | 94/94 pass (2026-04-07) |

**Total: 480/480 tests passing as of 2026-05-20**

---

## Known Bugs

| # | Found | Module | Description | Status |
|---|-------|--------|-------------|--------|
| 1 | 2026-03-28 | Settings > Thresholds | "No thresholds configured" shown even when cylinder types exist | ✅ Fixed |
| 2 | 2026-04-07 | All API routes | Super admin null distributorId caused 500 crashes on all distributor-scoped endpoints | ✅ Fixed (c9c6f3d) |
| 3 | 2026-04-07 | Invoices / Billing / Analytics | PDF/Excel downloads missing X-Distributor-Id header — file was a JSON error response | ✅ Fixed (7f2758f) |
| 4 | 2026-04-07 | Billing > Invoices | Credit note button visible when GST mode = DISABLED (should be hidden) | 🚧 Pending |
| 5 | 2026-04-07 | Orders | Vehicle field shown in assign-driver modal (should not be there) | 🚧 Pending |
| 6 | 2026-05-20 | Fleet/Dispatch | Mark as Returned button never appeared — vehicle.status not set to 'dispatched' on preflight success | ✅ Fixed (WI-082) |
| 7 | 2026-05-20 | Orders > Cancel | Cancel modal showed GST warning even for pending_driver_assignment orders (no invoice yet) | ✅ Fixed (WI-082) |
| 8 | 2026-05-20 | Inventory | Delivered and Outgoing Empties columns showed spurious minus signs | ✅ Fixed (WI-083) |
| 9 | 2026-05-20 | Inventory | Opening Empties always 0 — initial_balance.emptiesChange not included in computeSummaryForDate | ✅ Fixed (WI-083) |
| 10 | 2026-05-20 | Orders > Cancel | IRN cancel failure left invoice in ambiguous state (EWB cancelled, IRN still live, no status persisted) | ✅ Fixed (WI-083 — cancel_failed status + amber badge + retry button) |
| 11 | 2026-05-20 | Fleet/Dispatch | DVA findFirst picked lowest-tripNumber (stale) row when multiple sessions ran without cleanup | ✅ Fixed (WI-083 — orderBy tripNumber desc) |
| 12 | 2026-05-20 | GST/Auth | WhiteBooks sandbox `TokenExpiry` field echoes previous session even on fresh token — hard SESSION_EXPIRED blocked valid tokens | ✅ Fixed (d7aa5cf — 55-min fallback when expiry in past) |
| 13 | 2026-05-20 | Settings > GST | Test Connection showed "NIC GSTNDETAILS rejected: [1005]" even though IRN generation works fine | ✅ Fixed (f61861e — treat 1005 on GSTNDETAILS as reachable) |
| 14 | 2026-05-20 | Fleet/Dispatch | 1005 on dispatch looped forever when WhiteBooks kept returning same stale NIC token | ✅ Fixed (0471a29 — same-token-on-retry → immediate SESSION_EXPIRED) |
| 15 | 2026-05-20 | Reports > Trip Sheet PDF | Order # column width=45pt — order numbers (~15 chars at 9pt) need ~82pt, text wraps into Customer column | ✅ Fixed (WI-083a2 → 85pt; WI-084 full redesign: 90pt, ellipsis, dark header, zebra rows) |
| 16 | 2026-05-20 | Inventory > Cancelled Stock | Cancelled order (Trip 2 Bangalore Foods 47.5KG) not visible in Undelivered Stock tab — CancelledStockEvent was created at `returned_to_depot` directly, skipping `on_vehicle` state | ✅ Fixed (WI-083a2) |
| 17 | 2026-05-20 | Inventory > Daily Summary | `cancellation_return` events feed `incomingFulls` bucket instead of `cancelledStockQty` — Cancelled column always 0, Incoming falsely +1 | ✅ Fixed (WI-083a2) |
| 18 | 2026-05-20 | GST > Dispatch | Re-dispatch after SESSION_EXPIRED stamped `irnStatus='failed'` even when IRN already committed — corrupted INV-MPE5ZM628T4 | ✅ Fixed (WI-084 — retry guard in processInvoiceGst outer catch; DB patched direct) |
| 19 | 2026-05-20 | GST > Cancel | IRN/EWB cancel always returned SESSION_EXPIRED — stale token cached from dispatch session never cleared before cancel callWithLog | ✅ Fixed (WI-084 — clearTokenCache() before cancelIrn + cancelEwb) |

---

## Session Log

| Date | What Was Done | Next Step |
|------|--------------|-----------|
| 2026-03-28 | Baseline commit `a72b25e`. Created this tracker. 0 tests run. | Start Phase 1 Navigation Smoke Test |
| 2026-04-07 | Fixed P0 null distributorId (c9c6f3d) + PDF download header bug (7f2758f). 94/94 API tests pass. Invoice PDF verified working. | Start Phase 1 Navigation Smoke Test (0/55 done) |
| 2026-05-20 | WI-081: order cancellation + vehicle return workflow. WI-082: cancel modal context-aware messaging, Mark as Returned vehicle status fix, inventory tab spacing, undelivered stock tab date filter removed. WI-083: cancel_failed IRN status (schema + enum + service + PDF + UI), computeSummaryForDate empties fix, DVA tripNumber ordering fix, seed script fully working (Opening Fulls + Empties populated, Incoming Fulls = 0). 479/479 tests passing. dist-002 data clean-slated. | Phase 1 Navigation Smoke Test or Phase 2 E2E by module |
| 2026-05-20 (session 2) | Live GST dispatch testing on dist-002 (Sharma Gas Distributors, sandbox). Fixed 3 auth/token bugs (d7aa5cf, f61861e, 0471a29). Successfully generated IRNs + EWBs: B2B intra-state (Maruthi), B2B inter-state IGST (Hyderabad Caterers), B2C (Bangalore Foods). Preflight dispatch: 2/2 orders succeeded (Kiran Reddy's trip). Identified 3 live-test gaps (bugs #15, #16, #17): trip sheet PDF column width, Undelivered Stock missing cancelled order, daily summary cancellation_return→incomingFulls misrouting. 480/480 tests passing. | Fix GAP 1 (trip sheet PDF), GAP 2 (Undelivered Stock), GAP 3 (daily summary cancelled column) |
| 2026-05-20 (session 3) | WI-083a2: fixed trips #15/#16/#17 — Order# column width 45→85pt, CSE status on_vehicle for cancelOrder, cancellation_return→cancelledStockQty routing. WI-084: (1) IRN retry-corruption guard in processInvoiceGst outer catch (checks invoice.irn before stamping failed); (2) clearTokenCache() before cancelIrn + cancelEwb to fix SESSION_EXPIRED on every cancel; (3) full professional trip sheet PDF redesign — branded header, PRIMARY divider, 2-col info block, dark drawTableHeader, zebra rows, drawBox border, ellipsis on all cells, col widths Order#=90/Customer=115/Address=105/EWB=85/Items=55/Value=65. DB direct-patched INV-MPE5ZM628T4 irn_status failed→success. 480/480 tests passing, typecheck clean. Commit 8aae463. | Live-verify: (a) trip sheet PDF visually — no overflow; (b) cancel IRN/EWB — should succeed on first attempt; (c) Undelivered Stock tab shows on_vehicle cancelled orders |

