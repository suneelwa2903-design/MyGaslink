-- Group A: sandbox-mode allowlist. is_test_tenant gates which distributors
-- can hold gst_mode='sandbox'. Real distributors transition disabled → live
-- directly. dist-demo is the only initial true value.

ALTER TABLE "distributors"
  ADD COLUMN "is_test_tenant" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: dist-demo is the only test tenant.
UPDATE "distributors"
SET "is_test_tenant" = true
WHERE "distributor_id" = 'dist-demo';
