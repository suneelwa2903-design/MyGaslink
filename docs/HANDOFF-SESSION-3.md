# Re-New GasLink — Session 3 Handoff (for the next Claude session)

> **Read this top-to-bottom before doing anything.** It is self-contained: a fresh
> Claude instance reading only this file can understand the whole system and continue
> testing without asking questions. Date written: **2026-05-21**.

---

## 1. SYSTEM STATE

| | |
|---|---|
| **Master SHA** | `07b76193d2fde7ec21631386affea2428760383b` (`07b7619`) |
| **Branch** | `master` (all work lands directly on master; no feature branches; remote not pushed) |
| **API tests** | **484 / 484 passing** (37 files) — `cd packages/api && pnpm test` |
| **Web typecheck** | clean (2 pre-existing `afterAll` import errors in `credit-debit-note-amount.test.ts` + `invoice-list-badges-cn-pdf.test.ts` — harmless, tests pass) |
| **Monorepo** | `packages/api` (Express+Prisma+PG), `packages/web` (React19+Vite+Tailwind+Zustand), `packages/mobile` (Expo) |

### Services & how to start them
```bash
# From repo root (C:\Projects\Re-New_Gaslink)
pnpm docker:up      # PostgreSQL container "gaslink-db" (port 5432)
pnpm dev            # API (:5000) + Web (:5173) in parallel  ← normal way to bring up
# or individually:
pnpm dev:api        # API only, :5000  (tsx watch — auto-reloads on save)
pnpm dev:web        # Web only, :5173

# Health checks
curl http://localhost:5000/api/health          # {"status":"healthy", database connected}
curl -o /dev/null -w "%{http_code}" http://localhost:5173   # 200

# Database
pnpm db:generate    # regenerate Prisma client after schema change
pnpm db:migrate     # run migrations
pnpm db:seed        # seed dist-001 + dist-002 base data
pnpm db:studio      # Prisma Studio GUI
```
**Currently running** (this session left them up): DB ✅, API ✅ :5000, Web ✅ :5173.

### Database state
- **dist-001 — "Bhargava Gas Agency"** — `gstMode = disabled`. The GST-OFF tenant. Used by most unit/integration tests (treated as a **disposable** test distributor — `cleanupTestOrders('dist-001')` wipes all its orders/invoices on `pnpm test`).
- **dist-002 — "Sharma Gas Distributors"** — `gstMode = sandbox`. The GST-ON tenant wired to the **WhiteBooks sandbox**. Used for all live GST/dispatch testing.
- **Platform-level:** `SUPER_ADMIN` spans both; tenant switch via `X-Distributor-Id` header (validated in `middleware/auth.ts:resolveDistributor`).
- **Test-fixture vehicles** (WI-090): `TEST-PF-VEHICLE-D2`, `TEST-TS-VEHICLE-D2`, `TEST-DISPATCH-TRIP-D2` (dist-002) and `TEST-PF-VEHICLE-D1` (dist-001) appear `idle` in Fleet — harmless, created by integration tests. Ignore them.
- **Known messy data:** a few dist-002 orders sit in `pending_delivery` with cancelled invoices (leftover from earlier diagnostics). Cancel via UI or ignore.

### Credentials (all roles, both tenants)
**dist-001 (Bhargava, GST OFF):**
| Role | Email | Password |
|------|-------|----------|
| Super Admin (platform) | admin@mygaslink.com | Admin@123 |
| Dist Admin | bhargava@gasagency.com | Distadmin@123 |
| Finance | finance@gasagency.com | Finance@123 |
| Inventory | inventory@gasagency.com | Inventory@123 |
| Driver (Raju) | raju@gasagency.com | Driver@123 |
| Customer (Royal Kitchen) | royal@kitchen.com | Customer@123 |

**dist-002 (Sharma, GST SANDBOX):**
| Role | Email | Password | Linked entity |
|------|-------|----------|----------------|
| Dist Admin | sharma@gasdist.com | Gstadmin@123 | — |
| Finance (Divya Sharma) | finance2@gasdist.com | Finance@123 | — |
| Inventory (Suresh Reddy) | inventory2@gasdist.com | Inventory@123 | — |
| Driver (Kiran Reddy) | driver2@gasdist.com | Driver@123 | driver: Kiran Reddy |
| Customer (Bangalore Foods) | customer2@gasdist.com | Customer@123 | customer: Bangalore Foods |

> dist-002 sub-role users are created by `scripts/create-dist002-users.ts` (idempotent upsert). Re-run with `npx tsx scripts/create-dist002-users.ts` if missing.

---

## 2. WHAT WAS BUILT (WI-001 → WI-090)

Status legend: ✅ done · ⏸ pending · 🔁 in_progress · ⛔ wont_fix. "BLOCKS" = blocksLaunch flag.

