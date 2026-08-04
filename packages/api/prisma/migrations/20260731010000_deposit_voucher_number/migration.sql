-- Change L v2 (2026-07-31): sequential voucher_number on deposit ledger rows.
-- Nullable + unique-per-distributor. Populated by paymentService.createPayment
-- (deposit branch) and refundDeposit inside their tx, using allocateNumber('V').
-- Legacy rows stay NULL and fall back to DEP-<uuid-prefix> at PDF render time.

ALTER TABLE "customer_ledger_entries"
  ADD COLUMN "voucher_number" TEXT;

CREATE UNIQUE INDEX "customer_ledger_entries_dist_voucher_key"
  ON "customer_ledger_entries" ("distributor_id", "voucher_number");
