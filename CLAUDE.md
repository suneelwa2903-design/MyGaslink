# Re-New GasLink — Claude Code Instructions

## MANDATORY: Read This At Every Session Start

Before doing ANYTHING else in every session, run these two steps:

1. **Read the live testing tracker:**
   ```
   Read docs/TESTING_PROGRESS.md
   ```

2. **Check git state:**
   ```
   git log --oneline -5
   git status --short
   ```

Then tell the user: what phase/step we're on, what was last tested, and what's next.

---

## Project Overview

Re-New GasLink is an LPG distribution management SaaS — monorepo with 3 packages:
- `packages/api` — Express + TypeScript + Prisma (PostgreSQL)
- `packages/web` — React 19 + Vite + Tailwind + Zustand
- `packages/mobile` — React Native + Expo 54 + NativeWind

**Status:** Production live as of 2026-05-29. Current focus: iOS submission track (single-tracking). See PRODUCTION STATE below.

---

## PRODUCTION STATE

*Last updated: 2026-06-08 (Phase 0 iOS audit — ground-truth refresh, [docs/IOS-PHASE0-GROUND-TRUTH.md](docs/IOS-PHASE0-GROUND-TRUTH.md))*

- **LIVE AT:** mygaslink.com / api.mygaslink.com
- **SUPER-ADMIN:** suneel@mygaslink.com (password set)
- **LOCAL HEAD:** `4b7e83f` (2026-06-07 — Google Analytics gtag.js). EC2 HEAD unknown from this machine; was `58404de` as of 2026-05-29, ~96 commits ago.
- **RDS MIGRATIONS:** 17 / 17 applied (last verified 2026-05-29)
- **TESTS:** 942 passing + 2 skipped, 0 failing. Per-package: api 895, mobile 41 (+2 skipped), web 6. `pnpm typecheck` and `pnpm lint` both exit 0.
- **`INVENTORY_DISPATCH_DEBIT`:** `true`
- **`TZ`:** `Asia/Kolkata`

### CURRENT FOCUS: iOS feature parity + App Store submission (single track)

All other tracks parked until iOS is in App Store review. See [docs/IOS-PHASE0-GROUND-TRUTH.md](docs/IOS-PHASE0-GROUND-TRUTH.md) for the full audit. Target: submission in ~7-10 days from 2026-06-08; Apple review adds 1-2 days.

