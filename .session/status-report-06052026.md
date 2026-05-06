# Status Report — Re-New GasLink

**Generated:** 2026-05-06
**Branch:** `claude/peaceful-bartik-21e3d2` (worktree of `master` @ `85a6eda`)
**Working tree:** modified `CLAUDE.md`; untracked `.session/`, `ARCHITECTURE.md`, `gap-report.md` (all from `/onboard`, uncommitted)

---

## 1. Gap-report questions — re-answered against the codebase

### Q1 — Migration policy
**ANSWERED (partially) — needs human confirmation on intent.**
- `.github/workflows/ci.yml` runs `pnpm --filter @gaslink/api run db:migrate` for the test job and `db:migrate:prod` on staging/production EC2 deploys → CI is built around **incremental migrations**, not `prisma db push`.
- However, only one migration exists on disk (`packages/api/prisma/migrations/20260323000000_init/migration.sql`, 1254 lines). The single huge file strongly suggests a `prisma migrate reset` happened at baseline.
- `.github/workflows/e2e-monitor.yml` uses `prisma db push --skip-generate` against an ephemeral DB — that's fine for E2E, but means E2E doesn't validate migrations.
- **NEEDS HUMAN:** Was the reset deliberate at baseline, and is the going-forward rule "every schema change = a new incremental migration on dev/staging/prod"?

### Q2 — `requireDistributor` exemptions
**ANSWERED — see §4 below for full analysis.** All three routes deliberately handle cross-tenant access in the handler. The pattern works but is inconsistent with the rest of the codebase (uses query string instead of `X-Distributor-Id` header in places).

### Q3 — Web/mobile test policy
**NEEDS HUMAN.** Vitest is configured for `packages/web` and Jest for `packages/mobile`, but:
- `packages/web/src/__tests__/` directory does not exist as a populated suite (only smoke).
- Mobile has `packages/mobile/src/__tests__/` but coverage is unverified.
- `docs/TESTING_PROGRESS.md` Phase 3 is "Mobile Testing (Expo Go) — manual" — implying the mobile strategy is manual E2E.
- No CI step runs web or mobile tests separately — `pnpm run test` is wired but coverage policy isn't documented.

### Q4 — CI workflows
**ANSWERED.**
- `ci.yml`: 6 jobs — `lint-and-typecheck` → `test` (postgres service, runs migrate/seed/test) → `build` (uploads `web-dist` artifact) → `deploy-staging` (S3 sync + CloudFront invalidation + SSH-pull-and-pm2-restart on EC2) → `deploy-production` (same pattern) → `backup` (pg_dump → S3).
- `e2e-monitor.yml`: scheduled cron at 21:00 UTC daily (02:30 IST), spins up Postgres + API, runs `packages/api/scripts/e2e-monitor.ts`, emails results via SMTP, creates a GitHub issue with `bug, monitoring` labels on failure.
- **Critical finding:** Both workflows trigger on `main`/`develop`. **The repo's default branch is `master`.** CI is therefore **not running on commits to master**. This is a real production blocker.
- **Critical finding:** `e2e-monitor.yml` sets `JWT_SECRET` (line 53) instead of `JWT_ACCESS_SECRET`. The app reads `JWT_ACCESS_SECRET` ([config/index.ts:14](packages/api/src/config/index.ts:14)). Only saved by `NODE_ENV=test` not triggering `validateEnv` strict checks — but the API in that workflow is running with the dev fallback secret.

### Q5 — Production hosting
**ANSWERED.** Per `ci.yml` deploy steps:
- **Backend:** EC2 (SSH + git pull + `pnpm install` + `db:migrate:prod` + `pm2 restart`), region ap-south-1. Path on host: `/opt/gaslink`.
- **Frontend:** S3 + CloudFront (separate buckets/distributions for staging vs production via repo variables).
- **Backups:** `scripts/backup.sh` invoked on production EC2, pg_dump uploaded to S3 backup bucket.
- (Update `ARCHITECTURE.md §12` to reflect this — currently says NEEDS_HUMAN_INPUT.)

### Q6 — i18n branch
**NEEDS HUMAN.** No technical signal in the codebase about who owns `claude/sharp-grothendieck` or when it merges.

