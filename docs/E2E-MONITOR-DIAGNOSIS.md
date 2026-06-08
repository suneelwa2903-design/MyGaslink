# E2E Production Monitor — Failure Diagnosis

*Date: 2026-06-08*
*Investigator: Claude Code (side-quest during SAA manual test pass)*
*Scope: read-only diagnosis. No code changes. Decision to fix-forward / disable / rewrite to be made by Suneel after reviewing findings.*

---

## TL;DR

**Root cause:** seed step crashes because `WHITEBOOKS_EINVOICE_CLIENT_ID` (+3 sibling vars) became required env vars on **2026-05-24** (commit `8edeeb3`, "WI-114 — move WhiteBooks seed credentials to env vars"), but the `.github/workflows/e2e-monitor.yml` workflow was never updated to provide them. Every scheduled run since has failed identically at the same line.

**Category:** **(c) credentials configuration issue.** Not stale test code, not a real production outage.

**Severity:** Low operational risk (workflow is misnamed — see Finding #4 — and doesn't actually monitor production), but high alert-fatigue cost: 13+ days of red Xs in CI history numbs the team to future real failures.

**Recommendation:** **fix-forward** with 4 GitHub Secrets + a 4-line env-block addition + a `permissions:` block. ~10 minutes of work. Separately, consider renaming the workflow because it does NOT monitor production despite the name.

---

## 1. What the workflow actually does

File: [.github/workflows/e2e-monitor.yml](.github/workflows/e2e-monitor.yml) — last modified at the initial repo commit (`8c14039`); never edited since.

Schedule: `0 21 * * *` (daily at 2:30 AM IST / 21:00 UTC previous day).

**Despite the name "E2E Production Monitor", this workflow does NOT touch production.** It:
1. Spins up Postgres 17-alpine as a service container on the GitHub Actions runner
2. Runs `prisma db push` + `tsx prisma/seed.ts` against that local DB
3. Starts the API server at `http://localhost:5000`
4. Runs `pnpm exec tsx scripts/e2e-monitor.ts` against `BASE_URL=http://localhost:5000/api`
5. Sends an email + creates a GitHub issue on failure

Net: it's a daily smoke-test of the dev DB + API + seed + the 530-line e2e-monitor script. **It does not hit `api.mygaslink.com` or any real production endpoint.** A genuine production outage would NOT be detected by this workflow.

The 530-line `scripts/e2e-monitor.ts` runs grouped assertions against the local API: login, fetch orders, response-time SLOs, etc. Standard test runner pattern.

## 2. The exact failure (from run `27138861675`, 2026-06-08)

The grep-filtered error from `gh run view --log`:

```
2026-06-08T12:52:28.8425600Z Error: WHITEBOOKS_EINVOICE_CLIENT_ID is required in packages/api/.env for seeding (see .env.example)
2026-06-08T12:52:28.8742989Z ##[error]Process completed with exit code 1.
```

This is the **seed step** crashing, not the e2e-monitor script. The seed step runs before the API even starts, so:
- No `packages/api/e2e-results.json` is written
- The "Build email body" step falls into the "monitor crashed before producing results" branch
- The "Create GitHub issue" step then ALSO fails with `Resource not accessible by integration` (secondary issue — see Finding #3)
- Final step exits 1 → red X

## 3. Timeline

| Date | Event |
|---|---|
| Initial commit | Workflow committed at `.github/workflows/e2e-monitor.yml`. Env block: only `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `NODE_ENV`, `PORT`. No WhiteBooks vars. |
| **2026-05-24 — commit `8edeeb3`** | "fix: WI-114 — move WhiteBooks seed credentials to env vars" — added `requireEnv('WHITEBOOKS_EINVOICE_CLIENT_ID')` and 3 siblings to `prisma/seed.ts:493-496`. Sound fix per anti-pattern #11 (don't commit credentials). |
| 2026-05-24 onwards | Every scheduled run begins to fail at the seed step. |
| 2026-05-27 (earliest in fetched batch) | First confirmed failure in the 20-run window. Failures likely started one day after `8edeeb3` landed. |
| 2026-05-27 → 2026-06-08 | **13 consecutive scheduled runs**, all failed identically. None investigated. |
| 2026-06-08 | Today's diagnostic side-quest. |

`git log --follow .github/workflows/e2e-monitor.yml` confirms the workflow itself has not been edited since the initial commit. The break is purely on the consumer side (the seed script gained a new requirement).

## 4. Three related issues uncovered

### Finding #1 — The seed-credentials gap (THE primary cause)

`packages/api/prisma/seed.ts:493-496` requires four env vars via `requireEnv()`:
- `WHITEBOOKS_EINVOICE_CLIENT_ID`
- `WHITEBOOKS_EINVOICE_CLIENT_SECRET`
- `WHITEBOOKS_EINVOICE_USERNAME`
- `WHITEBOOKS_EINVOICE_PASSWORD`

`.github/workflows/e2e-monitor.yml:51-57` env block doesn't include any of them. Hence `requireEnv` throws on first call. The companion `.env.example` documents the variable names but the workflow has no `secrets:` reference.

### Finding #2 — The workflow is misnamed and misleading

The display name "E2E Production Monitor" implies it monitors `api.mygaslink.com` for real outages. It doesn't — it monitors a freshly-spun-up local environment built from the same code that's in the repo. Same-commit smoke-test = same coverage as the CI workflow, just on a different schedule.

If you wanted a real production monitor, the URL `BASE_URL=http://localhost:5000/api` would need to become `BASE_URL=https://api.mygaslink.com/api`, the service container would be removed (no need for a local Postgres if hitting prod), and the seed step would be removed (you can't seed prod from CI).

Today, "Production Monitor" is just a daily CI run with a misleading name. **Even if Finding #1 is fixed, this workflow's value-add is limited.**

### Finding #3 — Secondary: workflow lacks `issues: write` permission

After the primary failure, the `Create GitHub issue on failure` step tries to file a GitHub issue and itself fails:
```
RequestError [HttpError]: Resource not accessible by integration
```
GitHub Actions defaults to `contents: read` only since 2023. To create issues, the workflow needs:
```yaml
permissions:
  contents: read
  issues: write
```
This is a separate gap. Even when the seed step starts succeeding, the issue-on-failure escalation will keep silently broken until this is added. The email notification path (via `dawidd6/action-send-mail`) is separate and not affected by this — it uses SMTP secrets, not GitHub permissions.

### Finding #4 — Workflow is also on a deprecated Node.js path

A warning from the most recent run:
```
Node.js 20 actions are deprecated. The following actions are running on Node.js 20 and may not work as expected: actions/checkout@v4, actions/github-script@v7, actions/setup-node@v4, actions/upload-artifact@v4. Actions will be forced to run with Node.js 24 by default starting June 16th, 2026.
```
2026-06-16 deadline. Not blocking; future-proofing. Either bump action versions to the Node.js 24 majors, or set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`.

## 5. Three options for resolution

### Option A — Fix-forward (recommended)

Lowest effort, restores the original intent.

1. **Add 4 GitHub Secrets** (Settings → Secrets and variables → Actions, or via `gh secret set`):
   - `WHITEBOOKS_EINVOICE_CLIENT_ID`
   - `WHITEBOOKS_EINVOICE_CLIENT_SECRET`
   - `WHITEBOOKS_EINVOICE_USERNAME`
   - `WHITEBOOKS_EINVOICE_PASSWORD`

   Values: the same WhiteBooks sandbox creds that live in your local `packages/api/.env` and on the EC2 production environment. Sandbox creds (`gstMode='sandbox'`) are non-destructive — they hit NIC's sandbox endpoints, no live e-invoices are generated.

2. **Add the 4 vars to `e2e-monitor.yml` env block** (~lines 51-57):
   ```yaml
   env:
     # ... existing vars ...
     WHITEBOOKS_EINVOICE_CLIENT_ID: ${{ secrets.WHITEBOOKS_EINVOICE_CLIENT_ID }}
     WHITEBOOKS_EINVOICE_CLIENT_SECRET: ${{ secrets.WHITEBOOKS_EINVOICE_CLIENT_SECRET }}
     WHITEBOOKS_EINVOICE_USERNAME: ${{ secrets.WHITEBOOKS_EINVOICE_USERNAME }}
     WHITEBOOKS_EINVOICE_PASSWORD: ${{ secrets.WHITEBOOKS_EINVOICE_PASSWORD }}
   ```

3. **Add `permissions:` block at the workflow level** to fix Finding #3:
   ```yaml
   permissions:
     contents: read
     issues: write
   ```

4. (Optional, Finding #4) bump `actions/*@v4` → newer majors when they release for Node.js 24, or set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` at the workflow env level.

**Effort:** ~10 minutes (4 `gh secret set` invocations + ~10-line yaml diff + push). Manual verification: trigger the workflow via `workflow_dispatch` and confirm green.

**Risk:** very low. The workflow doesn't touch prod even on success.

**Caveat:** if the WhiteBooks sandbox creds are also expired (sandbox tokens rotate), the seed step will pass but the GST-related portions of e2e-monitor will fail on the first NIC call. Worth verifying creds against the live sandbox first — `packages/api/scripts/probe-nic-session.ts` exists for exactly this. But the seed-step crash will at least be unblocked, and any subsequent failure will be a real diagnosable error in `e2e-results.json` instead of a generic "crashed before producing results."

### Option B — Disable the workflow

If the value-add doesn't justify the maintenance:

1. Add `if: false` to the cron schedule, OR
2. Comment out the `schedule:` block and keep `workflow_dispatch:` only (manual-trigger only — never runs unless someone clicks Run), OR
3. Delete `.github/workflows/e2e-monitor.yml` entirely.

**Rationale:** Finding #2 — the workflow is misnamed. It's a daily CI smoke test, not a production monitor. The main CI workflow (`.github/workflows/ci.yml`) already runs on every push and is currently green. A daily replay of the same code against the same Postgres is redundant.

**Effort:** ~2 minutes. **Risk:** zero.

### Option C — Rewrite to actually monitor production

If you want a real production monitor:

1. Change `BASE_URL` from `http://localhost:5000/api` to `https://api.mygaslink.com/api`.
2. Remove the Postgres service container, the `prisma db push`, the `tsx prisma/seed.ts`, and the local API server steps — none are needed for hitting prod.
3. Create a dedicated production "monitor user" with read-only / minimal-write scope. Add `PROD_ADMIN_EMAIL` + `PROD_ADMIN_PASSWORD` as secrets pointing to that user. (Currently the workflow hardcodes `bhargava@gasagency.com` / `Distadmin@123` — these are seed creds, not production creds. They won't work against the real API.)
4. Reduce the e2e-monitor script's scope to read-only assertions only (don't create real orders against prod).
5. Add a `PagerDuty` / SMS-tier escalation for failures (the current SMTP email is enough but slow-to-notice).

**Effort:** ~1-2 days of dedicated work. Includes designing what a "non-destructive prod monitor" looks like, creating the monitor user with limited scope, restructuring the script. **Risk:** moderate — touches production credentials and read-paths.

**This is its own work item, not a side-quest.** Don't bundle with the fix-forward.

## 6. Recommendation

**Suneel — recommend Option A + a separate decision on Option C later.**

Reasoning:
- Option A clears the red-X noise from CI history (the alert-fatigue cost is real even though the workflow's value-add is limited — psychological cost of red Xs in a dashboard).
- Once Option A lands, you'll see whether the e2e-monitor script itself passes against the freshly-seeded local stack. If yes, you have a daily CI sanity check. If no, the failure will be a real diagnosable error in the JSON, not a cryptic "crashed before producing results."
- After ~1 week of post-fix green runs, decide whether to invest in Option C (real production monitor) or accept that the daily CI run is enough.
- Do NOT do Option B (disable) without first investing 10 min in Option A — the cost is identical and you keep the option of future expansion.

If for some reason Option A is too much friction (e.g., you don't want WhiteBooks sandbox creds in GitHub Secrets), Option B is the next best move. Don't leave it failing.

## 7. What I am NOT doing

- No code changes
- No commits
- No secrets created
- No workflow runs triggered

Waiting on Suneel's direction. Once both this diagnosis and the SAA test results are in, decide whether to fold the fix-forward into the next chunk or queue it for after Chunk A.

---

*End of diagnosis.*
