# Local Dev Startup Guide

How to get the full Re-New GasLink stack running on a fresh laptop and get back to work each morning.

---

## Section 1 — Prerequisites

Install once per machine:

| Tool | Version | Why |
|------|---------|-----|
| Node.js | `>= 20.0.0` (Node 24 works) | Runs the API + bundles the web app + Expo |
| pnpm | `>= 9.0.0` (locked at `9.15.0` via `packageManager`) | Workspace + lockfile manager |
| Docker Desktop | latest | Hosts local Postgres on port 5433 |
| Git | latest | Versioning |
| (mobile) Expo Go on a phone | latest | Runs the React Native app without a build |

Verify:
```bash
node --version    # v20+ (or v24)
pnpm --version    # 9.15.0
docker --version  # Docker version 24+
git --version
```

If `pnpm` is missing: `npm install -g pnpm@9.15.0`.

---

## Section 2 — First-time setup

Run these in order, from the repo root.

```bash
# 1. Install all workspace deps (api + web + mobile + shared)
pnpm install

# 2. Copy env example files for each package
cp packages/api/.env.example   packages/api/.env
cp packages/web/.env.example   packages/web/.env       # only if you need to override defaults
cp packages/mobile/.env.example packages/mobile/.env   # only if you need to override defaults

# 3. Start Postgres (Docker container 'gaslink-db' on port 5433)
pnpm docker:up

# 4. Wait ~5s for the container to become healthy, then:
#    Generate the Prisma client + apply migrations
pnpm db:generate
pnpm db:migrate          # runs all pending migrations
#    On Windows PowerShell, if migrate fails with "advisory lock timeout"
#    kill stale connections first:
#    docker exec gaslink-db psql -U gaslink -d gaslink -c \
#      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
#       WHERE state IS NOT NULL AND pid != pg_backend_pid() AND datname='gaslink';"

# 5. Seed test data (creates all the users in Section 5 below)
pnpm db:seed

# 6. Build the shared package once so api/web/mobile can resolve it
pnpm --filter @gaslink/shared build

# 7. Start everything
pnpm dev          # runs API (5000) + web (5173) in parallel
```

The first run takes ~3 minutes (mostly downloading Prisma's query engine and building the shared types). Subsequent runs are seconds.

---

## Section 3 — Daily startup

Three commands and you're back to work:

```bash
pnpm docker:up                     # ensure Postgres is up
pnpm --filter @gaslink/shared build # rebuild shared types (skip if untouched)
pnpm dev                           # API + web together
```

If your container died overnight: `pnpm docker:reset` rebuilds it but **wipes the DB**. Re-seed with `pnpm db:seed` afterwards.

---

## Section 4 — Access URLs

| Service | URL | Notes |
|---------|-----|-------|
| Web app | http://localhost:5173 | Vite dev server, HMR enabled |
| API | http://localhost:5000 | Express + tsx watch |
| API docs (Swagger) | http://localhost:5000/api-docs | Super-admin login required |
| Prisma Studio | run `pnpm db:studio` | Opens at http://localhost:5555 |
| Postgres | localhost:5433 | user `gaslink`, password `gaslink_dev`, db `gaslink` |

The web Vite server proxies `/api/*` to `http://localhost:5000`, so the browser sees same-origin requests.

---

## Section 5 — Test login credentials

All seeded by `packages/api/prisma/seed.ts`. Two distributors exist:

- **Bhargava Gas Agency** — GST mode `disabled`. Use this for everyday workflow testing.
- **Sharma Gas Distributors** — GST mode `sandbox` (talks to WhiteBooks sandbox). Use this for GST flows.

| Role | Email | Password | Distributor |
|------|-------|----------|-------------|
| Super Admin (platform) | `admin@mygaslink.com` | `Admin@123` | none — sees all tenants |
| Distributor Admin | `bhargava@gasagency.com` | `Distadmin@123` | Bhargava (GST OFF) |
| Distributor Admin (GST) | `sharma@gasdist.com` | `Gstadmin@123` | Sharma (GST SANDBOX) |
| Finance | `finance@gasagency.com` | `Finance@123` | Bhargava |
| Inventory | `inventory@gasagency.com` | `Inventory@123` | Bhargava |
| Driver | `raju@gasagency.com` | `Driver@123` | Bhargava |
| Customer (portal) | `royal@kitchen.com` | `Customer@123` | Bhargava (linked to "Royal Kitchen Restaurant") |

The seed also creates 4 customers under Bhargava (Royal Kitchen, Spice Garden, Metropolis Industries, Green Valley Caterers), 4 cylinder types (5 KG, 19 KG, 47.5 KG, 425 KG), drivers, vehicles, opening stock, and a few sample orders so the dashboards aren't empty on first login.

---

## Section 6 — Mobile (Expo Go)

The mobile app runs through Expo Go on a phone — no native build needed for development.

### Start the bundler

```bash
pnpm dev:mobile                     # equivalent to: pnpm --filter @gaslink/mobile start
# A QR code appears in the terminal.
```

### Connect your phone

1. Install **Expo Go** from Play Store / App Store.
2. Phone and laptop must be on the **same Wi-Fi network**.
3. Open Expo Go → **Scan QR code** from the terminal (Android) or scan with the camera app (iOS).

### Point Expo at your laptop's API

The phone can't reach `localhost` — that means the phone itself. It needs your laptop's LAN IP.

**Find your LAN IP:**
```bash
# Windows
ipconfig                            # look for "IPv4 Address" under your active adapter
# macOS / Linux
ifconfig | grep "inet "             # find a 192.168.x.x or 10.x.x.x address
```

**Set it for Expo:**
```bash
# Create / edit packages/mobile/.env
echo 'EXPO_PUBLIC_API_URL=http://192.168.1.42:5000/api' > packages/mobile/.env
#     ^^ replace with YOUR laptop's LAN IP
```

Then restart `pnpm dev:mobile` so the new env var is picked up.

### CORS

The API's `CORS_ORIGINS` (in `packages/api/.env`) defaults to `http://localhost:5173,http://localhost:8081`. Expo Go itself doesn't send a browser-style Origin header, so you usually don't need to change this. If you hit a CORS error from Expo Go's proxy, append the LAN IP:

```bash
CORS_ORIGINS="http://localhost:5173,http://localhost:8081,http://192.168.1.42:8081"
```

### Driver / role for testing

Use `raju@gasagency.com` / `Driver@123`. The mobile app routes drivers to `(driver)/orders` where the new offline delivery queue can be exercised by toggling Wi-Fi.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `vitest: not found` after fresh clone | run `pnpm install` |
| Tests fail with `column users.X does not exist` | DB schema drifted — run `pnpm exec prisma db push` from `packages/api/` to force-sync, then re-seed |
| `Environment variable not found: DATABASE_URL` during `pnpm db:seed` | the seed script reads `process.env.DATABASE_URL` directly. Run it with the env inline: `cd packages/api && DATABASE_URL="postgresql://gaslink:gaslink_dev@localhost:5433/gaslink?schema=public" pnpm db:seed` |
| `prisma migrate` hangs on advisory lock | another worktree or another `tsx watch` has a connection — kill them (see Section 2 step 4) |
| Port 5000 already in use | `lsof -i:5000` (mac) / `netstat -ano | findstr :5000` (Windows), kill the process or change `PORT=` in `packages/api/.env` |
| Web shows blank page | check the browser console — most often a missing locale key or a mismatched `@gaslink/shared` build. Run `pnpm --filter @gaslink/shared build` and restart `pnpm dev:web` |
