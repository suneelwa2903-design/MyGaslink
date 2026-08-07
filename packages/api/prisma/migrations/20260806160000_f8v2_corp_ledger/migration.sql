-- F8 v2 Corporation Ledger (2026-08-06)
-- See docs/F8-V2-DESIGN.md for the full spec.
--
-- Pure additive migration. Zero destructive DDL. Backward-compatible:
-- pre-v2 PurchaseEntry rows land with documentType='invoice' (default)
-- and gstRate=0 on their items. Reverses cleanly by dropping new columns
-- + tables + enums.

-- ─── 1. New enums ──────────────────────────────────────────────────────────
CREATE TYPE "PurchaseDocumentType" AS ENUM (
  'invoice',
  'deposit_invoice'
);

CREATE TYPE "PurchaseDebitNoteReason" AS ENUM (
  'short_supply',
  'damaged_at_plant',
  'late_payment_interest',
  'rate_differential',
  'other'
);

-- ─── 2. Extend PurchaseEntry — v2 fields ───────────────────────────────────
ALTER TABLE "purchase_entries"
  ADD COLUMN "plant_name"    TEXT,
  ADD COLUMN "document_type" "PurchaseDocumentType" NOT NULL DEFAULT 'invoice';

-- ─── 3. Extend PurchaseEntryItem — per-line GST rate ───────────────────────
ALTER TABLE "purchase_entry_items"
  ADD COLUMN "gst_rate" DECIMAL(5, 2) NOT NULL DEFAULT 0;

-- ─── 4. purchase_debit_notes — supplier-side DN header ─────────────────────
CREATE TABLE "purchase_debit_notes" (
  "purchase_debit_note_id"    TEXT NOT NULL,
  "distributor_id"            TEXT NOT NULL,
  "source_distributor_id"     TEXT NOT NULL,
  "source_distributor_name"   TEXT,
  "debit_note_number"         TEXT NOT NULL,
  "supplier_document_number"  TEXT,
  "debit_note_date"           TEXT NOT NULL,
  "received_date"             TEXT NOT NULL,
  "total_amount"              DECIMAL(18, 4) NOT NULL,
  "reason"                    "PurchaseDebitNoteReason" NOT NULL DEFAULT 'other',
  "notes"                     TEXT,
  "created_by"                TEXT NOT NULL,
  "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                TIMESTAMP(3) NOT NULL,
  "deleted_at"                TIMESTAMP(3),

  CONSTRAINT "purchase_debit_notes_pkey" PRIMARY KEY ("purchase_debit_note_id")
);

CREATE UNIQUE INDEX "purchase_debit_notes_distributor_id_debit_note_number_key"
  ON "purchase_debit_notes"("distributor_id", "debit_note_number");

CREATE INDEX "purchase_debit_notes_dist_source_date_idx"
  ON "purchase_debit_notes"("distributor_id", "source_distributor_id", "debit_note_date" DESC);

ALTER TABLE "purchase_debit_notes"
  ADD CONSTRAINT "purchase_debit_notes_distributor_id_fkey"
  FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_debit_notes"
  ADD CONSTRAINT "purchase_debit_notes_source_distributor_id_fkey"
  FOREIGN KEY ("source_distributor_id") REFERENCES "source_distributors"("source_distributor_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 5. purchase_debit_note_allocations ────────────────────────────────────
CREATE TABLE "purchase_debit_note_allocations" (
  "purchase_debit_note_allocation_id" TEXT NOT NULL,
  "purchase_debit_note_id"            TEXT NOT NULL,
  "purchase_entry_id"                 TEXT NOT NULL,
  "amount"                            DECIMAL(18, 4) NOT NULL,
  "created_at"                        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "purchase_debit_note_allocations_pkey" PRIMARY KEY ("purchase_debit_note_allocation_id")
);

CREATE INDEX "purchase_debit_note_allocations_debit_note_id_idx"
  ON "purchase_debit_note_allocations"("purchase_debit_note_id");

CREATE INDEX "purchase_debit_note_allocations_purchase_entry_id_idx"
  ON "purchase_debit_note_allocations"("purchase_entry_id");

ALTER TABLE "purchase_debit_note_allocations"
  ADD CONSTRAINT "purchase_debit_note_allocations_debit_note_id_fkey"
  FOREIGN KEY ("purchase_debit_note_id") REFERENCES "purchase_debit_notes"("purchase_debit_note_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "purchase_debit_note_allocations"
  ADD CONSTRAINT "purchase_debit_note_allocations_purchase_entry_id_fkey"
  FOREIGN KEY ("purchase_entry_id") REFERENCES "purchase_entries"("purchase_entry_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Rollback (destructive) ────────────────────────────────────────────────
-- DROP TABLE IF EXISTS "purchase_debit_note_allocations";
-- DROP TABLE IF EXISTS "purchase_debit_notes";
-- ALTER TABLE "purchase_entry_items" DROP COLUMN IF EXISTS "gst_rate";
-- ALTER TABLE "purchase_entries" DROP COLUMN IF EXISTS "document_type";
-- ALTER TABLE "purchase_entries" DROP COLUMN IF EXISTS "plant_name";
-- DROP TYPE IF EXISTS "PurchaseDebitNoteReason";
-- DROP TYPE IF EXISTS "PurchaseDocumentType";
