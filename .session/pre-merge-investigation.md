# Pre-Merge Investigation — Primary Worktree vs Branch

**Generated:** 2026-05-06
**Mode:** Read-only investigation. No changes made to any file or branch.
**Primary worktree path:** `C:/Projects/Re-New_Gaslink/`
**Branch worktree path:** `C:/Projects/Re-New_Gaslink/.claude/worktrees/peaceful-bartik-21e3d2/`

---

## 1. CLAUDE.md uncommitted changes (primary worktree)

### What sections are added
A single `## MOBILE — ADDITIONAL RULES` section appended to the bottom of CLAUDE.md (after line 111, the existing "Architecture Notes" section). ~180 lines. The content is a **generic mobile-development rules template** with the following sub-sections:

- **Mobile Platform** (5 placeholder choices for framework/target/state/nav)
- **Mobile Security — NON-NEGOTIABLE** (Token & Secret Storage, Certificate Pinning, Jailbreak/Root Detection, Deeplinks, Biometric Auth, API Communication)
- **Mobile Architecture Rules** (API Layer, Offline Support, State Management, Navigation, Performance Rules)
- **Mobile Testing Rules** (Unit/Integration/E2E/Device)
- **Mobile Spec Template Additions** (a snippet to copy into mobile feature specs)
- **Mobile Build & Release Rules** (Versioning, Pre-release checklist, Crash Reporting, OTA Updates)
- **Mobile CLAUDE.md Anti-Patterns** (8 specific things never to do)

### Placeholder count
**0 literal `REPLACE:` strings** (the script-style placeholder format used in `.session/config.json` is not used here). Instead it uses **6 bracketed `[ X | Y | Z ]` choice placeholders** that need to be resolved for this project:

| Line | Placeholder | Recommended value for GasLink |
|---|---|---|
| Mobile Platform > Framework | `[React Native (Expo managed | bare) | Flutter]` | **React Native (Expo managed)** — confirmed via `packages/mobile/package.json` (uses `expo`) |
| Mobile Platform > Targets | `[iOS | Android | both]` | **both** — `eas.json` builds for both |
| Mobile Platform > Min OS | `[iOS 15+ | Android 10+]` | needs founder confirmation |
| Mobile Platform > State | `[Zustand | Redux Toolkit | Jotai]` | **Zustand** — confirmed via `packages/mobile/package.json` |
| Mobile Platform > Navigation | `[React Navigation v7 | Expo Router]` | **Expo Router** — confirmed via `packages/mobile/package.json` (uses `expo-router`) |
| Offline Support > Conflict resolution | `[last-write-wins | server-wins | manual-merge]` | needs founder decision per entity |

There are also **~10 spec-template placeholders** like `[any iOS-specific behaviour]`, `[screen/tab/deeplink]` etc. inside the "Mobile Spec Template Additions" sub-section. These are placeholders **for spec authors** to fill in when writing a mobile feature spec, not placeholders that need to be filled now.

### Are these rules already implemented?

| Rule | Status in codebase |
|---|---|
| `expo-secure-store` for tokens (not AsyncStorage) | ✅ **implemented** — `packages/mobile/src/lib/api.ts`, `stores/distributorStore.ts`, `stores/themeStore.ts` all import `expo-secure-store` |
| Certificate pinning | ❌ **not implemented** — no `react-native-ssl-pinning` in `package.json` |
| Jailbreak / root detection | ❌ **not implemented** — no `jail-monkey` or `expo-device` jailbreak check |
| Universal Links / App Links | 🟡 **partial** — custom scheme `mygaslink://` configured in `app.json`; no Universal/App Links yet |
| Biometric auth (`expo-local-authentication`) | ❌ **not implemented** — not in `package.json` |
| HTTPS-only API | ✅ — `eas.json` profiles use `https://api.mygaslink.com/api` |
| API layer in `/src/api/` | 🟡 — actually in `src/lib/api.ts` (single file, not a folder); compatible spirit |
| Offline queue | ❌ **not implemented** — no offline write queue |
| React Query for server state | ✅ — `@tanstack/react-query` in mobile package |
| `react-hook-form + zod` for forms | ✅ — both in mobile deps |
| `FlatList` not `ScrollView` for long lists | 🟡 — found 39 occurrences across 10 mobile files; not audited for "long list" classification |
| `expo-image` (caching) | ❌ — using plain `<Image>` |
| Unit/Integration/E2E (Jest/MSW/Detox) | 🟡 — Jest configured (`packages/mobile/jest.config.js`), 3 test files exist; MSW + Detox not in deps |
| `babel-plugin-transform-remove-console` | ❌ — not in deps |
| Sentry for crash reporting | 🟡 **partial** — DSN wired into `eas.json` preview/production env, but no `@sentry/react-native` in mobile `package.json` |

