# WI-054 — Test Connection: bypass cache + verify NIC reachability

**Owner:** Claude (Re-New GasLink)
**Status:** in_progress (2026-05-16)
**Branch:** master

---

## Problem

The "Test Connection" button on the GST credentials settings card returns
"Validated" in two situations where it should not:

1. **Cached-token success.** `getAuthToken()` short-circuits to the cached
   token when the in-memory cache holds a still-valid entry. Test Connection
   never hits WhiteBooks — pure cache read. Admins see a green ✅ even when
   the live WhiteBooks gateway is down.
2. **Auth-only coverage.** The endpoint only exercises
   `POST /einvoice/authenticate` (or `/ewaybillapi/v1.03/authenticate`).
   It does NOT exercise any NIC-side operation. The 2026-05-15 outage
   (NIC rejecting every IRN GENERATE with generic `5002`) returned green
   on Test Connection throughout — because auth still worked, NIC was the
   broken hop.

Surfacing the difference between "credentials are valid" and "NIC IRP will
accept work" is the whole point of this button. Today it conflates them.

## Goal

Test Connection becomes a genuine two-stage probe with truthful UI feedback:

1. **Stage 1 — WhiteBooks auth.** Force-bypass the in-memory token cache.
   Always call `/einvoice/authenticate` (or `/ewaybillapi/v1.03/authenticate`)
   fresh. Report whether WhiteBooks accepted our credentials.
2. **Stage 2 — NIC reachability.** After auth succeeds, make one
   `GET /einvoice/type/GSTNDETAILS/version/V1_03?param1=<own gstin>` call.
   This proves NIC IRP responds and the GSP→NIC handshake is healthy
   without writing any IRN to the portal.
3. Return a structured response the UI can render with two distinct
   green/red indicators.

We intentionally do NOT call `GENERATE` — that would create a real IRN.
`GSTNDETAILS` is the lightest read-only NIC operation that proves the
upstream is up.

## Scope

### Backend
- New shape for `POST /api/settings/gst/credentials/:scope/test` response:
  ```ts
  {
    authenticated: boolean;
    nicReachable: boolean;
    message: string;       // short human-readable status
    authError?: string;    // populated when authenticated=false
    nicError?: string;     // populated when nicReachable=false
  }
  ```
- Endpoint flow:
  ```
  1. clearTokenCache(distributorId)     // force fresh
  2. try getAuthToken(scope)            // stage 1
  3. if einvoice scope, try one         // stage 2 — einvoice only;
     GSTNDETAILS call for distributor   //   ewaybill has no equivalent
     .gstin                             //   read-only ping endpoint
  4. settingsService.markGstCredentialsInvalid only when stage 1 fails
  ```
- The `ewaybill` scope skips stage 2 (its `authenticate` endpoint
  itself touches the NIC EWB portal — a green auth there already
  proves reachability). Response sets `nicReachable: true` if auth
  succeeded.

### Frontend
- `SettingsPage.tsx` already has Test Connection buttons. Replace the
  toast-only feedback with a two-row status block under each credentials
  card that reads:
  ```
  WhiteBooks  : ✅ Connected     OR  ❌ {authError}
  NIC Portal  : ✅ Reachable     OR  ❌ {nicError}
  ```
  Today's outage would render:
  ```
  WhiteBooks  : ✅ Connected
  NIC Portal  : ❌ NIC GSTNDETAILS returned 5002 — Application error
  ```
- Mutation reads the new envelope fields directly.

### Tests
- Unit: when in-memory token cache holds a valid token, the test endpoint
  STILL makes a fresh auth call (verified by spying on the underlying
  fetch / `apiCall`).
- Unit: when WhiteBooks auth fails, response is
  `{authenticated:false, nicReachable:false, message:"WhiteBooks auth failed"}`,
  and `markGstCredentialsInvalid` was called.
- Unit: when WhiteBooks auth succeeds but NIC GSTNDETAILS throws,
  response is `{authenticated:true, nicReachable:false, …}`.
- Unit: when both succeed, response is `{authenticated:true, nicReachable:true, …}`.
- Integration: `POST /api/settings/gst/credentials/einvoice/test` returns
  the new envelope (both fields, regardless of outcome).
- Anti-pattern guard: response shape must contain BOTH `authenticated` and
  `nicReachable` booleans on every call — protects against #9 silent
  shape drift.

### Out of scope
- Calling IRN GENERATE as part of Test Connection.
- Polling NIC continuously (separate health-monitor work).
- Showing per-endpoint latency in the UI (logged only).

## Anti-pattern compliance
- **#11** every test call writes a `gst_api_logs` row via the existing
  `callWithLog` / `loggedApiCall` flow — both auth and the GSTNDETAILS
  ping, success or failure. `apiType` = `AUTH_TEST` and
  `GSTIN_LOOKUP_TEST` respectively, so the audit trail distinguishes
  Test Connection traffic from real workflow traffic.
- **#9** response shape guard test added against `anti-pattern-guards.test.ts`.

## Acceptance
- Typecheck clean.
- Vitest suite 350+ (3+ new tests for this WI).
- Manually clicking Test Connection on the Sharma GST card shows the
  current real outage:
  - WhiteBooks ❌ (today's "email not registered" condition surfaces
    instead of a misleading green).
  - If/when auth is restored but NIC still 5002s, surfaces NIC ❌.
