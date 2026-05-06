---
description: Bootstrap any existing project — generates all ADLC framework files from codebase
---

# Onboard — ADLC Framework

One-time setup for an existing project. Scans everything, generates framework files, reports gaps.

## Step 1: Full Codebase Assessment

Scan in this order (read structure first, then key files):
```bash
find . -type f -name "*.py" -o -name "*.ts" -o -name "*.js" -o -name "*.tsx" | \
  grep -v node_modules | grep -v venv | grep -v .git | head -200

# Read key files
cat requirements.txt 2>/dev/null || cat package.json 2>/dev/null
cat docker-compose.yml 2>/dev/null
cat .env.example 2>/dev/null
ls -la migrations/ 2>/dev/null || ls -la alembic/versions/ 2>/dev/null
```

Identify:
- Tech stack and exact versions
- Auth implementation (JWT/Firebase/session/OAuth)
- Multi-tenancy: does `tenant_id` appear in models? Schema-per-tenant? DB-per-tenant?
- All database tables (from migrations)
- All API routes (from routers/views)
- Frontend component structure
- External integrations (from imports and env vars)
- Existing test structure and coverage

## Step 2: Generate ARCHITECTURE.md

Fill the ARCHITECTURE.md template with actual findings.
Mark anything uncertain as: `⚠️ [NEEDS_HUMAN_INPUT: specific question]`

Multi-tenant section is mandatory — document exactly how tenant isolation works.

## Step 3: Generate CLAUDE.md

Fill the CLAUDE.md template with:
- Actual stack details
- Patterns FOUND in the codebase (not ideal patterns — actual ones)
- Anti-patterns found (document what NOT to do — with file:line examples)
- Actual naming conventions from the code
- Multi-tenant rules based on actual implementation

## Step 4: Initialise .session/

```bash
mkdir -p .session/specs/_templates .session/tracking .session/learnings
echo '{"items":[]}' > .session/tracking/work_items.json
echo "# Learnings Log" > .session/learnings/learnings.md
```

Copy session config template and update project name.

## Step 5: Generate gap-report.md

```markdown
# Gap Report — [PROJECT_NAME]
Generated: [date]

## Requires Human Input
[List every [NEEDS_HUMAN_INPUT] item with specific questions]

## Anti-patterns Found (fix in future work items)
[List issues found in codebase that should be addressed]

## Suggested First Work Items
[Based on what you found — suggest 3-5 work items to create]
```

## Step 6: Confirm

```
ONBOARD COMPLETE — [PROJECT_NAME]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Files generated:
  ✅ ARCHITECTURE.md
  ✅ CLAUDE.md  
  ✅ .session/ initialised
  ✅ gap-report.md

Gaps requiring your input: [N items]
Anti-patterns found: [N items]

Next step: Open gap-report.md and fill in all [NEEDS_HUMAN_INPUT] items.
Then run /work-new to create your first work item.
```
