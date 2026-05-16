# Re-New GasLink — Project Handoff

> Drop this entire document into a fresh Claude session and you have full context to keep working. Updated 2026-05-16.

---

## What This Project Is

Re-New GasLink (consumer brand: **MyGasLink**) is a multi-tenant SaaS for LPG (cooking-gas cylinder) distribution. One **Distributor** = one tenant. Customers order → driver delivers → invoice → payment → optional credit/debit note. GST e-invoice (IRN) and e-waybill (EWB) are generated pre-dispatch via the WhiteBooks GSP for tenants in `sandbox` or `live` mode.

**Stack:**
- **Backend:** Express 5 + TypeScript + Prisma 6 + PostgreSQL 17
- **Web:** React 19 + Vite + Tailwind + Zustand + TanStack Query
- **Mobile:** Expo SDK 54 + RN 0.81 + expo-router 6 + Zustand + TanStack Query
- **Monorepo:** pnpm workspaces, packages = `api` / `web` / `mobile` / `shared`

Read [ARCHITECTURE.md](../ARCHITECTURE.md) once for full system design (23 sections, current as of 2026-05-16).

---

## Current State

**Date:** 2026-05-16
**Master SHA:** `301aede` (this branch: `claude/vigorous-ardinghelli-7d9e65`, will be merged to master at end of session)
**API tests:** **347/347 passing** (Vitest, integration suite against shared dev Postgres)
**Servers:** API on `:5000` (binds `0.0.0.0` in dev so phones on the LAN can reach it; `127.0.0.1` in prod), Web on `:5173`, Postgres in Docker on `:5433` → container `:5432`

---

## Two Distributors (Seeded)

| ID | Business Name | OMC | GST Mode | Notes |
|---|---|---|---|---|
| `dist-001` | Bhargava Gas Agency | IOCL | `disabled` | Most "happy-path" tests run here. |
| `dist-002` | Sharma Gas Distributors | HPCL | `sandbox` | The only tenant where the WhiteBooks IRN/EWB pipeline actually fires. |

---

## All Credentials

| Role | Email | Password | Distributor |
|------|-------|----------|-------------|
| Super Admin | `admin@mygaslink.com` | `Admin@123` | All (platform-level) |
| Dist Admin (GST OFF) | `bhargava@gasagency.com` | `Distadmin@123` | Bhargava Gas Agency |
| Dist Admin (GST ON) | `sharma@gasdist.com` | `Gstadmin@123` | Sharma Gas Distributors |
| Finance | `finance@gasagency.com` | `Finance@123` | Bhargava Gas Agency |
| Inventory | `inventory@gasagency.com` | `Inventory@123` | Bhargava Gas Agency |
| Driver | `raju@gasagency.com` | `Driver@123` | Bhargava Gas Agency |
| Customer | `royal@kitchen.com` | `Customer@123` | Bhargava Gas Agency (Royal Kitchen Restaurant) |

---

## Work Items Status

51 items total in [.session/tracking/work_items.json](../.session/tracking/work_items.json):
- **Done:** 39 (WI-001 through WI-044, plus WI-052 added 2026-05-16)
- **Pending:** 10 (WI-007, WI-023, WI-024, WI-045 → WI-051)
- **In progress:** 2 (WI-008 i18n, WI-053 mobile security hardening)
- **blocksLaunch=true:** 19

**New this session (WI-045 → WI-053, 2026-05-16):**
- WI-045 Driver mobile smoke (P0, blocks launch)
- WI-046 Distributor Admin mobile smoke + finance PDF TODO fix (P0, blocks launch)
- WI-047 Inventory mobile smoke (P0, blocks launch)
- WI-048 Customer mobile smoke (P0, blocks launch)
- WI-049 Finance mobile smoke (P1)
- WI-050 Super Admin mobile smoke (P2)
- WI-051 Mobile role guards on layout files (P1)
- WI-052 Mobile setup docs + .env wiring (**done this session**)
- WI-053 Mobile security hardening pre-pilot (in progress, P0; rate-limit + binding done, SSL pinning pending)

---

## Web Testing Status

(See [docs/TESTING_PROGRESS.md](TESTING_PROGRESS.md) for the live tracker.)

