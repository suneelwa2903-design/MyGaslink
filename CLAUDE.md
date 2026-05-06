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
