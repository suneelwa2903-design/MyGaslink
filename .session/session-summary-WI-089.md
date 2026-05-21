# Session Summary — WI-089 — NIC SESSION_EXPIRED investigation + B2B IRN cancel forensics (2026-05-21)

Two-part session, both investigation-led. WI-089 was proposed as a code feature
(auto-refresh NIC session on SESSION_EXPIRED, then retry) but a live sandbox probe
**disproved the premise**, so it ships as `wont_fix` plus a small honest-badge UI
fix. The session also did read-only forensics on two failed B2B IRN cancels.

**Outcome:** 481/481 API tests passing (37 files). Web typecheck clean.
One frontend-only commit. No DB migrations. No backend behaviour change.

---

## Branch / repo state

- Branch: `master`
- **HEAD: `f8d1117`** — `fix(settings): honest GST credential badge when NIC hop is down (WI-089 wont_fix)`
- Previous: `fede06a` (timezone @db.Date fix), `afc4cb2`, `292b724`, `abc7076`
- API tests: **481/481** (`cd packages/api && pnpm test`)
- Web typecheck: clean (`cd packages/web && pnpm exec tsc --noEmit`)
- Working tree: clean after commit

---

## TASK 1 — WI-089: why "NIC session expired" keeps recurring

### What was proposed
On `SESSION_EXPIRED`: call the same refresh flow Test Connection uses
(`/authenticate`), retry the API call once, fail only if the retry also expires.
Plus wrap `lookupGstin` (raw `fetch`, no retry) in the `apiCall` wrapper.

### Why it's `wont_fix` — live probe findings
Probe: `scripts/probe-nic-session.ts` (read-only; reads gst_api_logs, calls
`/authenticate` + GSTNDETAILS; no IRN, no DB writes). Run against dist-002
(Sharma, sandbox, GSTIN 29AAGCB1286Q000, email mvsuneelkumar2903@gmail.com).

1. **WhiteBooks sandbox pins ONE auth token per session window.** Auth #1 (cold),
   #2 (immediate), #3 (after 60s) all returned the *identical* token string
   (len=25, same first/last 6 chars, same TokenExpiry `2026-05-21 12:07:00`).
   → `apiCall`'s strategy "evict cache → re-auth → get a *fresh* token → retry"
   has no fresh token to get. Its `newToken === token` guard
   (`whitebooksClient.ts:425`) fires every time → `SESSION_EXPIRED`, with
   `responsePayload = NULL` (it short-circuits *before* the retry NIC call).

2. **Test Connection has no special refresh power.** `settings.ts:202-214` does
   the same `clearTokenCache` + `getAuthToken` as `apiCall`'s retry. It does NOT
   force a WhiteBooks↔NIC re-handshake. The reason clicking it "works" is
   **elapsed time**, not the click.

3. **The outage is upstream and self-heals.** gst_api_logs showed `SESSION_EXPIRED`
   on GSTIN_LOOKUP at **10:24:08, 10:27:53, 10:37:34** (dead ≥13.5 min straight),
   then the *same pinned token* returned `status_cd=1 "GSTR request succeeds"`
   minutes later in the probe. No client action shortens it. A synchronous
   in-request retry (even 60s) cannot bridge a 10+ min upstream outage.

4. **Dispatch never calls GSTNDETAILS.** Preflight uses GENERATE + EWB. The error
   only affects the Settings health card and customer GSTIN auto-fill — not IRN.

> Caveat: token-pinning may be sandbox-only (WI-085 notes the stale-expiry quirk
> is sandbox-specific). Re-evaluate against a **LIVE-mode tenant** before any
> production retry work — there, re-auth may issue genuinely fresh tokens and the
> existing `apiCall` retry might already suffice.

### What shipped instead — honest badge (commit f8d1117)
`packages/web/src/pages/SettingsPage.tsx`:
- The green "Valid · last validated" badge read `row.isValid`, which `getAuthToken`
  stamps `true` on every successful *auth* regardless of NIC health — so it showed
  green while NIC Portal showed red ×.
- Now: relabeled **"Credentials valid"**, and downgraded to amber
  **"Credentials valid · NIC unreachable"** when an in-session Test Connection
  reports `authenticated && !nicReachable`.