---

## 2. CLAUDE.md and ARCHITECTURE.md accuracy check

**CLAUDE.md** — accurate as of right now. Spot-check:
- Auth chain `authenticate → resolveDistributor → requireDistributor` matches `app.ts:84-101` ✅
- Anti-pattern #3 names exactly the three routes that skip `requireDistributor` ✅
- Anti-pattern #5 refers to commit `7f2758f` — exists in `git log` ✅
- Anti-pattern #4 refers to `config/index.ts:14` — that's the JWT default fallback line ✅
- Naming conventions (snake_case columns + camelCase TS via `@map`) match `schema.prisma` ✅

**ARCHITECTURE.md** — mostly accurate, with three corrections needed:
- §11 says "94/94 passing as of 2026-04-07" — confirmed via `TESTING_PROGRESS.md` ✅
- §12 marks "Production hosting" as NEEDS_HUMAN — **now answered** by `ci.yml` (EC2 + S3 + CloudFront, ap-south-1, pm2). Update.
- §6 says 45 models — `grep "^model"` returns 45 ✅
- §1 says monorepo has 3 packages — actual count is **4** (`packages/shared` exists). Already mentioned in the body of §1, but the headline understates it. Minor.
- §11 says "scripts/" contains the e2e monitor — actually `packages/api/scripts/e2e-monitor.ts` is the live one; the root `scripts/e2e_test.js` is something different (older). Worth a note.

---

## 3. Work items
`.session/tracking/work_items.json` is `{"items":[]}` — **empty**. None of the 7 suggested items in `gap-report.md` have been formalised yet.

---

## 4. Routes that skip `requireDistributor` — security analysis

All three routes mount `authenticate → resolveDistributor → <router>` (no `requireDistributor`). Each handler defends differently.

### `/api/users` ([routes/users.ts](packages/api/src/routes/users.ts))
- `GET /profile` — reads from JWT `userId` only. ✅ safe.
- `GET /` (list users) — gated `super_admin | distributor_admin`. Calls `userService.listUsers(req.user.distributorId, req.user.role)` which does:
  ```ts
  if (role !== 'super_admin' && distributorId) where.distributorId = distributorId;
  ```
  super_admin sees all users globally (intended). distributor_admin sees their tenant. ✅ safe.
- `GET /:id` — fetches by id, then `if (req.user.role !== 'super_admin' && user.distributorId !== req.user.distributorId) return 404`. Returns 404 (not 403) to avoid leaking existence. ✅ safe.
- `POST /` — distributor_admin's body is forced to their own `distributorId`. super_admin must have a distributor selected to create distributor-scoped roles. ✅ safe.
- `PUT /:id`, `DELETE /:id` — same ownership re-check pattern as `GET /:id`. ✅ safe.
- **Verdict:** isolation is correct but every handler open-codes `if role !== super_admin && existing.distributorId !== req.user.distributorId`. Each new endpoint is a chance to forget the check.

### `/api/billing` ([routes/billing.ts](packages/api/src/routes/billing.ts))
- `GET /cycles` — `req.user.role === 'super_admin' ? req.query.distributorId : req.user.distributorId`. **The super_admin path trusts a query-string parameter, not the `X-Distributor-Id` header.** This breaks the rule documented in `CLAUDE.md` ("Never trust `distributorId` from request body or query params"). It's only "safe" because `requireRole('super_admin')` isn't on this endpoint — wait, it isn't gated by role at all → a non-super_admin still ends up using JWT `distributorId` (line 18 falls through). So functionally OK, but the precedent is bad.
- `GET /cycles/:id` — fetches, then ownership check `if (role !== super_admin && cycle.distributorId !== req.user.distributorId)`. ✅ safe.
- `POST /generate`, `PUT /cycles/:id/mark-paid`, `POST /suspend/:distributorId`, `POST /unsuspend/:distributorId`, `POST /check-expiry`, `POST /mark-overdue` — all gated `requireRole('super_admin')`. ✅ safe.
- **Verdict:** functionally safe, but the `req.query.distributorId` pattern for super_admin (instead of the header) is **inconsistent** and trains future code to do the wrong thing. Worth tightening.

