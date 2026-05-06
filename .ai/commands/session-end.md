---
description: End session — runs quality gates, captures learnings, commits, alerts
argument-hint: [work-item-id] [complete|incomplete]
---

# Session End — ADLC Framework

Clean session closure. Captures learnings, enforces gates, commits, alerts.

## Step 1: Run Quality Gates

```bash
# Python projects
pytest --cov=app --cov-report=term-missing 2>&1 | tee /tmp/test-results.txt
ruff check . --fix
bandit -r app/ -ll 2>&1 | tee /tmp/security-scan.txt

# Node/React projects  
npm test -- --coverage 2>&1 | tee /tmp/test-results.txt
npm run lint -- --fix
npm audit --audit-level=high 2>&1 | tee /tmp/security-scan.txt
```

## Step 2: Evaluate Gates

Parse results:
- Tests: PASS if coverage ≥ threshold in config.json | FAIL if any test fails
- Security: PASS if no HIGH/CRITICAL | WARN if MEDIUM | FAIL if HIGH or CRITICAL
- Lint: auto-fixed inline (non-blocking unless config says required)

## Step 3A: If All Gates Pass

```bash
# Stage all changes
git add -A

# Commit with standard format
git commit -m "[type]: [spec title] (#[item-id])

- [bullet: key change 1]
- [bullet: key change 2]
- Tests: [X new tests, coverage: Y%]"

# Push
git push
```

Update `.session/tracking/work_items.json`:
- Set `status` = `"completed"` (if `$ARGUMENTS` includes `complete`) or `"in_progress"` (if incomplete)
- Set `completed_at` = current timestamp
- Set `last_session_summary` = brief summary of what was done

Capture learnings — for each thing learned this session, append to `.session/learnings/learnings.md`:
```
[YYYY-MM-DD] [category] — [what was learned, specific enough to help next session]
```
Categories: `[architecture]` `[gotcha]` `[best-practice]` `[tech-debt]` `[performance]` `[security]`

Send Telegram alert:
```
✅ [PROJECT_NAME] — [item-id] shipped
[spec title]
Tests: [X passing, Y% coverage]
Files changed: [N]
```

## Step 3B: If Any Gate Fails

Do NOT commit.

Set item status = `"in_progress"` in work_items.json.

Output exactly what failed:
```
🔴 SESSION END BLOCKED
Failed gates:
- [Tests: X tests failing — list them]
- [Security: HIGH finding in file:line]
- [Coverage: 67% — below 80% threshold]

Do not ship until all gates pass.
Run /fix for failing tests.
Run /secure for security findings.
```

Send Telegram alert:
```
🔴 [PROJECT_NAME] — [item-id] BLOCKED
Gate failures: [list]
Action needed.
```

## Step 4: Session Summary

Output:
```
SESSION END: [item-id]
Status: [completed | in_progress | blocked]
Duration: [session time if known]
Files changed: [list]
Tests: [X passing, Y% coverage]
Learnings captured: [count]
Next: [suggested next work item or action]
```
