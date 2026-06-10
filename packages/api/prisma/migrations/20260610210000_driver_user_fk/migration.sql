-- Group B Part 3 — explicit Driver→User FK.
--
-- Pre-flight (manual): scripts/inspect-driver-user-population.ts ran clean
-- after the 229-row test-fixture cleanup. Remaining state:
--   * 6 live drivers (3 with matching driver-role User by phone, 3 orphan)
--   * 0 duplicate phones, 0 ambiguous matches.
-- Orphans get user_id=NULL after backfill — that's the intended model.
--
-- Effect:
--   1. Add nullable user_id column to drivers.
--   2. Unique index so 1:0..1 is enforced at the DB layer.
--   3. FK to users(user_id) with ON DELETE SET NULL — deleting a user
--      detaches the driver row (it does NOT cascade-delete the driver).
--   4. Backfill via the same phone+distributor_id+role='driver' join the
--      legacy resolveDriverFromUser() function uses. Orphans stay NULL.

ALTER TABLE "drivers" ADD COLUMN "user_id" TEXT;

CREATE UNIQUE INDEX "drivers_user_id_key" ON "drivers"("user_id");

ALTER TABLE "drivers"
  ADD CONSTRAINT "drivers_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("user_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill — phone+distributor_id is the canonical implicit join key. Only
-- match against live (not soft-deleted) users with role='driver'. A driver
-- with no matching user stays user_id=NULL.
UPDATE "drivers" d
SET    "user_id" = u."user_id"
FROM   "users" u
WHERE  u."phone" = d."phone"
  AND  u."distributor_id" = d."distributor_id"
  AND  u."role" = 'driver'
  AND  u."deleted_at" IS NULL
  AND  d."deleted_at" IS NULL
  AND  d."user_id" IS NULL;
