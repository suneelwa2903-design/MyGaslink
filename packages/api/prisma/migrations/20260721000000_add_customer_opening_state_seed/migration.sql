-- 2026-07-21 Customer opening-state seed:
--   1. customers.opening_state_seeded_at — audit marker "did we run
--      the opening-state seed step on this customer?"
--   2. customer_allowed_cylinder_types — per-customer cylinder-type
--      *preference* list (semantics finalised 2026-07-21 evening:
--      table name kept for physical stability, but readers treat it
--      as a SORT hint on the order-form picker, NOT as a hard filter).

ALTER TABLE "customers"
  ADD COLUMN "opening_state_seeded_at" TIMESTAMP(3);

CREATE TABLE "customer_allowed_cylinder_types" (
  "customer_allowed_cylinder_type_id" TEXT NOT NULL,
  "customer_id" TEXT NOT NULL,
  "cylinder_type_id" TEXT NOT NULL,
  "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_allowed_cylinder_types_pkey" PRIMARY KEY ("customer_allowed_cylinder_type_id")
);

CREATE UNIQUE INDEX "customer_allowed_cylinder_types_customer_id_cylinder_type_id_key"
  ON "customer_allowed_cylinder_types"("customer_id", "cylinder_type_id");

CREATE INDEX "customer_allowed_cylinder_types_cylinder_type_id_idx"
  ON "customer_allowed_cylinder_types"("cylinder_type_id");

ALTER TABLE "customer_allowed_cylinder_types"
  ADD CONSTRAINT "customer_allowed_cylinder_types_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id")
  ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "customer_allowed_cylinder_types"
  ADD CONSTRAINT "customer_allowed_cylinder_types_cylinder_type_id_fkey"
  FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types"("cylinder_type_id")
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- Opening-empties snapshot: immutable per-cylinder-type count captured
-- at seed-time. Ledger OB row Pend E column reads this so the running
-- count starts from the correct baseline (not zero) on subsequent
-- delivery rows.
ALTER TABLE "customer_inventory_balances"
  ADD COLUMN "opening_seed_qty" INTEGER NOT NULL DEFAULT 0;
