-- WI-055: amount-based CN/DN modal redesign.
--
-- Adds an optional free-text "note" column to credit_notes and debit_notes
-- so the new modal can persist the customer-visible explanation alongside
-- the one-line `reason`. Nullable + no default — existing rows pre-dating
-- this column read back as NULL and the read path stays backward-compatible.

ALTER TABLE "credit_notes"
  ADD COLUMN "note" TEXT;

ALTER TABLE "debit_notes"
  ADD COLUMN "note" TEXT;
