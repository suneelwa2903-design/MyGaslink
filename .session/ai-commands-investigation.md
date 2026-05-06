# AI Commands & ADLC v3 Investigation

**Generated:** 2026-05-06
**Mode:** Read-only. No changes made.

---

## 1. `.ai/commands/` directory

**Location:** `C:/Projects/Re-New_Gaslink/.ai/commands/` (untracked in primary worktree)
**File count:** 8 markdown files
**Naming:** kebab-case `<command>.md`, each opening with YAML frontmatter (`description:`, sometimes `argument-hint:`)

| File | One-sentence summary |
|---|---|
| `onboard.md` | One-time setup: scans an existing codebase, generates `ARCHITECTURE.md` + `CLAUDE.md` + `.session/` + `gap-report.md`. **(This is exactly what we ran at session-1 start.)** |
| `secure.md` | Reviews changed code against an OWASP A01–A08 + multi-tenant + XSS + financial-data checklist; runs `scripts/security/security-scan.sh`; writes `security-review.md`; **blocks ship** on HIGH/CRITICAL findings. |
| `session-start.md` | Loads full context (CLAUDE.md, ARCHITECTURE.md, the spec for the given work-item, learnings tail, recent git log, status), checks dependencies are met, sets the work-item to `in_progress`. |
| `session-end.md` | Runs quality gates (tests, lint, security, coverage), commits + pushes if all pass, captures learnings to `.session/learnings/learnings.md`, sends Telegram alert; **blocks** if any gate fails. |
| `status.md` | Read-only snapshot: in-progress + ready + blocked + completed (last 5) + unresolved-security + last-commit, all sourced from `work_items.json` + git. |
| `validate.md` | Pre-flight gate runner that does **not** commit, push, or change status — designed to be run before `/session-end` to see what's still red. |
| `work-new.md` | Creates a spec file from the right `_templates/<type>-spec.md`, asks for priority/deps/description, registers a new entry in `work_items.json`. |
| `work-next.md` | Reads `work_items.json`, computes which items have all dependencies satisfied, recommends the highest-priority eligible one (security/bug before feature/refactor at same priority). |

### Placeholder / incomplete content audit

- **No `[PLACEHOLDER]` or `[REPLACE]` strings** appear in any of the 8 command files at the configuration level.
- The bracketed strings inside the commands (e.g. `[item-id]`, `[date]`, `[PROJECT_NAME]` in output templates) are **runtime substitution markers** — they get filled in when the command runs, not during install. These are fine.
- `secure.md` references `./scripts/security/security-scan.sh` — the script exists in the primary worktree (untracked) and is genuinely runnable.
- `session-end.md` and `validate.md` include both Python (`pytest`, `bandit`, `mypy`, `ruff`) **and** Node (`npm test`, `npm audit`, `npx tsc`) toolchain blocks. **Both are kept; the operator runs the correct one for their stack.** Not a defect; the framework is multi-stack.
- Test coverage threshold mentioned in `session-end.md` (Step 2) defers to `config.json`. That config is in `.session/config.json`.

**Verdict:** All 8 commands are complete and functional. None require placeholder substitution to work.

---

## 2. `.claude/commands/` directory

**Location:** `C:/Projects/Re-New_Gaslink/.claude/commands/` (untracked in primary worktree)
**File count:** 8 markdown files (same names as `.ai/commands/`)

```
$ diff -r .ai/commands/ .claude/commands/
(no output → byte-identical)
```

**Both directories contain the exact same 8 files with identical content.** Why two locations? Likely because:
- `.ai/commands/` is the ADLC framework's canonical path (per `bootstrap.sh` install pattern).
- `.claude/commands/` is the path Claude Code's slash-command registry recognises by default.

**Verdict:** they are mirrors — committing both ensures the commands are visible to Claude Code's `/command` UI and to any other ADLC-aware tooling.

---

## 3. `CLAUDE.md.adlc-template` (untracked, primary worktree)

**Size:** 158 lines, ~7 KB
**Type:** **Base template, NOT project-specific.** Header explicitly says:
> `# Copy this to every project. Fill in the [PROJECT_*] placeholders.`

It contains **`[PROJECT_NAME]`, `[saas-multi-tenant | erp-standalone | trading | api-service | other]`, `[jwt | firebase | session | oauth — specify exact implementation]`, `[yes | no]`, `[row-level | schema-per-tenant | db-per-tenant]`, `[local | aws-ec2 | aws-ecs | client-server]`** — all in the "Project Identity" section. These are the placeholders to fill when bootstrapping a new project.

