---
description: Quick project status snapshot
---

# Status — ADLC Framework

Read-only snapshot. No changes made.

## Output Format

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROJECT STATUS: [PROJECT_NAME]
[current date/time]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

IN PROGRESS:
  [item-id] — [title] (since [date])

READY TO START (all deps complete):
  [item-id] — [title] [priority]
  [item-id] — [title] [priority]

BLOCKED (waiting on dependencies):
  [item-id] — [title] → blocked by: [dep-id]

COMPLETED (last 5):
  ✅ [item-id] — [title] ([date])

UNRESOLVED SECURITY:
  [list any HIGH/CRITICAL from last security scan, or "None"]

LAST COMMIT:
  [git log --oneline -1 output]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Read from:
- `.session/tracking/work_items.json` for all item statuses
- `git log --oneline -1` for last commit
- `.session/specs/_security-findings.md` if exists for unresolved security items