### GST / e-Invoicing (IRN + EWB) — the deepest area
- **WI-035** ✅ BLOCKS — Pre-dispatch preflight: generate IRN + EWB **before** goods leave depot.
- **WI-036** ✅ BLOCKS — Dispatch UI: per-driver Dispatch button + preflight results screen.
- **WI-037** ✅ BLOCKS — Delivery-mismatch reissue (cancel + regenerate IRN/EWB on qty change).
- **WI-038** ✅ — Consolidated EWB ("trip sheet") auto-generated on dispatch (gencewb).
- **WI-039** ✅ — Credit/Debit Note IRN flow + Billing UI exposure.
- **WI-040/041/042/043** ✅ — Customer GSTIN autofill; EWB in invoice PDF; GST creds in Settings; GSTIN lookup for dist-admin.
- **WI-044** ✅ — Fixed GET /settings response shape (envelope, not raw array).
- **WI-054** ✅ — Test Connection bypasses token cache + NIC reachability probe.
- **WI-055/056** ✅ — Amount-based CN/DN modal; invoice list CN/DN badges; CN PDF reads IRN from gst_documents.
- **WI-057** ✅ — Closed payload gaps; vehicleNo / transDistance guards.
- **WI-058** ✅ — Tenant isolation in `lookupGstin` (anti-pattern #13).
- **WI-059** ✅ — Dedup concurrent auth fetches + pre-warm token before preflight.
- **WI-060** ✅ BLOCKS — TZ-safe parsing of NIC `TokenExpiry` (UTC-host production landmine).
- **WI-064** ✅ BLOCKS — Reissue 2278-trap fix + display bugs (the 2-hour incident).
- **WI-065** ✅ BLOCKS — **Add to Trip** + tripNumber on orders + dispatch-gate order fix.
- **WI-066** ✅ BLOCKS — Invoice total stores GST-**inclusive** amount (reissue unit-mismatch fix).
- **WI-067 / WI-070** ✅ BLOCKS — EWB `transDistance` via pincode lat/lon + Haversine + road-circuity factor.
- **WI-071 → WI-076** ✅ BLOCKS — B2C/B2B EWB correctness: URP sentinel, transactionType, omit redundant shipTo/dispatchFrom (NIC 616). **Current:** B2C `transactionType=2`, B2B `transactionType=1` (see §8).
- **WI-077** ✅ — Billing list B2B/B2C differentiation; B2C CN/DN PDF skips compliance section.
- **WI-078** ✅ BLOCKS — Cancel order wires NIC EWB cancellation + DVA release into `cancelOrder()`.
- **WI-083 / WI-083a2 / WI-084 / WI-085 / WI-086** ✅ BLOCKS — Cancel/dispatch token-and-status hardening (see anti-patterns #10–#13; §8 token behavior).
- **WI-089** ⛔ wont_fix — Auto-refresh NIC session on SESSION_EXPIRED (premise disproved by live probe; shipped honest-badge UI instead).
- **WI-090** ✅ BLOCKS — **(this session)** IRN-cancel guard fix (retry cancel with pinned token), add-to-trip vehicle status, trip-sheet PDF hyphen, test→live vehicle contamination fix.
- **WI-007** ⏸ BLOCKS — Verify GST **live** mode against WhiteBooks **production** (NOT done — sandbox only so far).

### Orders / Dispatch / Vehicle workflow
- **WI-062** ✅ BLOCKS — GET /api/orders auto-scopes to driver_id for driver role (within-tenant leak fix).
- **WI-068/069** ✅ BLOCKS — Auto-reset DVA after last delivery; exclude stale `loaded_and_dispatched` DVAs.
- **WI-081** ✅ BLOCKS — Order cancellation + vehicle return workflow (initial).
- **WI-082** ✅ — Cancel modal context-aware messaging + Mark-as-Returned vehicle status.
- **WI-087** ✅ — Vehicle workflow safety guards (markVehicleReturned + confirmDelivery).
- **WI-005** ✅ BLOCKS — Removed vehicle field from assign-driver modal.

### Inventory
- **WI-079** ✅ — 5 inventory-role bugs (analytics access, assign-driver dropdown, edit/dispatch perms, −0 display) + finance customer view-only.
- **WI-080** ✅ — Daily ledger, adjust stock, forecast, onboarding, config access.
- **WI-083** ✅ — Empties opening-balance fix; cancelled-stock routing (`cancellation_return` → cancelledStockQty); CSE `on_vehicle` state.

### Roles / Tenant isolation / Security
- **WI-001** ✅ P0 — Tenant-isolation audit of all services.
- **WI-002** ✅ — Tighten requireDistributor exemptions on /users, /billing, /pricing.
- **WI-013/014** ✅ — Verify distributor active in resolveDistributor; audit super_admin tenant switches.
- **WI-009/010/011/012** ✅ BLOCKS — Graceful shutdown + unhandledRejection; web ErrorBoundary; disable prod source maps; axios CVE upgrade.
- **WI-020** ✅ — Sentry for web ErrorBoundary.
- **WI-004** ✅ BLOCKS — Hide credit-note button when gstMode=DISABLED.

### Infrastructure / Tests / Data
- **WI-003** ✅ — Cleaned ad-hoc test-*.ts root scripts.
- **WI-006** ✅ — Float→Decimal migration (storage; see §10).
- **WI-016/017/018/030** ✅ — Integration test coverage expansion.
- **WI-019** ✅ — Typecheck bug fixes (Distributor pages).
- **WI-032/033/034** ✅ — Seed idempotency (upserts); Prisma shadow-DB fix; seed scoping.
- **WI-022** ✅ BLOCKS — Merged worktree branch to master.
- **WI-025/026/027/028/029** ✅ — Role-aware dashboard; collections call list; **offline delivery queue** (idempotent server); driver contact in portal; onboarding checklist + CSV import.

### UX / i18n
- **WI-008** 🔁 — Telugu i18n (in progress; EN+TE branch `claude/sharp-grothendieck` not merged).
- **WI-015** ✅ — Fixed PORT discrepancy in CLAUDE.md.

### Mobile (Expo) — mostly pending
- **WI-045** ✅ BLOCKS — Driver smoke test + fixes.
- **WI-052** ✅ BLOCKS — Mobile setup guide + env config.
- **WI-063** ✅ BLOCKS — Driver mobile: Trip + Vehicle Stock + delivery modal + EWB compliance.
- **WI-053** 🔁 BLOCKS — Mobile security hardening pre-pilot (SecureStore tokens, rate limiting — partially done).
- **WI-046/047/048** ⏸ BLOCKS — Mobile smoke tests: Dist Admin, Inventory, Customer.
- **WI-049/050/051** ⏸ — Mobile: Finance, Super Admin, role guards.

### Launch-blocking PENDING items (not started/partial)
- **WI-007** ⏸ — GST **live**-mode verification against WhiteBooks production.
- **WI-023** ⏸ — Create GitHub repo + push master.
- **WI-024** ⏸ — Phase-1 manual smoke tests (55 cases, 7 roles).
- **WI-046/047/048/053** — Mobile pilot readiness.

---

## 3. ARCHITECTURE SUMMARY

### Tech stack
- **API:** Node ESM + TypeScript, Express, Prisma ORM, PostgreSQL. ESM relative imports use `.js` suffix on `.ts` sources. Zod validation (`middleware/validate.ts`). Winston logger. Sentry auto-wired. JWT auth (not Firebase) — token in Zustand + localStorage (web) / expo-secure-store (mobile).
- **Web:** React 19 + Vite + TailwindCSS + Zustand (persist) + TanStack Query + react-hook-form + Zod. Shared axios instance injects `Authorization` + `X-Distributor-Id`. UI primitives in `components/ui/`.
- **Mobile:** Expo 54 + expo-router + NativeWind. Tokens in expo-secure-store. Offline write queue.

### Key service files (packages/api/src)
- `lib/prisma.ts` — Prisma singleton (never `new PrismaClient()` elsewhere).
- `middleware/auth.ts` — `authenticate` → `resolveDistributor` → `requireDistributor`; tenant resolution + super_admin switch.
- `utils/apiResponse.ts` — `sendSuccess/sendError/...` (never `res.json` directly).
- `utils/decimal.ts` — `toNum()` reads Decimal columns as number for arithmetic.
- `services/orderService.ts` — order lifecycle, assignDriver, **cancelOrder** (orchestrates EWB→IRN cancel + DVA release + payment guard).
- `services/deliveryWorkflowService.ts` — `markVehicleReturned` (→ vehicle 'returned'), vehicle reconciliation (→ 'idle'), confirmDelivery guards.
- `services/gst/gstPreflightService.ts` — `preflightDispatch` (new trip) + `preflightAddToTrip` (existing trip); sets vehicle 'dispatched'; consolidated EWB.
- `services/gst/gstService.ts` — `processInvoiceGst`, `cancelIrn`, `cancelEwb`, CN/DN GST.
- `services/gst/whitebooksClient.ts` — auth/token cache, `apiCall` (the **cancel-retry guard** lives here, WI-090), `clearTokenCache`, `getCredentials`.
- `services/gst/apiLogger.ts` — `callWithLog` wrapper: writes `gst_api_logs` row on success AND failure (anti-pattern #11).
- `services/gst/payloadBuilders.ts` — IRN + EWB payload construction (B2B/B2C, transactionType).
- `services/gst/gstinLookup.ts` — tenant-scoped GSTIN lookup (anti-pattern #13).
- `services/pdf/tripSheetPdfService.ts`, `invoicePdfService.ts` — PDFs.
- `scripts/diag-irn-cancel.ts` — reusable live IRN-cancel forensic harness (WI-090).
- `scripts/probe-nic-session.ts`, `probe-cancel-logs.ts` (repo-root `scripts/`) — read-only NIC diagnostics.

### Database models
~45 Prisma models, 38+ enums. Single DB, `distributor_id` discriminator (NO row-level security — convention only). Every tenant-scoped query MUST filter `distributorId`. Core: Distributor, User, Customer, CylinderType, Order, OrderItem, Invoice, InvoiceItem, GstDocument, GstApiLog, GstCredential, CreditNote, DebitNote, Driver, Vehicle, DriverVehicleAssignment (DVA), InventoryEvent, InventorySummary, CancelledStockEvent, PaymentTransaction, PaymentAllocation, CustomerLedgerEntry, PendingAction, OrderStatusLog. Platform-level (no distributorId): gst_states, hsn_codes, provider_catalog_*, distributors.

**Key enums (exact values):**
- `OrderStatus`: `pending_driver_assignment · pending_dispatch · preflight_in_progress · pending_delivery · delivered · modified_delivered · cancelled · returns_only`
- `VehicleStatus`: `idle · dispatched · returned · inactive`
- `AssignmentStatus` (DVA): `dispatch_ready · loaded_and_dispatched · returned_inventory · reconciled · cancelled`
- `GstMode`: `disabled · sandbox · live`
- `IrnStatus`: `not_attempted · pending · success · failed · cancelled · cancel_failed`
- `EwbStatus`: `not_attempted · pending · active · failed · cancelled`

### GST flow (IRN/EWB generation + cancellation)
**Generation (preflight, before goods leave depot):**
1. `preflightDispatch` (new trip) or `preflightAddToTrip` (existing trip) iterates each `pending_dispatch` order → `preflightOne`.
2. **IRN**: `POST /einvoice/type/GENERATE/version/V1_03` — payload has **NO inline `EwbDtls`** (inline path is dead code; NIC sandbox 5002'd on it — anti-pattern #10).
3. **EWB**: separate `POST /ewaybillapi/v1.03/ewayapi/genewaybill` call by IRN.
4. On full-batch success (`failed===0 && succeeded>0`): DVA → `loaded_and_dispatched`, **vehicle → `dispatched`** (both `preflightDispatch` and, since WI-090, `preflightAddToTrip`). If ≥2 EWBs → consolidated EWB (gencewb) = trip sheet.
5. Orders → `pending_delivery`; invoices get `irn`, `irnStatus=success`, `ewbStatus=active`.

**Cancellation (NIC enforces EWB-before-IRN order):**
1. `cancelOrder` (orderService) blocks if recorded payments exist (see §10). Calls `clearTokenCache(distributorId)` **once**.
2. `cancelEwb` → `POST /ewaybillapi/v1.03/ewayapi/canewb` (scope `ewaybill`).
3. `cancelIrn` → `POST /einvoice/type/CANCEL/version/V1_03` (scope `einvoice`). Guard: if active EWB still exists → refuses (`EWB_ACTIVE`).
4. Standalone retries: `POST /api/invoices/:id/cancel-ewb` and `/cancel-irn` (each clears token cache itself).
5. On IRN cancel failure → `irnStatus='cancel_failed'` (amber badge) + `IRN_CANCEL_FAILED` pending action.

### Inventory flow
- `InventoryEvent` rows feed `InventorySummary` per (distributorId, cylinderType, date). `computeSummaryForDate` builds Opening/Incoming/Delivered/Outgoing-Empties/Cancelled.
- `cancellation_return` events route to `cancelledStockQty` (NOT incomingFulls — anti-pattern fix WI-083a2).
- `CancelledStockEvent` lifecycle: `on_vehicle` → `pending_return`/`returned_to_depot` (reconciliation). Days can be locked/unlocked.

### Order lifecycle (states + transitions)
`pending_driver_assignment` → (assign-driver, vehicle from confirmed DVA) → `pending_dispatch` → (preflight claims) → `preflight_in_progress` → (IRN+EWB success) → `pending_delivery` → (confirmDelivery) → `delivered` / `modified_delivered`. Any non-terminal → `cancelled`. `returns_only` for empties-only orders. Cancel after dispatch triggers GST doc cancellation.

### Vehicle return flow
`idle` → (preflight success) → `dispatched` → (driver/admin **Mark as Returned**, blocked if any `pending_delivery` orders still out — WI-087) → `returned` → (Inventory **Vehicle Reconciliation**: cancels undelivered orders, restores stock, cancels GST) → `idle`. `confirmDelivery` is blocked once vehicle is `returned` (WI-087). The Fleet "Mark as Returned" button renders **only** when `vehicle.status === 'dispatched'` (web `FleetPage.tsx:424`).

---

## 4. TESTING STATUS

### Tested & passing
- **API integration suite: 484/484** (37 files) — auth, inventory, gst-invoicing, gst-toggle, customer-portal, workflow, gst-preflight, gst-trip-sheet, gst-dispatch-trip, gst-reissue (+variants), cancel-order, gst-token-expiry (incl. WI-090 cancel-guard tests), gst-payload-shape, anti-pattern-guards, settings, etc.
- **Live GST sandbox (dist-002):** B2B intra-state (Maruthi), B2B inter-state IGST (Hyderabad Caterers), B2C (Bangalore Foods) IRN+EWB generation; preflight dispatch; **IRN/EWB cancel succeeds at NIC** (WI-090 verified — production endpoint + standalone retry + direct fetch); add-to-trip → vehicle dispatched; trip-sheet PDF order numbers render with hyphen.
- **Invoice PDF download** (FB-006) — header bug fixed.
- **Settings thresholds** (FS-008/009).

### Pending (the real work for next session)
- **Phase 1 — Navigation smoke (55 cases, 7 roles)** — `docs/Navigation_Smoke_Test.xlsx` / TESTING_PROGRESS.md Phase 1. **0/55 done.** START HERE.
- **Phase 2 — E2E by module** (Orders 22, Inventory 18, Customers 17, Billing 26, Fleet 11, Settings 17, Workflows 47+) — `docs/E2E_Testing_Guide.xlsx` (272 cases). Mostly untested via UI.
- **Phase 3 — Mobile (Expo Go)** — driver/admin/inventory/customer/finance/super-admin.
- **WI-007** — GST live-mode verification (production WhiteBooks).

### Known issues / workarounds (see also §6)
- A few dist-002 orders stuck `pending_delivery` with cancelled invoices (diagnostic leftovers). Workaround: ignore or cancel via UI.
- `TEST-*-VEHICLE-*` fixtures show in Fleet (harmless).
- 2 pre-existing test-file typecheck warnings (`afterAll` not imported) — tests still pass.
- Bug #4 (CN button on DISABLED) and Bug #5 (vehicle field in assign modal) — marked fixed (WI-004/005); re-verify in UI during Phase 1/2.

---

## 5. PENDING TEST PLAN (exhaustive) — dist-002, by role

Web at http://localhost:5173. Do these in order; record pass/fail in `docs/TESTING_PROGRESS.md` and commit after the session. **Round 1 = the dist-admin block below.**

### A. sharma@gasdist.com — Distributor Admin (GST sandbox)
| # | Do | Check | Expected |
|---|----|-------|----------|
| A1 | Login | redirect | Lands on role dashboard; no console errors |
| A2 | Open every nav item (Analytics, Orders, Inventory, Customers, Billing & Payments, Fleet, Collections, Settings) | each page loads | All render; GST columns/buttons visible (gstMode=sandbox) |
| A3 | Customers → create B2B customer with GSTIN | GSTIN autofill (WI-040) | Name/address autofilled from GSTIN lookup |
| A4 | Orders → create order (Maruthi Agencies, 19KG ×2) | order created | Status `pending_driver_assignment` |
| A5 | Assign driver (Kiran Reddy) | vehicle auto-from-mapping | Status → `pending_dispatch`; no vehicle dropdown (WI-005) |
| A6 | Driver Assignment tab → Dispatch | preflight modal | Per-order IRN+EWB success; order → `pending_delivery`; vehicle → `dispatched` |
| A7 | Fleet → Vehicles | Mark as Returned button | Visible on the dispatched vehicle only (WI-090) |
| A8 | Add another order to same driver → "Add to Trip" | add-to-trip preflight | New order dispatched; vehicle stays `dispatched`; trip number preserved |
| A9 | Billing → invoice detail → Download PDF | PDF | EWB No in header; order numbers show full `ORD-XXXX` with hyphen |
| A10 | Billing → Cancel IRN on a dispatched invoice | EWB-then-IRN sequence | Both cancel at NIC (`status_cd=1`); `irnStatus=cancelled` (NOT cancel_failed) |
| A11 | Reissue: modify delivered qty | cancel+regenerate | New IRN/EWB; invoiceRevision row; no 2278 error |
| A12 | Create Credit Note (amount-based modal) → approve | CN IRN | CN gets IRN; PDF shows IRN; badge on invoice list |
| A13 | Order cancel WITH recorded payment | guard | Blocked: "handle the payment in Billing & Payments first" |
| A14 | Settings → GST → Test Connection | reachability | "Credentials valid" or amber "NIC unreachable" (honest badge, WI-089) |
| A15 | Cancel an order after dispatch | GST cancel + DVA release | EWB+IRN cancelled; vehicle/DVA released; inventory restored |

### B. finance2@gasdist.com — Finance
| # | Do | Check | Expected |
|---|----|-------|----------|
| B1 | Login | dashboard | Finance dashboard + collections call list |
| B2 | Billing & Payments | full access | Invoice list, filters (status, IRN status, date) |
| B3 | Record payment (cash/UPI/bank/cheque); partial payment | allocation | Auto + manual allocate work |
| B4 | Create + approve Credit Note / Debit Note | IRN-on-approval | CN/DN gets IRN; reject path works |
| B5 | Collections page | call list | Overdue customers listed |
| B6 | Customers | **view-only** (WI-079) | Can view, cannot edit |
| B7 | Try Orders/Inventory/Fleet/Settings | role gate | Blocked or limited per role (Finance now has preflight-dispatch access per WI-088, but is dist-002-scoped) |
| B8 | Cancel IRN / EWB (finance allowed, WI-039) | cancel | Succeeds |

### C. inventory2@gasdist.com — Inventory
| # | Do | Check | Expected |
|---|----|-------|----------|
| C1 | Login | dashboard | Inventory dashboard; analytics accessible (WI-079) |
| C2 | Inventory → daily summary | columns | Opening/Incoming/Delivered/Outgoing-Empties/Cancelled correct; no `-0` |
| C3 | Navigate dates; record incoming fulls / outgoing empties / manual adjust | events | Summary recomputes |
| C4 | Lock day / unlock day; add on locked day | guard | Locked day blocks edits |
| C5 | Orders → assign driver | dropdown populated (WI-079) | Driver dropdown works |
| C6 | Dispatch (preflight) | inventory role allowed | Preflight runs (inventory has dispatch access) |
| C7 | Vehicle Reconciliation (returned vehicle) | cancelled/undelivered stock | Stock restored; GST cancelled; vehicle → idle |
| C8 | Cancelled Stock tab | on_vehicle cancelled orders visible (WI-083a2) | Cancelled order shows in Undelivered Stock |
| C9 | Forecast / thresholds / onboarding (WI-080) | access | Renders |

### D. driver2@gasdist.com — Driver (Kiran Reddy)
| # | Do | Check | Expected |
|---|----|-------|----------|
| D1 | Login (web or Expo) | dashboard | Driver view |
| D2 | Orders | **only own assigned** (WI-062) | Cannot see other drivers' orders |
| D3 | Trip screen → Vehicle Stock | loaded stock | Per-cylinder counts |
| D4 | Confirm delivery (full / partial / with empties) | inventory events | Order → delivered/modified_delivered; EWB compliance |
| D5 | Confirm delivery after vehicle returned | guard (WI-087) | Blocked (409) |
| D6 | Mark Vehicle Returned (mobile, WI-085) | vehicle status | Blocked if pending_delivery orders out (WI-087); else → returned |
| D7 | Offline: confirm delivery with no network (WI-027) | queue + sync | Queued locally, syncs on reconnect (idempotent) |
| D8 | Try Inventory/Billing/Fleet/Customers/Settings | role gate | Blocked/redirect |

### E. customer2@gasdist.com — Customer (Bangalore Foods)
| # | Do | Check | Expected |
|---|----|-------|----------|
| E1 | Login | redirect | → /app/customer/dashboard |
| E2 | Customer Dashboard / Orders / Invoices / Payments / Account | load | All render; only own data |
| E3 | Invoice detail → driver contact (WI-028) | contact shown | Driver name/phone on delivered order |
| E4 | Modification request → (admin approve/reject) | workflow | Request created; admin sees it |
| E5 | Try admin routes (/app/analytics, /app/orders) | guard | Redirect to customer portal / 403 |
| E6 | Cross-tenant: attempt to view dist-001 data | tenant isolation | Impossible (no leak) |

> **Cross-tenant assertion (every role):** a dist-002 user must NEVER see dist-001 data and vice versa. Spot-check by inspecting IDs/customer names.

---

## 6. OPEN ITEMS & BUGS

### Parked / wont_fix WIs (with rationale)
- **WI-089 (wont_fix)** — Auto-refresh NIC session on SESSION_EXPIRED. Live probe disproved the premise: WhiteBooks **pins one token per session window** (immediate AND 60s-delayed re-auth return the identical token), and Test Connection has no special refresh power (it "works" due to elapsed time). The einvoice-session outage is transient/upstream and self-heals (seen dead ≥13.5 min). A synchronous retry can't bridge a 10-min outage. Shipped an honest credential badge instead. **Re-evaluate against LIVE-mode tenant** (pinning may be sandbox-only).
- **WI-008 (in_progress)** — Telugu i18n on branch `claude/sharp-grothendieck`, not merged.
- **WI-053 (in_progress)** — Mobile security hardening (SecureStore + rate limiting partly done; verify limiter fires before pilot).

### Known bugs not yet fixed
- **Bug #4** — Credit-note button visible when gstMode=DISABLED (WI-004 marked fixed; re-verify in UI).
- **Bug #5** — Vehicle field in assign-driver modal (WI-005 marked fixed; re-verify in UI).
- Stuck dist-002 `pending_delivery` orders with cancelled invoices (diagnostic leftovers) — clean via UI.

### Post-launch / needs decision
- **WI-007** — GST **live**-mode verification on production WhiteBooks (cannot fully clear cancel/retry behavior until done; token-pinning quirk may differ in prod).
- **WI-023** — Create GitHub repo + push master (remote not set up).
- **WI-024 / Phase 1** — 55-case manual smoke test not started.
- **Mobile WI-046/047/048** — smoke tests for admin/inventory/customer apps.
- Seed-cleanup pass to own/prune `TEST-*-VEHICLE-*` fixtures.
- dist-001 wholesale test cleanup wipes dist-001 data on `pnpm test` — fine if no manual data lives there; isolate if it becomes a problem.

---

## 7. CRITICAL ANTI-PATTERNS (CLAUDE.md #1–#15)

Each: **trigger → what NOT to do.**

1. **Ad-hoc test-*.ts at packages/api root** — trigger: writing a quick verification script. Don't litter root; make it a Vitest test or put it in `scripts/` with a clear purpose.
2. **Single Prisma migration on disk** — trigger: schema change. Don't `prisma migrate reset` shared dev/staging; write incremental migrations.
3. **`requireDistributor` skipped on /users, /billing, /pricing** — trigger: adding routes there. Don't assume isolation; enforce per-handler.
4. **Default JWT secrets fall back in code** — trigger: relying on dev fallback secrets. Don't ship code depending on weak secrets; hard-fail on missing.
5. **PDF/blob downloads bypassing the axios client** — trigger: new download/export endpoint. Don't use raw fetch (drops `X-Distributor-Id`); use the shared axios instance.
6. **Mocking an external API without validating payload shape** — trigger: GST/WhiteBooks tests. Don't trust mock-only; keep a `*-payload-shape.test.ts` asserting field formats/lengths against the provider schema.
7. **today()-dated fixtures on shared dev DB** — trigger: seeding time-sensitive data (orders/DVAs). Don't use real today (services query by date sweep up live rows + write mock IRNs). Use `TEST_DATE='2099-12-31'`.
8. **Cleanup that deletes only fixture IDs when the service queries broader** — trigger: test calls a service filtering by (distributorId, driverId, date). Don't clean by `IN(orderIds)` only; isolate by far-future date OR clean by the same broad criteria. **Companion (WI-090): never blanket-reset `vehicle.updateMany({where:{distributorId}})` — use a dedicated test vehicle and reset by `vehicleNumber`.**
9. **API typed as one shape but route returns another** — trigger: web `apiGet<T>` consuming an endpoint. Don't return raw Prisma arrays / TS enum names when the type says object/`@map` value; add a wire-shape guard test.
10. **Implementing external-API feature with mock-only verification** — trigger: new WhiteBooks/NIC path. Don't mark done without a LIVE sandbox call documented. IRN GENERATE has **no inline EwbDtls**; EWB is a separate call.
11. **External-API failures logged as errors, not persisted payloads** — trigger: new external client. Don't only `logger.error`; persist BOTH success+failure with full request+response (`gst_api_logs` via `callWithLog`).
12. **Error in EWB sub-step overwriting committed IRN status** — trigger: multi-step external flow with intermediate DB commits. Don't let the outer catch blindly mark the whole op failed; track `*Persisted` flags, only overwrite fields whose precondition is false.
13. **Tenant-scoped findFirst/findMany without distributorId** — trigger: `prisma.<tenantModel>.findFirst({where:{...}})`. Don't omit `distributorId`. Platform-fallback paths must also require `isValid:true`, exclude NULLs, use deterministic `orderBy`.
14. **shipToGSTIN/dispatchFromGSTIN on EWB with transactionType=1** — trigger: building EWB payload. Don't emit those four fields under type=1 (NIC 616). Only valid for type 2/3/4.
15. **Defensive short-circuit premised on provider-specific token behavior, applied across op types** — trigger: writing a retry-suppression heuristic. Don't assume "same token = stale" (WhiteBooks pins tokens; the pinned token is valid). Don't apply a dispatch/GENERATE guard to cancel. Cancel now retries the real NIC call with the pinned token; SESSION_EXPIRED only after a 2nd NIC rejection, with the raw NIC body attached.

---

## 8. GST REFERENCE

### WhiteBooks credentials — dist-002 (SANDBOX ONLY)
Stored in DB `gst_credentials` (scope `einvoice` + `ewaybill`); also visible in test mocks/seed. Sandbox base `https://apisandbox.whitebooks.in` (prod would be `https://api.whitebooks.in`).
- `client_id`: `EINS-...` (per seed) · `username`: `BVMGSP` · `password`: `Wbooks@0142` · `gstin`: `29AAGCB1286Q000` · `email`: `mvsuneelkumar2903@gmail.com`.
- Auth: einvoice = username/password in **headers**; ewaybill = username/password in **query params** (returns `no-token-needed` — EWB validates creds only, no bearer token).

### Token refresh behavior (sandbox vs prod)
- **Sandbox PINS one auth token per session window** — re-auth (immediate or delayed) returns the **identical** token string. Proven by `scripts/probe-nic-session.ts`. The pinned token is **valid** (GSTNDETAILS + IRN cancel succeed with it).
- Sandbox also returns a **stale `TokenExpiry`** (echoes a previous session). WI-085: retry auth once; if still stale, accept with a **55-minute fallback** window (WhiteBooks confirmed sandbox tokens valid 1h from issuance).
- `SESSION_EXPIRED` is surfaced ONLY when NIC actually rejects the token (error 1004/1005) — and for **cancel**, only after a SECOND rejection (WI-090). The `apiCall` cancel path now retries the real NIC call with the pinned token instead of short-circuiting.
- **Prod behavior unknown** — may issue genuinely fresh tokens. Re-evaluate retry logic during WI-007.

### B2B vs B2C flow differences (`payloadBuilders.ts`)
- `isB2C = !buyer.gstin || buyer.gstin === 'URP'`.
- IRN `TranDtls.SupTyp`: `B2C` vs `B2B`. `BuyerDtls.Gstin`: B2C = `'URP'`, B2B = real GSTIN.
- **EWB `transactionType`: B2C = `2`, B2B = `1`** (line ~421). *(Earlier approaches WI-057 forced type=1 for B2C; WI-071/074 corrected B2C to type=2 with URP Bill-To + depot Ship-To. There is NO transactionType=4 in current code.)*
- **Redundant fields:** under transactionType=1 (B2B) OMIT all four `shipToGSTIN/shipToTradeName/dispatchFromGSTIN/dispatchFromTradeName` (NIC 616 — anti-pattern #14). B2C (type=2) emits `shipToGSTIN`/`shipToTradeName` (depot is Ship-To) only.
- `transDistance`: pincode lat/lon → Haversine × road-circuity factor (WI-067/070).

### IRN cancel sequence (STRICT: EWB first, then IRN)
1. NIC rejects IRN cancel if an active EWB exists → **cancel EWB first** (`canewb`), then IRN (`CANCEL`).
2. `cancelOrder` evicts token cache **once**, then EWB→IRN. Standalone retries: `/cancel-ewb`, `/cancel-irn`.
3. Cancel reason codes: 1=Duplicate, 2=Data entry error, 3=Order cancelled, 4=Others.
4. NIC cancel window ~24h from generation.

### Common NIC error codes
| Code | Meaning | Handling |
|------|---------|----------|
| `1004` / `1005` | Auth token expired / invalid | apiCall evicts + re-auths; cancel retries the real call (WI-090); SESSION_EXPIRED only after 2nd reject |
| `5002` | Generic JSON/validation failure (no field hint) | Often payload-shape (e.g. inline EwbDtls — removed). Inspect stored request payload in gst_api_logs |
| `616` | EWB "JSON validation failed" | Redundant shipTo/dispatchFrom under transactionType=1 (anti-pattern #14) — strip them |
| `2278` | IRN cancel window/trap | Reissue 2278-trap (WI-064) — handle, don't blind-retry |
| `2150` | Duplicate IRN | Treated as success (order proceeds) |
| `3028` | GSTIN invalid | Surface to user; do not retry |

---

## 9. NEXT SESSION START SEQUENCE

```bash
# 0. cd to repo
cd C:\Projects\Re-New_Gaslink

# 1. Confirm you're on the expected commit
git rev-parse HEAD
#   EXPECTED: 07b76193d2fde7ec21631386affea2428760383b
git log --oneline -3
git status --short      # should be clean

# 2. Confirm tests are green (THE baseline)
pnpm --filter @gaslink/api test
#   EXPECTED: Test Files 37 passed (37) | Tests 484 passed (484)

# 3. Bring the system up
pnpm docker:up          # if gaslink-db not already healthy
pnpm dev                # API :5000 + Web :5173 (background it)
curl http://localhost:5000/api/health     # status healthy
# Web: open http://localhost:5173

# 4. (Optional) Clean dist-002 test data to a known baseline
npx tsx scripts/cleanup-dist002-seed.ts   # resets dist-002 seed + vehicle statuses to idle
npx tsx scripts/create-dist002-users.ts   # ensure finance2/inventory2/driver2/customer2 exist
```

### First thing to do
Begin **§5 Round 1 — sharma@gasdist.com (Distributor Admin)** test cases A1–A15, then B (finance2), C (inventory2), D (driver2), E (customer2). Record each result in `docs/TESTING_PROGRESS.md` (Phase 1 Navigation table + Phase 2 module tables) and commit at session end:
```bash
git add docs/TESTING_PROGRESS.md && git commit -m "test: <what was tested>"
```
Then move to Phase 2 E2E modules (`docs/E2E_Testing_Guide.xlsx`, 272 cases). Mobile (Phase 3) and WI-007 live-mode after UI testing stabilizes.

---

## 10. KEY DECISIONS MADE

- **Float→Decimal (WI-006) — storage migrated, service arithmetic deferred.** All 35 monetary fields are now `NUMERIC(18,4)` in Postgres (migration `20260506010000_...` via `ALTER COLUMN ... USING ::NUMERIC(18,4)`, preserving data) — so storage and SQL aggregates are penny-perfect. The **deferred** part: service-layer arithmetic still reads columns as `number` via `toNum()` (`utils/decimal.ts`) instead of full `Prisma.Decimal` math everywhere. Rationale: the storage fix removes the float-drift risk in the DB; converting every service computation to Decimal is large, lower-risk-reward, and can follow later.
- **Payments on cancel — block, don't auto-reverse.** `cancelOrder` throws `409 "Cannot cancel order with recorded payments. Please handle the payment in Billing & Payments first."` when `paymentAllocation` rows exist. Rationale: auto-reversing money is error-prone and surprising; force explicit manual handling in Billing. *(There is no "Option C" label in the repo — this is the implemented decision; the rejected alternatives were silent auto-reversal and partial-cancel.)*
- **B2C EWB uses `transactionType=2`, NOT 4.** B2C = Bill-To is unregistered (`URP`), Ship-To is the depot → NIC spec `transactionType=2` (Bill-To ≠ Ship-To) with URP Bill-To + depot Ship-To (WI-074, superseding WI-057's type=1 forcing). B2B = `transactionType=1`. Under type=1, the four shipTo/dispatchFrom fields are OMITTED (NIC 616). *(If you see "type=4" anywhere it's stale — current code is 1/2.)*
- **Role access expansions (WI-079, WI-088).** Inventory role got analytics access, assign-driver dropdown, edit/dispatch perms, and (per WI-088 in test comments) **finance + inventory can run preflight-dispatch** — rationale: dispatch is an operational/inventory task, and finance needs to clean up IRNs for CN/DN. Finance got **view-only** customer access. All still tenant-scoped (a dist-001 finance token calling a dist-002 driver gets 404, not 403 — role gate passes, tenant isolation blocks).
- **Cancel-retry guard premise (WI-090).** Kept the GENERATE short-circuit (duplicate-IRN risk) but made cancel flows retry the real NIC call with the pinned token, because the live probe proved the pinned token is valid. SESSION_EXPIRED now only after a 2nd NIC rejection and carries the raw NIC body (no more `responsePayload=NULL`).
- **WI-089 wont_fix** — synchronous SESSION_EXPIRED auto-refresh abandoned (token pinning + self-healing upstream outage make it ineffective). See §6.
- **Single dev DB shared by tests + manual testing** — drives anti-patterns #7/#8 and the WI-090 dedicated-test-vehicle fix. Tests must isolate by far-future `TEST_DATE` and dedicated fixtures, never blanket distributor-scoped mutations.

---

*End of handoff. SHA `07b7619` · 484/484 tests · master · 2026-05-21.*
