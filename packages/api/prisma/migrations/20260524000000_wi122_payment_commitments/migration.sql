-- WI-122: payment commitment system
-- Adds the `collections` pending-action module and the payment_commitments table.

-- ADD VALUE must run outside a transaction block; applied standalone.
ALTER TYPE "PendingActionModule" ADD VALUE IF NOT EXISTS 'collections';

CREATE TABLE "payment_commitments" (
    "commitment_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "order_id" TEXT,
    "escalation_level" INTEGER NOT NULL,
    "overdue_amount_snapshot" DECIMAL(18,4) NOT NULL,
    "promised_date" DATE,
    "promised_amount" DECIMAL(18,4),
    "status" TEXT NOT NULL DEFAULT 'open',
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_commitments_pkey" PRIMARY KEY ("commitment_id")
);

CREATE INDEX "payment_commitments_distributor_id_customer_id_status_idx" ON "payment_commitments"("distributor_id", "customer_id", "status");

ALTER TABLE "payment_commitments" ADD CONSTRAINT "payment_commitments_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_commitments" ADD CONSTRAINT "payment_commitments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_commitments" ADD CONSTRAINT "payment_commitments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE SET NULL ON UPDATE CASCADE;
