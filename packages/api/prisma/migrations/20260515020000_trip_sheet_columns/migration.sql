-- WI-038: consolidated EWB / trip sheet columns on the day's
-- driver-vehicle assignment. Populated at the tail of pre-dispatch
-- preflight when 2+ orders generate per-order EWBs successfully.

ALTER TABLE "driver_vehicle_assignments"
  ADD COLUMN "trip_sheet_no" TEXT;

ALTER TABLE "driver_vehicle_assignments"
  ADD COLUMN "trip_sheet_generated_at" TIMESTAMP(3);
