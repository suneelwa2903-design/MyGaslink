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
  (trip.tsx:463-538). GAP: no **IRN/reissue-success** indicator — after a
  modified delivery the driver can't tell if the reissue actually succeeded
  (only the EWB badge hints indirectly). Pairs with #16.

**#1 — Proof photo in delivery modal**
- Status: **PARTIAL** · Priority: low
- DONE: camera button + capture/preview exist (orders.tsx:375-401,
  DeliveryProofCamera.tsx, expo-camera). GAP: `submitDelivery` never sends the
  photo (posts only `{items, notes}`, orders.tsx:73-89); API `confirmDelivery`
  + `deliveryConfirmationSchema` have no photo field — captured locally then
  discarded. Decide: implement upload/storage or remove the button.

**#11 — Tab bar z-index issue on mobile**
- Status: **NOT APPLICABLE** · Priority: low
- No z-index/elevation issue in code. `getTabBarConfig` (theme.ts:110-117) sets
  no zIndex; the prior modal-vs-tabbar overlap was already handled in the
  delivery modal (`overFullScreen` + `statusBarTranslucent`, orders.tsx:263-278).
  No open defect — close unless a device repro surfaces.

**#6 — Finance role mobile app**
- Status: **DONE** · Priority: medium
- Functional screens under (finance)/: dashboard, invoices, payments (record
  payment + credit-note forms), collections, more, profile — all real
  useApiQuery/useApiMutation, no stubs.

**#7 — Inventory role mobile app**
- Status: **DONE** · Priority: medium
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
  IRN+EWB inline (OrdersPage.tsx:1808-1924). GAP: no in-modal **retry**/
  re-dispatch for failed orders — recovery still needs the separate "Generate
  GST" button on BillingPaymentsPage.tsx:735-743. Needs Suneel approval for the
  combined retry action.

---

## Backend / API

**#3 — Auto-retry transient NIC 5002 during dispatch**
- Status: **PENDING** · Priority: medium
- No 5002 retry loop. `apiCall` retries only on token errors 1004/1005
  (whitebooksClient.ts); 5002 throws straight through. Partial mitigation: the
  WI-091 pre-dispatch `pingEinvoiceSession` probe (3 attempts) aborts a
  session-down batch — but does not retry a per-order 5002.

**#20 — Cancelled order bleeds into current trip view**
- Status: **PARTIAL** · Priority: medium
- The chosen fix was per-order **tripNumber** stamping (WI-096b), NOT the
  proposed `dispatchedAt` scoping. `GET /me/assignment` orders query
  (driversVehicles.ts:309-322) filters by `tripNumber: effectiveTrip` with no
  status filter — a cancelled order carrying the current trip number can still
  appear. (Sibling `/me/trip-stock` DOES exclude cancelled, :388-389.) GAP:
  exclude cancelled from the assignment orders view too. Root fix is #17.

---

## GST / NIC / Compliance

**#24 — Null-value guard on all NIC success responses**
- Status: **PENDING** · Priority: high
- generateEwbFromIrn (gstService.ts): on `status_cd=1` with null ewbNo it only
  `logger.warn`s then writes ewbStatus='active', ewbNo=null — the
  EWB_GENERATION pending action fires only in the `catch` (thrown error), not on
  the null-number path. Full spec in PENDING-ACTIONS-ROADMAP.md → NIC Response
  Integrity. Confirms the expected gap.

**#22 — Blank IRN guard at dispatch**
- Status: **PENDING** · Priority: high
- Both processInvoiceGst (gstService.ts ~313-335) and runB2bPreflight
  (gstPreflightService.ts ~964-989) write `irnStatus:'success'` with the
  returned `irn` and **no null/empty check** — a `status_cd=1` with null Irn
  stores success+null. This is path #1 of #24; track together.

**#16 — WI-099 modified-delivery admin review gate**
- Status: **PENDING** · Priority: high
- confirmDelivery (orderService.ts:894-904) still fires
  reissueForDeliveryMismatch **fire-and-forget** on `isModified && hasLiveGstDoc`
  — no PendingAction gate / admin approval. `MODIFIED_DELIVERY_REVIEW` is listed
  as a not-yet-built action type in PENDING-ACTIONS-ROADMAP.md. Pairs with #2.

**#5 — EWB QR code on trip sheet PDF + Compliance Docs**
- Status: **PENDING** · Priority: medium
- tripSheetPdfService.ts renders EWB numbers as plain text only — no QR
  (no qr/SignedQRCode/doc.image of a QR). `signedQr` is captured to gstDocument
  (gstService.ts:316,350) but never rendered. (No docs/WI-095-EWB-QR.md found.)

