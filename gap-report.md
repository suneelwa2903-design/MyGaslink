# Gap Report — Re-New GasLink

**Generated:** 2026-05-04 by `/onboard`

---

## Open Questions — All Resolved

All six questions are now ANSWERED. Re-resolved 2026-05-06 (5 from codebase scan, 3 confirmed by founder).

1. **Migration policy.** ✅ ANSWERED (founder, 2026-05-06): Every schema change gets its own incremental Prisma migration. **No `prisma db push` on staging or production.** No resets on shared databases. The single existing migration (`20260323000000_init`) is the agreed-upon baseline; everything from here is incremental.
2. **`requireDistributor` exemptions.** ✅ ANSWERED (codebase, 2026-05-06): The three exempt routes (`/api/users`, `/api/billing`, `/api/pricing`) intentionally allow super_admin cross-tenant views. Each handler open-codes the `if (role !== super_admin && row.distributorId !== req.user.distributorId)` ownership check, so isolation is preserved today. Two follow-ups remain (tracked as work items): (a) `/api/billing` and `/api/pricing` use `req.query.distributorId` for super_admin instead of the validated `X-Distributor-Id` header — should be tightened; (b) the per-handler check is regression-prone. Documented in `.session/status-report-06052026.md §4`.
3. **Web/mobile test policy.** ✅ ANSWERED (founder, 2026-05-06): Pre-launch manual testing covers Phase 1 smoke (55 cases) and critical Phase 2 workflows. Post-launch: expand automated coverage.
4. **CI workflows.** ✅ ANSWERED (codebase, 2026-05-06): `ci.yml` runs lint→typecheck→test→build→deploy-staging(develop)→deploy-production(main)→backup. `e2e-monitor.yml` runs critical-path E2E daily at 02:30 IST, emails results, opens a GitHub issue on failure. Two bugs identified at the same time: workflow triggers on `main`/`develop` not `master`/`develop`, and `e2e-monitor.yml` line 53 sets `JWT_SECRET` instead of `JWT_ACCESS_SECRET`. Both fixed in this session.
5. **Production hosting.** ✅ ANSWERED (codebase, 2026-05-06): EC2 + pm2 for the backend (`/opt/gaslink`, deployed via SSH + git pull + `pnpm install` + `db:migrate:prod`); S3 + CloudFront for the frontend (separate buckets/distributions for staging vs production); region `ap-south-1`; pg_dump backups uploaded to S3 backup bucket on every production deploy. To be reflected in `ARCHITECTURE.md §12`.
6. **i18n branch.** ✅ ANSWERED (founder, 2026-05-06): Telugu support (branch `claude/sharp-grothendieck`) is REQUIRED for launch. Merge is **P0 before production deploy**.

---

## Anti-patterns Found

Listed in `CLAUDE.md` under "Anti-patterns Found". Summary:

1. Ad-hoc test scripts at `packages/api/` root (`test-debit-note.ts`, `test-distance.ts`, `test-e2e-v2.ts`, `test-e2e-v3.ts`, `test-e2e-v4.ts`, `test-e2e.ts`, `test-ewb.ts`, `test-production-gst.ts`, `test-whitebooks.ts`, `check-users.ts`) — not in the Vitest suite, undocumented.
2. Single Prisma migration — discipline gap going forward.
3. Three routes (`/api/users`, `/api/billing`, `/api/pricing`) skip `requireDistributor` — needs documented rationale.
4. JWT secrets have hardcoded fallbacks; only `validateEnv()` blocks them in production.
5. Historical bug pattern: download/export endpoints bypassing the shared axios client and dropping `X-Distributor-Id` (caught in TESTING_PROGRESS.md bug #3, fixed in 7f2758f).
6. Two pending bugs in `docs/TESTING_PROGRESS.md`: #4 credit-note button visible when `gstMode = DISABLED`, #5 vehicle field showing in assign-driver modal.

---

## Suggested First Work Items

In rough priority order — create with `/work-new` when ready.

1. **WI-001 — Tenant-isolation audit.** Grep every `prisma.<model>.findMany|findFirst|update|delete|count` in `packages/api/src/services/` and prove each one filters by `distributorId`. Convert findings into a checklist; fix any leaks. (P0, security.)
2. **WI-002 — Decide `requireDistributor` exemptions.** Review `/api/users`, `/api/billing`, `/api/pricing`. Either tighten (add `requireDistributor` and split super_admin endpoints) or document the cross-tenant contract per handler. (P1.)
3. **WI-003 — Clean up ad-hoc test scripts in `packages/api/`.** Migrate the still-useful ones into `src/__tests__/` (integration) or `scripts/` (one-off). Delete the rest. (P2.)
4. **WI-004 — Fix bug #4 (credit-note button on GST DISABLED).** Hide CN/DN buttons + endpoints when `distributor.gstMode === 'disabled'`. Add an integration test. (P1.)
5. **WI-005 — Fix bug #5 (vehicle field in assign-driver modal).** Remove the field from the form; assignments are driver-only at that step. (P2.)
6. **WI-006 — i18n merge plan.** Decide whether to merge `claude/sharp-grothendieck` to `master` now or defer; document the call. (P2.)
7. **WI-007 — Harden dev JWT secrets.** Make `validateEnv()` fail in dev too if `JWT_*_SECRET` is using the default fallback. (P2, low-effort.)

---

## What `/onboard` Created

- `ARCHITECTURE.md` — full system architecture, multi-tenancy model, API surface, integrations
- `CLAUDE.md` — extended with Code Conventions, Multi-tenant Rules, Anti-patterns sections (existing testing protocol kept intact at top)
- `.session/` — initialised with `tracking/work_items.json`, `learnings/learnings.md`, `specs/_templates/spec.md`, `config.json`
- `gap-report.md` — this file

---

**Next step:** Fill in the answers above, then run `/work-new` to create your first work item.
