-- F8 Supplier Ledger (2026-08-06)
-- See docs/F8-SUPPLIER-LEDGER-DESIGN.md for the full spec.
--
-- Pure additive migration. Zero destructive DDL. Existing rows/columns
-- untouched. Rollback = drop the 3 new tables + drop the 2 new enums +
-- drop the 2 new PurchaseEntry columns (safe to reverse — no data
-- backfill required beyond the auto-seed script in Slice 1).

-- ─── 1. New enums ──────────────────────────────────────────────────────────
CREATE TYPE "PurchaseEntryChargeType" AS ENUM (
  'freight',
  'handling',
  'testing',
  'insurance',
  'other'
);

CREATE TYPE "PurchaseCreditNoteReason" AS ENUM (
  'volume_incentive',
  'quality_incentive',
  'scheme_incentive',
  'rate_differential',
  'freight_reimbursement',
  'other'
);

-- ─── 2. Extend PurchaseEntry — OMC-side reference fields ───────────────────
-- Nullable so pre-F8 rows (mini-op purchase entries and F1 opening-balance
-- synthetic rows) stay valid. The supplier statement PDF falls back to
-- `purchase_number` when `supplier_document_number` is NULL.
ALTER TABLE "purchase_entries"
  ADD COLUMN "supplier_document_number" TEXT,
  ADD COLUMN "supplier_document_date"   TEXT;

-- ─── 3. purchase_entry_charges — freight / handling / testing lines ────────
CREATE TABLE "purchase_entry_charges" (
  "purchase_entry_charge_id" TEXT NOT NULL,
  "purchase_entry_id"        TEXT NOT NULL,
  "charge_type"              "PurchaseEntryChargeType" NOT NULL,
  "amount"                   DECIMAL(18, 4) NOT NULL,
  "notes"                    TEXT,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "purchase_entry_charges_pkey" PRIMARY KEY ("purchase_entry_charge_id")
);

CREATE INDEX "purchase_entry_charges_purchase_entry_id_idx"
  ON "purchase_entry_charges"("purchase_entry_id");

ALTER TABLE "purchase_entry_charges"
  ADD CONSTRAINT "purchase_entry_charges_purchase_entry_id_fkey"
  FOREIGN KEY ("purchase_entry_id") REFERENCES "purchase_entries"("purchase_entry_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 4. purchase_credit_notes — supplier-side CN header ────────────────────
CREATE TABLE "purchase_credit_notes" (
  "purchase_credit_note_id"   TEXT NOT NULL,
  "distributor_id"            TEXT NOT NULL,
  "source_distributor_id"     TEXT NOT NULL,
  "source_distributor_name"   TEXT,
  "credit_note_number"        TEXT NOT NULL,
  "supplier_document_number"  TEXT,
  "credit_note_date"          TEXT NOT NULL,
  "received_date"             TEXT NOT NULL,
  "total_amount"              DECIMAL(18, 4) NOT NULL,
  "reason"                    "PurchaseCreditNoteReason" NOT NULL DEFAULT 'other',
  "notes"                     TEXT,
  "created_by"                TEXT NOT NULL,
  "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                TIMESTAMP(3) NOT NULL,
  "deleted_at"                TIMESTAMP(3),

  CONSTRAINT "purchase_credit_notes_pkey" PRIMARY KEY ("purchase_credit_note_id")
);

CREATE UNIQUE INDEX "purchase_credit_notes_distributor_id_credit_note_number_key"
  ON "purchase_credit_notes"("distributor_id", "credit_note_number");

CREATE INDEX "purchase_credit_notes_dist_source_date_idx"
  ON "purchase_credit_notes"("distributor_id", "source_distributor_id", "credit_note_date" DESC);

ALTER TABLE "purchase_credit_notes"
  ADD CONSTRAINT "purchase_credit_notes_distributor_id_fkey"
  FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_credit_notes"
  ADD CONSTRAINT "purchase_credit_notes_source_distributor_id_fkey"
  FOREIGN KEY ("source_distributor_id") REFERENCES "source_distributors"("source_distributor_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 5. purchase_credit_note_allocations — per-PurchaseEntry alloc rows ───
CREATE TABLE "purchase_credit_note_allocations" (
  "purchase_credit_note_allocation_id" TEXT NOT NULL,
  "purchase_credit_note_id"            TEXT NOT NULL,
  "purchase_entry_id"                  TEXT NOT NULL,
  "amount"                             DECIMAL(18, 4) NOT NULL,
  "created_at"                         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "purchase_credit_note_allocations_pkey" PRIMARY KEY ("purchase_credit_note_allocation_id")
);

CREATE INDEX "purchase_credit_note_allocations_credit_note_id_idx"
  ON "purchase_credit_note_allocations"("purchase_credit_note_id");

CREATE INDEX "purchase_credit_note_allocations_purchase_entry_id_idx"
  ON "purchase_credit_note_allocations"("purchase_entry_id");

ALTER TABLE "purchase_credit_note_allocations"
  ADD CONSTRAINT "purchase_credit_note_allocations_credit_note_id_fkey"
  FOREIGN KEY ("purchase_credit_note_id") REFERENCES "purchase_credit_notes"("purchase_credit_note_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "purchase_credit_note_allocations"
  ADD CONSTRAINT "purchase_credit_note_allocations_purchase_entry_id_fkey"
  FOREIGN KEY ("purchase_entry_id") REFERENCES "purchase_entries"("purchase_entry_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Rollback (destructive) ────────────────────────────────────────────────
-- DROP TABLE IF EXISTS "purchase_credit_note_allocations";
-- DROP TABLE IF EXISTS "purchase_credit_notes";
-- DROP TABLE IF EXISTS "purchase_entry_charges";
-- ALTER TABLE "purchase_entries" DROP COLUMN IF EXISTS "supplier_document_date";
-- ALTER TABLE "purchase_entries" DROP COLUMN IF EXISTS "supplier_document_number";
-- DROP TYPE IF EXISTS "PurchaseCreditNoteReason";
-- DROP TYPE IF EXISTS "PurchaseEntryChargeType";
