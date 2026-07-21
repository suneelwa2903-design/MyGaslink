-- 2026-07-21 Mini-Operator opening state seed:
--   1. Adds customers.opening_state_seeded_at as audit marker for
--      "did we run the reseller opening setup on this customer?"
--   2. Adds customer_allowed_cylinder_types join table (per-customer
--      cylinder-type allowlist for the order/delivery form picker).

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
