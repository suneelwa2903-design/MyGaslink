# WI-035 (WI-A): Pre-dispatch preflight service — IRN + EWB before goods leave depot
Type: feature
Priority: critical
Created: 2026-05-15
Dependencies: none

---

## Overview

LPG distribution is a physical-goods workflow regulated by NIC: every consignment crossing into transit must carry a valid e-Way Bill, and B2B Tax Invoices must additionally carry an IRN issued before invoicing. Today our code generates both **after** delivery confirmation using delivered quantities — too late legally, and impossible to remediate once a vehicle has left without an EWB. This work item moves IRN + EWB generation to **dispatch time** (when the admin commits to a driver's daily route), using **ordered** quantities. Delivery-mismatch corrections are handled separately by WI-037 (reissue flow). Outcome: no LPG cylinder leaves a distributor's depot without legally-valid GST documents on file.

## User Story

As a **distributor admin**, I want **all required GST documents to be issued before my driver leaves the depot** so that **the goods are legally compliant in transit and I am not exposed to NIC penalties or vehicle seizure at checkpoints**.

## Acceptance Criteria

- [ ] A new service method `gstPreflightService.preflightDispatch({ distributorId, driverId, assignmentDate, userId })` exists and is exported. It loads every order assigned to that driver for that date in status `pending_dispatch` and generates compliance docs for each.
- [ ] For each B2B order (customer.gstin set and ≠ 'URP'): IRN is generated via `POST /einvoice/type/GENERATE/version/V1_03` and the EWB is produced **inline** (transport details included in the IRN payload's `TranspDtls` block) — falling back to `POST /einvoice/type/GENERATE_EWAYBILL/version/V1_03?param1=<irn>` only if the IRN response did not include EWB fields. The standalone `/ewaybillapi/.../genewaybill` endpoint MUST NOT be used for B2B Tax Invoices ≥ 2020-10-01 (NIC EWB spec rule #1).
- [ ] For each B2C order (no gstin or gstin='URP'): no IRN is generated. EWB is produced via `POST /ewaybillapi/v1.03/ewayapi/genewaybill` with `toGstin: "URP"` and `transactionType: 1` (Regular).
- [ ] On success for an order: `invoice.irn`, `invoice.ackNo`, `invoice.ackDate`, `invoice.irnStatus='success'` (B2B only), `invoice.ewbStatus='active'`, `gstDocument.ewbNo`, `gstDocument.ewbDate`, `gstDocument.ewbValidTill` are all populated. The order transitions to `pending_delivery` and the driver-vehicle assignment to `loaded_and_dispatched`.
- [ ] **All-or-nothing per driver:** if any of the driver's orders fails preflight, NO orders transition status. The endpoint response lists every order with its individual outcome (success / error code / error message) so the UI can render a remediation screen. The admin can fix the failures and retry — successful orders are not re-attempted (idempotent via existing `gst_documents.is_latest` + IRN existence checks).
- [ ] The response includes a `summary` with `{ total, succeeded, failed }` counts so the UI can show a single-glance result.
- [ ] Failures create `PendingAction` rows of `actionType='DISPATCH_PREFLIGHT'` (one per failing order) so they appear in the existing Pending Actions queue alongside other GST errors.
- [ ] All WhiteBooks calls are logged to a new `gst_api_logs` table (or the existing `audit_logs` if we choose not to add a new model — see Database Changes) with request/response payloads, latency, error code, and a tenant scope on every row.

## Out of Scope

- The dispatch UI (per-driver button, results screen, retry interaction) — that's WI-036.
- Consolidated EWB / trip sheet generation — that's WI-038.
- Delivery-mismatch reissue (cancel + regenerate when delivered ≠ ordered) — that's WI-037.
- Vehicle-change-in-transit (`vehewb` Part-B update) — separate future work.
- EWB validity extension (`extendvalidity`) — separate future work.
- Cross-driver retry orchestration / scheduled retries — failures land in PendingActions and stay there until resolved manually.
- Changes to existing `processInvoiceGst` post-delivery path — it remains available as a fallback for tenants who skip preflight (and for the legacy auto-trigger from confirmDelivery, which becomes a no-op when docs already exist from preflight).

## Implementation Details

### Approach

1. **Add `gstPreflightService.ts`** at `packages/api/src/services/gst/gstPreflightService.ts`. Single exported function: `preflightDispatch(params)`. Internally it loads the driver-vehicle assignment for the date, finds all orders in `pending_dispatch`, and processes them sequentially (sequential, not parallel — WhiteBooks rate-limits and we want deterministic ordering for diagnostics).

2. **Per order, inside a transaction (per order, not batch):**
   a. Resolve buyer GSTIN to decide B2B vs B2C.
   b. Ensure a draft invoice exists for the order using **ordered** quantities. If one exists, reuse it (idempotency check on `gst_documents.is_latest` + invoice.irnStatus).
   c. Build the IRN payload via `buildIrnPayload(invoiceData)` enriched with `TranspDtls` (vehicleNumber from `order.vehicleId` / day's mapping, `transMode: '1'`, `transDistance: 1`).
   d. **B2B path:** call `POST /einvoice/.../GENERATE` and parse the response — `Irn`, `AckNo`, `AckDt`, `SignedQRCode`, plus inline `EwbNo` / `EwbDt` / `EwbValidTill`. Persist all to invoice + gst_documents. If inline EWB absent, fall back to `POST /einvoice/.../GENERATE_EWAYBILL` referencing the IRN. If THAT fails too (rare), the order is marked failed and is NOT dispatched.
   e. **B2C path:** skip IRN. Call `POST /ewaybillapi/.../genewaybill` with `transactionType: 1`, `toGstin: 'URP'`. Persist `EwbNo`/dates to gst_documents.
   f. Transition `order.status: pending_dispatch → pending_delivery`. Add a row to `order_status_logs`.

3. **Batch wrap-up:** if every order succeeded, transition the day's `DriverVehicleAssignment.status: dispatch_ready → loaded_and_dispatched`. If any order failed, leave all orders in `pending_dispatch` (status reverts via a saved snapshot — see error handling) and leave the assignment alone.

4. **Idempotency:** a re-run only attempts WhiteBooks calls for orders that don't already have `gst_documents.irnStatus = 'success'` + `ewbStatus = 'active'`. Already-compliant orders are auto-marked succeeded and transitioned. This way a partial-failure retry only re-attempts the failed orders.

5. **Logging:** every WhiteBooks call writes to `gst_api_logs` BEFORE the transaction commits the business change, so we always have an audit trail even when the DB write fails.

### Components / Files Affected

- `packages/api/src/services/gst/gstPreflightService.ts` — **new file** containing `preflightDispatch()` and helpers.
- `packages/api/src/services/gst/payloadBuilders.ts` — extend `buildIrnPayload` to accept and emit `TranspDtls` when transport info is supplied.
- `packages/api/src/services/gst/gstService.ts` — extract IRN-success/inline-EWB persistence + B2C EWB persistence into reusable helpers (called by both `processInvoiceGst` and `preflightDispatch`). Keep `processInvoiceGst` as the post-delivery fallback.
- `packages/api/src/routes/orders.ts` — new route `POST /api/orders/preflight-dispatch` (request body `{ driverId, assignmentDate }`), wired to `gstPreflightService.preflightDispatch`. Authenticated, requires `distributor_admin` or `super_admin`, requireDistributor.
- `packages/api/src/services/orderService.ts` — extract the `pending_dispatch → pending_delivery` transition into a reusable function (today it doesn't transition at all; this hook is missing).
- `packages/api/prisma/schema.prisma` — new `GstApiLog` model (see Database Changes) and an `actionType` enum value of `dispatch_preflight` if `PendingAction.actionType` is enum-typed (it's a string today; confirm).
- `packages/shared/src/schemas/index.ts` — new `preflightDispatchSchema` for request validation.
- `packages/api/src/__tests__/preflight.test.ts` — **new test file** with the cases in Testing Strategy below.

### API Changes

```
POST /api/orders/preflight-dispatch
Auth: required (Bearer JWT)
Roles: distributor_admin | super_admin
Headers: X-Distributor-Id (super_admin only)
Request:
{
  "driverId": "<uuid>",
  "assignmentDate": "YYYY-MM-DD"
}

Response (200) — all orders processed (some may have failed):
{
  "success": true,
  "data": {
    "summary": { "total": 5, "succeeded": 4, "failed": 1 },
    "results": [
      {
        "orderId": "<uuid>",
        "orderNumber": "ORD-XYZ",
        "customerName": "Maruthi Agencies",
        "mode": "B2B",                       // "B2B" | "B2C"
        "success": true,
        "irn":   "8a288142cd1cbaf0...",       // present for B2B
        "ackNo": "112610251284733",
        "ewbNo": "181012048106",
        "ewbValidTill": "2026-05-16T23:59:00Z"
      },
      {
        "orderId": "<uuid>",
        "orderNumber": "ORD-ABC",
        "customerName": "Cash sale",
        "mode": "B2C",
        "success": false,
        "errorCode": "611",
        "errorMessage": "invalid document type for the given supply type",
        "pendingActionId": "<uuid>"
      }
    ],
    "dispatched": false   // false if any failed; true only on all-or-nothing success
  },
  "error": null
}

Error cases:
- 400 — invalid body / missing driver-vehicle mapping for the date
       { "success": false, "error": "Driver has no confirmed vehicle mapping for 2026-05-15", "code": "NO_VEHICLE_MAPPING" }
- 400 — no eligible orders
       { "success": false, "error": "No orders in pending_dispatch for this driver/date", "code": "NO_ORDERS" }
- 403 — gstMode === 'disabled' on this distributor (preflight is a no-op; orders may dispatch via a separate path or this endpoint is rejected)
       { "success": false, "error": "GST is disabled for this distributor — preflight is not applicable", "code": "GST_DISABLED" }
- 409 — assignment already loaded_and_dispatched
       { "success": false, "error": "Driver assignment already dispatched", "code": "ALREADY_DISPATCHED" }
- 500 — unexpected
```

### Database Changes

```sql
-- New: per-call audit of every WhiteBooks API call
CREATE TABLE gst_api_logs (
  log_id            TEXT PRIMARY KEY,
  distributor_id    TEXT NOT NULL REFERENCES distributors(distributor_id),
  invoice_id        TEXT REFERENCES invoices(invoice_id),
  order_id          TEXT REFERENCES orders(order_id),
  api_type          TEXT NOT NULL,           -- 'IRN_GENERATE' | 'EWB_GENERATE_INLINE' | 'EWB_GENERATE_BY_IRN' | 'EWB_GENERATE_STANDALONE' | 'IRN_CANCEL' | 'EWB_CANCEL' | 'GSTIN_LOOKUP' | ...
  scope             TEXT NOT NULL,           -- 'einvoice' | 'ewaybill'
  endpoint          TEXT NOT NULL,           -- full URL path
  status            TEXT NOT NULL,           -- 'success' | 'failed'
  error_code        TEXT,
  error_message     TEXT,
  request_payload   JSONB NOT NULL,
  response_payload  JSONB,
  latency_ms        INTEGER NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX gst_api_logs_distributor_idx ON gst_api_logs (distributor_id, created_at DESC);
CREATE INDEX gst_api_logs_invoice_idx     ON gst_api_logs (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX gst_api_logs_order_idx       ON gst_api_logs (order_id)   WHERE order_id   IS NOT NULL;

-- No schema change needed for orders / invoices / gst_documents (existing columns suffice).
-- No schema change needed for DriverVehicleAssignment (existing AssignmentStatus enum has dispatch_ready / loaded_and_dispatched).
```

Migration file: `packages/api/prisma/migrations/<timestamp>_gst_api_logs/migration.sql`.

### Multi-Tenant Considerations

- All queries filter by `distributorId`: yes — `preflightDispatch` reads `req.user.distributorId` from JWT and uses it in every WHERE clause.
- New tables tenant-scoped: yes — `gst_api_logs.distributor_id NOT NULL`.
- Cross-tenant risk: medium — WhiteBooks credentials are per-distributor in `gst_credentials`; `getCredentials(distributorId, scope)` already enforces this. Risk would surface if the new endpoint accepted `distributorId` from the body; it does not (taken from `req.user`/`X-Distributor-Id` only).
- Audit logs: yes — `auditLog('preflight_dispatch', 'order')` middleware on the route, plus the `gst_api_logs` rows.

### Auth & Permissions

- Requires auth: yes
- Required role(s): `distributor_admin` or `super_admin` (super_admin must send `X-Distributor-Id`)
- Permission check location: route-level via `requireRole('super_admin', 'distributor_admin')` and `requireDistributor`.

### Error Handling

- `GST_DISABLED` (distributor.gstMode === 'disabled') → 403, do not attempt anything. Caller (UI) should not show the Dispatch button in this mode anyway, but defence in depth.
- `NO_VEHICLE_MAPPING` (driver has no confirmed vehicle for this date) → 400, no API calls made. Existing FIX 3 guard from earlier work catches the same case at order-assignment time, but we re-check here in case the mapping was deleted.
- `NO_ORDERS` (driver has zero orders in pending_dispatch for the date) → 400, no API calls made.
- `ALREADY_DISPATCHED` (assignment already in loaded_and_dispatched) → 409, do not re-run.
- `IRN failure` for one order → that order goes into the `failed` list with `errorCode` and `errorMessage`. Other orders in the same batch continue to be processed. A PendingAction is created with severity `high`. The endpoint still returns 200 overall (HTTP success, business-level partial failure).
- `EWB failure` for one order (B2B fallback or B2C standalone) → same pattern as IRN failure. PendingAction with severity `high`.
- `WhiteBooks 5002` (sandbox transient) → marked failed for this run, retry-safe. Idempotency means re-running only re-attempts the failed order.
- `WhiteBooks 604` (EWB already exists on portal) → use existing recovery via `recoverEwbFromIrn` (B2B) or new `getewaybillgeneratedbyconsigner` lookup (B2C). Order is considered succeeded if the existing EWB number is recovered; failed otherwise.
- `WhiteBooks 2150` (duplicate IRN) → fetch via `GET /einvoice/.../GETIRNBYDOCDETAILS` to recover the existing IRN value, then continue to EWB. Success if both recovered.
- `Network / fetch failed` → individual order failure, no PendingAction (transient), report in `results` so UI can retry.
- `DB transaction failure` mid-order → the WhiteBooks calls have already happened (IRN/EWB exist on portal) but our DB is out of sync. The `gst_api_logs` row exists. On retry, idempotency check finds no `irn` on invoice → re-attempts WhiteBooks → hits 2150 / 604 → recovers via the lookup endpoints. This is the same self-healing path used by the existing `processInvoiceGst`.

## Testing Strategy

### Unit Tests

- `gstPreflightService.preflightDispatch` with mocked `apiCall`:
  - Happy path B2B (IRN with inline EWB) — one order, asserts persisted IRN + EWB + status transitions.
  - Happy path B2B (IRN response with no inline EWB → fallback to GENERATE_EWAYBILL by IRN) — asserts the second API call is made, asserts ewb fields persisted.
  - Happy path B2C (standalone genewaybill, `toGstin: 'URP'`, `transactionType: 1`).
  - Mixed-mode batch (3 B2B + 2 B2C) — all succeed → assignment transitions to `loaded_and_dispatched`.
  - One IRN fails, others succeed — no orders transition status, PendingAction created for the failure, response.summary reflects partial.
  - 2150 duplicate IRN → lookup via GETIRNBYDOCDETAILS → success.
  - 604 EWB already exists → recover via getewaybillgeneratedbyconsigner → success.
  - `gstMode === 'disabled'` → 403, no API call.
  - No vehicle mapping → 400, no API call.
- `buildIrnPayload` with `TranspDtls` enrichment — assert the `TranspDtls.VehNo` / `TransMode` / `Distance` fields are emitted correctly.

### Integration Tests

- `POST /api/orders/preflight-dispatch` happy path against Sharma (dist-002, GST sandbox) — assertions:
  - response.success === true, summary.total/succeeded/failed match
  - orders transitioned to `pending_delivery`
  - DriverVehicleAssignment transitioned to `loaded_and_dispatched`
  - gst_documents rows show `irnStatus='success'`, `ewbStatus='active'`
  - invoice rows show `irn`, `ackNo`, `ewbStatus='active'`
  - gst_api_logs has one row per WhiteBooks call
- Cross-tenant test: super_admin sending `X-Distributor-Id: dist-001` for a driver in dist-002 → 404 (driver not found in dist-001's scope), no API call.
- `gstMode === 'disabled'` distributor (Bhargava/dist-001) → 403.
- Already-dispatched assignment → 409.

### E2E Scenarios

1. **Morning routine — 3 drivers, 12 orders, all valid:** admin assigns drivers, clicks Dispatch on each driver in turn. All preflight calls succeed. Orders move to `pending_delivery`, trip sheet PDFs available, drivers leave depot with documents in hand. (Spans WI-035 + WI-036 + WI-038.)
2. **B2C-only driver (Bangalore Foods customer, no GSTIN):** preflight skips IRN entirely, generates standalone EWB with `URP`/`transactionType: 1`. Order moves to `pending_delivery`.
3. **Partial failure — 4 orders, 1 has stale customer GSTIN:** preflight reports `errorCode: 3028` on the bad order, three other orders dispatch normally (idempotency on retry preserves their dispatch state if admin fixes the bad customer and retries). Wait — current spec says all-or-nothing. Confirm with founder before implementation. (See Open Questions.)

### Edge Cases

- Order with `total_amount = 0` after pricing fetch — fail with clear error (NIC requires `TotInvVal > 0`).
- Customer's GSTIN went `inactive`/`cancelled` between order creation and dispatch (NIC error 3028/3029) — surface the error, allow admin to call SYNC_GSTIN_FROMCP or change customer to B2C-URP.
- Same docNo collision (rare — invoice numbers are tx-time random) → NIC 2150 → recovered via GETIRNBYDOCDETAILS.
- Driver assigned but vehicle removed/inactivated between assignment and dispatch — preflight fails with `NO_VEHICLE_MAPPING` before any API call.
- WhiteBooks credentials expired/invalid (token-cache stale) — `whitebooksClient.apiCall` already retries once on `1004` token-expiry; if still failing, surface as per-order failure.
- Preflight called twice in quick succession (admin double-clicks) — second call's idempotency check skips already-compliant orders; only newly-arrived orders or previously-failed orders are processed.

## Security Checklist

- [ ] Input validated and sanitised — `driverId` is UUID, `assignmentDate` is `YYYY-MM-DD` regex, both via Zod `preflightDispatchSchema`.
- [ ] All DB queries parameterised — Prisma client; no raw SQL.
- [ ] Auth checked on all new endpoints — route uses `authenticate → resolveDistributor → requireDistributor → requireRole('super_admin', 'distributor_admin')`.
- [ ] `distributorId` enforced on all tenant-scoped queries — every Prisma call in preflightService filters `distributorId: req.user.distributorId`.
- [ ] No sensitive data in logs or error responses — WhiteBooks credentials are never echoed; `gst_api_logs.request_payload` masks `client_secret`/`password` before write (helper in `whitebooksClient`).
- [ ] Rate limiting applied where needed — Express global rate limit covers; consider stricter per-tenant cap (10 preflights/min) if we see abuse; out of scope for v1.

## Open Questions (resolve before implementation)

1. **All-or-nothing per driver vs partial dispatch?** Current spec is all-or-nothing (if any order fails, the whole driver batch stays in `pending_dispatch`). Founder may prefer to dispatch the successful orders and leave only the failing ones — confirm. (E2E #3 above implicitly assumes partial; spec body assumes strict. Pick one.)
2. **Distance source.** Preflight needs `transDistance` for the EWB payload. Today we send `1`. Where does the real distance come from — order-level field, calculated from PIN codes, or hardcoded? NIC tolerates ±10% if PIN-to-PIN is in their DB. Need a decision.
3. **Cancel order during preflight window.** If an order is being preflighted and the admin cancels it from another tab, what happens to the in-flight WhiteBooks call? Current proposal: ignore, treat as `failed` in the results. Better answer welcome.
4. **B2C-EWB endpoint choice.** Use the e-waybill scope `genewaybill` (current code path) — confirmed correct for B2C since NIC rule #1 only blocks B2B Tax Invoices from the standalone endpoint. No change there.