**#13 — WhiteBooks/WhatsApp sandbox → production cutover**
- Status: **PARTIAL** · Priority: critical
- WhiteBooks host switch exists (SANDBOX_BASE/PROD_BASE, getCredentials picks by
  `gstMode==='sandbox'`) — so `gstMode='live'` flips to prod; null-distributor
  creds default to sandbox. GAP: WhatsApp is fully **stubbed**
  (mobile/src/services/notifications.ts no-ops; no twilio/whatsapp in api). The
  cutover itself (prod creds + go-live) is an operational task, not yet done.

---

## Inventory

**#18 — Dispatch-event architecture cutover (WI-106)**
- Status: **PENDING** · Priority: high
- WI-106 built + flag-gated; verified live (20/20). Prerequisite
  `scripts/lock-historical-summaries.ts` **exists**. Cutover NOT performed:
  `INVENTORY_DISPATCH_DEBIT` is absent from .env / .env.example (defaults off,
  inventoryFlags.ts:19). Go-live step: run the lock script BEFORE setting the
  flag true. Enables #15.

**#15 — Over-delivery guard on delivery modal**
- Status: **PENDING** · Priority: medium
- No upper-bound cap in any layer: Zod `deliveredQuantity` is `min(0)` only
  (schemas/index.ts:150); web (OrdersPage.tsx:1037) and mobile
  (orders.tsx:142-178) inputs have no `max`; confirmDelivery
  (orderService.ts) never rejects delivered > loaded. WI-104 only *warns*.
  Dependency: needs #18 to make "loaded" accurate.

**#23 — Over-delivery guard (duplicate of #15)**
- Status: **PENDING** · Priority: medium — same item as #15 (ID alias).

---

## Infrastructure / DevOps

**#9 — Phase-1 production blockers final sign-off**
- Status: **DONE** · Priority: high
- All verified: graceful shutdown SIGTERM/SIGINT (server.ts:98-99); React
  ErrorBoundary wrapping app (ErrorBoundary.tsx, main.tsx:54); axios ^1.15.0
  across web/mobile/api (above CVE range); `build.sourcemap:false`
  (vite.config.ts:25); seed passwords are expected test creds (documented in
  CLAUDE.md), not a blocker.

**#10 — Log persistence, Nginx security headers, Docker non-root user**
- Status: **PENDING** · Priority: medium
- All three unfixed: API Dockerfile has **no USER** (runs as root); web
  nginx.conf sets only Cache-Control (no X-Frame-Options/CSP/HSTS/
  X-Content-Type-Options); winston logger is **Console-only** (logger.ts:19-25)
  — no file/rotating/remote transport. Dockerfiles + compose exist; hardening
  does not.

**#14 — EAS production build + Play Store / App Store submission**
- Status: **PARTIAL** · Priority: high
- eas.json HAS a `production` build profile (autoIncrement, prod API/Sentry).
  GAP: `submit.production` is empty `{}` — no ascAppId / serviceAccountKeyPath /
  store creds; no artifacts; git history shows only readiness-audit commits — a
  production build has never been run.

---

## Post-Launch Architecture

**#12 — Float → Decimal migration**
- Status: **PARTIAL** · Priority: high
- Currency amounts are already `Decimal(18,4)` (invoices etc.). 13 `Float`
  columns remain in schema.prisma — most legitimately non-monetary (lat/long,
  capacity, weight). The only rate fields still Float: `gstRate` (×2),
  `quarterlyDiscount`, `halfYearlyDiscount`, `yearlyDiscount`. Net: currency
  migration effectively done; convert the 4 rate% fields for completeness.

**#17 — DVA per-trip refactor**
- Status: **PARKED** · Priority: medium
- Confirmed still the OLD model: one DVA row per (driver, assignmentDate) with
  incrementing `tripNumber`, `@@unique([driverId, assignmentDate, tripNumber])`
  (schema.prisma:800,834). Intentionally deferred post-launch; root fix for #20.

**#19 — Pending Actions full improvements**
- Status: **PARTIAL** · Priority: medium
- DONE: SLA-deadline badge + Overdue state (PendingActionsPage.tsx:103-112).
  GAP: grouping is by module not date-wise (today/overdue/upcoming); role
  filtering is a manual Select, not role-aware default; **no bulk resolve**
  (per-action only, :177-203).

---

## Testing (not yet done)

**#8 — Web testing rounds 2–6**
- Status: **PENDING** · Priority: high
- Finance, Inventory, Driver-web, Customer portal, Tenant-isolation rounds not
  started. (Testing task — not code-verifiable.)

**#21 — Customer app testing**
- Status: **PENDING** · Priority: medium
- Not started. (Testing task — not code-verifiable.)