**Net:** Roughly **half** of the rules describe behaviour the codebase already exhibits; the other half are aspirational. None are actively violated in code today, but several "non-negotiable" items (certificate pinning, jailbreak detection, biometric auth, offline queue, expo-image, console.log stripping) require dependency additions and code changes that haven't been done yet.

### Conflicts with our branch's CLAUDE.md changes
**Low conflict risk.** Our branch added content to lines 115-185 (Code Conventions, Multi-tenant Rules, Anti-patterns sections). The primary worktree's mobile addition appends after line 111 — but **our branch already pushed the file longer than 111 lines** (it's now ~190 lines in our branch).

What will happen on `git merge`:
- The merge tries to apply the primary worktree's diff (which targets line 111 onward in the *original* CLAUDE.md) to our branch's CLAUDE.md (where line 111 has different surrounding context).
- Three-way merge will likely succeed because the two changes are at different anchor points — but `git diff` against our committed version is computed against `a5367e3` (the master baseline at `85a6eda`), so it should layer cleanly.
- **The primary worktree's CLAUDE.md is a working-tree change, not a commit.** A `git merge` with a dirty working tree will refuse with `error: Your local changes to the following files would be overwritten by merge: CLAUDE.md` unless we stash or commit first.

### Genuinely new and valuable
- **Mobile Security — NON-NEGOTIABLE** subsection: certificate pinning, jailbreak detection, biometric auth — these are all valuable additions our branch does NOT cover. Should be kept.
- **Mobile Build & Release** with its pre-release checklist (E2E green, no console.log, bundle analysed, physical device tested, privacy policy URL valid, deep link tested): genuinely useful as a launch gate. Aligns with `.session/eas-readiness.md`.
- **Mobile Anti-Patterns** list: 8 specific don'ts. Concrete and useful.
- **Mobile Spec Template Additions** snippet: defines what every mobile feature spec must include (Platform Behaviour, Navigation, Permissions, Performance Requirements). Pairs with `mobile-feature-spec.md` template.

---

## 2. `.session/config.json` (primary worktree, untracked)

```json
{
  "_comment": "ADLC Framework — quality gate config. Adjust thresholds per project.",
  "project": {
    "name": "Re-New_Gaslink",
    "stack": "REPLACE: fastapi-react | django-react | node-react | other",
    "multi_tenant": true
  },
  "quality_gates": {
    "spec_completeness": { "enabled": true, "required": true },
    "tests": {
      "enabled": true, "required": true,
      "coverage_auth": 100, "coverage_business": 80, "coverage_overall": 70
    },
    "linting": { "enabled": true, "required": false, "auto_fix": true },
    "security": { "enabled": true, "required": true, "fail_on": "high" },
    "type_checking": { "enabled": true, "required": false }
  },
  "git": {
    "auto_commit": true, "auto_push": true, "branch_per_item": true
  },
  "alerts": {
    "on_ship_success": true, "on_gate_failure": true,
    "on_sprint_complete": true, "on_cron_failure": true, "on_infra_alert": true
  }
}
```

### Quality gates and thresholds defined
- **spec_completeness**: every work item must have a spec file before shipping. Required.
- **tests**: 100% auth coverage, 80% business-logic coverage, 70% overall. Required.
- **linting**: enabled, not required to pass, auto-fix on.
- **security**: enabled, required, fails the gate on `high`-severity findings.
- **type_checking**: enabled, not required to pass (advisory).

