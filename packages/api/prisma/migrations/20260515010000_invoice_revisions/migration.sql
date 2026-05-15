-- WI-037: post-delivery invoice reissue (cancel + regenerate IRN/EWB
-- when delivered qty ≠ ordered qty). Adds an audit table and a flag
-- on the invoice itself so UIs can surface "revised after delivery".

ALTER TABLE "invoices"
  ADD COLUMN "revised_post_delivery_at" TIMESTAMP(3);

CREATE TABLE "invoice_revisions" (
  "revision_id" TEXT NOT NULL,
  "invoice_id" TEXT NOT NULL,
  "distributor_id" TEXT NOT NULL,
  "revision_number" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "original_total" DECIMAL(18,4) NOT NULL,
  "revised_total" DECIMAL(18,4) NOT NULL,
  "original_items" JSONB NOT NULL,
  "revised_items" JSONB NOT NULL,
  "revised_by" TEXT,
  "revised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "invoice_revisions_pkey" PRIMARY KEY ("revision_id")
);

CREATE INDEX "invoice_revisions_invoice_id_idx" ON "invoice_revisions"("invoice_id");
CREATE INDEX "invoice_revisions_distributor_id_idx" ON "invoice_revisions"("distributor_id");

ALTER TABLE "invoice_revisions"
  ADD CONSTRAINT "invoice_revisions_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("invoice_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
