-- Phase 5 (2026-06-12) — GSTR-1 export columns.
--
-- Adds 11 nullable columns to invoices / invoice_items / credit_notes
-- so the GSTR-1 export service (next sprint) can pull schema-native data
-- instead of re-deriving values from JOINed customer rows that may have
-- drifted since issue. Every column is nullable on historical rows; the
-- backfill script at packages/api/scripts/gstr1-backfill.ts (dry-run by
-- default) can populate them for prod data when Suneel decides to run it.
--
-- DebitNotes are NOT included in this phase per Suneel's spec — they're
-- far less common in the codebase and the GSTR-1 9B export can derive
-- DN tax splits from the original invoice for the rare case until the
-- DN-equivalent columns are added in a follow-up.

ALTER TABLE "invoices"
  ADD COLUMN "taxable_value"           DECIMAL(18, 4),
  ADD COLUMN "place_of_supply_code"    TEXT,
  ADD COLUMN "reverse_charge"          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "customer_gstin_snapshot" TEXT;

ALTER TABLE "invoice_items"
  ADD COLUMN "taxable_value" DECIMAL(18, 4),
  ADD COLUMN "uom"           TEXT NOT NULL DEFAULT 'NOS';

ALTER TABLE "credit_notes"
  ADD COLUMN "taxable_value" DECIMAL(18, 4),
  ADD COLUMN "cgst_value"    DECIMAL(18, 4),
  ADD COLUMN "sgst_value"    DECIMAL(18, 4),
  ADD COLUMN "igst_value"    DECIMAL(18, 4),
  ADD COLUMN "reason_code"   TEXT;
