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
pnpm dev:api        # API on port 3000
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
- Prisma schema: 46 models, 38 enums
- All routes scoped by distributorId from JWT middleware

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

