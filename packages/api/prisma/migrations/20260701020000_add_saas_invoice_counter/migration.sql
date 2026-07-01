-- Platform-level SaaS invoice counter (Gaslink Consulting Solutions
-- billing distributor customers). One row per financial year.
CREATE TABLE "saas_invoice_counters" (
  "counter_id"     TEXT NOT NULL,
  "financial_year" TEXT NOT NULL,
  "last_sequence"  INTEGER NOT NULL DEFAULT 0,
  "updated_at"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "saas_invoice_counters_pkey" PRIMARY KEY ("counter_id")
);
CREATE UNIQUE INDEX "saas_invoice_counters_financial_year_key"
  ON "saas_invoice_counters" ("financial_year");

-- Seed FY 2627 (Apr 2026 – Mar 2027) at 2921 so the first allocation
-- returns 2922 (matches Suneel's IMGL2627002922 starting number).
INSERT INTO "saas_invoice_counters"
  ("counter_id", "financial_year", "last_sequence", "updated_at")
VALUES
  ('sic_fy2627', '2627', 2921, NOW());
