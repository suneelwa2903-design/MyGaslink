-- WI-108: structured invoice/order numbering.
-- Incremental, non-destructive: adds the per-tenant docCode and the
-- sequence-counter table. Applied via `prisma db execute` because the shared
-- dev DB has historical drift (managed by db push) and `migrate dev` would
-- demand a reset — forbidden by CLAUDE.md anti-pattern #2.

-- AlterTable: 3-letter tenant code on the distributor (globally unique).
ALTER TABLE "distributors" ADD COLUMN "doc_code" TEXT;
CREATE UNIQUE INDEX "distributors_doc_code_key" ON "distributors"("doc_code");

-- CreateTable: per-(distributor, type, financialYear) sequence counter.
CREATE TABLE "invoice_counters" (
    "counter_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "financial_year" TEXT NOT NULL,
    "last_sequence" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "invoice_counters_pkey" PRIMARY KEY ("counter_id")
);

CREATE UNIQUE INDEX "invoice_counters_distributor_id_type_financial_year_key" ON "invoice_counters"("distributor_id", "type", "financial_year");
CREATE INDEX "invoice_counters_distributor_id_idx" ON "invoice_counters"("distributor_id");

ALTER TABLE "invoice_counters" ADD CONSTRAINT "invoice_counters_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;