### `/api/pricing` ([routes/pricing.ts](packages/api/src/routes/pricing.ts))
- `GET /seat-limits`, `GET /gst-usage`, `GET /gst-usage/history`, `GET /seat-requests` — all use the same `req.user.role === 'super_admin' ? req.query.distributorId : req.user.distributorId` pattern. Same critique as billing.
- `GET /tiers`, `GET /gst-usage/all`, `PUT /seat-requests/:id/approve|reject`, `GET /billing-invoice/:cycleId` — all `requireRole('super_admin')`. ✅ safe.
- `POST /seat-requests` — uses `req.user.distributorId!` (non-null assertion). **If a super_admin without a selected distributor hits this, `distributorId` is `null` and the create will throw at the DB layer with a NOT NULL violation, not a clean 400.** Minor robustness bug, not a security bug.
- **Verdict:** same pattern as billing — functionally safe but the query-string trust for super_admin is the wrong pattern.

### Overall
- **Tenant data is not leaking from these routes today.** Distributor_admin and below cannot bypass their `req.user.distributorId`. Super_admin is intentionally cross-tenant.
- **The risk is regression.** Every new handler in these three files has to remember the `if (role !== super_admin && row.distributorId !== req.user.distributorId)` guard. There's no middleware enforcing it. One missed line = a tenant leak.
- **Bad precedent to clean up:** super_admin reading `req.query.distributorId` instead of the validated `X-Distributor-Id` header. Switch to header everywhere; delete the query-param fallback.

---

## 5. Super-admin elevation via `X-Distributor-Id` — safety review

Code: [middleware/auth.ts:97-119](packages/api/src/middleware/auth.ts:97).

### What it does
1. If `req.user.role === 'super_admin'`: read `X-Distributor-Id` header; if present, validate against `/^[a-zA-Z0-9_-]{1,128}$/`; if regex passes, `req.user.distributorId = headerDistributorId`. If header absent, `distributorId` stays `null`.
2. If non-super_admin: no header read; if their JWT has no `distributorId`, return 403.

### Strengths
- Header is validated against a strict regex before being assigned — rejects SQL/control-char injection attempts.
- JWT `distributorId` is the floor for non-super_admin; they cannot elevate by sending a header.
- `requireDistributor` afterwards rejects `null` distributorId for routes that need a tenant.
- Format validation length capped at 128, narrower than UUID norms but covers seed IDs (`dist-001`).

