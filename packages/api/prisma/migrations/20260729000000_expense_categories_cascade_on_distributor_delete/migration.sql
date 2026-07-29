-- 2026-07-29 — Cascade expense_categories on distributor hard-delete.
--
-- Before: ON DELETE RESTRICT — a distributor with any seeded category rows
-- could not be hard-deleted, blocking test cleanups that do
-- `prisma.distributor.deleteMany(...)`.
--
-- After: ON DELETE CASCADE. Semantic is correct — a distributor's
-- taxonomy is meaningless without the tenant, so when the tenant is
-- gone the taxonomy goes with it. Production distributors are always
-- soft-deleted via `deletedAt`, so this cascade only fires in tests
-- (and any hypothetical future admin-driven hard-delete flow, where
-- cascade is the wanted behavior anyway).
--
-- No data change. Only the constraint's ON DELETE action flips.

ALTER TABLE "expense_categories"
  DROP CONSTRAINT "expense_categories_distributor_id_fkey";

ALTER TABLE "expense_categories"
  ADD CONSTRAINT "expense_categories_distributor_id_fkey"
  FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
