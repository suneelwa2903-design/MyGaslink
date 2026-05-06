---
description: Run quality gates without committing — pre-flight check
---

# Validate — ADLC Framework

Runs all quality gates. No commits. No status changes. Read the results, fix issues, then /session-end.

## Run All Gates

```bash
# Tests + coverage
pytest --cov=app --cov-report=term-missing 2>&1
# or: npm test -- --coverage

# Lint (report only, no auto-fix in validate mode)
ruff check . 2>&1
# or: npm run lint

# Security scan
bandit -r app/ -ll 2>&1
# or: npm audit --audit-level=high

# Type check
mypy app/ 2>&1
# or: npx tsc --noEmit

# Check for common issues
grep -r "TODO_TEST" app/ --include="*.py" | head -20
grep -r "hardcoded\|password\s*=" app/ --include="*.py" -i | grep -v "test\|#\|schema" | head -10
```

## Output Summary

```
PRE-FLIGHT CHECK
━━━━━━━━━━━━━━━━
Tests:    [PASS ✅ | FAIL ❌] — [X/Y passing, Z% coverage]
Lint:     [PASS ✅ | WARN ⚠️ | FAIL ❌] — [N issues]  
Security: [PASS ✅ | WARN ⚠️ | FAIL ❌] — [findings summary]
Types:    [PASS ✅ | FAIL ❌] — [N errors]
TODO_TEST: [N functions not yet tested]

READY TO SHIP: [YES | NO]

Issues to fix before /session-end:
[list specific issues with file:line]
```

No commits. No pushes. No status updates.
