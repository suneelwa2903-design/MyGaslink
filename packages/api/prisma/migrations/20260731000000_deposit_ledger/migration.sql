-- Deposit Ledger — 2026-07-31
--
-- Adds two entry types to LedgerEntryType so a "cylinder deposit charged"
-- and a "cylinder deposit refunded" event can be persisted alongside the
-- normal invoice/payment/credit-note rows. Attributes deposit rows to a
-- specific cylinder_type + qty so the ledger renderer can show per-type
-- breakdowns without a parallel table.
--
-- Design rationale (see CLAUDE.md conversation 2026-07-31):
--   - No touching PaymentAllocation or PaymentTransaction (anti-pattern
--     #24 blast-radius avoidance). Payments stay pure money events; the
--     deposit is a companion ledger row on the SAME transaction.
--   - Customer.depositBalance is NOT stored — it's computed as
--     sum(deposit_charged.amountDelta) - sum(deposit_refunded.amountDelta)
--     from customer_ledger_entries. Source of truth = the ledger table.
--   - cylinder_type_id + qty_delta on customer_ledger_entries are OPTIONAL
--     (NULL for existing invoice/payment/credit-note rows). Only deposit
--     and empties_return rows populate them.

-- 1. New enum values
ALTER TYPE "LedgerEntryType" ADD VALUE 'deposit_charged';
ALTER TYPE "LedgerEntryType" ADD VALUE 'deposit_refunded';

-- 2. Optional per-cylinder-type attribution on customer_ledger_entries
ALTER TABLE "customer_ledger_entries"
  ADD COLUMN "cylinder_type_id" TEXT,
  ADD COLUMN "qty_delta" INTEGER;

ALTER TABLE "customer_ledger_entries"
  ADD CONSTRAINT "customer_ledger_entries_cylinder_type_id_fkey"
    FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types"("cylinder_type_id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Index for the per-customer, per-type deposit breakdown query.
-- Partial index — only rows with cylinder_type_id populated (deposit +
-- empties_return rows), keeps the index tiny even at scale.
CREATE INDEX "customer_ledger_entries_customer_id_cylinder_type_id_idx"
  ON "customer_ledger_entries" ("customer_id", "cylinder_type_id")
  WHERE "cylinder_type_id" IS NOT NULL;
