# [item-id]: [Refactor Title]
Type: refactor
Priority: [high|medium|low]
Created: [YYYY-MM-DD]
Dependencies: [item-ids or none]

---

## Overview
[What is being refactored and why — business case for doing this now]

## Current State (the problem)
[Describe what exists now — with code examples of the problematic pattern]

```python
# Current — problematic
[code showing the issue]
```

**Problems with current approach:**
- [Problem 1 — be specific]
- [Problem 2]

## Proposed State (the solution)
[Describe what it will look like after — with code examples]

```python
# After refactor
[code showing the improved pattern]
```

## Scope

### In Scope
- [File/module 1]
- [File/module 2]

### Out of Scope
- [Explicitly not touching X]
- [Not changing behaviour — only structure]

## Migration Plan
[If this changes APIs, models, or shared code — how to migrate without breaking things]

1. [Step 1]
2. [Step 2]

## Benefits
- [Measurable improvement 1 — e.g. removes 200 lines of duplication]
- [Measurable improvement 2 — e.g. enables X future feature]

## Acceptance Criteria
- [ ] All existing tests pass with zero changes to test assertions
- [ ] No behaviour change — only structure changes
- [ ] Code coverage maintained or improved
- [ ] [Specific measurable improvement — e.g. cyclomatic complexity reduced]

## Risks
- [Risk 1 and mitigation]
- [Risk 2 and mitigation]