**Parked until iOS submission complete:**
- WhiteBooks production activation
- Super Admin SaaS billing ship-blockers ([docs/SUPERADMIN-BILLING-AUDIT.md](docs/SUPERADMIN-BILLING-AUDIT.md) — 5 fixes, ~2 hours of work). Gated by July 1 first-real-billing event — **must restart by ~2026-06-25** or July billing slips.
- GSTR-1 export feature
- Distributor NIC portal registration push
- Float-to-Decimal service migration (WI-006)
- Customer ledger view (WI-075)
- B2C reissue docNo bump
- WhatsApp outreach to new distributors
- FLAG_SECURE removal (Android)
- Push notifications (super-critical label transferred to v1.1 Sprint 1 — see below)
- SSL cert pinning in mobile (deferred to post-v1.0; Apple doesn't require it, DPDP review likely will)

### iOS submission ship-blockers (pre-Apple-review)

| # | Item | Status 2026-06-08 | Phase |
|---|------|--------------------|-------|
| 1 | Apple Developer Program enrollment (Organization, D-U-N-S → Apple) | TODO Suneel — start within 48h | Parallel — longest lead time |
| 2 | Account deletion: PII anonymization + statutory retention, real `DELETE /api/users/me` | Spec being written — [docs/IOS-ACCOUNT-DELETION-SPEC.md](docs/IOS-ACCOUNT-DELETION-SPEC.md). Currently a `mailto:` link → Apple 5.1.1(v) rejection risk | Spec → 3-4 day mini-track parallel to Phase 1 |
| 3 | DPDP consent checkbox in mobile app | ✅ Done (verified Phase 0) | — |
| 4 | Feature parity matrix (Android vs iOS) per app per screen | Phase 1 in progress | Phase 1 |
| 5 | iOS config: `buildNumber`, `usesNonExemptEncryption`, `eas.json submit.production.ios` block | Fixed in this housekeeping pass | Phase 1 setup |
| 6 | `expo prebuild --no-install` dry-run to surface native module Info.plist gaps | Phase 1 | Phase 1 |

### v1.1 Post-iOS-submission backlog (Sprint 1)

- **Push notifications** — wire real APNs + FCM via `expo-notifications`. Currently a no-op stub; SSE covers driver foreground only. Plugin removed from `app.config` for v1.0 to avoid Apple rejection on entitlement-without-handler. Package + code stubs retained for the v1.1 rebuild.
- **Super Admin SaaS billing 5 ship-blockers** — must restart by ~2026-06-25 for July 1 first-distributor billing event.
- **SSL cert pinning in mobile** — Apple doesn't require; DPDP/security review likely will.
- **Account deletion UI v2** — if Apple flags any v1.0 shortcuts during review.

### ANDROID SUBMISSION — 3 steps remaining (PARKED — finish after iOS submission)

1. Ads declaration → "No ads"
2. Confirm content rating "Submitted"
3. `eas build --platform android --profile production`

### PARKED (defer past iOS submission)

- Monitoring (CloudWatch alarms + UptimeRobot)
- GitHub billing fix (GH_PAT workaround is in place)
- Test flakiness (timezone + anti-pattern-guards DB contamination)

---

## Dev Commands

```bash
# Start everything (API + Web)
pnpm dev

# Or individually
pnpm dev:api        # API on port 5000
pnpm dev:web        # Web on port 5173

# Database
pnpm db:generate    # Regenerate Prisma client after schema changes
pnpm db:migrate     # Run migrations
pnpm db:seed        # Seed test data
pnpm db:studio      # Prisma Studio GUI

# Docker (PostgreSQL)
pnpm docker:up
pnpm docker:down

# Tests
pnpm test           # All tests
cd packages/api && pnpm test   # API integration tests only
```

---

## Test Accounts (Seeded)

| Role | Email | Password | Distributor |
|------|-------|----------|-------------|
| Super Admin | admin@mygaslink.com | Admin@123 | All (platform-level) |
| Dist Admin (GST OFF) | bhargava@gasagency.com | Distadmin@123 | Bhargava Gas Agency |
| Dist Admin (GST ON) | sharma@gasdist.com | Gstadmin@123 | Sharma Gas Distributors |
| Finance | finance@gasagency.com | Finance@123 | Bhargava Gas Agency |
| Inventory | inventory@gasagency.com | Inventory@123 | Bhargava Gas Agency |
| Driver | raju@gasagency.com | Driver@123 | Bhargava Gas Agency |
| Customer | royal@kitchen.com | Customer@123 | Bhargava Gas Agency |

> **Dev-DB test fixtures in Fleet (WI-090):** the GST integration tests
> (`gst-preflight`, `gst-trip-sheet`, `gst-dispatch-trip`) dispatch DEDICATED
> test vehicles instead of the seeded fleet, so they no longer corrupt live
> vehicle dispatch state. As a result you will see extra vehicles named
> **`TEST-PF-VEHICLE-D2`**, **`TEST-TS-VEHICLE-D2`**, **`TEST-DISPATCH-TRIP-D2`**
> (Sharma / dist-002) and **`TEST-PF-VEHICLE-D1`** (Bhargava / dist-001) in
> Fleet → Vehicles, normally `idle`. They are harmless test fixtures created
> on demand by `getOrCreateTestVehicle` (packages/api/src/__tests__/helpers.ts)
> — ignore them during manual testing. They are DB rows (not files, so not a
> `.gitignore` concern); a future seed-cleanup pass can prune them.

---

## Testing Protocol

### Tracking File
All test progress lives in `docs/TESTING_PROGRESS.md`. **Always update it and commit after each session.**

Session end checklist:
```bash
git add docs/TESTING_PROGRESS.md
git commit -m "test: update progress - [what was tested today]"
```

### Test Assets
- `docs/E2E_Testing_Guide.xlsx` — 272 detailed E2E test cases
- `docs/Navigation_Smoke_Test.xlsx` — 55 navigation smoke tests (7 roles)

### Phase Order
1. Phase 1 — Navigation Smoke (7 roles, ~30 min)
2. Phase 2 — E2E by module (Orders, Inventory, Customers, Billing, Fleet, Settings, Workflows)
3. Phase 3 — Mobile (Expo Go)
4. Phase 4 — API integration tests (`pnpm test`)

---

## Key Rules

- **Never use kill commands** that would terminate the remote Claude terminal session
- **Always commit** after a testing session updates `TESTING_PROGRESS.md`
- When fixing a bug found during testing, document it in the Known Bugs table in `TESTING_PROGRESS.md`
- The i18n branch (`claude/sharp-grothendieck`) has EN+TE translations — not yet merged to master

---

## Architecture Notes

- JWT auth (not Firebase) — tokens stored in Zustand + localStorage
- 6 user roles: SUPER_ADMIN, DISTRIBUTOR_ADMIN, FINANCE, INVENTORY, DRIVER, CUSTOMER
- Multi-distributor: SUPER_ADMIN can switch distributors via header selector
- GST modes per distributor: DISABLED / SANDBOX / LIVE
- Prisma schema: 45 models, 38+ enums
- All routes scoped by distributorId from JWT middleware

> Full architecture lives in [ARCHITECTURE.md](ARCHITECTURE.md). Read it once per major task.

---

## Code Conventions (observed in this repo)

These are the patterns the codebase actually uses today. Match them — don't reinvent.

**Backend (`packages/api`)**
- ESM TypeScript (`"type": "module"`). All relative imports use `.js` suffix even though sources are `.ts` (Node ESM requirement).
- Zod schemas live next to or inside route files; validation runs in `middleware/validate.ts`.
- All responses go through `utils/apiResponse.ts` helpers (`sendSuccess`, `sendError`, `sendUnauthorized`, `sendForbidden`, `sendNotFound`). **Never call `res.json` directly** — bypasses the standard envelope.
- Prisma client is a singleton at `lib/prisma.ts`. Don't `new PrismaClient()` anywhere else.
- Logger is Winston via `utils/logger.ts`. Don't `console.log` outside dev-only scripts.
- Sentry is auto-wired via `lib/sentry.ts` and the global error handler. Don't capture exceptions manually unless adding context.
- Route mounting in `app.ts` is canonical — every new tenant-scoped route MUST go through `authenticate → resolveDistributor → requireDistributor`.
- Services own DB access; routes orchestrate. Don't put Prisma queries directly in route handlers.

**Frontend web (`packages/web`)**
- TanStack Query for server state — keys live alongside the hook. Don't fetch in `useEffect` for data we cache.
- Zustand for client/auth state with `persist` middleware (not raw `localStorage`).
- All API calls go through the shared axios instance — it injects `Authorization` and `X-Distributor-Id`. Bypassing it drops headers (see Anti-pattern #5 below).
- Forms: react-hook-form + Zod. No raw `<input>` state.
- Tailwind first; one-off CSS goes in `index.css`. No CSS modules.
- UI primitives in `components/ui/` (Button, Input, Modal, Badge, Loader, Select, EmptyState).

**Mobile (`packages/mobile`)**
- expo-router file-based routing under `app/`. Folder names with `(parens)` are route groups (no URL segment).
- Token storage MUST go through `expo-secure-store`, never AsyncStorage.

**Naming**
- DB columns: `snake_case`, mapped via Prisma `@map`/`@@map` to `camelCase` TS fields.
- Files: `camelCase.ts` for services/utils, `PascalCase.tsx` for React components, `camelCase.ts` for hooks/stores.
- Routes: kebab-case URLs (`/api/customer-portal`, `/api/cylinder-types`).

---

## Multi-tenant Rules (CRITICAL)

This is a **single-database, distributor_id-discriminator** SaaS. Cross-tenant data leaks would be catastrophic.

1. **Every Prisma query on a tenant-scoped model MUST include `where: { distributorId: req.user.distributorId }`** (or pass it as a service argument). There is no row-level security — only convention.
2. **Never trust `distributorId` from the request body or query params.** Always read from `req.user.distributorId` (set by JWT) or `req.headers['x-distributor-id']` (super_admin only, validated in `resolveDistributor`).
3. **Super admin = the only role that can change tenant context.** Implementation lives in `middleware/auth.ts:resolveDistributor`. Don't add other ways to switch.
4. **GST behaviour is per-tenant.** Check `distributor.gstMode` before any IRN/EWB call — DISABLED tenants must never hit WhiteBooks. Same gate for showing GST UI columns/buttons in the web.
5. When adding a new model, **always** add `distributorId String @map("distributor_id")` and an `@@index([distributorId])` unless the table is genuinely platform-level (gst_states, hsn_codes, provider_catalog_*, distributors itself, contact_submissions if cross-tenant).
6. When writing tests, seed at least two distributors and assert that User A from Distributor 1 cannot see anything owned by Distributor 2. The existing test suite ([packages/api/src/__tests__/](packages/api/src/__tests__/)) is the reference.

---

## Anti-patterns Found

Things in the codebase today that should NOT be copied. Fix these in future work items.

1. **Ad-hoc test scripts at `packages/api/` root** — `test-debit-note.ts`, `test-distance.ts`, `test-e2e-v2/v3/v4.ts`, `test-e2e.ts`, `test-ewb.ts`, `test-production-gst.ts`, `test-whitebooks.ts`, `check-users.ts`. Not in the Vitest suite, undocumented, bit-rot quickly. New verification scripts should either become integration tests under `src/__tests__/` or move into `scripts/` with a clear purpose.
2. **Single Prisma migration on disk** (`20260323000000_init`). Going forward, schema changes should be incremental migrations — never `prisma migrate reset` against shared dev/staging DBs.
3. **`requireDistributor` skipped on `/api/users`, `/api/billing`, `/api/pricing`** ([app.ts:82,96,101](packages/api/src/app.ts:82)). Likely intentional (super_admin needs cross-tenant lists), but per-handler isolation is then up to each route. Confirm and document, or tighten.
4. **Default JWT secrets fall back in code** ([packages/api/src/config/index.ts:14](packages/api/src/config/index.ts:14)). Prod is gated by `validateEnv()`, but in dev it's easy to ship code that depends on weak secrets. Prefer hard-failing on missing secrets even in dev.
5. **PDF/blob downloads previously bypassed the axios client** (fixed in commit 7f2758f — see TESTING_PROGRESS.md bug #3). When adding a new download/export endpoint, route it through the same axios instance as everything else.
6. **Mocking an external API without validating payload shape.** Unit + integration tests for the GST flow mock WhiteBooks and return fake success — they verify our logic but never see the raw payload NIC actually validates. A `TransDocDt: ''` regression slipped through every mocked test and only blew up on the first live dispatch (5002 error). **Rule:** for every external-API integration (WhiteBooks, NIC, future GSP / payment-gateway / etc.) keep a `*-payload-shape.test.ts` next to the logic tests that calls the payload builder directly (no DB, no HTTP) and asserts field formats, lengths, and required keys against the provider's documented schema. Reference: [packages/api/src/__tests__/gst-payload-shape.test.ts](packages/api/src/__tests__/gst-payload-shape.test.ts).
7. **Using today's date for time-sensitive test fixtures on the shared dev DB.** The integration suite runs against the same Postgres as manual testing (see §6 below — single dev DB). When a test seeds orders with `deliveryDate: today` and then calls a service that queries by `(distributorId, driverId, deliveryDate, status)` — like `preflightDispatch` — the service sweeps up **every** real order in that bucket too. With WhiteBooks mocked, the test then writes the fake mock IRN to real invoices, and the test's `clearPreflightArtifacts(orderIds)` only deletes the fixture orders, leaving the contaminated real rows behind. We hit this exact bug on 2026-05-15 (invoices `INV-MP6OYSFP3U0` and `INV-MP6QW86XT5T` ended up with `irn_` mock values from `irnSuccessWithInlineEwb`). **Rule:** any test that seeds time-sensitive data (orders, assignments, vehicle mappings) for a service that later filters by date MUST use a fixed far-future date that real manual-test data will never occupy. Convention: `const TEST_DATE = '2099-12-31'`. See [packages/api/src/__tests__/gst-preflight.test.ts](packages/api/src/__tests__/gst-preflight.test.ts), [gst-reissue.test.ts](packages/api/src/__tests__/gst-reissue.test.ts), [gst-trip-sheet.test.ts](packages/api/src/__tests__/gst-trip-sheet.test.ts).
8. **Test cleanup that only deletes fixture IDs when the service queries by broader criteria.** Companion to anti-pattern #7. `clearPreflightArtifacts(orderIds)` cleans by `IN (orderIds)` — fine when nothing else exists. But the moment the service query is `(distributorId, driverId, deliveryDate)`, the test can hijack real rows whose IDs were never in `orderIds`. **Rule:** when a test calls a service that queries by broader criteria than fixture IDs, EITHER (a) isolate the fixture into a bucket the service will never accidentally hit (date trick from anti-pattern #7 — preferred) OR (b) make the cleanup query by the same broader criteria the service used (`deleteMany where distributorId+driverId+date`).
9. **API response type-annotated as one shape but route returns another.** The web consumes endpoints via typed clients (`apiGet<DistributorSettings>('/settings')`). When the route returns a different shape (raw array vs envelope object, TS enum names vs `@map`'d DB values, `_cn`/`_dn`-suffixed Prisma status vs the shared enum value), every consumer that reads `settings.gstMode` or `note.status === 'pending'` silently gets `undefined` / non-matching values. Symptom: a downstream feature flag (`gstEnabled`) is silently false; a status badge never colours; an Approve button never renders. Surfaced four times so far — WI-019 (BillingStatus `paid_billing` vs `paid`), WI-039 (CreditNoteStatus `pending_cn` vs `pending`), WI-044 (GET /settings returning `DistributorSetting[]` not `DistributorSettings`), and the inverse-fix in the same WI-039 (mapper added). **Rule:** every API route that the web types as object T must (a) actually return shape T (not a raw Prisma array if the type says object), and (b) translate Prisma's TS-side enum names to their `@map`'d values via a mapper before returning. Add a guard test next to the consumer that asserts the wire shape — `expect(res.body.data).toHaveProperty('gstMode')` is cheap insurance. Reference guards: [packages/api/src/__tests__/anti-pattern-guards.test.ts](packages/api/src/__tests__/anti-pattern-guards.test.ts).
10. **Implementing an external API feature without verifying it works in the real sandbox before marking the WI done.** Mock tests passing ≠ feature working. WI-035 shipped inline `EwbDtls` in the IRN payload (the "1-call instead of 2" optimization NIC's Postman advertises). Every mocked unit + integration test passed because the mock returned a successful response shape regardless of what we sent. The first live dispatch attempt on 2026-05-15 returned generic NIC 5002 — no specific field error, no payload hint — and consumed two hours of progressively wrong speculative fixes (RegRev='Y'→'N' reverted, field-name casing reverted) before we realized the entire inline path was broken on this sandbox. The fix was to drop the inline block entirely and use the proven two-step pattern (`processInvoiceGst` had 5 successes that day). **Rule:** every new WhiteBooks/NIC API path must (a) name the exact endpoint + payload schema in the spec BEFORE writing code, (b) be exercised against the live sandbox after implementation, (c) have the sandbox call result (success or failure with the raw NIC response body) documented in the session summary. Mock-only verification is not sufficient. For the GST flow specifically: IRN goes to `POST /einvoice/type/GENERATE/version/V1_03` with **no `EwbDtls` block**; EWB goes to a **separate** `POST /ewaybillapi/v1.03/ewayapi/genewaybill` call. Inline `EwbDtls` in the IRN payload is dead code (removed in [payloadBuilders.ts](packages/api/src/services/gst/payloadBuilders.ts)) — do not re-introduce without a fresh live sandbox verification.
11. **External API call failures logged only as errors, never as request payloads.** Until 2026-05-15, `apiCall()` in [whitebooksClient.ts](packages/api/src/services/gst/whitebooksClient.ts) only sent failures through Winston's `logger.error(...)` and never persisted the outgoing request to `gst_api_logs`. When NIC sandbox started returning generic 5002 on the dispatch preflight path, we had eight stored success payloads in `gst_documents` (success path writes the payload to the gst_documents row) and **zero** stored failure payloads — making the "what changed between successes and failures?" diff literally impossible to run from the DB. Hours of speculation followed. **Rule:** every external-API client must persist *both* success and failure calls with the full outgoing `request_payload` and the raw `response_payload`. The write must be best-effort (never block the API result) but it must happen for both branches, and it must capture enough context (`apiType`, `invoiceId`, `orderId`, `distributorId`, `httpStatus`, `errorCode`, `latencyMs`) to make a side-by-side diff possible. Don't trust upstream providers to echo back the failing field — they often won't. Capture the *outgoing* payload at the call site. For the GST flow specifically: every `apiCall(...)` in [whitebooksClient.ts](packages/api/src/services/gst/whitebooksClient.ts) writes a `gst_api_logs` row via `writeApiLog()` regardless of outcome; the optional `context` parameter (`{ apiType, invoiceId?, orderId? }`) gives the row its forensic value.
12. **External-API status persistence bug: error in EWB sub-step overwriting committed IRN status.** Companion to #10/#11. Inside `processInvoiceGst()` / `runB2bPreflight()`, the outer `try` wraps IRN generation; the EWB call lives inside the same `try` with its own inner `try/catch`. If anything in the EWB branch — `recoverEwbFromIrn`, a downstream `prisma.invoice.update`, `createPendingAction`, `transitionToPendingDelivery`, or the inner catch's own `prisma.*` call — throws, the error propagates to the outer IRN catch which then runs `prisma.invoice.update({ irnStatus: 'failed' })`. Two real invoices on 2026-05-15 ended up with valid 64-char NIC IRNs in `invoices.irn` but `invoices.irn_status='failed'` from this exact path (`INV-MP6FSGSNM1N`, `INV-MP6JW3EH46T`). **Rule:** when a multi-step external-API flow commits intermediate state to the DB, the outer catch MUST NOT blindly mark the whole operation failed. Track a local `*Persisted` flag after each commit; in the catch, only overwrite status fields whose precondition flag is false. For the GST flow: see the `irnPersisted` flag in [gstService.ts processInvoiceGst()](packages/api/src/services/gst/gstService.ts) and [gstPreflightService.ts runB2bPreflight()](packages/api/src/services/gst/gstPreflightService.ts).
13. **Tenant-scoped Prisma queries without an explicit `distributorId` filter.** Companion to #1: this calls out the specific trap of `findFirst({ where: { ... } })` on a tenant-scoped table with NO `distributorId` clause. `lookupGstin` in [gstinLookup.ts](packages/api/src/services/gst/gstinLookup.ts) did exactly this — `prisma.gstCredential.findFirst({ where: { scope: 'einvoice' } })` with no `distributorId`, no `orderBy`, no `isValid` filter. On 2026-05-16 the dev DB held a test-leaked dist-001 credential row (`client_id='test-client-id'`, `email=NULL`, `distributor.gstMode='disabled'`). Prisma picked it as the "first" einvoice row for **every** caller — including Sharma admins. The handler then used its bogus client_id + fallback email `info@mygaslink.com` and hit **production** WhiteBooks (because `gstMode='disabled'` made the sandbox check evaluate false). Production WhiteBooks returned `"This email is not registered"`, which we spent ~24 hours misdiagnosing as a WhiteBooks-side account suspension before a direct `curl` proved the live account was healthy. **Rule:** every `prisma.<tenantScoped>.findFirst()` / `findMany()` MUST include `distributorId` in `where`. The super-admin or platform-level fallback paths (the rare legitimate exception) must additionally require `isValid: true`, exclude NULL values for fields the API depends on (e.g. `email`), and use a deterministic `orderBy` so a leaked row can't win a race. Reference: WI-058 — fix in commit referenced by `.session/specs/WI-058-gstin-lookup-tenant-isolation.md`.
14. **Sending `shipToGSTIN` or `dispatchFromGSTIN` on an EWB payload with `transactionType: 1`.** NIC's EWB validator rejects this with error 616 ("JSON validation failed"). Under `transactionType: 1` ("Bill-To party and Ship-To party are the SAME registered legal entity"), `toGstin` already IS the Ship-To and `fromGstin` already IS the Dispatch-From — the extra fields are redundant and now cause hard rejection. Valid only on `transactionType: 2` (Bill-To ≠ Ship-To), `3` (Bill-From ≠ Dispatch-From), or `4` (both). WI-073 stripped these fields for the B2C path; WI-076 (2026-05-19) extends the same omission to B2B after four live dispatches on dist-002 (Maruthi ×2, Hyderabad Caterers ×2) all failed 616 with valid IRNs. Live A/B proof on a brand-new docNo NIC had never seen (`INV-MPCJV99K`): same payload with the four fields → 616; same payload stripped → `ewayBillNo: 101012061787`. **Rule:** in [payloadBuilders.ts buildEwbPayload()](packages/api/src/services/gst/payloadBuilders.ts), `shipToGSTIN` / `shipToTradeName` / `dispatchFromGSTIN` / `dispatchFromTradeName` may ONLY be emitted when `transactionType !== 1`. The B2B branch (`isB2C === false`) omits all four; the B2C branch emits `shipToGSTIN`/`shipToTradeName` only (depot is Ship-To, dispatchFrom omitted because Bill-From == Dispatch-From). Guard test: [gst-b2c-urp-investigation.test.ts "B2B EWB: redundant ship-to/dispatch-from omitted"](packages/api/src/__tests__/gst-b2c-urp-investigation.test.ts) asserts these four fields are `undefined` on B2B output.

15. **A defensive short-circuit whose premise is provider-specific token behaviour, applied uniformly across operation types.** The `apiCall` token-expiry handler in [whitebooksClient.ts](packages/api/src/services/gst/whitebooksClient.ts) re-authenticated after a NIC 1004/1005, and if WhiteBooks returned the *same* token string it threw `SESSION_EXPIRED` immediately — assuming "same token ⇒ NIC session dead ⇒ retrying is pointless." That premise is FALSE for WhiteBooks: it pins ONE auth token per session window and returns the identical string on every re-auth (immediate AND 60s-delayed), even when the NIC session is perfectly healthy. Proven live by [scripts/probe-nic-session.ts](scripts/probe-nic-session.ts) — the pinned token succeeded at GSTNDETAILS *and* at a direct IRN CANCEL. So the guard fired on EVERY transient 1004/1005, short-circuiting **before the cancel ever reached NIC** and leaving the IRN live at NIC with `responsePayload=NULL` (un-diagnosable). It also wrongly applied a *dispatch* safety rule (avoid duplicate IRN on GENERATE retry — bug #14) to the *cancel* path, where retrying is safe and idempotent-ish. WI-090 (2026-05-21) fix: cancel calls (`apiType` IRN_CANCEL/EWB_CANCEL) now RETRY the real NIC call with the pinned token; `SESSION_EXPIRED` is surfaced only after a SECOND NIC rejection and now carries the raw NIC body. The GENERATE short-circuit is kept. **Rule:** before writing a retry-suppression heuristic for an external API, verify the provider's token/session semantics with a live probe — don't assume "same token = stale". And never apply a guard built for one operation (dispatch/GENERATE) to a structurally different one (cancel) without re-checking the safety argument. Guard test: [gst-token-expiry.test.ts "WI-090 — apiCall cancel-retry guard"](packages/api/src/__tests__/gst-token-expiry.test.ts). Live harness: [scripts/diag-irn-cancel.ts](packages/api/scripts/diag-irn-cancel.ts).

16. **The same DB column written with different unit conventions in different code paths — and downstream readers assume one convention.** `InvoiceItem.unitPrice` was written as GST-BASE by [invoiceService.ts createInvoiceFromOrder](packages/api/src/services/invoiceService.ts) (after a `/1.18` at write time), as EXCLUSIVE by [invoiceService.ts createManualInvoice](packages/api/src/services/invoiceService.ts) (raw input pass-through), while every reader — [invoicePdfService.ts computeItems](packages/api/src/services/pdf/invoicePdfService.ts), [payloadBuilders.ts buildIrnPayload](packages/api/src/services/gst/payloadBuilders.ts), [gstService.ts processInvoiceGst/processCreditNoteGst/processDebitNoteGst](packages/api/src/services/gst/gstService.ts), [gstPreflightService.ts buildInvoiceData](packages/api/src/services/gst/gstPreflightService.ts), [gstReissueService.ts buildInvoiceData](packages/api/src/services/gst/gstReissueService.ts) — assumed INCLUSIVE and applied its OWN `/1.18` to extract the assessable amount. Net effect: a `₹42,000` GST-inclusive cylinder produced `AssAmt = ₹42,000 / 1.18² = ₹30,163.75` in every B2B IRN sent to NIC, so live e-invoices on dist-002 (Sharma GST-LIVE) under-reported tax for months. The `Invoice.cgstValue/sgstValue/igstValue` aggregates were correct (single `/1.18`) so customer ledger + grand totals matched — only the per-line PDF figures, the IRN AssAmt/TotInvVal, and any downstream re-issue diverged. The feeders at the IRN call sites silently absorbed the unit drift by adding back `discountPerUnit` (`unitPrice + discountPerUnit`) — neither value was actually GST-inclusive after the BASE write, so the addition was nonsense compensating for nonsense. **Rule:** every numeric DB column that participates in a multi-stage tax computation MUST declare its unit convention in a `///` Prisma comment AND in every reader's local variable name (`unitPriceInclusive`, never bare `unitPrice`). Pick one convention (we picked GST-INCLUSIVE for `InvoiceItem.unitPrice` so it matches `OrderItem.unitPrice` and `CylinderPrice.price`) and enforce it in the writer; readers do at most one inverse step. Fix (2026-06-01): writer at [invoiceService.ts:152-180](packages/api/src/services/invoiceService.ts) stores inclusive; readers at gstService.ts:297-308, 1032-1041, 1131-1140, gstPreflightService.ts:996-1005, gstReissueService.ts:807-816 stop adding discount back. Companion to anti-pattern #6 (payload-shape tests that mock the provider but never test the WRITE→READ pipeline end-to-end). Guard test: [gst-inclusive-unit-price.test.ts](packages/api/src/__tests__/gst-inclusive-unit-price.test.ts) walks DB→service→payload and pins both positive (`AssVal ≈ 35593.22, TotInvVal ≈ 42000`) and negative (`AssVal ≠ 30163.75`) assertions. Operational fix: [scripts/gst-unit-price-backfill.ts](packages/api/scripts/gst-unit-price-backfill.ts) (dry-run by default; multiplies `unit_price` and — for manual invoices — `discount_per_unit` by `1.18`, idempotent via `notes` marker), then [scripts/nic-reissue-tool.ts](packages/api/scripts/nic-reissue-tool.ts) lists every `irnStatus=success` invoice that needs re-issue via the existing `gstReissueService` so NIC GSTR-1 auto-populates the correct amounts.

---

## ESLint

ESLint runs clean and **blocking** in CI (`pnpm run lint`, 0 errors). The flat
config lives at the repo root ([eslint.config.js](eslint.config.js)); ESLint 9 +
typescript-eslint (recommended, non-type-checked) + React/React-hooks plugins.

`@typescript-eslint/no-explicit-any` is an **`error`** (promoted 2026-05-26). The
dedicated typing session replaced all 759 `any` instances with correct specific
types (Prisma `*Input`/`GetPayload`, shared DTOs, Express/React/RN/axios types,
vitest mock types, `unknown`+narrowing for catches). **Do not add new `any`** —
the rule blocks CI. No blanket `unknown` swaps, no `eslint-disable`; type it
properly. The only remaining warnings are a handful of `react-hooks/exhaustive-deps`.

---

## MOBILE â€” ADDITIONAL RULES
*Appended to CLAUDE.md for mobile (React Native) and fullstack projects*

### Mobile Platform
- **Framework:** React Native (Expo managed workflow)
- **Targets:** iOS and Android
- **Min OS:** iOS 15+, Android 10+ (API level 29)
- **State:** Zustand
- **Navigation:** Expo Router

---

### Mobile Security â€” NON-NEGOTIABLE

#### Token & Secret Storage
- **NEVER store auth tokens in AsyncStorage** â€” this is unencrypted
- JWT/session tokens â†’ `expo-secure-store` (Keychain on iOS, Keystore on Android)
- Sensitive user data (PII, financial) â†’ SecureStore only
- Non-sensitive preferences (theme, language) â†’ AsyncStorage is fine

#### Certificate Pinning
<!-- PLANNED — dependency not yet in package.json (2026-05-06) -->
<!-- Implement when feature is prioritised in work_items.json -->
- Pin SSL certificates for all production API calls
- Use `react-native-ssl-pinning` or custom interceptor
- Without pinning: man-in-the-middle attacks are trivial on mobile networks

#### Jailbreak / Root Detection
<!-- PLANNED — dependency not yet in package.json (2026-05-06) -->
<!-- Implement when feature is prioritised in work_items.json -->
- Check for jailbreak/root on app launch for financial/trading apps
- Use `jail-monkey` or `expo-device` checks
- On detection: warn user, optionally restrict sensitive features

#### Deeplinks
- Validate ALL deeplink parameters before using
- Never trust deeplink data directly â€” treat as user input
- Use Universal Links (iOS) / App Links (Android) â€” not custom schemes for auth flows

#### Biometric Auth
<!-- PLANNED — dependency not yet in package.json (2026-05-06) -->
<!-- Implement when feature is prioritised in work_items.json -->
- Use `expo-local-authentication` for biometric prompts
- Never store biometric data â€” use platform APIs only
- Fallback: PIN / password â€” never skip auth fallback

#### API Communication
- All API calls over HTTPS only â€” reject HTTP
- Implement request/response interceptors for token refresh
- Never log full request/response bodies in production

---

### Mobile Architecture Rules

#### API Layer
- All API calls in `/src/api/` â€” never inline fetch() in components
- Use axios with interceptors for: auth headers, token refresh, error normalisation
- Implement offline queue for write operations (critical for ERP apps)
- Response caching strategy: define per endpoint (cache/no-cache/stale-while-revalidate)

#### Offline Support
<!-- PLANNED — offline write queue not yet implemented (2026-05-06) -->
<!-- Conflict resolution strategy decided per-entity when feature is built -->
- For ERP/business apps: assume offline is normal, not an edge case
- Write operations: queue locally â†’ sync on reconnect
- Use `@react-native-async-storage/async-storage` for offline queue (non-sensitive)
- Conflict resolution strategy: last-write-wins | server-wins | manual-merge — to be decided per entity

#### State Management
- Server state: React Query or SWR â€” not hand-rolled useEffect fetching
- UI state: component-local or Zustand
- Auth state: Zustand + SecureStore persistence
- Form state: react-hook-form with zod

#### Navigation
- Deep link handling registered in root navigator
- Auth-gated routes: redirect to login if no valid token
- Tab bar: max 5 items â€” no nested bottom tabs
- Modal stack separate from main stack

#### Performance Rules
- No anonymous functions in render â€” use useCallback for callbacks
- List rendering: FlatList not ScrollView for >20 items
- Images: use `expo-image` with caching â€” not plain `<Image>`
- Bundle splitting: lazy load heavy screens
- Hermes engine enabled for both platforms

---

### Mobile Testing Rules

#### Unit Tests (Jest)
- All business logic tested â€” navigation helpers, formatters, validators
- Mock native modules: `__mocks__/` folder per native module
- Coverage: same as web (80% business logic, 100% auth flows)

#### Integration Tests (Jest + React Native Testing Library)
- Test component interactions â€” not implementation details
- Mock API calls with MSW (Mock Service Worker)
- Test offline scenarios â€” mock network failure

#### E2E Tests (Detox)
<!-- PLANNED — Detox not yet in package.json; mobile E2E currently manual via Expo Go (2026-05-06) -->
<!-- Implement when feature is prioritised in work_items.json -->
- Happy path for each major user flow
- Auth flow (login, logout, token refresh)
- Critical business flow (e.g. invoice creation for ERP)
- Run on both iOS simulator and Android emulator

#### Device Testing
- Test on real devices before any release
- iOS: test on oldest supported OS version
- Android: test on mid-range device (not just flagship)
- Test with slow network (throttle to 3G in dev settings)

---

### Mobile Spec Template Additions
Every mobile feature spec must also include:

```markdown
## Platform Behaviour
- iOS: [any iOS-specific behaviour]
- Android: [any Android-specific behaviour]
- Offline: [what happens when offline]

## Navigation
- Entry point: [screen/tab/deeplink]
- Exit: [back behaviour, modal dismiss]

## Permissions Required
- [ ] Camera
- [ ] Location
- [ ] Notifications
- [ ] Contacts
(only list what this feature needs)

## Performance Requirements
- Screen load time: < 300ms
- List scroll: 60fps
- API calls: show loading state if > 200ms
```

---

### Mobile Build & Release Rules

#### Versioning (MANDATORY)
- `version` in app.json/package.json: semantic (1.2.3)
- `buildNumber` (iOS) / `versionCode` (Android): increment every build â€” never reuse
- Tag every release: `git tag v1.2.3`

#### Before Any Release Build
- [ ] All E2E tests passing
- [ ] No console.log in production code (`babel-plugin-transform-remove-console`)
- [ ] Bundle analysed â€” no unexpected size increase
- [ ] Tested on physical device (iOS + Android)
- [ ] App Store / Play Store metadata updated if changed
- [ ] Privacy policy URL valid
- [ ] Deep link handling tested

#### Crash Reporting
- Sentry configured for both platforms
- Capture: unhandled errors, promise rejections, native crashes
- Set user context on login, clear on logout (no PII in error reports)

#### OTA Updates (Expo)
- Use EAS Update for minor fixes and content changes
- App store submission required for: new native modules, permission changes, major features
- Test OTA update flow before relying on it for critical fixes

---

### Mobile CLAUDE.md Anti-Patterns

Never do these in mobile code:
- `AsyncStorage` for auth tokens or any sensitive data
- `console.log` in production builds
- Anonymous functions in FlatList `renderItem`
- `ScrollView` for long lists (use `FlatList`)
- Fetch inside `useEffect` without proper cleanup
- Hardcoded API URLs (use environment config)
- `Platform.OS === 'ios' ? ... : ...` scattered everywhere (centralise platform logic)
- Ignoring keyboard avoiding on forms (always wrap with `KeyboardAvoidingView`)
- Not handling app state changes (background/foreground for session refresh)

---

## Mobile Development Rules

These are NON-NEGOTIABLE rules for the `packages/mobile` codebase. They turn the anti-pattern list above into positive guardrails. Added 2026-05-16 alongside WI-053 hardening.

1. **Always use `expo-secure-store` for tokens.** Never `AsyncStorage`. Encrypted at rest via Keychain (iOS) / Keystore (Android). Reference: [packages/mobile/src/lib/api.ts:13](packages/mobile/src/lib/api.ts:13).
2. **Every screen must handle loading, error, and empty states.** Use `EmptyState` from [components/ui/](packages/mobile/src/components/ui/). A spinner-then-blank-screen is not acceptable — the user must always know which of (loading / error / empty / data) state they're in.
3. **All API calls go through `useApiQuery` or `useApiMutation`** ([hooks/useApi.ts](packages/mobile/src/hooks/useApi.ts)). Never raw `fetch()` or raw `axios`. The hooks ensure JWT injection, distributor header, error normalisation, and TanStack Query cache integration.
4. **Test offline scenarios for every driver-facing screen.** The driver works in low-coverage areas; the app must enqueue writes and auto-sync on reconnect. Reference implementation: [services/deliveryQueue.ts](packages/mobile/src/services/deliveryQueue.ts) + the NetInfo listener in [(driver)/_layout.tsx](packages/mobile/app/(driver)/_layout.tsx).
5. **`EXPO_PUBLIC_API_URL` must use the laptop's LAN IP for phone testing** — never `localhost`. Phones can't reach `localhost` on your laptop. The API binds `0.0.0.0` in dev so this works automatically (see [packages/api/src/server.ts](packages/api/src/server.ts)). Setup walkthrough in [docs/MANUAL-TESTING-GUIDE.md SESSION 9](docs/MANUAL-TESTING-GUIDE.md).
6. **Rate limiting on auth endpoints must be verified before any pilot with real users.** Login, refresh, forgot-password, and verify-reset-otp are all rate-limited as of WI-053 (commit on this branch). Don't ship without confirming the limiter actually fires (manual check: 11 rapid login attempts → 11th returns 429).
