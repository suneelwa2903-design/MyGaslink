-- Phase 2 Report Builder — SavedReport + SavedReportRun tables.
--
-- Design: SavedReport stores a user-authored ReportBuilderSpec (JSONB).
-- Tenant scope + role gate enforced by the server on every read/write.
-- SavedReportRun logs each execution for audit + future throttling.
--
-- No CHECK constraints on `visibility` / `model` — enforced at the
-- application layer (Zod on write, allowlist on read). Keeping the
-- schema flexible so we can add new models without a migration.

CREATE TABLE "saved_reports" (
  "saved_report_id" TEXT NOT NULL,
  "distributor_id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "model" TEXT NOT NULL,
  "spec" JSONB NOT NULL,
  "visibility" TEXT NOT NULL DEFAULT 'private',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),

  CONSTRAINT "saved_reports_pkey" PRIMARY KEY ("saved_report_id")
);

CREATE INDEX "saved_reports_distributor_id_owner_id_idx"
  ON "saved_reports"("distributor_id", "owner_id");

CREATE INDEX "saved_reports_distributor_id_visibility_idx"
  ON "saved_reports"("distributor_id", "visibility");

ALTER TABLE "saved_reports"
  ADD CONSTRAINT "saved_reports_distributor_id_fkey"
  FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "saved_reports"
  ADD CONSTRAINT "saved_reports_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "users"("user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "saved_report_runs" (
  "saved_report_run_id" TEXT NOT NULL,
  "saved_report_id" TEXT NOT NULL,
  "run_by" TEXT NOT NULL,
  "ran_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "duration_ms" INTEGER NOT NULL,
  "row_count" INTEGER NOT NULL,

  CONSTRAINT "saved_report_runs_pkey" PRIMARY KEY ("saved_report_run_id")
);

CREATE INDEX "saved_report_runs_saved_report_id_ran_at_idx"
  ON "saved_report_runs"("saved_report_id", "ran_at" DESC);

ALTER TABLE "saved_report_runs"
  ADD CONSTRAINT "saved_report_runs_saved_report_id_fkey"
  FOREIGN KEY ("saved_report_id") REFERENCES "saved_reports"("saved_report_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
