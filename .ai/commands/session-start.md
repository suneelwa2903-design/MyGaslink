---
description: Start a development session — loads full context before any work begins
argument-hint: [work-item-id]
---

# Session Start — ADLC Framework

You are starting a scoped development session. Load full context BEFORE writing any code.

## Step 1: Load Core Context (mandatory, in this order)

```bash
cat CLAUDE.md
cat ARCHITECTURE.md
cat .session/specs/$ARGUMENTS.md
```

If spec file not found: STOP. Tell user to run `/spec` first. Do not proceed.

## Step 2: Load Session History

```bash
cat .session/learnings/learnings.md | tail -50
git log --oneline -10
git status
```

## Step 3: Check Work Item Status

Read `.session/tracking/work_items.json`:
- Find item with id matching `$ARGUMENTS`
- Check all dependencies — are they `completed`?
- If any dependency is NOT completed: STOP. List what's blocking. Do not proceed.
- If item is `in_progress`: load previous session context (commits made, what was done)

## Step 4: Update Status

Mark item status as `in_progress` in `.session/tracking/work_items.json`.

## Step 5: Brief Summary to User

Output a brief session brief:
```
SESSION START: [item-id]
Title: [title]
Type: [type] | Priority: [priority]
Dependencies: [all clear / blocked by X]
Relevant learnings loaded: [count]
Last git activity: [last commit message]

Ready to build. Spec loaded. Architecture loaded. Rules loaded.
```

## Step 6: Begin Implementation

Follow CLAUDE.md rules absolutely.
If anything is unclear after reading the spec: ask before building.
Run existing tests first to record baseline.
