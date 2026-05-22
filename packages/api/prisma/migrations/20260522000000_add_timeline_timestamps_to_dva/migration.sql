-- WI-094: trip lifecycle timestamps on driver_vehicle_assignments.
-- Server-populated only (dispatchedAt on preflight success, returnedAt on
-- markVehicleReturned, reconciledAt on reconcileVehicle). All nullable —
-- additive, no backfill, no data loss.
ALTER TABLE "driver_vehicle_assignments"
  ADD COLUMN "dispatched_at" TIMESTAMP(3),
  ADD COLUMN "returned_at" TIMESTAMP(3),
  ADD COLUMN "reconciled_at" TIMESTAMP(3);
