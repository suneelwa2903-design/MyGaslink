-- WI Tally Setup (2026-06-17) — per-tenant Tally accounting export config.
--
-- One row per distributor (unique on distributor_id). All ledger / voucher
-- columns have defaults matching Tally's stock Chart of Accounts so a
-- distributor whose Tally was installed with defaults gets a working
-- export without ever opening this row. `cylinder_stock_items` is a
-- JSON map of CylinderType.id → Tally stock item name; missing keys
-- fall back to invoice_items.description at export time (which also
-- handles non-cylinder line items with NULL cylinder_type_id, such as
-- transport charges or ad-hoc fees).

CREATE TABLE "tally_settings" (
  "tally_settings_id"         TEXT    NOT NULL,
  "distributor_id"            TEXT    NOT NULL,
  "tally_version"             TEXT    NOT NULL DEFAULT 'prime',
  "tally_company_name"        TEXT,
  "ledger_sales"              TEXT    NOT NULL DEFAULT 'Sales',
  "ledger_cgst"               TEXT    NOT NULL DEFAULT 'Output CGST',
  "ledger_sgst"               TEXT    NOT NULL DEFAULT 'Output SGST',
  "ledger_igst"               TEXT    NOT NULL DEFAULT 'Output IGST',
  "ledger_cash"               TEXT    NOT NULL DEFAULT 'Cash',
  "ledger_bank"               TEXT    NOT NULL DEFAULT 'Bank Account',
  "ledger_sundry_debtors"     TEXT    NOT NULL DEFAULT 'Sundry Debtors',
  "ledger_round_off"          TEXT    NOT NULL DEFAULT 'Round Off',
  "voucher_type_sales"        TEXT    NOT NULL DEFAULT 'Sales',
  "voucher_type_receipt"      TEXT    NOT NULL DEFAULT 'Receipt',
  "voucher_type_credit_note"  TEXT    NOT NULL DEFAULT 'Credit Note',
  "voucher_type_debit_note"   TEXT    NOT NULL DEFAULT 'Debit Note',
  "stock_unit"                TEXT    NOT NULL DEFAULT 'NOS',
  "cylinder_stock_items"      JSONB   NOT NULL DEFAULT '{}',
  "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                TIMESTAMP(3) NOT NULL,

  CONSTRAINT "tally_settings_pkey" PRIMARY KEY ("tally_settings_id")
);

CREATE UNIQUE INDEX "tally_settings_distributor_id_key" ON "tally_settings"("distributor_id");

ALTER TABLE "tally_settings"
  ADD CONSTRAINT "tally_settings_distributor_id_fkey"
  FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
