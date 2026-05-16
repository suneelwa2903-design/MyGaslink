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

**Status:** Code ~90% built. Testing phase started 2026-03-28. Target: production launch.

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