### Reality check vs the codebase
- **`stack: "REPLACE: fastapi-react | django-react | node-react | other"`** — placeholder unfilled. Correct value: **node-react** (Express + React 19).
- **`coverage_auth: 100`** — actual API auth coverage today: 254 tests pass and the auth.test.ts suite exists, but no coverage instrumentation is wired. `vitest --coverage` would need to run; threshold is currently aspirational.
- **`coverage_business: 80`** — same: no coverage measurement in CI.
- **`coverage_overall: 70`** — same.
- **`type_checking: enabled, required: false`** — our branch enforces zero typecheck errors via `pnpm typecheck`. We're stricter than this config.
- **`linting: required: false`** — `pnpm lint` runs in CI but doesn't block. Matches.
- **`security: fail_on: "high"`** — no automated security scanner is wired to CI today (`scripts/security/security-scan.sh` is the new addition, not yet integrated).
- **`git.auto_commit: true, auto_push: true`** — aspirational. The harness this session has been operating under does require explicit user approval for commits, and `auto_push` cannot work because there is **no `origin` remote configured**.
- **`alerts.*`** — assume the new `scripts/alerts/telegram.sh` script will deliver these. Not yet wired.

### Comparison with our branch's `.session/config.json`
Our committed version is much simpler:
```json
{
  "project": "Re-New GasLink",
  "tenancyModel": "shared-db-discriminator",
  "tenantField": "distributorId",
  "primaryLanguage": "typescript",
  "packageManager": "pnpm",
  "testRunner": "vitest",
  "trackingFile": ".session/tracking/work_items.json",
  "learningsFile": ".session/learnings/learnings.md",
  "specsDir": ".session/specs",
  "specTemplate": ".session/specs/_templates/spec.md"
}
```

These are **complementary, not overlapping**. Theirs defines quality gates and alerting policy; ours defines tooling and tenancy model. The merged version should keep both shapes — likely by nesting our fields under a `project` block alongside theirs. **Their schema wins on structure.**

---

## 3. Spec templates (`.session/specs/_templates/`)

| File | Lines | First 10-line summary |
|---|---|---|
| `bug-spec.md` | 71 | bug report template — fields: title, priority, dependencies, description, impact, repro |
| `deployment-spec.md` | 70 | deploy plan — scope, dependencies, environment, rollback |
| `feature-spec.md` | 89 | new feature — overview, user impact, acceptance criteria, etc. |
| `mobile-feature-spec.md` | 93 | mobile feature with platform-specific blocks (iOS/Android/offline) |
| `mobile-release-spec.md` | 89 | mobile release with version + items + store metadata |
| `refactor-spec.md` | 60 | refactor — what's changing, why now, business case |
| `security-spec.md` | 74 | security finding — defaults to critical priority |

**Total: 7 templates, 546 lines** of structured headings.

Comparison with our branch: we committed exactly **one** generic `spec.md` (~25 lines) at `.session/specs/_templates/spec.md`. Theirs is **richer in every dimension** — more types, more structure, mobile-aware, security-aware.

### Verdict per template
- **bug-spec.md** — useful, generic enough to apply to GasLink. **Useful.**
- **deployment-spec.md** — useful for tracking release notes / deploy plans. **Useful.**
- **feature-spec.md** — useful, would replace our generic `spec.md`. **Useful.**
- **mobile-feature-spec.md** — directly relevant: GasLink has a mobile package. **Useful.**
- **mobile-release-spec.md** — directly relevant; matches the EAS launch flow in `.session/eas-readiness.md`. **Useful.**
- **refactor-spec.md** — useful for items like WI-006 (Float→Decimal). **Useful.**
- **security-spec.md** — useful for items like WI-001 (tenant audit) and WI-007 (GST live). **Useful.**

**None are generic-only boilerplate. All seven are valuable for this project.**

---

## 4. New scripts in primary worktree

### `scripts/alerts/`
| File | Purpose |
|---|---|
| `Send-Alert.ps1` | Windows PowerShell Telegram alerter. Reads creds from `.env.monitor`. Used by `health-check.ps1`. |
| `telegram.sh` | Bash equivalent. Reads `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`. Used by `cron-runner.sh`, `health-check.sh`, `security-scan.sh`. |

