-- 20260710000000_add_empties_return_ledger_type
--
-- Q3 follow-up to docs/INVESTIGATION-JUL09-B.md item 7.
--
-- Extends the LedgerEntryType enum with `empties_return`. Rows of this
-- type are pure stock movement (amountDelta=0, invoiceId=null) written
-- by emptiesReturnService.recordEmptiesReturn so the customer statement
-- and ledger view surface empties returns instead of only the daily
-- inventory summary. Impact analysis confirmed:
--   * Tally export does not read the ledger table — no accounting leak.
--   * computeCustomerOverdue reads Order + Invoice, not the ledger — no
--     overdue miscalculation.
--   * Payment allocation cannot target a stock-only row.
-- Adding an enum value is a safe additive schema change; existing rows
-- untouched. Uses ADD VALUE IF NOT EXISTS so re-runs on any environment
-- that already has it (via prisma migrate dev auto-sync) are a no-op.

ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'empties_return';