**Sections:**
1. Project Identity (placeholders)
2. Non-Negotiable Rules (Before Writing Any Code, While Building, Never Do These)
3. Security (Input & Output, Authentication, Multi-Tenant Data Isolation, Authorisation, Secrets, Financial Data)

This file matches the master at `/c/dev-tools/adlc-v3/framework/templates/CLAUDE.md` (158 lines confirmed via `wc -l`). It is the **portable starter kit** the user will copy into future projects.

**Verdict:** keep as a meta-template, not as the project's actual `CLAUDE.md`. This project's `CLAUDE.md` is the filled-in one with our merged content.

---

## 4. ADLC Framework version confirmation

### Master location
`/c/dev-tools/adlc-v3/` exists and is populated:

```
/c/dev-tools/adlc-v3/
├── ADLC-README.md           ← framework setup guide
├── WINDOWS-SETUP.md         ← Windows-specific setup
├── bootstrap.sh             ← Linux/macOS installer
├── bootstrap.ps1            ← Windows installer
├── framework/               ← copied into each project
│   ├── .ai/commands/        (8 commands, identical to project's)
│   ├── .session/
│   ├── scripts/
│   └── templates/
│       ├── CLAUDE.md         (158 lines)
│       └── CLAUDE-MOBILE.md  (179 lines)
└── global/
    └── scripts/monitor-all.sh
```

The README header says `# ADLC Framework v3 — Setup Guide`. **Confirmed: this is ADLC v3.**

### bootstrap.sh / bootstrap.ps1 in project root?
**No.** `ls bootstrap.* 2>/dev/null` returns empty in `C:/Projects/Re-New_Gaslink/`. `ls ADLC-README.md` also empty in project root. **The framework is installed, but the bootstrap files themselves stay in the master `~/dev-tools/adlc-v3/` directory** — that's the design (per the README: "Never edit files here directly — this is your master copy").

### Discrepancies vs README

- README says "all slash commands (11 commands)" — actual count in master and in this project is **8**. The README is stale on this number; the install is consistent at 8.
- README mentions `framework/templates/ARCHITECTURE.md` and `ARCHITECTURE-MOBILE.md`, but I didn't enumerate them. They likely exist alongside the CLAUDE.md templates and are bootstrap-time copies.

---

## Summary

| Item | Verdict |
|---|---|
| `.ai/commands/` (8 files) | Complete. No incomplete placeholders. Each command is functional and well-documented. **KEEP AS IS.** |
| `.claude/commands/` (8 files) | Byte-identical to `.ai/commands/`. **KEEP — mirror is intentional.** |
| `CLAUDE.md.adlc-template` (158 lines) | Generic portable base template. Different file from this project's `CLAUDE.md`. **KEEP AS IS** — it's the cross-project starter kit. |
| ADLC v3 framework | Confirmed installed via `~/dev-tools/adlc-v3/`. v3 is the active version. Bootstrap files stay in master, not in project root. |
| README claim of "11 commands" | Stale — only 8 exist. Not a project issue, an upstream README inaccuracy. |
| Safety to commit `.ai/` | **Safe.** No API keys, secrets, or sensitive content. Just markdown command definitions. |

---

## Implications for the merge

1. **Commit both `.ai/commands/` and `.claude/commands/`** — the 16 files (8 mirrored each) are all framework documentation, no secrets.
2. **Commit `CLAUDE.md.adlc-template`** — the master template is useful for any future project the founder spins up.
3. The 8 slash commands assume **`config.json` quality gate values** are real (coverage_auth=100, coverage_business=80) — but no coverage instrumentation is wired in CI today. So `/session-end` would fail every time it tries to enforce thresholds. This is a real gap — flag in the merge commit.
4. The 8 slash commands assume **Telegram alerts work** — depends on `.env.monitor` being filled in with real `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`. Currently only `.env.monitor.example` exists. So `/session-end` and `/secure` will silently skip the alerts step.
5. The 8 slash commands assume **`scripts/security/security-scan.sh`** exists and is runnable — yes (it's in the primary worktree, will be committed alongside).
6. **`/session-start.md` will fail** if `.session/specs/<id>.md` doesn't exist for a work item — currently we have 20 work items in `work_items.json` but **no per-item spec files**. This is a known gap; the templates exist (`bug-spec.md`, `feature-spec.md`, etc.) but specific specs haven't been authored yet. This affects future use of the framework but doesn't block the merge.

These are all framework-level "the install is good but the operational data isn't there yet" gaps. None block the merge. They map to follow-up work items the founder can add later.

**No code or config changed during this investigation.**
