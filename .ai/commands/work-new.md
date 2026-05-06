---
description: Create a new work item with spec template
argument-hint: [feature|bug|security|refactor|deployment] [brief-title]
---

# Work New — ADLC Framework

Creates a work item spec file and registers it in tracking.

## Step 1: Parse Arguments

From `$ARGUMENTS`:
- Type: first word (feature | bug | security | refactor | deployment)
- Title: remaining words → convert to kebab-case for ID

Generate item-id: `[type]-[kebab-title]-[YYYYMMDD]`
Example: `feature-cylinder-stock-alert-20260504`

## Step 2: Ask for Details

Ask user:
1. Priority? (critical / high / medium / low)
2. Dependencies? (other item IDs, or none)
3. Brief description (2-3 sentences)? 

## Step 3: Create Spec File

Copy the appropriate template from `.session/specs/_templates/[type]-spec.md`
to `.session/specs/[item-id].md`

Pre-fill from user's answers:
- Title, type, priority, dependencies, date
- Overview section from brief description

Output: "Spec created at .session/specs/[item-id].md — open it and fill in the remaining sections before running /session-start"

## Step 4: Register in work_items.json

Append to items array:
```json
{
  "id": "[item-id]",
  "title": "[title]",
  "type": "[type]",
  "priority": "[priority]",
  "status": "not_started",
  "dependencies": [],
  "created_at": "[ISO timestamp]",
  "spec_file": ".session/specs/[item-id].md"
}
```

## Step 5: Confirm

```
✅ Work item created: [item-id]
Title: [title]
Type: [type] | Priority: [priority]

Next steps:
1. Fill in .session/specs/[item-id].md (all sections required)
2. Run /session-start [item-id] when spec is complete
```
