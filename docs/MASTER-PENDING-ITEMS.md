# Re-New GasLink — Master Pending Items

Single source of truth for everything parked, deferred, or not-yet-built.
Item numbers (1–24) are **stable IDs** carried over from the working list —
they are referenced elsewhere, so they are kept fixed even though the items
are grouped by category below (numbers are therefore non-contiguous within a
group).

Status: `pending` (planned, not started) · `parked` (deliberately deferred) ·
`blocked` (waiting on an external dependency/approval) · `in-progress`.
Priority: `critical` · `high` · `medium` · `low`.

Last compiled: 2026-05-23. Total items: **24**.

---

## Driver Mobile App

**#2 — Post-reissue GST status visibility on driver app**
- Status: pending · Priority: high
- Driver sees "Delivery confirmed!" even when the modified-delivery reissue
  fails — the EWB shown at a checkpoint can be silently stale/invalid.
- WI-104 built the warning, but post-reissue IRN/EWB status is not surfaced
  on the driver screen. Dependency: relates to #16 (review gate) and #24.

**#1 — Proof photo upload in delivery modal**
- Status: parked · Priority: low
- Photo is captured but never uploaded to the server. Either implement the
  S3 upload or remove the camera button from the UI.

**#11 — Tab bar z-index issues on mobile**
- Status: pending · Priority: low
- Visual layering bug on the mobile bottom tab bar.

**#6 — Finance role mobile app**
- Status: pending · Priority: medium
- Not yet investigated or built. (Mobile, Finance role.)

**#7 — Inventory role mobile app**
- Status: pending · Priority: medium
- Not yet investigated or built. (Mobile, Inventory role.) See also Inventory
  group for stock-accounting items.

---

## Customer Mobile App

- No open build items. Customer-app testing is tracked under **#21** in the
  Testing group.

---

## Web App

**#4 — "Generate GST & re-dispatch" single action in dispatch modal**
- Status: parked · Priority: medium
- Currently a two-screen dance (Billing → Orders). Collapse into one action
  in the dispatch modal. Needs Suneel approval before building.

---

## Backend / API

**#3 — Auto-retry transient NIC 5002 during dispatch**
- Status: pending · Priority: medium
- Should silently retry 2–3× before surfacing the error to the admin.

**#20 — Cancelled order bleeds into current trip view**
- Status: pending · Priority: medium
- A stale cancelled order from a previous dispatch session appears in the
  current trip's "Orders in Trip" when both sessions share the same
  tripNumber. Fix: scope cancelled orders to those cancelled after the
  current DVA `dispatchedAt` timestamp. Related root cause: #17.

---

## GST / NIC / Compliance

**#24 — Null-value guard on all NIC success responses**
- Status: pending · Priority: high
- NIC can return `status_cd=1` with a null/empty IRN or EWB number. WI-091
  handled dispatch EWB only; the same guard is needed on all four NIC calls
  (dispatch IRN, dispatch EWB ✅, reissue IRN, reissue EWB). Never store
  active/success with a null identifier — mark failed + raise a pending
  action. **Full detail in `docs/PENDING-ACTIONS-ROADMAP.md` → NIC Response
  Integrity.** Touch points: gstService.ts, gstReissueService.ts.

**#22 — Audit blank IRN at dispatch (subsumed by #24)**
- Status: pending · Priority: high
- Verify whether a blank IRN on `status_cd=1` is handled at dispatch time.
  Currently only EWB is guarded (WI-091). This is path #1 of #24 — track
  together.

**#16 — WI-099 modified-delivery admin review gate**
- Status: pending · Priority: high
- When a driver delivers a different qty, reissue currently fires
  automatically. Approved design: raise a PendingAction and defer the
  reissue until an admin approves (bell notification + Orders "modified"
  filter). Not yet built. Dependency: pairs with #2.

**#5 — EWB QR code on trip sheet PDF + Compliance Docs screen**
- Status: parked · Priority: medium
- Format confirmed: `EWB No. : {ewbNo} / GSTIN : {gstin} / Date : {ewbDate}`.
  Parked pending approval. See `docs/WI-095-EWB-QR.md`.

**#13 — WhiteBooks GST + WhatsApp: sandbox → production cutover**
- Status: blocked · Priority: critical
- Required before real revenue flows. WhatsApp is still stubbed
  (`packages/mobile/src/services/notifications.ts`). Blocked on go-live.

---

## Inventory

**#18 — Dispatch-event architecture cutover (WI-106)**
- Status: pending · Priority: high
- WI-106 is built and flag-gated. On go-live day, run
  `scripts/lock-historical-summaries.ts` BEFORE setting
  `INVENTORY_DISPATCH_DEBIT=true`. Verified live (20/20). Enables #15.

**#15 — Over-delivery guard on delivery modal**
- Status: parked · Priority: medium
- Total delivered of a cylinder type across the trip cannot exceed total
  loaded. All data available from the trip-stock endpoint. Dependency: needs
  the dispatch-event model (#18) to make "loaded" accurate.

**#23 — Over-delivery guard (duplicate of #15)**
- Status: parked · Priority: medium
- Same item as #15; kept as an ID alias to avoid renumbering.

---

## Infrastructure / DevOps

**#9 — Phase-1 production blockers final sign-off**
- Status: pending · Priority: high
- Graceful shutdown, ErrorBoundary, Axios CVE, source maps, seed
  credentials. Committed but never formally signed off.

**#10 — Log persistence, Nginx security headers, Docker non-root user**
- Status: pending · Priority: medium
- Queued from the security audit.

**#14 — EAS production build + Play Store / App Store submission**
- Status: pending · Priority: high
- Pipeline exists; the production build has not been triggered. See
  `.session/eas-readiness.md`.

---

## Post-Launch Architecture

**#12 — Float → Decimal migration**
- Status: parked · Priority: high
- 49 monetary fields use Float. Highest business risk; deferred to
  post-launch week 2. See `.session/float-to-decimal-plan.md`.

**#17 — DVA per-trip refactor**
- Status: parked · Priority: medium
- One DVA row per trip instead of reusing one row with an incrementing
  tripNumber. Eliminates all DVA scoping bugs at the root (incl. #20).
  Medium effort, post-launch.

**#19 — Pending Actions full improvements**
- Status: parked · Priority: medium
- Date-wise grouping, SLA deadlines, role-based actioning
  (Finance/Inventory, not just Distributor Admin), bulk resolve, overdue
  state. Full roadmap in `docs/PENDING-ACTIONS-ROADMAP.md`.

---

## Testing (not yet done)

**#8 — Web testing rounds 2–6**
- Status: pending · Priority: high
- Finance, Inventory, Driver-web, Customer portal, and Tenant-isolation
  rounds not started.

**#21 — Customer app testing**
- Status: pending · Priority: medium
- Not started.
