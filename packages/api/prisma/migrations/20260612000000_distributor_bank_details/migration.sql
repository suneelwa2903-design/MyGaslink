-- Phase 3 (2026-06-12) — bank + UPI payment details on Distributor.
-- Surfaced on invoice and customer-ledger PDFs so end customers know
-- where to pay. All five columns nullable; the PDF render path checks
-- `bank_account_number IS NOT NULL AND ifsc_code IS NOT NULL` before
-- emitting the "Payment Details" block. UPI line appended only when
-- `upi_id` is also set. IFSC + UPI format checks live in the API zod
-- schema (shared/src/schemas) — NOT at the DB level — so legacy data
-- imports can't accidentally fail the migration.

ALTER TABLE "distributors"
  ADD COLUMN "bank_name"           TEXT,
  ADD COLUMN "bank_account_number" TEXT,
  ADD COLUMN "bank_branch_name"    TEXT,
  ADD COLUMN "ifsc_code"           TEXT,
  ADD COLUMN "upi_id"              TEXT;
