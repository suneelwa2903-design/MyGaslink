-- Adds invoice_number + invoice_date to gaslink_billing_cycles so the SaaS
-- invoice number and issue date are ALLOCATED ONCE at cycle creation and
-- read from the row on every subsequent PDF render.
--
-- Fixes the pre-existing bug where allocateSaasInvoiceNumber() lived inside
-- generateBillingInvoicePdf and minted a fresh number from
-- SaasInvoiceCounter on every download. That produced 6 different invoice
-- numbers (IMGL2627002922..002927) for the single Kruthee July cycle and
-- would break GST Rule 46 (invoice serial must be stable per FY).
--
-- Companion cleanup script:
--   packages/api/scripts/saas-billing-compaction-2026-08-03.sql
-- documents the counter reset from 2927 back to 2923 and the pinning of
-- Kruthee's July cycle to IMGL2627002923 (the one the customer received).
--
-- Both columns nullable to keep the migration reversible; the service +
-- PDF layer populate them going forward and the compaction script
-- backfills the one live row.

ALTER TABLE "gaslink_billing_cycles"
  ADD COLUMN "invoice_number" TEXT,
  ADD COLUMN "invoice_date"   DATE;

CREATE UNIQUE INDEX "gaslink_billing_cycles_invoice_number_key"
  ON "gaslink_billing_cycles"("invoice_number");