- `isValid` deliberately **untouched** — it is load-bearing for `gstinLookup`
  credential selection and the dispatch credential-resolution path; flipping it
  on a transient NIC blip would wrongly disable a working credential (dispatch
  uses GENERATE, which is unaffected by the GSTNDETAILS-session outage).

---

## TASK 2 — B2B IRN cancel forensics (report only, no fix)

Probe: `scripts/probe-cancel-logs.ts` (read-only). Invoices cancelled 2026-05-21:

| Invoice | Customer | EWB_CANCEL | IRN_CANCEL | EWB→IRN gap | irnStatus (DB) | ewbStatus (DB) |
|---|---|---|---|---|---|---|
| INV-MPFCFGZWUGV | Hyderabad Caterers (36AAGCB1286Q004) | ✅ success | ❌ SESSION_EXPIRED | **973ms** | `cancel_failed` | `cancelled` |
| INV-MPFCFGNAOBZ | Maruthi Agencies (29AWGPV7107B1Z1) | ✅ success | ❌ SESSION_EXPIRED | **584ms** | `cancel_failed` | `cancelled` |

**Answers:**
- **(a) EWB_CANCEL attempted/success?** Yes, both succeeded — NIC returned
  `status_cd=1` with `cancelDate` and `ewayBillNo` (101012064319 / 131012064318).
- **(b) IRN_CANCEL attempted/success?** Attempted on both; **both failed**.
- **(c) Exact error?** `code=SESSION_EXPIRED`, message "NIC session expired on
  WhiteBooks' end…", **`responsePayload = NULL`** on both. Null payload is
  decisive: the error came from `apiCall`'s `newToken === token` guard, which
  throws *before* the NIC CANCEL retry call — NIC never saw the second attempt.
- **(d) Same WI-086 double-auth race?** **No.** WI-086's fix is verified in place:
  `cancelOrder` (orderService.ts:1078-1081) calls `clearTokenCache` **exactly once**
  before the EWB+IRN sequence; `cancelEwb`/`cancelIrn` no longer evict internally.
  The ~0.6–1s EWB→IRN gap *superficially resembles* WI-086's "<1s apart" signature,
  but the mechanism is different — this is the **WI-089 pinned-token / dead-einvoice-
  NIC-session** phenomenon. The 1004/1005 hit the *CANCEL* call (token already dead
  against NIC), not a second auth; re-auth then returned the same pinned token →
  `SESSION_EXPIRED`. Same upstream outage seen in TASK 1 (10:24–10:37; cancels at
  ~11:45 caught another dead window).
- **(e) Current irnStatus in DB?** Both `cancel_failed`. IRNs are still **ACTIVE at
  NIC** (not cancelled); `IRN_CANCEL_FAILED` pending_actions were created
  (orderService.ts:1132). EWBs ARE cancelled at NIC.

**Compliance gap to flag:** for both invoices the **EWB is cancelled but the IRN is
not** — local invoice.status='cancelled' while the e-invoice IRN still lives at NIC.
Resolution requires retrying `POST /invoices/:id/cancel-irn` *once the einvoice NIC
session recovers* (it will hit the same pinned-token wall until then), or manual
cancel at the NIC portal. No code fix attempted this session (report-only).

---

## Files touched
- `packages/web/src/pages/SettingsPage.tsx` — honest badge (committed)
- `.session/tracking/work_items.json` — WI-089 added as `wont_fix` (committed)
- `scripts/probe-nic-session.ts` — NEW read-only token-timing probe (committed)
- `scripts/probe-cancel-logs.ts` — NEW read-only cancel forensics (committed)

## Reusable diagnostics (run from packages/api)
```
pnpm exec tsx --env-file=.env ../../scripts/probe-nic-session.ts [distributorId]
pnpm exec tsx --env-file=.env ../../scripts/probe-cancel-logs.ts
```

## Open follow-ups (not started)
1. Resolve the two stranded IRNs (cancel_failed) once NIC einvoice session recovers.
2. If production confirms WhiteBooks issues fresh tokens (not pinned), revisit a
   bounded retry on SESSION_EXPIRED — but only with live-mode evidence.
3. Consider surfacing IRN_CANCEL_FAILED pending_actions more prominently in the
   admin UI so EWB-cancelled-but-IRN-active invoices aren't silently stranded.
