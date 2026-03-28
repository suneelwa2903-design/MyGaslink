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
