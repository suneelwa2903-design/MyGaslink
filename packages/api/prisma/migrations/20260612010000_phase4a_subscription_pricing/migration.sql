-- Phase 4a (2026-06-12) — subscription pricing schema refresh.
--
-- 1. Adds 'ultra' to subscription_plan enum so distributors above 50k
--    cylinders/month can be assigned to it.
-- 2. Adds per-role addon pricing columns + customer-portal free-tier
--    cap. Defaults match the new pricing structure (Phase 4a seed):
--      extraSeatPriceAdmin    ₹999  (was ₹299)
--      extraSeatPriceDriver   ₹299  (was ₹99)
--      extraSeatPriceFinance  ₹499  (new)
--      extraSeatPriceInventory ₹499 (new)
--      extraSeatPriceCustomer ₹249  (new — was implicit-via-admin)
--      freeCustomerLogins     5     (new)
--
-- Decision (Suneel, 2026-06-12): only the schema shape changes here.
-- Existing pricing_tiers rows in PROD stay on their old values until the
-- super-admin runs the seed manually. This migration is safe to apply
-- against prod RDS — no UPDATE statements touch existing rows.

ALTER TYPE "subscription_plan" ADD VALUE IF NOT EXISTS 'ultra';

ALTER TABLE "pricing_tiers"
  ADD COLUMN "extra_seat_price_finance"   DECIMAL(18, 4) NOT NULL DEFAULT 499,
  ADD COLUMN "extra_seat_price_inventory" DECIMAL(18, 4) NOT NULL DEFAULT 499,
  ADD COLUMN "extra_seat_price_customer"  DECIMAL(18, 4) NOT NULL DEFAULT 249,
  ADD COLUMN "free_customer_logins"       INTEGER NOT NULL DEFAULT 5;

-- Per-Suneel decision (2026-06-12): the new default values for
-- extra_seat_price_admin (999) and extra_seat_price_driver (299) ONLY
-- affect rows created from this migration onward. Existing dev / prod
-- rows keep their old defaults until the seed is re-run. See seed.ts.
ALTER TABLE "pricing_tiers"
  ALTER COLUMN "extra_seat_price_admin" SET DEFAULT 999,
  ALTER COLUMN "extra_seat_price_driver" SET DEFAULT 299;
