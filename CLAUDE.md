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