### Weaknesses / risks
1. **Existence not verified.** Regex says it *looks like* a valid ID; it doesn't check the distributor row actually exists or is `status=active` or non-soft-deleted. A super_admin sending `dist-fake-9999` will pass middleware, then queries return empty results. Not a leak — but no signal that the tenant context is real. Worth a `prisma.distributor.findFirst({ where: { id, status: 'active', deletedAt: null }})` in `resolveDistributor`.
2. **No audit log of tenant switches.** A super_admin can hop between tenants every request and there's no record. For a SaaS, the support/forensics value of an audit trail here is high.
3. **`distributorId` mutates the JWT payload object.** Line 111: `req.user.distributorId = headerDistributorId` rewrites the per-request `req.user`. That's fine (it's a per-request copy), but if any downstream service caches `req.user` outside the request (it doesn't appear to), it would be unsafe.
4. **Routes that skip `requireDistributor` (see §4) inherit the risk** that super_admin's `distributorId` may be `null` and a handler may use `req.user.distributorId!` (non-null assertion) — pricing line 96 (`POST /seat-requests`) and a few others fit that pattern.
5. **No CSRF on the header.** Auth is JWT-bearer, so CSRF is generally not the threat model — but if a refresh-token cookie path ever lands, the header would need protection.

### Verdict
**Mechanism is fundamentally sound** for the current threat model: validated input, JWT-grounded role check, can't be elevated by non-admins. The two recommended hardening items are (a) verify the distributor exists/is active inside the middleware, and (b) emit an audit log entry when a super_admin tenant-switches. Neither is a launch blocker.

---

## 6. What is genuinely blocking production launch

Ordered by severity (everything visible in the codebase right now).

### P0 — Hard blockers
1. **CI is not running on master.** `ci.yml` triggers on `main`/`develop`; repo default branch is `master`. Every commit on master since `8c14039` ships untested. Either rename master → main, or change the workflow triggers. (`e2e-monitor.yml` is on cron, so it does run — but on whatever it pulls.)
2. **Manual E2E suite barely started.** `docs/TESTING_PROGRESS.md`: Phase 1 Navigation Smoke 0/55, Phase 2 E2E modules 0/204, Phase 3 Mobile 0. Only Phase 4 (API integration tests, 94/94) is done. You cannot launch a SaaS payment/billing system without getting through Phase 1 and a meaningful slice of Phase 2.
3. **Tenant-isolation audit not performed.** 339 Prisma read/write operations across 28 service files; convention-based isolation; the suggested WI-001 has not been done. One missed `where: { distributorId }` is a cross-tenant leak.

### P1 — Should-fix before launch
4. **Two known UI bugs pending** (`TESTING_PROGRESS.md` #4, #5):
   - #4 — Credit/Debit note buttons visible when `gstMode=DISABLED` on Bhargava (non-GST tenant); could let a user issue a CN with no IRN, which then can't be regulated.
   - #5 — Vehicle field surfaces in assign-driver modal where it shouldn't.
5. **`/api/billing` and `/api/pricing` super_admin path trusts `req.query.distributorId`.** Functional, but inconsistent with the documented "header only" rule and trains future regressions.
6. **`e2e-monitor.yml` env var name mismatch** — sets `JWT_SECRET`, app reads `JWT_ACCESS_SECRET`. The E2E runs are using the dev fallback secret silently.
7. **GST live mode never been tested.** API tests cover sandbox only (`TESTING_PROGRESS.md:370`). Live IRN/EWB issuance against WhiteBooks production has zero verification.
8. **No tenant-existence check in `resolveDistributor`.** Super_admin can set the header to any well-formed string; queries silently return empty rather than failing fast.

### P2 — Should-fix soon, not blocking
9. **Default JWT secret fallbacks in `config/index.ts`.** Hardened in prod by `validateEnv`, but trivially shippable to dev/staging. Make it fail-fast everywhere.
10. **Single Prisma migration on disk.** Going forward, every schema change must add an incremental migration; reset on shared DBs is now off the table.
11. **Ad-hoc `test-*.ts` scripts at `packages/api/` root** — bit-rot, undocumented, and mix of legitimate verification (e.g. WhiteBooks) and abandoned attempts.
12. **No audit log for super_admin tenant switches.** Forensic gap.
13. **i18n branch (`claude/sharp-grothendieck`) is unmerged** — if Telugu support is launch-required, this is P0; if optional, this is P3. Founder call.
14. **`packages/api/.env.example` lists `PORT=5000`** but `CLAUDE.md` says API runs on 3000. Verify which is right.

### Not blockers but worth recording
- 4 packages, not 3 (`shared` is real and consumed everywhere).
- `e2e-monitor.yml` doesn't seed two distributors → can't catch tenant-isolation regressions itself.
- No web or mobile unit tests in CI — only API tests run in `pnpm run test` for CI's purposes.
- Sentry is wired in but no DSN env var documented in `.env.example`.

---

## TL;DR

- **6 gap-report questions**: 4 ANSWERED from the codebase (migration intent partial, requireDistributor exemptions, CI workflows, prod hosting), 2 NEEDS HUMAN (test policy, i18n).
- **CLAUDE.md** accurate. **ARCHITECTURE.md** has 3 minor corrections (production hosting now answerable; package count says 3 should say 4; e2e script path).
- **0 work items** tracked.
- **3 routes that skip `requireDistributor`** are functionally safe today but use a query-string fallback pattern that violates the project's own rules and invites regressions.
- **Super_admin elevation** is sound; two non-blocking hardening items (verify distributor exists; audit-log switches).
- **Top 3 launch blockers:** (1) CI not running on `master` branch; (2) manual E2E ~0% done outside Phase 4; (3) tenant-isolation audit never performed.
