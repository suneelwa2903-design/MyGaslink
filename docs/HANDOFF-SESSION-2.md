# Re-New GasLink — Session 2 Handoff

**Date:** 2026-05-19
**Author:** Session 2 (worktree `recursing-goldwasser-a27681`)
**Audience:** the next Claude Code thread picking up this work.

---

## SECTION 1 — Current State

| Item | Value |
|---|---|
| Master SHA | **`655b779`** — `merge: WI-073 — omit shipTo/dispatchFrom under transactionType=1 for B2C` |
| API test suite | **450 passed / 450 total** (36 test files, `pnpm --filter @gaslink/api test`) |
| Typecheck | clean (`pnpm --filter @gaslink/api typecheck`) |
| API process | tsx watch on port 5000, auto-reloads on file change in master worktree |
| Web dev server | Vite on port 5173 (master worktree) |
| Date | 2026-05-19 |
| Worktree where work was done | `C:\Projects\Re-New_Gaslink\.claude\worktrees\recursing-goldwasser-a27681` |

---

## SECTION 2 — Work Items Completed (WI-054 onwards)

Listed chronologically with status + one-line summary. Full descriptions are in `.session/tracking/work_items.json`.

| ID | Status | Title | One-liner |
|---|---|---|---|
| WI-054 | ✅ done (2026-05-16) | Test Connection — bypass token cache, add NIC reachability probe | Two-stage probe: clear token cache then validate against NIC. UI shows two distinct rows. |
| WI-055 | ✅ done (2026-05-16) | Amount-based Credit / Debit Note modal | Replaced items grid with Reason + Amount + Note. Schema migration added `note` column. |
| WI-056 | ✅ done (2026-05-16) | Invoice list CN/DN count badges + CN PDF reads IRN from gst_documents | Trimmed list payload + fixed dead-code CN PDF IRN block. |
| WI-057 | ✅ done (2026-05-16) | Close GST payload gaps G1+G2; pin vehicleNo / transDistance guards | transactionType always 1; recover IRN on 2150 duplicate via GETIRNBYDOCDETAILS. |
| WI-058 | ✅ done (2026-05-16) | Tenant isolation in lookupGstin + test cleanup + anti-pattern #13 | `lookupGstin` now requires distributorId; fixed cross-tenant credential leak that caused 24h misdiagnosed outage. |
| WI-059 | ✅ done (2026-05-16) | Deduplicate concurrent auth fetches + pre-warm token before preflight | In-flight Promise dedup map + pre-warm both auth scopes before per-order loop. |
| WI-060 | ✅ done (2026-05-16) | TZ-safe parsing of WhiteBooks/NIC TokenExpiry | NIC sends naive IST datetimes; UTC prod would have parsed them 5.5h ahead → fake-valid tokens. Fixed via parseNicDateTime. |
| WI-061 | ✅ done (2026-05-16) | Trip sheet scoping + DN PDF IRN parity + DVA dedup | Trip sheet status filter narrowed; DN PDF gains IRN block; (driver,date,trip_number) made UNIQUE. |
| WI-045 | ✅ done (2026-05-16) | Mobile — Driver smoke test + fixes | Live tested on Android. Anti-pattern #9 sweep across 5 mobile screens. |
| WI-046 | 🚧 pending | Mobile — Distributor Admin smoke test + fixes | Awaiting WI-052. |
| WI-047 | 🚧 pending | Mobile — Inventory smoke test + fixes | Awaiting WI-052. |
| WI-048 | 🚧 pending | Mobile — Customer app smoke test + fixes | Awaiting WI-052. |
| WI-049 | 🚧 pending | Mobile — Finance smoke test + fixes | Lower priority. |
| WI-050 | 🚧 pending | Mobile — Super Admin smoke test + fixes | Lower priority. |
| WI-051 | 🚧 pending | Mobile — Add role guards to layout files | Defense-in-depth, not primary control. |
| WI-052 | ✅ done (2026-05-16) | Mobile — Setup guide + env config | LAN IP guide added; AppHeader brand component. |
| WI-053 | 🟡 in_progress | Mobile — Security hardening pre-pilot | Rate limiting + HTTPS + 0.0.0.0 dev-only binding done; SSL pinning pending. |
| WI-062 | ✅ done (2026-05-16) | GET /api/orders driver auto-scoping (within-tenant data-leak fix) | Driver role auto-scoped to own orders; prevented other-driver data exposure within same distributor. |
| WI-063 | ✅ done (2026-05-16) | Driver mobile — Trip + Vehicle Stock + delivery modal + EWB compliance | Seven-part driver mobile polish; /me/* endpoint corrections; compliance docs section. |
| WI-064 | ✅ done (2026-05-19) | Fix reissue after modified delivery — 2278 error + display bugs | Pre-bump invoice number before regenerate; catch BOTH 2150 and 2278; fix outstanding drift; modal display fixes. |
| WI-065 | ✅ done (2026-05-19) | Add to Trip feature + trip number on orders + fix dispatch gate + fix trip sheet | New POST /preflight-add-to-trip; orders stamped with tripNumber; trip sheet filters by tripNumber. |
| WI-066 | ✅ done (2026-05-19) | Invoice total stores GST-inclusive amount | Fixed reissue using BASE × qty (lost 15.25% per modified delivery); now perUnit = totalPrice/qty. |
| WI-067 | ✅ done (2026-05-19) | Fix EWB transDistance using pincode lat/lon lookup + Haversine | Replaced WI-057 hardcoded '1' with pincode-derived value. |
| WI-068 | ✅ done (2026-05-19) | Auto-reset DVA after last order delivered + fix Add to Trip gate | confirmDelivery now flips DVA → dispatch_ready on last delivery; Add-to-Trip 409 if no in-flight. |
| WI-069 | ✅ done (2026-05-19) | Fix in-transit endpoint: exclude stale loaded_and_dispatched DVAs | Endpoint filters by inTransitCount > 0; SQL backfill reset 6 stale rows. |
| WI-070 | ✅ done (2026-05-19) | Fix tripNumber increment regression from WI-068 + fix EWB transDistance road-circuity factor | Increment moved into confirmDelivery auto-reset block; Haversine × 1.15; cap at 4000km. |
| WI-071 | ✅ done (2026-05-19) | B2C EWB uses URP sentinel + phantom-active EWB guard + B2C PDF regression tests | toGstin='URP' (initially also shipToGSTIN); guard against status_cd=1 with no ewayBillNo. |
| WI-072 | ✅ done (2026-05-19) | shipToGSTIN must be 15-char GSTIN (NIC EWB regex rejects 'URP') | Reverted shipToGSTIN to seller.Gstin (asymmetric vs toGstin). |
| WI-073 | ✅ done (2026-05-19) | B2C EWB must omit shipToGSTIN/dispatchFromGSTIN under transactionType=1 (NIC error 616) | Per NIC prep-tools spec: those fields cannot be sent under Regular. B2B kept as-is. |
| **WI-074** | **🔴 NEEDED** | **B2C EWB still failing with NIC 240/240_3** | **See Section 3 #1. Spec-correct payload isn't enough. Try legacy `transactionType=2` pattern next.** |

---

## SECTION 3 — Known Pending Issues

### 1. B2C EWB generation still failing with NIC 240 / 240_3 (BLOCKING)

**Status:** WI-073 made the payload spec-correct per the official `e_Waybill_preparation_tools.xlsx`, but live retries still fail.

- After WI-073: NIC returned **`240`** ("Could not generate eway bill, pls contact helpdesk") on `INV-MPCFGEY1WVA`.
- After bumping the docNo to fresh `INV-MPCFGEY1-R1`: NIC returned **`240_3`** (sub-variant). Same generic catch-all, empty `info` field.
- The "burnt docNo" theory was only partially right — the fresh docNo also failed.
- B2B dispatches on the same account (Maruthi, Hyderabad Caterers) worked the same day → account itself is fine; the issue is specific to the URP / B2C path.

**Next action — WI-074:**
Read the legacy proven B2C pattern in `New_GasLink/backend/services/gst/gstEwayPayloadBuilder.js` lines 641-714:
- `transactionType: 2` (NOT 1) for B2C
- `toGstin: 'URP'` (keep)
- `shipToGSTIN: distributor.gstin` (15-char depot GSTIN)
- All ship-to/dispatch-from fields PRESENT (not omitted)

The legacy code was empirically proven in production. Spec-divergent (NIC docs say type=1 for single-recipient) but battle-tested.

**Important caveat:** the legacy pattern's correctness depends on NIC's actual sandbox behaviour, which has been flaky all day. If WI-074 also fails, escalate to WhiteBooks support — they can look at NIC's internal trace for the request.

### 2. Consolidated EWB not generating for single-order dispatches

`generateConsolidatedEwb` (gencewb) only fires when 2+ orders in a dispatch generate EWBs successfully ([gstPreflightService.ts:254](packages/api/src/services/gst/gstPreflightService.ts:254)). One-order trips skip the consolidated EWB intentionally — driver carries the per-order EWB instead. Not a bug, but the "Trip Sheet (PDF)" button still appears in the In Transit UI and downloads a fallback "EWB Pending" PDF when there's no consolidated EWB. Verify behaviour with one-order dispatches.

### 3. Stale `CONSOLIDATED_EWB_FAILED` pending actions

Multiple low-severity `CONSOLIDATED_EWB_FAILED` rows from older days are still `open` in `pending_actions` (assignment_ids that may or may not still exist). Counted ~10+ in today's logs alone. Decision: either auto-resolve on next successful gencewb for the same assignment_id, or sweep via SQL.

### 4. `gst_documents` lacks `credit_note_id` / `debit_note_id` FK

Current schema relies on `(invoice_id, doc_type='CRN'|'DBN', is_latest=true)` to locate the CN/DN GST doc — works when there's exactly one of each per invoice, breaks if a single invoice has 2+ CNs or 2+ DNs. Currently blocked by WI-064's reissue pattern (which generates separate IRN per credit note, but only one CN per invoice in practice). Future-proof by adding explicit FKs.

### 5. Float-to-Decimal full-arithmetic migration

WI-006 converted 35 monetary columns from Float to Decimal at the SCHEMA level (storage now penny-perfect) but service-layer arithmetic still uses `number` via `toNum()` at read boundaries. ~49 fields total when including derived/computed values. Pragmatic deviation from the original plan — full Prisma.Decimal arithmetic would be ~10h of mechanical replacement with bug surface in every reduce/sum. Acceptable for v1; revisit in post-launch week 2.

### 6. Open HIGH-severity pending actions (snapshot 2026-05-19 ~15:35 IST)

**30 of 326 open actions are HIGH severity.** All are 2026-05-19 EWB/IRN failures, with the same root causes already documented above:

| Pattern | Count today | Root cause |
|---|---|---|
| `Cannot read properties of undefined (reading 'data')` | 18 | Pre-WI-071 code threw when NIC returned no `data` block — fixed by WI-071 Defect B guard. Legacy rows; cleanup deferred. |
| `Order ORD-MPCFG9LCQ3W: {"errorCodes":"616..."` / `"611..."` / `"240..."` | 6 | The B2C URP iteration (WI-071/072/073). Pending WI-074. |
| `Order ...: JSON validation failed due to - [#/shipToGSTIN: ...]` | 2 | Pre-WI-072 schema error. Resolved by WI-072. Legacy rows. |
| `2150 duplicate but GETIRNBYDOCDETAILS returned no IRN` | 2 | Pre-WI-064 IRN reissue trap. Resolved by WI-064 pre-bump. Legacy rows. |
| `Order ORD-MPCCQW4XHLJ: IRN succeeded but EWB failed — {"errorCodes":"702,"}` | 1 | Pre-WI-070 Haversine straight-line under-shoot. Resolved. Manual retry pending. |
| `{"errorCodes":"611,"}` / `{"errorCodes":"240_3"}` | 2 | Same B2C URP family. |

**Cleanup plan:** once WI-074 lands and B2C dispatches succeed cleanly, sweep open pending_actions for the affected order IDs with a one-off SQL `UPDATE pending_actions SET status='resolved', resolved_at=NOW(), resolution_notes='Resolved post-WI-074' WHERE ...`.

---

## SECTION 4 — Testing Status

| Phase | Scope | Status |
|---|---|---|
| Phase 1 | Super Admin smoke | ✅ COMPLETE |
| Phase 2.1–2.14 | Distributor Admin (Sharma) | ✅ COMPLETE |
| Phase 2.15 | Debit note PDF | ⬜ NOT TESTED |
| Phase 2.16 | Modified delivery | ✅ COMPLETE |
| Phase 2.9 | Dispatch | ✅ COMPLETE |
| Phase 2.10 | Trip sheet | ✅ COMPLETE |
| Phase 2.12 | GST Test Connection (Settings → GST) | ⬜ NOT TESTED |
| Phase 3 | Finance user (`finance@gasagency.com`) | ⬜ NOT STARTED |
| Phase 4 | Inventory user (`inventory@gasagency.com`) | ⬜ NOT STARTED |
| Phase 5 | Driver web check | ⬜ NOT STARTED |
| Phase 6 | Customer portal | ⬜ NOT STARTED |
| Phase 7 | Tenant isolation | ⬜ NOT STARTED |

Live manual testing today exposed and resolved WI-064 → WI-073. The B2C URP path (WI-071/072/073/74) remains the single blocking item before declaring Phase 2 complete.

---

## SECTION 5 — Credentials Reference

### Web app
`http://localhost:5173`

### Test accounts (all seeded)
| Role | Email | Password | Distributor |
|---|---|---|---|
| Super Admin | `admin@mygaslink.com` | `Admin@123` | All (platform-level) |
| Sharma Admin (GST ON sandbox) | `sharma@gasdist.com` | `Gstadmin@123` | Sharma Gas Distributors (dist-002) |
| Bhargava Admin (GST OFF) | `bhargava@gasagency.com` | `Distadmin@123` | Bhargava Gas Agency (dist-001) |
| Finance | `finance@gasagency.com` | `Finance@123` | Bhargava Gas Agency |
| Inventory | `inventory@gasagency.com` | `Inventory@123` | Bhargava Gas Agency |
| Driver | `raju@gasagency.com` | `Driver@123` | Bhargava Gas Agency |
| Customer | `royal@kitchen.com` | `Customer@123` | Bhargava Gas Agency |

### WhiteBooks sandbox — dist-002 Sharma

**e-Invoice scope:**
- clientId: `EINSc0e87f75-51b3-4284-a57f-639a7582514c`
- clientSecret: `EINSda1f2b7a-feea-46b2-9054-0e4371da3fd4`
- username: `BVMGSP`
- password: `Wbooks@0142`
- email: `mvsuneelkumar2903@gmail.com`
- GSTIN: `29AAGCB1286Q000`

**e-Way Bill scope:**
- clientId: `EWBSa82587b9-88ca-43d0-a514-7457a38eb813`
- clientSecret: `EWBS68034a54-66a6-41d5-b7df-4acd0b17b525`

> Sensitive — do not paste into any third-party tool, gist, pastebin, or screenshot.

### Postgres
Docker container `gaslink-db` on host port 5433.
- user: `gaslink`
- pass: `gaslink_dev`
- db: `gaslink`

---

## SECTION 6 — Architecture Decisions (this session)

1. **Trip number stamped on orders at dispatch.** `order.tripNumber = dva.tripNumber` (WI-065). Lets the trip sheet PDF filter by tripNumber directly instead of fragile `updatedAt >= dva.updatedAt` time-window heuristics.
2. **tripNumber increments on LAST delivery** — inside `confirmDelivery`'s WI-068 auto-reset block, NOT inside `preflightDispatch`. The pre-WI-070 increment-in-preflight assumed the DVA stayed `loaded_and_dispatched` until the next dispatch click, which WI-068 broke. Moving the increment to the auto-reset closes the loop.
3. **DVA auto-resets to `dispatch_ready`** when the last in-flight order of a trip is delivered. Confirmed inside the same `prisma.$transaction` as the order status change to avoid drift (WI-068).
4. **Add to Trip = separate endpoint** `POST /api/orders/preflight-add-to-trip`. Hard-gated to `DVA.status === 'loaded_and_dispatched'` AND `inFlightCount > 0`. Stamps new orders with the existing tripNumber, generates a second consolidated EWB (`tripSheetNo2`). NIC has no append-to-CEWB semantics — sealed at gen.
5. **Trip sheet uses tripNumber filter** with legacy fallback (`tripNumber IS NULL AND updatedAt >= dva.updatedAt`) for pre-WI-065 historical rows. Status filter widened to include delivered/modified_delivered so the sheet renders after delivery.
6. **EWB transDistance uses Haversine × 1.15 road circuity factor**, capped at 4000km (NIC max). Falls back to `'0'` (NIC auto-calc) when pincode is unknown. Same-pincode → `'1'`. The 1.15 multiplier brings the value into NIC's ±10% road-distance tolerance window (BLR→HYD: 500km straight-line → 575km estimate → inside 517-632 NIC window).
7. **Invoice total stores GST-inclusive amount.** Fresh invoices always do (`invoiceService.createInvoiceFromOrder`). Reissue path (WI-066) now computes `perUnit = totalPrice/qty` instead of `unitPrice × qty` (which was BASE for GST tenants — lost 18/118 ≈ 15.25% per modified delivery).
8. **Reissue after modified delivery pre-bumps** the invoice number to `-R1` BEFORE the first regenerate attempt (WI-064). Eliminates the NIC 2278 trap ("doc number cancelled, cannot reuse") that emerged when the older 2150-only retry path was insufficient. The catch handles BOTH 2150 and 2278 thereafter.
9. **B2C EWB iteration (WI-071→073, WI-074 pending):** `toGstin='URP'` is the right sentinel. `shipToGSTIN`/`dispatchFromGSTIN` cannot be sent at all under `transactionType=1` per the official `e_Waybill_preparation_tools.xlsx` rules. But NIC's sandbox still rejects the spec-compliant payload with 240/240_3 → the legacy `transactionType=2` pattern from New_GasLink (with shipToGSTIN=distributor.gstin) is the likely battle-tested fix to try next.

---

## SECTION 7 — Anti-Patterns (CLAUDE.md)

These are documented at the bottom of `CLAUDE.md`. **Do NOT introduce new code that matches any of these patterns.**

1. **Ad-hoc test scripts at `packages/api/` root** — `test-*.ts` outside the Vitest suite bit-rot quickly. Either promote to integration test or move to `scripts/`.
2. **Single Prisma migration on disk** (`20260323000000_init`) — going forward, schema changes are incremental migrations. Never `prisma migrate reset` against shared dev/staging.
3. **`requireDistributor` skipped on `/api/users`, `/api/billing`, `/api/pricing`** — likely intentional for super_admin lists, but per-handler isolation is then up to each route. Confirm and document or tighten.
4. **Default JWT secrets fall back in code** — prod is gated by `validateEnv()`, but dev can ship code depending on weak secrets. Hard-fail on missing secrets in dev too.
5. **PDF/blob downloads bypassing the axios client** — drops the JWT/distributor headers. Always route through the shared axios instance.
6. **Mocking an external API without validating payload shape** — every external-API integration must keep a `*-payload-shape.test.ts` that calls the payload builder directly and asserts field formats/lengths against the provider's documented schema.
7. **Using today's date for time-sensitive test fixtures on the shared dev DB** — service queries by `(distributorId, driverId, deliveryDate)` sweep up real rows. Use `const TEST_DATE = '2099-12-31'`.
8. **Test cleanup that only deletes fixture IDs when the service queries by broader criteria** — companion to #7. Cleanup must match the service's query criteria, not just the seeded IDs.
9. **API response type-annotated as one shape but route returns another** — Prisma's TS-side enum names (`paid_billing`) leak instead of the `@map`'d value (`paid`). Guard tests with `expect(res.body.data).toHaveProperty(...)`.
10. **Implementing an external API feature without verifying it works in the real sandbox** — mock-only verification is not sufficient. Name the exact endpoint + payload schema in the spec BEFORE writing code; document the sandbox call result in the session summary.
11. **External API call failures logged only as errors, never as request payloads** — every external-API client must persist BOTH success and failure with the full outgoing `request_payload`. Don't trust the provider to echo back the failing field.
12. **External-API status persistence bug: error in EWB sub-step overwriting committed IRN status** — track local `*Persisted` flags after each commit; in the catch, only overwrite status fields whose precondition flag is false.
13. **Tenant-scoped Prisma queries without an explicit `distributorId` filter** — every `prisma.<tenantScoped>.findFirst()` / `findMany()` MUST include `distributorId` in `where`. Platform-level fallback paths must additionally require `isValid: true` and use deterministic `orderBy`.

**Mobile-specific rules** (also in CLAUDE.md, "Mobile Development Rules"):

1. Always use `expo-secure-store` for tokens — never AsyncStorage.
2. Every screen must handle loading, error, and empty states.
3. All API calls go through `useApiQuery` / `useApiMutation` — never raw fetch/axios.
4. Test offline scenarios for every driver-facing screen.
5. `EXPO_PUBLIC_API_URL` must use the laptop's LAN IP for phone testing.
6. Rate limiting on auth endpoints must be verified before any pilot with real users (WI-053).

---

## SECTION 8 — Key Files Changed (this session)

`git log --oneline af0d601..HEAD` (af0d601 = WI-065 starting point):

```
655b779 merge: WI-073 — omit shipTo/dispatchFrom under transactionType=1 for B2C
4f6b531 fix(gst): omit shipToGSTIN/dispatchFromGSTIN under transactionType=1 to fix B2C NIC 616 (WI-073)
0eed07d merge: WI-072 — shipToGSTIN must be 15-char GSTIN
a3a5ce8 fix(gst): shipToGSTIN must be 15-char GSTIN, NIC schema rejects URP (WI-072)
c366e39 merge: WI-071 — B2C EWB URP + phantom-active guard + PDF tests
a5c0538 fix(gst): B2C EWB uses URP sentinel, phantom-active EWB guard, B2C PDF regression tests (WI-071)
80e2e37 merge: WI-070 — tripNumber increment on last delivery + EWB road circuity factor
5d435bb fix(fleet): tripNumber increments on last delivery, EWB road circuity 1.15x factor for NIC distance (WI-070)
9390783 merge: WI-069 — exclude stale DVAs from /in-transit + SQL backfill
7cfc259 fix(fleet): exclude stale DVA from in-transit when 0 orders in flight, SQL backfill for existing stale rows (WI-069)
fcec3f5 fix(gst): pincode Haversine distance for EWB transDistance + auto-reset DVA after trip complete (WI-067, WI-068)
9c90e55 fix(billing): invoice total stores GST-inclusive amount (WI-066)
af0d601 feat(fleet): Add to Trip feature, trip number on orders, fix dispatch gate, trip sheet uses tripNumber (WI-065)
```

Most-touched files this session:
- `packages/api/src/services/gst/payloadBuilders.ts` (WI-071, WI-072, WI-073)
- `packages/api/src/services/gst/gstService.ts` (WI-071 Defect B guard)
- `packages/api/src/services/gst/gstPreflightService.ts` (WI-065, WI-068, WI-070)
- `packages/api/src/services/orderService.ts` (WI-068, WI-070 auto-reset block)
- `packages/api/src/utils/pincodeDistance.ts` (WI-067, WI-070 circuity)
- `packages/api/src/routes/orders.ts` (WI-069 /in-transit filter)
- `packages/api/src/__tests__/gst-dispatch-trip.test.ts` (WI-065/067/068/069/070 regression)
- `packages/api/src/__tests__/gst-b2c-urp-investigation.test.ts` (NEW — WI-071/072/073)
- `packages/web/src/pages/OrdersPage.tsx` (WI-065 In Transit card, WI-068 button gate)

---

## SECTION 9 — Immediate Next Steps (priority order)

1. **WI-074 — Fix B2C EWB using the legacy New_GasLink pattern.**
   - Read `/c/Projects/Re-New_Gaslink/New_GasLink/backend/services/gst/gstEwayPayloadBuilder.js` lines 641-714 (`shipToGSTIN`, `transactionType` handling).
   - Change B2C branch in `payloadBuilders.ts` to:
     - `transactionType: 2` (Bill-To different from Ship-To)
     - `toGstin: 'URP'`
     - `shipToGSTIN: seller.Gstin` (re-introduce; required under type=2)
     - `shipToTradeName: seller.TrdNm || seller.LglNm` (re-introduce)
     - `dispatchFromGSTIN`/`dispatchFromTradeName`: omit (Bill-From == Dispatch-From, so type=2 doesn't require these)
   - B2B path untouched.
   - Update the WI-071/072/073 regression test to assert the new asymmetric contract for B2C (type=2 + shipToGSTIN=seller).
   - Bump the burnt invoice number again (`INV-MPCFGEY1-R1` → `-R2`) to avoid NIC's docNo blocklist.
   - Test live against NIC sandbox: dispatch a fresh B2C order → expect `ewayBillNo` returned and `gst_documents.ewb_no` populated with a real number.
   - If 240 still appears: open a WhiteBooks support ticket with the full payload + response. Do not iterate further blind.

2. **Test 2.12 — GST Test Connection.** Settings → GST tab → "Test Connection" buttons (both e-Invoice and e-Way Bill scopes). Expect two distinct ✅/❌ rows per WI-054 design (authenticated + nicReachable).

3. **Test 2.15 — Debit note PDF.** Billing → open an invoice with a Debit Note → click "Download PDF". Expect IRN block to render via WI-061 + WI-056 fix.

4. **Phase 3 — Finance user testing.** `finance@gasagency.com` / `Finance@123`. Verify access matrix (payments, collections, billing read; orders/inventory/customers/fleet/settings BLOCKED).

5. **Phase 4 — Inventory user testing.** `inventory@gasagency.com` / `Inventory@123`. Daily summary, depot intake, manual adjustment, lock day, reconciliation.

6. **Phase 5 — Driver web check.** `raju@gasagency.com` — Web admin should redirect to /app/analytics (driver-tile-fallback view). Only `/app/orders` should be accessible (assigned-only via WI-062 auto-scoping).

7. **Phase 6 — Customer portal.** `royal@kitchen.com` — dashboard, orders (place new), invoices (download PDF), payments (record), account.

8. **Phase 7 — Tenant isolation.** Login as dist-001 user, try to access dist-002 entity IDs directly. Expect 404 (preferred) or 403. **CRITICAL** — the WI-058 incident showed how a single missing distributorId filter can leak across tenants.

9. **Float-to-Decimal full-arithmetic migration** — post-launch week 2. See Section 3 #5.

---

## SECTION 10 — DB State (2026-05-19 ~15:35 IST)

```
total_orders | total_invoices | open_pending_actions | todays_dva_rows
--------------+----------------+----------------------+-----------------
          35 |             41 |                  326 |               1
```

- `total_orders` (dist-002): **35** (includes seed + today's manual-test rows)
- `total_invoices` (dist-002): **41**
- `open_pending_actions` (dist-002): **326** (large because WI-071 Defect B guard now correctly raises pending actions on EWB failures; before the guard, many phantom-active rows masked the problem. Pre-launch cleanup needed.)
- `todays_dva_rows`: **1** (Kiran Reddy, tripNumber=4 post-WI-070 SQL repair, status=loaded_and_dispatched)

---

## SECTION 11 — How to Start the New Thread

### 1. Open a new Claude Code session at the master worktree
```
cd C:\Projects\Re-New_Gaslink
```

> **Note:** this session's work lived in a sibling worktree (`recursing-goldwasser-a27681`). All commits already merged to master. New thread starts on master directly. Use a fresh worktree if doing parallel work.

### 2. First commands — sanity check
```bash
# Verify current state
git rev-parse HEAD          # should be 655b779 (or newer after merge of this handoff doc)
git log --oneline -5

# Run tests (must be 450+ passing, 0 failing)
pnpm install                # only if node_modules missing in the worktree
pnpm --filter @gaslink/api typecheck
pnpm --filter @gaslink/api test
```

### 3. Read these before doing any work
- `CLAUDE.md` — non-negotiable. Anti-patterns + multi-tenant rules + mobile rules.
- `docs/HANDOFF-SESSION-2.md` — this file.
- `.session/tracking/work_items.json` — full WI history. Pay attention to WI-064 → WI-073 family.
- `ARCHITECTURE.md` — once per major task. Read §22 (mobile) if touching `packages/mobile/`.

### 4. Start with WI-074
Read Section 9 #1 above. Concrete file/line references included.

### 5. ADLC discipline reminder
- Spec first — write the WI-074 entry in `work_items.json` BEFORE coding.
- Investigate before coding — read the legacy New_GasLink builder line-by-line; do NOT guess at payload shape.
- Tests mandatory — every WI ships with regression test that fails pre-fix and passes post-fix.
- 0 failing tests always — never merge with red.
- Merge to master after each WI — `git -C C:/Projects/Re-New_Gaslink merge --no-ff <branch> -m "merge: WI-074 — ..."`.

### 6. Background / external docs
- WhiteBooks/NIC official specs are at `C:\Users\HP\Downloads\`: `e_Waybill_error_codes.xlsx`, `e_Waybill_preparation_tools (1).xlsx`, `e_Invoice_preparation_tools.xlsx`, `E-invoicing-error-codes.docx`. **Consult these before designing GST payloads.** Session 2 wasted 3 iterations (WI-071/072/073) by not reading them first.
- Legacy proven implementations live in `C:\Projects\Re-New_Gaslink\New_GasLink\backend\` — most notably `services/gst/gstEwayPayloadBuilder.js` and `services/gst/EWB_VALIDATION_TRACKER.md`. These are battle-tested production code from the prior version of this app. Spec-divergent in places but empirically validated.

---

## SECTION 11 — Session 3 Addendum (2026-05-19, later same day)

Session 3 took over from Session 2's `recursing-goldwasser` worktree. Worktree: `inspiring-solomon-664ac9`. One WI shipped: **WI-076**.

### Updated current state

| Item | Value |
|---|---|
| Master SHA | **WI-076 merge `47c0f34`** plus docs/handoff updates landed on top — final SHA reported in commit log after Session 3 merge |
| API test suite | **450 passed / 450 total** (36 test files) |
| B2B EWB | ✅ working live on dist-002 (Maruthi + Hyderabad Caterers) |
| B2C EWB | ✅ working live on dist-002 (Bangalore Foods URP) |

### WI-076 — B2B EWB returns NIC 616 ("JSON validation failed")

**Symptom.** Four live B2B dispatches on dist-002 the morning of 2026-05-19 (Maruthi Agencies ×2, Hyderabad Caterers ×2) all returned NIC error 616 on `EWB_GENERATE_BY_IRN` while their IRNs succeeded. Every B2B invoice ended up with a valid IRN but no EWB number on the PDF or trip sheet. B2C dispatches in the same window worked fine.

**Root cause.** Under NIC's EWB `transactionType: 1` ("Bill-To party and Ship-To party are the SAME registered legal entity"), `toGstin` IS already the Ship-To and `fromGstin` IS already the Dispatch-From. The redundant `shipToGSTIN` / `shipToTradeName` / `dispatchFromGSTIN` / `dispatchFromTradeName` fields had been tolerated by NIC's sandbox historically but at some point on or before 2026-05-19 the validator started hard-rejecting them with 616. WI-073 had already made the same observation for B2C; the B2B branch in [payloadBuilders.ts buildEwbPayload()](packages/api/src/services/gst/payloadBuilders.ts) still sent all four fields with matching values.

**Live A/B proof (sandbox).** On a fresh docNo NIC had never seen (`INV-MPCJV99K`), same auth, same payload otherwise byte-identical, sequential calls:
  - Variant A — with the 4 fields → `status_cd=0`, `errorCodes=616`
  - Variant B — 4 fields removed → `status_cd=1`, `ewayBillNo=101012061787`

**Fix.** [payloadBuilders.ts:434-444](packages/api/src/services/gst/payloadBuilders.ts) — the B2B branch of the `...(isB2C ? { ... } : { ... })` spread now resolves to `{}`. All four fields are omitted under `transactionType: 1`. Comment block on lines 424-433 updated with the WI-076 docNo as evidence trail.

**Latent bugs identified during the RCA, NOT fixed in this WI** (they are no longer exercised by the success path; deferred to a follow-up WI):
  - `runB2bPreflight` silent-failure path when `parsed.ewbNo` is null after `status_cd=1` ([gstPreflightService.ts:929-950](packages/api/src/services/gst/gstPreflightService.ts:929))
  - `processInvoiceGst` phantom-active row when `parseEwbResponse` returns null in the B2B catch ([gstService.ts:307-332](packages/api/src/services/gst/gstService.ts:307))
  - Two `isLatest=true` rows possible when a dispatch EWB pre-exists and the post-delivery `genewaybill` fails ([gstService.ts:280-291](packages/api/src/services/gst/gstService.ts:280))

**End-to-end verification (post-merge, fresh DB after a scoped dist-002 wipe).** Single preflight dispatch with three orders:

| Order | Customer | Mode | IRN | EWB |
|---|---|---|---|---|
| INV-MPCKWDW2WL4 | Maruthi Agencies (B2B intra-state KA→KA) | B2B | ✅ | ✅ `171012061832` |
| INV-MPCKWEGS0DC | Hyderabad Caterers (B2B inter-state KA→TS) | B2B | ✅ | ✅ `141012061833` |
| INV-MPCKWEYOSY9 | Bangalore Foods (B2C URP) | B2C | n/a | ✅ `111012061834` |

3/3 succeeded. All `irn_status` / `ewb_status` rows consistent across `invoices` and `gst_documents`.

### Tooling added

- [packages/api/scripts/smoke-test-ewb.ts](packages/api/scripts/smoke-test-ewb.ts) — reusable manual verification harness. Creates one B2B intra + one B2B inter + one B2C order via the live API, runs preflight, prints `gst_documents` and the last few `gst_api_logs` rows per order. Use for future GST regressions before/after a fix.

### Anti-pattern added to CLAUDE.md

  - **#14**: Sending `shipToGSTIN` or `dispatchFromGSTIN` on an EWB payload with `transactionType: 1` causes NIC 616. These fields are only valid for transactionType 2, 3, or 4. Guard test in [gst-b2c-urp-investigation.test.ts](packages/api/src/__tests__/gst-b2c-urp-investigation.test.ts).

### Outstanding for Session 4

- Address the three latent bugs above (silent-failure null `ewbNo`, phantom-active row, two `isLatest` rows). All are dead code on the success path but real risk if NIC's validator changes again. Recommend bundling under a single WI-077.
- Consider whether the test suite needs a `*-payload-shape.test.ts` guard that fails if any of the four redundant fields ever sneak back into the B2B EWB output. (Current guard only covers the `gst-b2c-urp-investigation.test.ts` B2B assertion — strengthen to a dedicated shape test.)

---

## SECTION 12 — Sessions 4 + 5 Addendum (2026-05-20 / 2026-05-21)

Sessions 4 and 5 ran as a single continuous Claude Code thread on the **master worktree** (no worktree). All WIs shipped directly to master.

### Updated state at end of Session 5

| Item | Value |
|---|---|
| Master SHA | **`6dcaf57`** — WI-087 vehicle workflow safety guards |
| API test suite | **481 passed / 481 total** (Vitest integration suite) |
| Typecheck | clean |
| Live GST (dist-002) | ✅ B2B + B2C dispatch + cancel fully end-to-end verified |
| Vehicle workflow guards | ✅ New (WI-087) |

### WIs completed in Sessions 4 + 5

| WI | Status | Summary |
|---|---|---|
| WI-074 | ✅ done | B2C EWB transactionType=2, URP Bill-To, depot shipToGSTIN — live B2C dispatch works |
| WI-076 | ✅ done | B2B EWB omits redundant shipTo/dispatchFrom (NIC 616 fix) — live verified |
| WI-077 | ✅ done | Billing list B2B/B2C pills + B2C CN/DN PDF skips IRN compliance block |
| WI-078 | ✅ done (absorbed) | Cancel EWB/IRN at NIC + DVA release — absorbed into WI-081..WI-084 |
| WI-079 | ✅ done | Inventory-role fixes (5 bugs) + finance customer view-only |
| WI-080 | ✅ done | Consolidated inventory improvements (daily ledger, adjust stock, forecast, onboarding) |
| WI-081 | ✅ done | Order cancellation wired to NIC cancel + CancelledStockEvent + vehicle return workflow |
| WI-082 | ✅ done | Cancel modal context-aware + Mark as Returned vehicle status fix |
| WI-083 | ✅ done | cancel_failed IRN status (schema→PDF→UI) + inventory empties fix + DVA ordering |
| WI-083a2 | ✅ done | Live-dispatch gaps: trip sheet PDF widths, CSE on_vehicle, cancellation_return routing |
| WI-084 | ✅ done | IRN retry corruption guard (irnPersisted flag) + cancel token refresh + trip sheet redesign |
| WI-085 | ✅ done | Stale token retry-once + 55-min fallback + mobile Mark as Returned + dev test endpoints |
| WI-086 | ✅ done | Single token eviction before EWB+IRN cancel sequence (NIC 1004 double-auth race) |
| WI-087 | ✅ done | Vehicle workflow safety guards (markVehicleReturned + confirmDelivery) |

### Key bugs found and fixed during live GST testing

1. **IRN retry-corruption** (WI-084): processInvoiceGst outer catch was stamping `irnStatus=failed` even when IRN was already committed. `irnPersisted` flag tracks commit; catch only overwrites if flag is false.
2. **Cancel SESSION_EXPIRED on every attempt** (WI-084/WI-086): WI-084 added `clearTokenCache` inside cancelIrn + cancelEwb; when cancelOrder calls both sequentially, two auth calls fire <700ms — NIC 1004 on second. WI-086 moved eviction to orchestrator (once before the sequence).
3. **Stale TokenExpiry** (WI-085): WhiteBooks sandbox returns stale `TokenExpiry` on every auth call. WI-085 retry-once; if both stale, use 55-min fallback (WhiteBooks confirmed tokens valid 1h). SESSION_EXPIRED only from NIC 1004/1005 guard.
4. **GST tenant isolation** (pre-session, WI-058): `lookupGstin` had no `distributorId` filter. Leaked dist-001 test credential to all callers including dist-002. Now requires distributorId; falls back to owner-distributor lookup. Anti-pattern #13.
5. **EWB status NIC 616** (WI-076): `shipToGSTIN`/`dispatchFromGSTIN` fields now rejected by NIC under transactionType=1. Omitted from B2B branch. Anti-pattern #14.

### Anti-patterns added to CLAUDE.md (sessions 4+5)

- **#11**: External API call failures logged only as errors, never as request payloads — persist both success and failure with full outgoing request payload.
- **#12**: EWB sub-step error overwriting committed IRN status — use `irnPersisted` flag pattern.
- **#13**: Tenant-scoped Prisma queries without `distributorId` filter.
- **#14**: Sending `shipToGSTIN`/`dispatchFromGSTIN` under `transactionType=1` — NIC 616.

### Verification scripts (in `packages/api/scripts/`)

| Script | Purpose |
|---|---|
| `test-full-b2b-b2c.ts` | Full B2B + B2C GST smoke (52 assertions). Stale-token inject, dispatch, cancel. |
| `test-wi085-token-retry.ts` | WI-085 stale-token retry verification (29 assertions) |
| `test-vehicle-workflow.ts` | WI-087 vehicle workflow guards (11 assertions) |
| `test-cancel-irn-ewb.ts` | Cancel IRN + EWB live verification (20 assertions) |
| `smoke-test-ewb.ts` | One-shot B2B+B2C dispatch smoke harness |

Run all: `cd packages/api && .\node_modules\.bin\tsx scripts/<name>.ts`

### Stale investigation scripts deleted (session 5 cleanup)

All `_*.ts` scripts (underscore-prefixed one-off investigation/debug scripts from sessions 4+5) deleted:
`_check-token-logs.ts`, `_irn-fix.ts`, `_wb-raw-test.ts`, `_check-cse.ts`, `_check-hyderabad.ts`, `_check-vehicle-state.ts`, `_debug-cancel.ts`, `_fix-hyderabad-cancel.ts`, `_gap-invest2.ts`, `_gap-investigation.ts`, `_list-customers.ts`, `_retry-cancel-irn.ts`

### Next steps

1. **Finance user test plan** (Phase 3): `finance@gasagency.com` / `Finance@123` on Bhargava Gas Agency. Access matrix: billing + collections + payments read; orders/inventory/customers/fleet/settings blocked. Salary access, reports, PDF download.
2. **Inventory user test plan** (Phase 4): `inventory@gasagency.com` / `Inventory@123`. Daily summary, depot intake, manual adjustment, lock day, reconciliation, vehicle return flow.
3. **Driver web check** (Phase 5): `raju@gasagency.com` — should redirect to driver tile view. Only /app/orders accessible.
4. **Customer portal** (Phase 6): `royal@kitchen.com` — dashboard, orders, invoices, payments.
5. **Tenant isolation** (Phase 7): cross-tenant entity ID access — expect 404 not data leak.
6. **Open pending_actions cleanup**: ~300+ open HIGH actions from pre-WI-076 B2C/B2B failures. SQL sweep once all Phase 2 testing done.

---

**End of handoff.**
