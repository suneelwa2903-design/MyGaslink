# Re-New GasLink — Master Pending Items

Single source of truth for everything parked, deferred, or not-yet-built.
Item numbers (1–24) are **stable IDs** — referenced elsewhere, kept fixed even
though items are grouped by category (so numbers are non-contiguous within a
group).

Status verified by **deep code/DB audit on 2026-05-23** (independent of the
prior doc's claims). Status: `DONE` · `PARTIAL` (gap noted) · `PENDING` (not
started) · `PARKED` (intentionally deferred) · `NOT APPLICABLE`.
Priority: `critical` · `high` · `medium` · `low`.

## Summary (post-audit)

| Status | Count | Items |
|--------|-------|-------|
| DONE | 3 | #6, #7, #9 |
| PARTIAL | 8 | #1, #2, #4, #12, #13, #14, #19, #20 |
| PENDING | 11 | #3, #5, #8, #10, #15, #16, #18, #21, #22, #23, #24 |
| PARKED | 1 | #17 |
| NOT APPLICABLE | 1 | #11 |
| **Total** | **24** | |

> #23 is a duplicate ID of #15 (over-delivery guard) — same item, both PENDING.

---

## Driver Mobile App

**#2 — Post-reissue GST status visibility on driver app**
- Status: **PARTIAL** · Priority: high
- DONE: WI-104 pre-submit mismatch warning Alert (orders.tsx:154-175); trip.tsx
  Compliance Docs shows per-order **EWB** status + numbers, polls every 30s
  (trip.tsx:463-538).
- Gap / What remains: surface a **post-reissue IRN/reissue-success indicator**
  on the driver screen — after a modified delivery the driver currently can't
  tell whether the reissue succeeded (only the EWB badge hints indirectly).
  Pairs with #16.

**#1 — Proof photo in delivery modal**
- Status: **PARTIAL** · Priority: low
- DONE: camera button + capture/preview exist (orders.tsx:375-401,
  DeliveryProofCamera.tsx, expo-camera).
- Gap / What remains: photo is captured locally then discarded —
  `submitDelivery` posts only `{items, notes}` (orders.tsx:73-89) and the API
  `confirmDelivery` + `deliveryConfirmationSchema` have no photo field. Either
  add a photo field end-to-end (upload + storage, e.g. S3) **or** remove the
  camera button.

**#11 — Tab bar z-index issue on mobile**
- Status: **NOT APPLICABLE** · Priority: low
- No z-index/elevation issue in code. `getTabBarConfig` (theme.ts:110-117) sets
  no zIndex; the prior modal-vs-tabbar overlap was already handled in the
  delivery modal (`overFullScreen` + `statusBarTranslucent`, orders.tsx:263-278).
  No open defect — close unless a device repro surfaces.

**#6 — Finance role mobile app**
- Status: **DONE** · Priority: medium · Last verified: 2026-05-23
- Functional screens under (finance)/: dashboard, invoices, payments (record
  payment + credit-note forms), collections, more, profile — all real
  useApiQuery/useApiMutation, no stubs.

**#7 — Inventory role mobile app**
- Status: **DONE** · Priority: medium · Last verified: 2026-05-23
- Functional screens under (inventory)/: inventory (incoming/outgoing/adjust
  forms), actions, alerts, analytics, fleet, orders, reconciliation, summary —
  all real API hooks, no stubs.

---

## Customer Mobile App

- No open build items. Customer-app testing tracked under **#21** (Testing).

---

## Web App

**#4 — "Generate GST & re-dispatch" single action in dispatch modal**
- Status: **PARTIAL** · Priority: medium
- DONE: normal dispatch is already one click — the Orders Dispatch button opens
  DispatchProgressModal which POSTs /orders/preflight-dispatch and generates
  IRN+EWB inline (OrdersPage.tsx:1808-1924).
- Gap / What remains: add an **in-modal Retry / re-dispatch** for failed orders
  inside DispatchProgressModal — recovery currently requires the separate
  "Generate GST" button on BillingPaymentsPage.tsx:735-743. Needs Suneel
  approval for the combined recovery action.

---

## Backend / API

**#3 — Auto-retry transient NIC 5002 during dispatch**
- Status: **PENDING** · Priority: medium
- No 5002 retry loop. `apiCall` retries only on token errors 1004/1005
  (whitebooksClient.ts); 5002 throws straight through. Partial mitigation: the
  WI-091 pre-dispatch `pingEinvoiceSession` probe (3 attempts) aborts a
  session-down batch — but does not retry a per-order 5002.
