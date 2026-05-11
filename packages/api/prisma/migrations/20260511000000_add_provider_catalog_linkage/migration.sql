-- Add optional FK from cylinder_types -> provider_catalog_cylinder_types so
-- tenant cylinder types can be traced back to the global IOCL/HPCL/etc.
-- catalog rows they were imported from. Nullable for legacy + bespoke rows.

ALTER TABLE "cylinder_types"
  ADD COLUMN "provider_catalog_id" TEXT;

CREATE INDEX "cylinder_types_provider_catalog_id_idx"
  ON "cylinder_types"("provider_catalog_id");

ALTER TABLE "cylinder_types"
  ADD CONSTRAINT "cylinder_types_provider_catalog_id_fkey"
  FOREIGN KEY ("provider_catalog_id")
  REFERENCES "provider_catalog_cylinder_types"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