### `scripts/crons/`
| File | Purpose |
|---|---|
| `cron-runner.sh` | Wraps any command, captures output, sends Telegram alert on failure. For cron-style scheduled jobs. |

### `scripts/monitor/`
| File | Purpose |
|---|---|
| `health-check.ps1` | Windows-side periodic health check (Task Scheduler every 5 min). Local dev environment monitor. |
| `health-check.sh` | Linux-side equivalent for production server. Checks DB / Redis / disk / mem / process running, alerts on threshold breach. |

### `scripts/security/`
| File | Purpose |
|---|---|
| `security-scan.sh` | Runs available security tools (npm audit, etc.), aggregates findings into `/tmp/security-report-*.txt`, alerts. |

### Are these implemented or new?
**All five script subfolders are new** — none of these files existed before in any commit, in master, or in our branch. They depend on `.env.monitor` (provided as `.env.monitor.example`) for configuration.

**Integration status with existing infra:**
- The codebase has `scripts/backup.sh` and `scripts/restore.sh` (DB backup/restore for production EC2) committed in master.
- The new scripts are **not wired into** `.github/workflows/ci.yml` or `e2e-monitor.yml`. They appear designed for **operator-side scheduled execution** (Windows Task Scheduler / Linux cron) rather than CI.
- `packages/api/scripts/e2e-monitor.ts` (live, in CI via `e2e-monitor.yml`) is a different, pre-existing E2E monitor — not what these scripts do.

These scripts are **operational tools for after-deploy monitoring** — Telegram-driven incident alerting. Useful, but launching them requires:
1. A Telegram bot token + chat ID (founder action)
2. A host (server / Windows machine) with cron / Task Scheduler set up
3. Filling in `.env.monitor` with project values

---

## 5. Other untracked items in primary worktree

### `CLAUDE.md.adlc-template` (untracked)
A **portable template** version of CLAUDE.md (~200 lines, ~7 KB) with placeholders like `[PROJECT_NAME]`, `[saas-multi-tenant | erp-standalone | trading | api-service | other]`, `[jwt | firebase | session | oauth]`. It's the *generic* "starting kit" for use across multiple projects, not GasLink-specific. Sections: Project Identity, Non-Negotiable Rules, Security (Input/Output, Auth, Multi-Tenant, Authz, Secrets, Financial Data).

### `.claude/commands/` (untracked, 8 files)
Slash command definitions matching the ADLC framework workflow:
- `onboard.md` — what we ran at session 1 start
- `secure.md`, `validate.md`, `session-start.md`, `session-end.md`, `status.md`, `work-new.md`, `work-next.md`

These are **project-local Claude Code slash commands**. Useful for the workflow.

