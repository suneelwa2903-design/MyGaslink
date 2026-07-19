-- Mini-Operator 2026-07-19 — Purchase Payments (money out to source distributors).
--
-- Mirrors the customer-side PaymentTransaction + PaymentAllocation shape so
-- both payables flows (customer receivables, supplier payables) share the
-- same allocation + reverse patterns.
--
-- amount_paid on purchase_entries is the running sum of allocations against
-- that entry — kept as a persistent column (not derived) so downstream
-- readers don't race with concurrent allocation writes. Existing rows get
-- 0.0000 by default; nothing outside the new API observes any change.

-- Adds the persistent running-sum column. Same convention as
-- invoices.amount_paid — updated inside the same $transaction that writes
-- allocations.
ALTER TABLE "purchase_entries"
  ADD COLUMN "amount_paid" DECIMAL(18, 4) NOT NULL DEFAULT 0;

CREATE TABLE "purchase_payments" (
  "purchase_payment_id" TEXT NOT NULL,
  "distributor_id" TEXT NOT NULL,
  "source_distributor_id" TEXT NOT NULL,
  "source_distributor_name" TEXT,
  "transaction_date" TEXT NOT NULL,
  "amount" DECIMAL(18, 4) NOT NULL,
  "payment_method" "PaymentMethod" NOT NULL DEFAULT 'cash',
  "reference_number" TEXT,
  "notes" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),

  CONSTRAINT "purchase_payments_pkey" PRIMARY KEY ("purchase_payment_id")
);

CREATE INDEX "purchase_payments_scope_date_idx"
  ON "purchase_payments"("distributor_id", "source_distributor_id", "transaction_date" DESC);

ALTER TABLE "purchase_payments"
  ADD CONSTRAINT "purchase_payments_distributor_id_fkey"
  FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_payments"
  ADD CONSTRAINT "purchase_payments_source_distributor_id_fkey"
  FOREIGN KEY ("source_distributor_id") REFERENCES "source_distributors"("source_distributor_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "purchase_payment_allocations" (
  "purchase_payment_allocation_id" TEXT NOT NULL,
  "payment_id" TEXT NOT NULL,
  "purchase_entry_id" TEXT NOT NULL,
  "amount" DECIMAL(18, 4) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "purchase_payment_allocations_pkey" PRIMARY KEY ("purchase_payment_allocation_id")
);

CREATE INDEX "purchase_payment_allocations_payment_id_idx"
  ON "purchase_payment_allocations"("payment_id");

CREATE INDEX "purchase_payment_allocations_purchase_entry_id_idx"
  ON "purchase_payment_allocations"("purchase_entry_id");

ALTER TABLE "purchase_payment_allocations"
  ADD CONSTRAINT "purchase_payment_allocations_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "purchase_payments"("purchase_payment_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "purchase_payment_allocations"
  ADD CONSTRAINT "purchase_payment_allocations_purchase_entry_id_fkey"
  FOREIGN KEY ("purchase_entry_id") REFERENCES "purchase_entries"("purchase_entry_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