| Phase | Status |
|---|---|
| Phase 1 — Super Admin | ✅ complete |
| Phase 2 — Distributor Admin | 🟡 partial: 2.1–2.8 done, 2.9–2.16 pending (need WhiteBooks sandbox up) |
| Phase 3 — Finance | 🔲 not started |
| Phase 4 — Inventory | 🔲 not started |
| Phase 5 — Driver (mobile) | 🔲 not started — needs WI-052 (done) → WI-045 |
| Phase 6 — Customer Portal | 🔲 not started |
| Phase 7 — Tenant Isolation | 🔲 not started |

---

## Mobile Testing Status

**Not started.** Setup is documented at [docs/MANUAL-TESTING-GUIDE.md](MANUAL-TESTING-GUIDE.md) **SESSION 9** (one-time setup). Per-role smoke sessions: **SESSION 10** (admin), **SESSION 11** (customer), **SESSION 12** (inventory), **SESSION 13** (finance). Driver flow lives in **SESSION 9** (since the setup itself logs in as driver).

Mobile is more built-out than the original architecture sketch suggested — see [ARCHITECTURE.md §20–§22](../ARCHITECTURE.md). Rough completeness: Driver 95%, Admin 85%, Inventory/Customer/Finance 80%, Super Admin 75%. All six roles have functional screens and consume the same API as the web.

---

## GST / WhiteBooks Status

- **Sandbox:** intermittently working. Last successful IRN: 2026-05-15 ~10:19 IST.
- **Known issue:** NIC sandbox enforces a daily quota; once hit, the only fix is to wait until the next morning IST.
- **Credentials (Sharma, in DB):**
  - e-Invoice scope: `EINSc0e87f75…`
  - e-Way Bill scope: `EWBSa82587b9…`
  - Notification email: `mvsuneelkumar2903@gmail.com`
- **Production:** **never tested** — WI-007 is the gating action for the founder. First production IRN is the moment of truth.

End-to-end pipeline (built across WI-035 → WI-043, summarised in ARCHITECTURE §15):

```
order assigned → preflight-dispatch (IRN B2B / EWB B2C) → trip sheet PDF
   → driver delivers → confirm-delivery → if qty mismatch + IRN live → reissue
```

---

## Key Technical Decisions Made

These are choices that look obvious in hindsight but cost real time to land. Don't second-guess them without a fresh sandbox verification.

