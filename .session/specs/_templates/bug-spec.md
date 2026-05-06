# [item-id]: [Bug Title]
Type: bug
Priority: [critical|high|medium|low]
Created: [YYYY-MM-DD]
Dependencies: [item-ids or none]

---

## Description
[Clear description of the bug and its impact on users/system]

## Steps to Reproduce
1. [Step 1]
2. [Step 2]
3. [Step 3 — observed error]

**Environment:** [local/staging/production] | Version: [x.x.x]

## Expected Behaviour
[What should happen]

## Actual Behaviour
[What actually happens]

**Error / Log:**
```
[paste error message, stack trace, or log output]
```

## Impact
- Severity: [critical|high|medium|low]
- Affected users: [all|percentage|specific role]
- Workaround exists: [yes — describe | no]

## Root Cause Analysis

### Investigation Steps
1. [What you checked]
2. [What you found]

### Root Cause
[The exact technical cause — be specific, include file:line if known]

**Broken code:**
```python
# file: path/to/file.py line X
[paste broken code]
```

### Why It Happened
[Design gap / edge case not handled / regression / missing test]

## Fix Approach
[How to fix it — be specific]

**Fixed code:**
```python
[paste corrected code]
```

**Files to change:**
- `[file]` — [what changes]

## Acceptance Criteria
- [ ] Steps to reproduce no longer trigger the bug
- [ ] Regression test added that fails before fix, passes after
- [ ] All existing tests still pass
- [ ] Root cause is addressed (not just symptom)

## Prevention
[How to prevent this class of bug in future — test to add, pattern to document, rule to add to CLAUDE.md]
