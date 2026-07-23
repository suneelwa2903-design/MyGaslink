-- 2026-07-23 Mini-op #4 extension — supplier opening empties by cylinder type.
-- Parallels the customer inventoryBalances.opening_seed_qty axis on the
-- supplier side: at seed time, the operator records how many empties of
-- each type they physically owe the supplier at the moment tracking begins.
-- Zero-quantity rows are not persisted (skipped by the service).
CREATE TABLE "source_distributor_empty_openings" (
    "id"                    TEXT NOT NULL,
    "source_distributor_id" TEXT NOT NULL,
    "cylinder_type_id"      TEXT NOT NULL,
    "opening_seed_qty"      INTEGER NOT NULL DEFAULT 0,
    "created_at"            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "source_distributor_empty_openings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "source_distributor_empty_openings_source_distributor_id_cylinder_type_id_key"
  ON "source_distributor_empty_openings" ("source_distributor_id", "cylinder_type_id");

CREATE INDEX "source_distributor_empty_openings_source_distributor_id_idx"
  ON "source_distributor_empty_openings" ("source_distributor_id");

ALTER TABLE "source_distributor_empty_openings"
  ADD CONSTRAINT "source_distributor_empty_openings_source_distributor_id_fkey"
  FOREIGN KEY ("source_distributor_id") REFERENCES "source_distributors" ("source_distributor_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "source_distributor_empty_openings"
  ADD CONSTRAINT "source_distributor_empty_openings_cylinder_type_id_fkey"
  FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types" ("cylinder_type_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
