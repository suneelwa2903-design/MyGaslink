-- ─────────────────────────────────────────────────────────────────────────────
--  SaaS billing compaction — 2026-08-03
--
--  Background
--  ----------
--  Before migration 20260803000000_billing_invoice_number_and_date landed,
--  allocateSaasInvoiceNumber() ran INSIDE generateBillingInvoicePdf() — so
--  every download of a billing-cycle PDF minted a fresh IMGL number from
--  saas_invoice_counters. The Kruthee July 2026 cycle was rendered 6 times
--  between 2026-07-01 and 2026-08-03 12:15 IST, consuming sequences
--  002922..002927 for a single logical invoice.
--
--  Timeline (reconstructed from pm2 logs + counter state at 2026-08-03 06:45 UTC):
--    IMGL2627002922  early Jul 2026 (before log retention) — test render, never sent
--    IMGL2627002923  early Jul 2026 (before log retention) — SENT TO CUSTOMER
--    IMGL2627002924  2026-08-03 12:10:28 IST — test render, never sent
--    IMGL2627002925  2026-08-03 12:13:31 IST — test render, never sent
--    IMGL2627002926  2026-08-03 12:13:44 IST — test render, never sent
--    IMGL2627002927  2026-08-03 12:15:12 IST — test render, never sent
--
--  This script pins Kruthee's cycle to IMGL2627002923 (the number the
--  customer received), discards the 5 orphan sequences (all had byte-
--  identical PDF bodies — only the top-right invoice number differed),
--  and resets saas_invoice_counters so the NEXT allocation returns 002924.
--  Under GST Rule 46 the FY 2627 series will read as
--  IMGL2627002921 (seed) → 002923 (Kruthee, live) → 002924 (next real
--  issuance). The 5 orphan numbers are documented here rather than in
--  the ledger because none reached a customer, appeared in GSTR-1, or
--  triggered a GST-portal upload.
--
--  Also removes the Vanasthali August 2026 cycle (id 3d9e106c-…-110cf5,
--  created 2026-08-03 12:11 IST while investigating the number-mint bug).
--  Never downloaded, never sent — safe to delete. Suneel will regenerate
--  after the code fix ships; the next allocation will assign 002924.
--
--  Prerequisites
--  -------------
--    1. Migration 20260803000000_billing_invoice_number_and_date applied
--       (adds gaslink_billing_cycles.invoice_number + invoice_date).
--    2. Deploy of billingService.generateBillingCycle + billingInvoicePdfService
--       so future generation stamps invoice_number/invoice_date at create time.
--
--  Run once, in a single transaction, against production RDS from the EC2
--  bastion via psql.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Guard: fail loudly if migration hasn't been applied yet.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'gaslink_billing_cycles'
       AND column_name = 'invoice_number'
  ) THEN
    RAISE EXCEPTION 'Migration 20260803000000_billing_invoice_number_and_date has not been applied. Aborting compaction.';
  END IF;
END $$;

-- 1) Delete the unwanted Vanasthali August cycle. Items first (FK).
DELETE FROM gaslink_billing_items
 WHERE billing_cycle_id = '3d9e106c-13f5-4689-945a-6e65f1110cf5';

DELETE FROM gaslink_billing_cycles
 WHERE cycle_id = '3d9e106c-13f5-4689-945a-6e65f1110cf5';

-- 2) Pin Kruthee July cycle to the number the customer actually received.
UPDATE gaslink_billing_cycles
   SET invoice_number = 'IMGL2627002923',
       invoice_date   = DATE '2026-07-01'
 WHERE cycle_id = 'c5980388-b8a2-4f86-99af-cbc8c3aa0eec';

-- 3) Reset counter so the next allocation returns 2924.
UPDATE saas_invoice_counters
   SET last_sequence = 2923,
       updated_at    = NOW()
 WHERE financial_year = '2627';

-- 4) Sanity check — exactly one live cycle should carry an IMGL number
--    (Kruthee 002923); the counter's last_sequence should equal 2923.
DO $$
DECLARE
  cycle_number TEXT;
  seq          INT;
BEGIN
  SELECT invoice_number INTO cycle_number
    FROM gaslink_billing_cycles
   WHERE cycle_id = 'c5980388-b8a2-4f86-99af-cbc8c3aa0eec';
  IF cycle_number IS DISTINCT FROM 'IMGL2627002923' THEN
    RAISE EXCEPTION 'Post-check failed: Kruthee cycle invoice_number = %, expected IMGL2627002923', cycle_number;
  END IF;

  SELECT last_sequence INTO seq
    FROM saas_invoice_counters
   WHERE financial_year = '2627';
  IF seq <> 2923 THEN
    RAISE EXCEPTION 'Post-check failed: FY 2627 last_sequence = %, expected 2923', seq;
  END IF;
END $$;

COMMIT;
