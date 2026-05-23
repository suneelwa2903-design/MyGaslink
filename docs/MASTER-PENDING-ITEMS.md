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
