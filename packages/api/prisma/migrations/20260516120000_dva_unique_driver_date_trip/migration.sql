-- WI-061: enforce (driver_id, assignment_date, trip_number) uniqueness on
-- driver_vehicle_assignments. The original design assumed preflight would
-- always reuse the existing row (incrementing trip_number in place), but
-- nothing enforced it. The dev DB accumulated 4 rows for a single
-- (driver, date) because callers used `INSERT … ON CONFLICT DO NOTHING`
-- on a non-existent conflict target, so DO NOTHING never fired.
--
-- Defensive cleanup BEFORE the index so we don't fail on existing dups.
-- Keep the earliest row per natural-key tuple (it has the oldest history
-- and is the one preflightDispatch has been incrementing in place).

DELETE FROM driver_vehicle_assignments a USING (
  SELECT MIN(created_at) AS keep_at, driver_id, assignment_date, trip_number
  FROM driver_vehicle_assignments
  GROUP BY driver_id, assignment_date, trip_number
  HAVING COUNT(*) > 1
) dups
WHERE a.driver_id = dups.driver_id
  AND a.assignment_date = dups.assignment_date
  AND a.trip_number = dups.trip_number
  AND a.created_at > dups.keep_at;

CREATE UNIQUE INDEX "driver_vehicle_assignments_driver_id_assignment_date_trip_number_key"
  ON "driver_vehicle_assignments" ("driver_id", "assignment_date", "trip_number");
