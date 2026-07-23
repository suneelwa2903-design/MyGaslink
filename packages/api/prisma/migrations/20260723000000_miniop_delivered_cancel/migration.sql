-- 2026-07-23 — Mini-operator delivered-order cancellation flow.
--
-- Adds columns to support the extended cancellation contract:
--   * Order.cancellation_type — one of the 5 audited types
--       (wrong_customer, damaged_returned, customer_refused,
--        duplicate_entry, other) — nullable so pre-existing rows
--       don't need backfill.
--   * Invoice.cancelled_at + cancellation_reason + cancellation_type —
--       matches Order-side cancellation columns so delivered-invoice
--       cancels carry the same audit trail.
--   * Customer.on_account_balance — credit accumulated when a
--       delivered-cancel reverses an already-applied payment.
--       Applied against the next invoice raised for the customer.
--
-- All additions are nullable / DEFAULT-safe so distributor tenants
-- (accountType='distributor') see NULL / 0 across the board and
-- the delivered-cancel path stays gated to accountType='mini_operator'
-- at the service layer.

ALTER TABLE "orders"
  ADD COLUMN "cancellation_type" VARCHAR(30) NULL;

ALTER TABLE "invoices"
  ADD COLUMN "cancelled_at" TIMESTAMPTZ NULL,
  ADD COLUMN "cancellation_reason" TEXT NULL,
  ADD COLUMN "cancellation_type" VARCHAR(30) NULL;

ALTER TABLE "customers"
  ADD COLUMN "on_account_balance" DECIMAL(12,2) NOT NULL DEFAULT 0;
