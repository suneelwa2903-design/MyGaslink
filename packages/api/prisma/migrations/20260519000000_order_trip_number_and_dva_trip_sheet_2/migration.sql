-- WI-065: Add to Trip + tripNumber stamping
--
-- 1. orders.trip_number — per-order trip identifier stamped by
--    preflightOne when the order transitions to pending_delivery.
--    Replaces the brittle `updatedAt >= dva.updatedAt` filter for the
--    trip-sheet PDF. NULL for orders dispatched before WI-065 shipped.
--
-- 2. driver_vehicle_assignments.trip_sheet_no_2 + trip_sheet_no_2_generated_at
--    — Add-to-Trip generates a SECOND consolidated EWB covering the
--    mid-trip batch. NIC's gencewb endpoint has no "append" — once a
--    CEWB is generated it is sealed, so a fresh CEWB per batch is the
--    only legal path. Stays NULL when only one batch was dispatched.
--
-- Both columns are additive and nullable; no backfill required.

ALTER TABLE orders
  ADD COLUMN trip_number INTEGER;

ALTER TABLE driver_vehicle_assignments
  ADD COLUMN trip_sheet_no_2 TEXT,
  ADD COLUMN trip_sheet_no_2_generated_at TIMESTAMP(3);
