-- 2026-07-20: optional per-membership alias for HQ portal display.
-- Nullable; readers fall back to customers.customer_name when NULL.
ALTER TABLE "customer_group_members"
  ADD COLUMN "display_name" VARCHAR(80);
