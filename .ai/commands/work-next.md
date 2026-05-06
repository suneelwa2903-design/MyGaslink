---
description: Recommend the next work item to start based on priority and dependencies
---

# Work Next — ADLC Framework

Reads work_items.json and recommends what to work on next.

## Logic

1. Read `.session/tracking/work_items.json`
2. Filter: status = `not_started` or `in_progress`
3. For each item, check: are ALL dependencies `completed`?
4. Eligible items = items where all deps are complete
5. Sort eligible by priority: `critical` → `high` → `medium` → `low`
6. Within same priority: `bug` and `security` before `feature` and `refactor`

## Output

```
NEXT WORK ITEMS
━━━━━━━━━━━━━━━━
Recommended (start this):
  🎯 [item-id] — [title]
     Type: [type] | Priority: [priority]
     Estimated: [effort if specified]
     Spec: .session/specs/[item-id].md

Also ready:
  • [item-id] — [title] ([type], [priority])
  • [item-id] — [title] ([type], [priority])

Blocked (waiting on deps):
  • [item-id] — blocked by [dep-id] ([dep status])

To start: /session-start [item-id]
```

If no items are ready: suggest which blocked item's dependency to work on first to unblock the most downstream work.
