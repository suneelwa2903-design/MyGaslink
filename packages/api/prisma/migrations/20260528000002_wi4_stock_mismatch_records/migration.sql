-- WI-4 — Stock Mismatch Records (Report Mismatch + Mismatch Log).
--
-- One row per (mismatchType × cylinderType) line. All lines from a single
-- submission share a `report_id` UUID so the log can group them visually
-- if needed, while remaining independently filterable by cylinder/status.
--
-- All id columns in this codebase are TEXT (Prisma `String @id @default(uuid())`).

-- Enums
CREATE TYPE "MismatchType" AS ENUM ('empties_short', 'fulls_short', 'both');
CREATE TYPE "AccountableParty" AS ENUM ('driver', 'customer');
CREATE TYPE "MismatchResolutionAction" AS ENUM ('write_off', 'settle_against_due');
CREATE TYPE "MismatchStatus" AS ENUM ('open', 'resolved');

-- Table
CREATE TABLE "stock_mismatch_records" (
  "mismatch_id"         TEXT                       PRIMARY KEY,
  "report_id"           TEXT                       NOT NULL,
  "distributor_id"      TEXT                       NOT NULL,
  "vehicle_id"          TEXT                       NOT NULL,
  "vehicle_number"      TEXT                       NOT NULL,
  "driver_id"           TEXT,
  "customer_id"         TEXT,
  "trip_date"           DATE                       NOT NULL,
  "mismatch_type"       "MismatchType"             NOT NULL,
  "cylinder_type_id"    TEXT                       NOT NULL,
  "qty_unaccounted"     INTEGER                    NOT NULL,
  "unit_amount"         DECIMAL(12, 2)             NOT NULL,
  "total_amount"        DECIMAL(14, 2)             NOT NULL,
  "accountable_party"   "AccountableParty"         NOT NULL,
  "resolution_action"   "MismatchResolutionAction" NOT NULL,
  "resolution_notes"    TEXT                       NOT NULL,
  "status"              "MismatchStatus"           NOT NULL DEFAULT 'open',
  "resolved_at"         TIMESTAMP(3),
  "resolved_by"         TEXT,
  "created_by"          TEXT                       NOT NULL,
  "created_at"          TIMESTAMP(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3)               NOT NULL,

  CONSTRAINT "stock_mismatch_records_distributor_id_fkey"
    FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id"),
  CONSTRAINT "stock_mismatch_records_vehicle_id_fkey"
    FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("vehicle_id"),
  CONSTRAINT "stock_mismatch_records_cylinder_type_id_fkey"
    FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types"("cylinder_type_id"),
  CONSTRAINT "stock_mismatch_records_driver_id_fkey"
    FOREIGN KEY ("driver_id") REFERENCES "drivers"("driver_id"),
  CONSTRAINT "stock_mismatch_records_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id")
);

-- Indexes
CREATE INDEX "stock_mismatch_records_distributor_id_status_idx"
  ON "stock_mismatch_records"("distributor_id", "status");
CREATE INDEX "stock_mismatch_records_distributor_id_vehicle_id_idx"
  ON "stock_mismatch_records"("distributor_id", "vehicle_id");
CREATE INDEX "stock_mismatch_records_distributor_id_trip_date_idx"
  ON "stock_mismatch_records"("distributor_id", "trip_date");
CREATE INDEX "stock_mismatch_records_report_id_idx"
  ON "stock_mismatch_records"("report_id");
