-- 2026-08-01 — preserve empty-cylinder-price history.
--
-- Before: (distributor_id, cylinder_type_id) was UNIQUE; every save was
-- an UPSERT and history was destroyed. Aligns the model with
-- cylinder_prices, which stores every row and reads the most-recent
-- effective_date on-or-before target.

-- 1. Add the new column, nullable initially so existing rows survive.
ALTER TABLE "empty_cylinder_prices"
  ADD COLUMN "effective_date" DATE;

-- 2. Backfill existing rows: use created_at::date as the effective_date.
UPDATE "empty_cylinder_prices"
   SET "effective_date" = "created_at"::date
 WHERE "effective_date" IS NULL;

-- 3. Now enforce NOT NULL.
ALTER TABLE "empty_cylinder_prices"
  ALTER COLUMN "effective_date" SET NOT NULL;

-- 4. Drop the old (distributor, type) uniqueness — a distributor now
--    holds N rows per cylinder type (one per effective date). Prisma's
--    @@unique(...) may materialise as either a CONSTRAINT or a UNIQUE
--    INDEX depending on how it was declared; drop both variants.
ALTER TABLE "empty_cylinder_prices"
  DROP CONSTRAINT IF EXISTS "empty_cylinder_prices_distributor_id_cylinder_type_id_key";
DROP INDEX IF EXISTS "empty_cylinder_prices_distributor_id_cylinder_type_id_key";

-- 5. Index matching the CylinderPrice model — supports the
--    getEffectiveEmptyPrice read: WHERE distributor_id=? AND cylinder_type_id=?
--    AND effective_date <= ? ORDER BY effective_date DESC, created_at DESC.
CREATE INDEX IF NOT EXISTS "empty_cylinder_prices_distributor_id_cylinder_type_id_effective_date_idx"
  ON "empty_cylinder_prices" ("distributor_id", "cylinder_type_id", "effective_date" DESC);
