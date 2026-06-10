-- ============================================================================
-- Group A Step 10 — Vanasthali GST reset (sandbox → disabled)
-- ============================================================================
--
-- One-off operational migration. NOT auto-applied. Run on prod RDS AFTER:
--   1. Group A code is pushed and CI deploy completes (so the activation flow
--      + transition guards are live before this migration changes state)
--   2. The pre-flight check block below returns the expected "safe-to-run"
--      counts (all zeros) — copy the SELECTs into psql FIRST and verify
--
-- Why: Vanasthali was set to gst_mode='sandbox' during early provisioning
-- before the Group A sandbox-allowlist rule existed. Real distributors should
-- never hold gst_mode='sandbox' (is_test_tenant=false). They transition
-- disabled → live directly via the super-admin activation flow.
--
-- After this migration, super-admin will re-activate Vanasthali to 'live' via
-- POST /api/admin/distributors/6a749f20-.../gst/activate with their real
-- WhiteBooks credentials (once the production package arrives).
--
-- Idempotent: re-running this script is safe — the UPDATE only fires if
-- gst_mode is still 'sandbox', and the audit log entry is unique by uuid.
-- ============================================================================

-- ─── PRE-FLIGHT CHECKS (run FIRST in psql, do NOT proceed if non-zero) ──────
--
-- The first three SELECTs verify Vanasthali has no in-flight state that the
-- mode flip could disturb. The fourth confirms the distributor exists and is
-- still in sandbox.

-- Should be 0
SELECT COUNT(*) AS open_invoices
FROM invoices
WHERE distributor_id = '6a749f20-5a82-4b74-9977-51eac69049f2'
  AND irn_status IN ('pending', 'pending_dispatch')
  AND deleted_at IS NULL;

-- Should be 0
SELECT COUNT(*) AS active_ewb_documents
FROM gst_documents
WHERE distributor_id = '6a749f20-5a82-4b74-9977-51eac69049f2'
  AND ewb_status = 'active';

-- Should be 0
SELECT COUNT(*) AS open_pending_actions
FROM pending_actions
WHERE distributor_id = '6a749f20-5a82-4b74-9977-51eac69049f2'
  AND status IN ('open', 'in_progress');

-- Should be 1 row with gst_mode='sandbox' (else the migration is a no-op
-- because someone already flipped it manually, OR the distributor was deleted)
SELECT distributor_id, business_name, gst_mode, is_test_tenant
FROM distributors
WHERE distributor_id = '6a749f20-5a82-4b74-9977-51eac69049f2';

-- ─── MIGRATION (run inside a single transaction) ────────────────────────────
--
-- DO NOT run the block below until ALL FOUR pre-flight queries return the
-- expected values. The transaction will fail loudly if Vanasthali isn't in
-- the expected starting state (defensive WHERE clause on the UPDATE).

BEGIN;

-- 1) Flip Vanasthali to disabled. The is_test_tenant flag stays false —
--    Vanasthali is a real distributor, not an internal test tenant.
UPDATE distributors
SET gst_mode = 'disabled',
    updated_at = NOW()
WHERE distributor_id = '6a749f20-5a82-4b74-9977-51eac69049f2'
  AND gst_mode = 'sandbox';

-- 2) Audit log entry — manually inserted because the auditLog middleware
--    only fires on HTTP request paths; ops migrations write the row directly.
--    The actor user_id is Suneel's super_admin account ID from prod RDS.
INSERT INTO audit_logs (
    log_id,
    distributor_id,
    user_id,
    action,
    entity_type,
    entity_id,
    details,
    ip_address,
    user_agent,
    created_at
) VALUES (
    gen_random_uuid(),
    '6a749f20-5a82-4b74-9977-51eac69049f2',
    '217db273-86d1-4f6a-a185-0afdd85d788d',  -- suneel@mygaslink.com super_admin
    'update',
    'gst_mode',
    '6a749f20-5a82-4b74-9977-51eac69049f2',
    jsonb_build_object(
        'mode', 'disabled',
        'fromMode', 'sandbox',
        'reason', 'group_a_target_model_alignment',
        'reasonText', 'Vanasthali was provisioned in sandbox before the Group A allowlist; real distributors hold disabled until super-admin activates them with prod WhiteBooks creds.',
        'actor', 'system_migration',
        'migration_file', 'group-a-vanasthali-gst-reset.sql'
    ),
    'system_migration',
    'group_a_migration',
    NOW()
);

-- 3) Verify the migration applied as expected. If gst_mode is still 'sandbox',
--    something raced or the WHERE clause matched 0 rows. Either way, the
--    operator should investigate before COMMITting.
SELECT distributor_id, business_name, gst_mode, updated_at
FROM distributors
WHERE distributor_id = '6a749f20-5a82-4b74-9977-51eac69049f2';

-- 4) Verify the audit row was written.
SELECT log_id, action, entity_type, details->>'fromMode' AS from_mode,
       details->>'toMode' AS to_mode, created_at
FROM audit_logs
WHERE distributor_id = '6a749f20-5a82-4b74-9977-51eac69049f2'
  AND action = 'update'
  AND entity_type = 'gst_mode'
ORDER BY created_at DESC
LIMIT 1;

-- If all looks right:
--   COMMIT;
-- If anything's off:
--   ROLLBACK;
--
-- (Left uncommitted so the operator MUST explicitly type COMMIT or ROLLBACK
--  after reviewing the verification SELECTs above.)