### `.ai/` (untracked) and `.env.monitor.example` (untracked)
- `.ai/` directory — content not inspected (out of scope; user can confirm it's framework-related).
- `.env.monitor.example` — the env-file template for the monitoring scripts (Telegram, DB host, thresholds). Useful, should be committed alongside the scripts.

### `.gitignore` uncommitted addition
```gitignore
# ADLC Framework
.session/specs/
.session/learnings/
ARCHITECTURE.md
gap-report.md
.env.monitor
logs/
```

**Important policy implication:** the user's framework intends `.session/specs/`, `.session/learnings/`, `ARCHITECTURE.md`, and `gap-report.md` to be **project-local working notes, not version-controlled**.

**This conflicts with our branch:** we committed `ARCHITECTURE.md`, `gap-report.md`, and `.session/specs/_templates/spec.md`. After merge, those files would still be tracked (history is permanent), but the gitignore policy says they shouldn't be.

**Recommendation:** keep `ARCHITECTURE.md` and `gap-report.md` committed (they're durable cross-team architectural docs, not working notes), and **remove those two lines from the `.gitignore` addition**. Keep `.session/specs/` and `.session/learnings/` gitignored if the user prefers (we don't need to commit per-item specs, just the templates).

---

## 6. Final verdict per item

| Item | Verdict | Justification |
|---|---|---|
| **CLAUDE.md mobile section** (~180 lines) | **KEEP AND FIX PLACEHOLDERS** | Valuable; 5 framework choices need filling (all known from package.json), 1 conflict-resolution choice needs founder input. Several "non-negotiable" rules (cert pinning, jailbreak, biometric, expo-image, console.log strip) describe NOT-yet-implemented behaviour — keep but flag as forward-looking. |
| **CLAUDE.md.adlc-template** (untracked) | **KEEP AS IS** | Generic portable template for cross-project use. Not project-specific; doesn't conflict with anything in our branch. Commit alongside the framework. |
| **`.session/config.json`** (primary version) | **MERGE WITH BRANCH VERSION** | Their schema is richer (quality gates, alerts) but missing project-specific fields (tenancyModel, tenantField, etc.). Combine: keep their structure + nest our fields under `project.*`. Fix `stack: "REPLACE:..."` → `"node-react"`. Keep `coverage_*` thresholds as aspirational targets; document that they're not currently CI-enforced. |
| **`.session/tracking/work_items.json`** | **DISCARD theirs, KEEP OURS** | Theirs is `{"items":[]}`. Ours has 20 items with completion dates. No question. |
| **`.session/specs/_templates/`** (7 files) | **DISCARD ours, KEEP theirs** | Theirs has 7 specialized templates (bug, deployment, feature, mobile-feature, mobile-release, refactor, security). Ours has one generic `spec.md`. Drop ours, take all 7. |
| **`.session/learnings/learnings.md`** | **KEEP AS IS (identical)** | Both are `# Learnings Log` with no entries. No conflict. |
| **`scripts/alerts/`** (Send-Alert.ps1, telegram.sh) | **KEEP AS IS** | Useful new ops tooling. Not currently integrated; flag as "post-launch operator setup". |
| **`scripts/crons/cron-runner.sh`** | **KEEP AS IS** | Useful wrapper; same caveat re: integration. |
| **`scripts/monitor/`** (health-check.{ps1,sh}) | **KEEP AS IS** | Useful for post-launch monitoring. Pairs with `e2e-monitor.yml` already in CI. |
| **`scripts/security/security-scan.sh`** | **KEEP AS IS** | Useful, not yet wired to CI. Future-integration with `npm audit` etc. |
| **`.env.monitor.example`** | **KEEP AS IS** | Belongs alongside the scripts above. Commit. |
| **`.claude/commands/`** (8 slash commands) | **KEEP AS IS** | Project-local Claude Code commands. Additive; no conflict. |
| **`.ai/`** | **NOT INSPECTED** | Empty/unknown content. Ask the user before deciding. |
| **`.gitignore` addition** | **PARTIAL KEEP** | Keep: `.session/specs/` `.session/learnings/` `.env.monitor` `logs/`. **Remove from the addition**: `ARCHITECTURE.md` and `gap-report.md` — those are durable docs, not working notes. We committed them in our branch and should keep them tracked. |

---

## Summary table — what to do for the merge

| Source | Files | Action when merging |
|---|---|---|
| **Take primary's version verbatim** | CLAUDE.md mobile section, all 7 spec templates, all 5 script subdirs + `.env.monitor.example`, `CLAUDE.md.adlc-template`, `.claude/commands/` | Stash/commit primary's WIP first; bring into master alongside our branch. |
| **Take primary's structure, fill our values** | `.session/config.json` | Use their schema as the outer shape; nest `tenancyModel`, `tenantField`, etc. under `project.*`; resolve `stack: "REPLACE..."` → `"node-react"`. |
| **Take our branch's version, discard primary's** | `.session/tracking/work_items.json` | Theirs is empty; ours has 20 items. |
| **Resolve manually** | `.gitignore` | Take primary's diff except the lines that gitignore `ARCHITECTURE.md` and `gap-report.md`. |
| **No conflict, both sides keep their version** | All security/test/UI commits in our branch (22 commits), packages/api source files | Standard fast-forward / no-ff merge. |

**Estimated merge effort:** 30-60 minutes of careful manual conflict resolution + a final `pnpm typecheck && pnpm test` pass to confirm 254/254 still green after all merges.

**No code changes have been made. This is a read-only investigation report.**
