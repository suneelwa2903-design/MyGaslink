-- 2026-07-23 — Supplier opening balance (MVP: ₹ axis).
--
-- Mini-op resellers migrating from a paper-ledger workflow need to
-- seed how much they already owe each supplier before the app takes
-- over. Same three-axis shape as customer OB — but this MVP delivers
-- the ₹ axis first (highest impact for supplier ledger recon). Empties
-- + preferred cylinder types will land in a follow-up alongside the
-- new supplier_inventory_balances table.
--
-- Fields added on source_distributors:
--   opening_balance_amount — ₹ amount ALREADY owed to the supplier at
--     the time this row was first seeded. Positive = we owe them.
--   opening_state_seeded_at — timestamp of the seed, doubles as an
--     idempotency guard on future Edit-later paths (same pattern as
--     customer_opening_state_seeded_at).
--
-- The seed writes a matching `purchase_entries` row with
-- is_opening_balance=TRUE + a `supplier_ledger_entries`-equivalent
-- carry-forward so the supplier ledger PDF shows an Opening Balance b/f
-- row at the top, mirroring the customer statement's OB block.

ALTER TABLE "source_distributors"
  ADD COLUMN "opening_balance_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "opening_state_seeded_at" TIMESTAMPTZ NULL;

-- Flag the OB purchase entry so supplier ledger reader can identify it
-- and emit the "Opening Balance b/f" row separately from delivery entries.
ALTER TABLE "purchase_entries"
  ADD COLUMN "is_opening_balance" BOOLEAN NOT NULL DEFAULT FALSE;