- Gap / What remains: add a transient-error retry (2–3× with backoff) keyed on
  5002 in `apiCall`/gstPreflightService before surfacing the error to the admin.

**#20 — Cancelled order bleeds into current trip view**
- Status: **PARTIAL** · Priority: medium
- The chosen fix was per-order **tripNumber** stamping (WI-096b), NOT the
  proposed `dispatchedAt` scoping. `GET /me/assignment` orders query
  (driversVehicles.ts:309-322) filters by `tripNumber: effectiveTrip` with no
  status filter. (Sibling `/me/trip-stock` DOES exclude cancelled, :388-389.)
- Gap / What remains: exclude cancelled orders from the `/me/assignment` orders
  query (mirror trip-stock's `status: { not: 'cancelled' }`) or scope by
  `dispatchedAt`. Root fix is the #17 DVA refactor.

---

## GST / NIC / Compliance

**#24 — Null-value guard on all NIC success responses**
- Status: **PENDING** · Priority: high
- generateEwbFromIrn (gstService.ts): on `status_cd=1` with null ewbNo it only
  `logger.warn`s then writes ewbStatus='active', ewbNo=null — the
  EWB_GENERATION pending action fires only in the `catch` (thrown error), not on
  the null-number path.
- Gap / What remains: on `status_cd=1` with null/empty ewbNo, mark
  ewbStatus='failed' + raise an EWB_GENERATION pending action (never store
  active with a null number). Full spec in PENDING-ACTIONS-ROADMAP.md → NIC
  Response Integrity (path #4).

**#22 — Blank IRN guard at dispatch**
- Status: **PENDING** · Priority: high
- Both processInvoiceGst (gstService.ts ~313-335) and runB2bPreflight
  (gstPreflightService.ts ~964-989) write `irnStatus:'success'` with the
  returned `irn` and **no null/empty check** — a `status_cd=1` with null Irn
  stores success+null.
- Gap / What remains: guard the IRN success branch — on `status_cd=1` with null
  Irn, set irnStatus='failed', raise an IRN_GENERATION pending action, and block
  the dispatch/billing entry. This is path #1 of #24; track together.

**#16 — WI-099 modified-delivery admin review gate**
- Status: **PENDING** · Priority: high
- confirmDelivery (orderService.ts:894-904) still fires
  reissueForDeliveryMismatch **fire-and-forget** on `isModified && hasLiveGstDoc`
  — no PendingAction gate / admin approval. `MODIFIED_DELIVERY_REVIEW` is listed
  as a not-yet-built action type in PENDING-ACTIONS-ROADMAP.md.
- Gap / What remains: replace the auto fire-and-forget reissue with a
  MODIFIED_DELIVERY_REVIEW PendingAction; defer the reissue until an admin
  approves (bell notification + Orders "modified" filter). Pairs with #2.

**#5 — EWB QR code on trip sheet PDF + Compliance Docs**
- Status: **PENDING** · Priority: medium
- tripSheetPdfService.ts renders EWB numbers as plain text only — no QR
  (no qr/SignedQRCode/doc.image of a QR). `signedQr` is captured to gstDocument
  (gstService.ts:316,350) but never rendered.
- Gap / What remains: render the stored `signedQr` as a QR image on the trip
  sheet PDF (and the Compliance Docs screen). Format confirmed:
  `EWB No. / GSTIN / Date`. Needs approval before building.

**#13 — WhiteBooks/WhatsApp sandbox → production cutover**
- Status: **PARTIAL** · Priority: critical
- WhiteBooks host switch exists (SANDBOX_BASE/PROD_BASE, getCredentials picks by
  `gstMode==='sandbox'`) — so `gstMode='live'` flips to prod; null-distributor
  creds default to sandbox.
- Gap / What remains: (a) build the WhatsApp integration — currently fully
  **stubbed** (mobile/src/services/notifications.ts no-ops; no twilio/whatsapp
  in api); (b) perform the operational cutover (set tenants to `gstMode='live'`
  + load production WhiteBooks creds) before real revenue flows.

---

## Inventory

**#18 — Dispatch-event architecture cutover (WI-106)**
- Status: **PENDING** · Priority: high
- WI-106 built + flag-gated; verified live (20/20). Prerequisite
  `scripts/lock-historical-summaries.ts` **exists**. `INVENTORY_DISPATCH_DEBIT`
  is absent from .env / .env.example (defaults off, inventoryFlags.ts:19).
- Gap / What remains: on go-live day, run `lock-historical-summaries.ts` FIRST,
  then set `INVENTORY_DISPATCH_DEBIT=true`. Enables #15.

**#15 — Over-delivery guard on delivery modal**
- Status: **PENDING** · Priority: medium
- No upper-bound cap in any layer: Zod `deliveredQuantity` is `min(0)` only
  (schemas/index.ts:150); web (OrdersPage.tsx:1037) and mobile
  (orders.tsx:142-178) inputs have no `max`; confirmDelivery (orderService.ts)
  never rejects delivered > loaded. WI-104 only *warns*.
- Gap / What remains: cap deliveredQuantity at the trip-stock loaded qty per
  type — Zod `.max()`, UI `max` on the input, and a server-side reject in
  confirmDelivery. Depends on #18 (so "loaded" is accurate).

**#23 — Over-delivery guard (duplicate of #15)**
- Status: **PENDING** · Priority: medium — same item as #15 (ID alias).
- Gap / What remains: see #15.

---

## Infrastructure / DevOps

**#9 — Phase-1 production blockers final sign-off**
- Status: **DONE** · Priority: high · Last verified: 2026-05-23
- All verified: graceful shutdown SIGTERM/SIGINT (server.ts:98-99); React
  ErrorBoundary wrapping app (ErrorBoundary.tsx, main.tsx:54); axios ^1.15.0
  across web/mobile/api (above CVE range); `build.sourcemap:false`
  (vite.config.ts:25); seed passwords are expected test creds (documented in
  CLAUDE.md), not a blocker.

**#10 — Log persistence, Nginx security headers, Docker non-root user**
- Status: **PENDING** · Priority: medium
- All three unfixed: API Dockerfile has **no USER** (runs as root); web
  nginx.conf sets only Cache-Control (no X-Frame-Options/CSP/HSTS/
  X-Content-Type-Options); winston logger is **Console-only** (logger.ts:19-25).
  Dockerfiles + compose exist; hardening does not.
- Gap / What remains: add a non-root `USER` to the API Dockerfile; add security
  headers (X-Frame-Options, CSP, HSTS, X-Content-Type-Options) to nginx.conf;
  add a file/rotating (or remote) winston transport for log persistence.

**#14 — EAS production build + Play Store / App Store submission**
- Status: **PARTIAL** · Priority: high
- eas.json HAS a `production` build profile (autoIncrement, prod API/Sentry).
- Gap / What remains: populate `submit.production` (ascAppId /
  serviceAccountKeyPath / store creds — currently empty `{}`) and actually run a
  production build + store submission (none has ever been run; no artifacts).

---

## Post-Launch Architecture

**#12 — Float → Decimal migration**
- Status: **PARTIAL** · Priority: high
- Currency amounts are already `Decimal(18,4)` (invoices etc.). 13 `Float`
  columns remain — most legitimately non-monetary (lat/long, capacity, weight).
- Gap / What remains: convert the 4 remaining **rate%** Float fields —
  `gstRate` (×2), `quarterlyDiscount`, `halfYearlyDiscount`, `yearlyDiscount` —
  to Decimal for completeness. Currency migration is effectively done.

**#17 — DVA per-trip refactor**
- Status: **PARKED** · Priority: medium
- Confirmed still the OLD model: one DVA row per (driver, assignmentDate) with
  incrementing `tripNumber`, `@@unique([driverId, assignmentDate, tripNumber])`
  (schema.prisma:800,834). Intentionally deferred post-launch; root fix for #20.

**#19 — Pending Actions full improvements**
- Status: **PARTIAL** · Priority: medium
- DONE: SLA-deadline badge + Overdue state (PendingActionsPage.tsx:103-112).
- Gap / What remains: add date-wise grouping (today/overdue/upcoming); make
  role filtering a role-aware default (not just a manual Select); add **bulk
  resolve** (currently per-action only, :177-203).

---

## Testing (not yet done)

**#8 — Web testing rounds 2–6**
- Status: **PENDING** · Priority: high
- Finance, Inventory, Driver-web, Customer portal, Tenant-isolation rounds not
  started. (Testing task — not code-verifiable.)
- Gap / What remains: execute all five rounds and log results in
  docs/TESTING_PROGRESS.md.

**#21 — Customer app testing**
- Status: **PENDING** · Priority: medium
- Not started. (Testing task — not code-verifiable.)
- Gap / What remains: execute the customer-app test pass and log results.

---

## UX (post-launch)

**#27 — Trip tab: "Trip Complete" state**
- Status: **PENDING** · Priority: low (post-launch UX)
- After all deliveries on a trip are done, the driver Trip tab still shows
  "dispatch ready" instead of a "Trip Complete" state. Add a terminal
  "Trip Complete" view once every order on the effective trip is
  delivered/modified_delivered (and reconciliation is pending/done).

**#28 — Vehicle Stock: show trip number**
- Status: **PENDING** · Priority: low (post-launch UX)
- Vehicle Stock (driver trip-stock view) doesn't indicate which trip number
  the displayed stock belongs to. Surface the effective trip number on the
  Vehicle Stock screen so the driver knows the stock is scoped to the current
  trip.

---

## Comprehensive audit findings (2026-05-24)

> Items #29–#36 surfaced by the four-part read-only audit on 2026-05-24.
> Items marked **IN PROGRESS** are being fixed in the current session.

**#29 — Inventory recompute "silent no-op" after reconciliation — NOT A BUG (misdiagnosed)**
- Status: **CLOSED / NOT A BUG** (WI-113 abandoned 2026-05-24) · superseded by **#18**
- Original theory: `confirmVehicleReconciliation` calls
  `recalculateSummariesFromDate(..., new Date())` with a timestamp, and since
  `summary_date`/`event_date` are `@db.Date` (midnight) the `gte: fromDate`
  filter would exclude today's events → silent no-op.
- **Disproven by direct Prisma probe (2026-05-24):** Prisma binds a `@db.Date`
  `gte` value as a DATE, so `gte: <today 16:53>` matches today's date-only
  events. `new Date()` is NOT a no-op — recompute works for both create and
  update, midnight or timestamp. The `startOfDay` change is behaviourally
  identical; reverted.
- **Real explanation of the 2026-05-23 5KG (32 vs 34) / 425KG (5 vs 6)
  discrepancy:** under dispatch-debit OFF, `cancelOrder` writes a `cancellation`
  (+qty) event AND reconciliation writes a `cancellation_return` (+qty) event
  for the SAME cancelled cylinders — a double-count. `computeSummaryForDate`
  folding in both yields 34 (double-counted, *wrong*); the stored 32 is the
  un-doubled (closer-to-physical) value. The staleness was a flag-OFF
  manual-testing artifact, not a recompute-date bug — and "fixing" the recompute
  would have made the number worse. The double-count is eliminated by the
  WI-106 dispatch-debit cutover (**#18**, flag-ON skips the `cancellation`
  event). No standalone fix; track under #18.

**#30 — IDOR: `GET /api/invoices/:id/gst-documents` not tenant-scoped**
- Status: **IN PROGRESS** (CRITICAL-FIX-A) · Priority: critical
- The route queries `prisma.gstDocument.findMany({ where: { invoiceId } })` with
  **no `distributorId` / ownership check** ([invoices.ts:272-275](packages/api/src/routes/invoices.ts)).
  Role allows distributor_admin/finance/inventory, so any tenant can pass another
  tenant's invoiceId and read its IRN/EWB numbers, signed QR, and NIC request/
  response payloads. The adjacent credit-notes ([line 293-296](packages/api/src/routes/invoices.ts))
  and debit-notes routes do the ownership pre-check first; this one was missed.
  Fix: add the same invoice-ownership pre-check (404 if not owned). Low risk.

**#31 — React Query cache not cleared on logout (systemic)**
- Status: **IN PROGRESS** (CRITICAL-FIX-A) · Priority: critical
- `logout()` clears only the Zustand auth store and SPA-navigates to /login
  ([DashboardLayout.tsx:75-79](packages/web/src/components/layout/DashboardLayout.tsx),
  [Sidebar.tsx:218-221](packages/web/src/components/layout/Sidebar.tsx)) — it never
  clears the TanStack Query cache. Combined with static query keys (`['orders']`,
  `['invoices']`, `['payments']`, `['vehicles']`, `['drivers']`, `['users']`,
  `['inventory']`, `['customers-list']`, …), a same-tab logout→login as a different
  tenant serves the prior tenant's lists from cache until refetch. The super-admin
  distributor *switch* is already mitigated (`DistributorSelector.resetQueries`);
  logout is not. Fix: `queryClient.clear()` in both logout handlers + scope the
  `customers-list` key by distributorId (belt-and-suspenders).

**#32 — WhiteBooks GSP credentials hardcoded in seed.ts**
- Status: **IN PROGRESS** (WI-114) · Priority: high
- `clientSecret`, `username`, and `password: 'Wbooks@0142'` for both einvoice and
  ewaybill scopes are committed in plaintext ([seed.ts:471-498](packages/api/prisma/seed.ts)).
  Sandbox, but live API secrets in the repo. Fix: read from env vars, fail loud if
  missing, add placeholders to `.env.example`, keep real values out of tracked files.

**#33 — Customer mobile: no invoice/statement PDF download**
- Status: **PENDING** · Priority: medium
- [(customer)/invoices.tsx](packages/mobile/app/(customer)/invoices.tsx) lists
  invoices + detail in-app but offers no PDF/statement download (no Linking/
  WebBrowser/FileSystem). The server route `GET /api/invoices/:id/pdf` already
  exists ([invoices.ts:165-172](packages/api/src/routes/invoices.ts)) — UI wiring
  only. Deferred (logged not built this session).

**#34 — Customer mobile: confirm-delivery & dispute not built**
- Status: **PENDING** · Priority: medium
- The confirm/dispute mutation hooks exist but point at routes that don't exist
  ([account.tsx:71-87,250](packages/mobile/app/(customer)/account.tsx), `TODO WI-093`);
  buttons are hard-disabled (`{false && …}`). `/customer-portal` has no
  confirm-delivery or dispute route. Needs 2 endpoints + a `customerAcknowledgedAt`
  column + mobile UI. Deferred (logged not built this session).

**#35 — Driver "My Deliveries" has no auto-refresh**
- Status: **IN PROGRESS** (WI-115) · Priority: medium
- `['driver-orders']` `useApiQuery` ([(driver)/orders.tsx:66-70](packages/mobile/app/(driver)/orders.tsx))
  passes no `refetchInterval`; My Deliveries refreshes only on pull-to-refresh +
  post-submit invalidation, while the Trip tab polls every 30s. Fix: add
  `refetchInterval: 30000`.

**#36 — Swagger: invoice PDF documented as 501 but implemented**
- Status: **PENDING** · Priority: low
- [swagger.ts:805-807](packages/api/src/swagger.ts) marks `/invoices/{id}/pdf` as
  "not yet implemented" / 501, but the route is fully implemented
  ([invoices.ts:165-172](packages/api/src/routes/invoices.ts)). Stale doc only.

**#37 — Daily cron for markOverdueInvoices**
- Status: **PENDING** · Priority: medium
- `computeCustomerOverdue` (the ledger FIFO formula,
  [paymentService.ts](packages/api/src/services/paymentService.ts)) is now the
  source of truth for overdue **amounts** (dashboard, collections, due-amounts,
  header metrics, order-placement gate — WI-122). But the `invoice.status`
  **badge** still relies on the manual `markOverdueInvoices`
  ([invoiceService.ts](packages/api/src/services/invoiceService.ts)), which only
  flips `issued`/`partially_paid` → `overdue` when explicitly invoked. Wire a
  daily cron to run it automatically so status badges stay current. Post-launch.

**#25 — EWB cancellation timing (cancel at order-cancel vs reconciliation)**
- Status: **PARKED** · Priority: medium
- Investigation confirmed: the EWB is cancelled at NIC at order-cancel time
  ([orderService.ts:1064](packages/api/src/services/orderService.ts), STEP 2,
  outside the TX), not at reconciliation — so a cancelled order's EWB disappears
  from Compliance Docs while the cylinders may still be physically on the truck.
  Moving the cancel to `confirmVehicleReconciliation` requires a ~30-50 line change
  in `cancelOrder` + `deliveryWorkflowService.ts` (reconciliation only handles
  still-`pending_*` orders, and currently cancels IRN but not EWB there), medium-high
  risk touching live NIC cancel ordering and the EWB-active-blocks-IRN invariant.
  Parked pre-launch.
