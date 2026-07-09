-- WI-JUL09: Prevent duplicate open PendingActions for the same
-- (distributor, entity, action_type) triple. Closes the TOCTOU race in
-- createPendingAction (gstService.ts:1651) where two concurrent failures
-- both findFirst-miss and both create, yielding duplicate bell entries.

-- Step 1: dedupe existing duplicates so the unique index can be built.
-- For every group with more than one open row, keep the most recently
-- created open row and mark the older siblings as resolved (audit-safe;
-- no delete). Note reflects the operational reason.
WITH duplicates AS (
  SELECT
    action_id,
    ROW_NUMBER() OVER (
      PARTITION BY distributor_id, entity_id, action_type
      ORDER BY created_at DESC, action_id DESC
    ) AS rn
  FROM "pending_actions"
  WHERE status = 'open'
)
UPDATE "pending_actions"
SET status = 'resolved',
    resolved_at = NOW(),
    resolved_by = 'system',
    resolution_notes = 'Auto-resolved: superseded by newer open PA — dedup before adding unique index'
WHERE action_id IN (SELECT action_id FROM duplicates WHERE rn > 1);

-- Step 2: partial unique — only enforces on OPEN rows so resolved /
-- rejected rows from prior cycles don't block a fresh open row on a
-- new failure.
CREATE UNIQUE INDEX IF NOT EXISTS "pending_actions_open_unique"
  ON "pending_actions" ("distributor_id", "entity_id", "action_type")
  WHERE "status" = 'open';