1. **IRN first, then a separate EWB call.** Never inline `EwbDtls` in the IRN payload — the inline path was broken on this WhiteBooks sandbox and silently consumed two hours on 2026-05-15. (Anti-pattern #10.)
2. **Per-order partial dispatch**, not all-or-nothing. Succeeded orders ship; failed ones get a `PendingAction` and the driver leaves anyway with the rest. (WI-035 Q1 founder directive.)
3. **`TransDistance = "0"`** so NIC auto-calculates from PIN codes. Manually computed distances were rejected.
4. **EWB always generated** for every dispatched order — no ₹50K threshold. Every truck on the road must carry a compliance doc. (WI-035 amendment 2026-05-15.)
5. **Finance creates CN/DN, admin approves.** Approval fires the IRN call in the background.
6. **Inventory role can create orders and dispatch.** Founder spec — dispatch is an inventory-floor task, not an admin-desk one.

---

## Anti-Patterns (12 total in CLAUDE.md)

Read all of them before any code change. The high-frequency ones to memorise:

- **#6** — Always validate external-API payload shape next to the logic test (no DB, no HTTP). Mocks lie.
- **#7** — Use `TEST_DATE = '2099-12-31'` for any time-sensitive test fixture on the shared dev DB. Today's-date fixtures contaminate real rows.
- **#8** — Test cleanup must match the broader query scope the service used, not just the fixture IDs.
- **#10** — Test every new external-API path against the live sandbox before marking the WI done. Mock pass ≠ feature works.
- **#11** — Persist BOTH success and failure API calls with the full outgoing payload. Don't trust upstream providers to echo the failing field.
- **#12** — Multi-step external-API flow: track per-commit `*Persisted` flags so an EWB sub-step error doesn't roll back a committed IRN status.

---

## ADLC Files Location

| File | Purpose |
|---|---|
| [CLAUDE.md](../CLAUDE.md) | Anti-patterns + rules + mobile development rules. **Re-read at every session start.** |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | 23 sections, full system design. Read once per major task. |
| [docs/MANUAL-TESTING-GUIDE.md](MANUAL-TESTING-GUIDE.md) | 60 manual tests across 13 sessions (web + mobile). |
| [docs/TESTING_PROGRESS.md](TESTING_PROGRESS.md) | Live test pass/fail tracker — update + commit per session. |
| [.session/tracking/work_items.json](../.session/tracking/work_items.json) | All 51 work items with status. |
| [.session/](../.session/) | Session summaries per work-item batch (e.g. `session-summary-WI-035.md`). |

---

## What To Do Next (priority order)

1. **WI-045 — Driver mobile smoke** (P0, blocks launch). Setup is now one-shot via SESSION 9 of the testing guide. Driver flow is the most polished — expect minor bugs only.
2. **WI-007 — Production WhiteBooks verification** (P0, blocks launch). Founder action: first real-world IRN issuance + cancellation + EWB cycle on the production GSP credentials. No code change.
3. **Complete web Phase 2 (tests 2.9 → 2.16)** — needs WhiteBooks sandbox up.
4. **WI-046 / WI-047 / WI-048 — Admin / Inventory / Customer mobile smoke** (P0, all block launch). Run after WI-045 is clean.
5. **Web Phase 3 → 7** — Finance, Inventory, Driver (web), Customer Portal, Tenant Isolation.
6. **WI-053 — Finalise mobile security hardening**. Rate-limit done, binding done, SSL pinning still pending (needs prod cert chain).
7. **WI-049 / WI-050** — Finance + Super Admin mobile smoke (P1 / P2, lower urgency).

---

## Known Issues / Gotchas

1. **WhiteBooks NIC sandbox** hits its daily IRN quota — retry next morning IST.
2. **API server process dies if its bash session ends** in dev. Run `pnpm dev:api` in a session you'll keep open, or use `nohup` / a persistent terminal.
3. **After `pnpm test`, the dev DB stays seeded but with `today`-date fixtures rotated to whatever date the seed last ran.** If workflow / assignment tests fail with 400s on a stale dev DB, the fix is usually to re-seed (idempotent) and ensure today's `driver_vehicle_assignments` rows exist for both seeded distributors. The shared dev DB is a known footgun (anti-patterns #7 and #8).
4. **Phone testing requires LAN IP**, not `localhost`. The mobile app's `EXPO_PUBLIC_API_URL` must be your laptop's Wi-Fi IPv4. The API now binds `0.0.0.0` in dev automatically.
5. **Token storage on mobile is `expo-secure-store` only** — never AsyncStorage. CLAUDE.md mobile rules + WI-053.

---

## How To Start A New Session

1. **Re-read context** (per CLAUDE.md mandatory steps):
   ```powershell
   # In your editor:
   #   1. Read docs/TESTING_PROGRESS.md
   #   2. git log --oneline -5
   #   3. git status --short
   ```
2. **Health-check the servers:**
   ```powershell
   curl http://localhost:5000/api/health
   ```
3. **If API/Web are down, restart:**
   ```powershell
   # In one terminal:
   pnpm --filter @gaslink/api dev
   # In another:
   pnpm --filter @gaslink/web dev
   ```
4. **Verify suite is green** (sanity check before any code change):
   ```powershell
   pnpm --filter @gaslink/api test
   # Expect: 347 passed (347)
   ```
5. **Read CLAUDE.md** before any code change. The 12 anti-patterns are not optional — they're hard-won lessons.
6. **For mobile work**, additionally verify SESSION 9 of [docs/MANUAL-TESTING-GUIDE.md](MANUAL-TESTING-GUIDE.md) prerequisites are met (LAN IP set in `packages/mobile/.env.local`).

---

## Trip-Wires (read before doing anything destructive)

- **Never `prisma migrate reset`** on a shared dev DB. Prisma's CLI now refuses by default; don't bypass.
- **Never push hooks-bypassed commits.** No `--no-verify`, no `--no-gpg-sign`. If a hook fails, fix the underlying issue.
- **Never call `res.json` directly** in API routes — use the [apiResponse.ts](../packages/api/src/utils/apiResponse.ts) helpers. Direct `res.json` skips the standard envelope and breaks every typed web client downstream.
- **Never `console.log` in API code** — use Winston via [utils/logger.ts](../packages/api/src/utils/logger.ts). Same for web after WI-011.
- **Never store mobile auth tokens in AsyncStorage** — `expo-secure-store` only.
- **Never trust `distributorId` from request body or query params.** Always read from `req.user.distributorId` (JWT) or the validated `X-Distributor-Id` header (super_admin only).
