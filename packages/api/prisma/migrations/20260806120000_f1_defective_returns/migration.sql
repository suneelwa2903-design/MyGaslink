-- F1 Defective Cylinder Returns (2026-08-06)
-- See docs/F1-DEFECTIVE-RETURNS-DESIGN.md for the full spec.
--
-- Pure additive migration. Zero destructive DDL. Existing rows/columns
-- untouched. Rollback = drop the new tables + revert the enum ADD VALUEs
-- (though PG doesn't support DROP VALUE cleanly — see the safe rollback
-- note at the bottom).

-- ─── 1. New enum: DefectiveReturnStatus ─────────────────────────────────────
CREATE TYPE "DefectiveReturnStatus" AS ENUM (
  'collected',
  'cn_issued',
  'sent_to_corporation',
  'corporation_credit_received',
  'cancelled'
);

-- ─── 2. Extend existing enums (additive) ────────────────────────────────────
-- InventoryEventType — 2 new values for defective flow event pair
ALTER TYPE "InventoryEventType" ADD VALUE IF NOT EXISTS 'defective_return_from_customer';
ALTER TYPE "InventoryEventType" ADD VALUE IF NOT EXISTS 'defective_return_to_corporation';

-- LedgerEntryType — 1 new value for the customer-side "captured but CN
-- pending" ledger row. amountDelta = 0, invoiceId = NULL, follows the
-- exact same anti-pattern-#24 rules as `empties_return`.
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'defective_collected';

-- ─── 3. Extend InventorySummary — parallel defective bucket ────────────────
-- WI-106 flag-critical `closing_fulls` formula is NOT touched. These 3
-- columns feed `closing_defective_fulls` only; `closing_fulls` continues
-- to be computed exactly as before.
ALTER TABLE "inventory_summaries"
  ADD COLUMN "defective_fulls_in"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "defective_fulls_out"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "closing_defective_fulls"   INTEGER NOT NULL DEFAULT 0;

-- ─── 4. defective_cylinder_ledger — per-defective-incident row ─────────────
CREATE TABLE "defective_cylinder_ledger" (
  "defective_id"            TEXT NOT NULL,
  "distributor_id"          TEXT NOT NULL,
  "customer_id"             TEXT NOT NULL,
  "cylinder_type_id"        TEXT NOT NULL,
  "quantity"                INTEGER NOT NULL,
  "source_invoice_id"       TEXT NOT NULL,
  "source_invoice_item_id"  TEXT,
  "per_cyl_rate"            DECIMAL(12,2) NOT NULL,
  "cn_amount"               DECIMAL(12,2) NOT NULL,
  "reason"                  TEXT,
  "notes"                   TEXT,
  "status"                  "DefectiveReturnStatus" NOT NULL DEFAULT 'collected',
  "credit_note_id"          TEXT,
  "batch_id"                TEXT,
  "collected_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "collected_date"          DATE NOT NULL,
  "collected_by"            TEXT NOT NULL,
  "cn_raised_at"            TIMESTAMP(3),
  "cn_raised_by"            TEXT,
  "cancelled_at"            TIMESTAMP(3),
  "cancelled_by"            TEXT,
  "cancel_reason"           TEXT,
  "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMP(3) NOT NULL,

  CONSTRAINT "defective_cylinder_ledger_pkey" PRIMARY KEY ("defective_id")
);

-- Indexes — mirror the access patterns in defectiveReturnService.ts
CREATE INDEX "defective_cylinder_ledger_dist_status_idx"
  ON "defective_cylinder_ledger" ("distributor_id", "status");
CREATE INDEX "defective_cylinder_ledger_dist_customer_collectedAt_idx"
  ON "defective_cylinder_ledger" ("distributor_id", "customer_id", "collected_at");
CREATE INDEX "defective_cylinder_ledger_dist_batch_idx"
  ON "defective_cylinder_ledger" ("distributor_id", "batch_id");
CREATE INDEX "defective_cylinder_ledger_dist_cylType_status_idx"
  ON "defective_cylinder_ledger" ("distributor_id", "cylinder_type_id", "status");
CREATE INDEX "defective_cylinder_ledger_sourceInvoice_idx"
  ON "defective_cylinder_ledger" ("source_invoice_id");

-- FKs
ALTER TABLE "defective_cylinder_ledger"
  ADD CONSTRAINT "defective_cylinder_ledger_distributor_id_fkey"
    FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "defective_cylinder_ledger_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "defective_cylinder_ledger_cylinder_type_id_fkey"
    FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types"("cylinder_type_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "defective_cylinder_ledger_source_invoice_id_fkey"
    FOREIGN KEY ("source_invoice_id") REFERENCES "invoices"("invoice_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "defective_cylinder_ledger_credit_note_id_fkey"
    FOREIGN KEY ("credit_note_id") REFERENCES "credit_notes"("credit_note_id")
    ON DELETE SET NULL ON UPDATE CASCADE;
-- batch_id FK added AFTER defective_return_batches table exists

-- ─── 5. defective_return_batches — header for outgoing shipment to OMC ────
CREATE TABLE "defective_return_batches" (
  "batch_id"                    TEXT NOT NULL,
  "distributor_id"              TEXT NOT NULL,
  "batch_number"                TEXT NOT NULL,
  "source_distributor_id"       TEXT,           -- optional FK, mandatory after F8
  "corporation_name"            TEXT NOT NULL,  -- denormalised snapshot
  "vehicle_id"                  TEXT,
  "challan_number"              TEXT,
  "challan_date"                DATE,
  "total_quantity"              INTEGER NOT NULL DEFAULT 0,
  "status"                      TEXT NOT NULL DEFAULT 'sent',
  "corp_credit_amount"          DECIMAL(12,2),
  "corp_credit_received_at"     TIMESTAMP(3),
  "notes"                       TEXT,
  "created_by"                  TEXT NOT NULL,
  "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "defective_return_batches_pkey" PRIMARY KEY ("batch_id")
);

CREATE UNIQUE INDEX "defective_return_batches_batchNumber_key"
  ON "defective_return_batches" ("batch_number");
CREATE INDEX "defective_return_batches_dist_createdAt_idx"
  ON "defective_return_batches" ("distributor_id", "created_at");
CREATE INDEX "defective_return_batches_dist_sourceDist_idx"
  ON "defective_return_batches" ("distributor_id", "source_distributor_id");

ALTER TABLE "defective_return_batches"
  ADD CONSTRAINT "defective_return_batches_distributor_id_fkey"
    FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "defective_return_batches_vehicle_id_fkey"
    FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("vehicle_id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "defective_return_batches_source_distributor_id_fkey"
    FOREIGN KEY ("source_distributor_id") REFERENCES "source_distributors"("source_distributor_id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Now add DR.batch_id FK (batches table exists)
ALTER TABLE "defective_cylinder_ledger"
  ADD CONSTRAINT "defective_cylinder_ledger_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "defective_return_batches"("batch_id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Rollback note (manual) ────────────────────────────────────────────────
-- Postgres does not support DROP VALUE on an enum type cleanly. To roll back
-- fully:
--   1. DROP TABLE defective_cylinder_ledger, defective_return_batches;
--   2. ALTER TABLE inventory_summaries DROP COLUMN defective_fulls_in,
--      DROP COLUMN defective_fulls_out, DROP COLUMN closing_defective_fulls;
--   3. DROP TYPE DefectiveReturnStatus;
-- The 3 added enum values on InventoryEventType + 1 on LedgerEntryType are
-- effectively permanent. Since they're additive and unused after rollback,
-- this is acceptable — mirrors how empties_return was added on 2026-07-10.
