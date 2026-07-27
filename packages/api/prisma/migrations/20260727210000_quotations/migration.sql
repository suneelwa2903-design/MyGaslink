-- Mini-op #7 (2026-07-27) — Quotations module.
--
-- Distributor-scoped rate-card quotations with per-cylinder and per-KG
-- line items. Includes lineage FK (duplicate_from_id) so monthly quotes
-- to the same customer form a chain — "Duplicate for this month" clones
-- the previous quote into a new draft.

CREATE TYPE "QuotationStatus" AS ENUM ('draft', 'sent', 'accepted', 'rejected', 'expired');
CREATE TYPE "QuotationMode"   AS ENUM ('per_cylinder', 'per_kg', 'mixed');
CREATE TYPE "QuotationItemKind" AS ENUM ('per_cylinder', 'per_kg');

CREATE TABLE "quotations" (
    "quotation_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "quotation_number" VARCHAR(32) NOT NULL,
    "year" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "quotation_date" TEXT NOT NULL,
    "valid_until" TEXT NOT NULL,
    "customer_id" TEXT,
    "recipient_name" VARCHAR(200) NOT NULL,
    "recipient_contact_person" VARCHAR(200),
    "recipient_address" VARCHAR(500),
    "recipient_city" VARCHAR(100),
    "recipient_state" VARCHAR(100),
    "recipient_pincode" VARCHAR(20),
    "recipient_email" VARCHAR(200) NOT NULL,
    "recipient_phone" VARCHAR(50),
    "recipient_gstin" VARCHAR(20),
    "subject" VARCHAR(500) NOT NULL,
    "cover_text" VARCHAR(5000) NOT NULL,
    "footer_notes" VARCHAR(1000),
    "terms" JSONB NOT NULL,
    "credit_terms" VARCHAR(200) NOT NULL,
    "gst_rate" DECIMAL(5, 4) NOT NULL,
    "mode" "QuotationMode" NOT NULL,
    "status" "QuotationStatus" NOT NULL DEFAULT 'draft',
    "sent_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "duplicate_from_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("quotation_id")
);

CREATE UNIQUE INDEX "quotations_distributor_id_year_seq_key"
    ON "quotations"("distributor_id", "year", "seq");
CREATE UNIQUE INDEX "quotations_distributor_id_quotation_number_key"
    ON "quotations"("distributor_id", "quotation_number");
CREATE INDEX "quotations_distributor_id_quotation_date_idx"
    ON "quotations"("distributor_id", "quotation_date" DESC);
CREATE INDEX "quotations_distributor_id_customer_id_quotation_date_idx"
    ON "quotations"("distributor_id", "customer_id", "quotation_date" DESC);
CREATE INDEX "quotations_distributor_id_status_idx"
    ON "quotations"("distributor_id", "status");

ALTER TABLE "quotations"
    ADD CONSTRAINT "quotations_distributor_id_fkey"
    FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "quotations"
    ADD CONSTRAINT "quotations_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "quotations"
    ADD CONSTRAINT "quotations_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("user_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "quotations"
    ADD CONSTRAINT "quotations_duplicate_from_id_fkey"
    FOREIGN KEY ("duplicate_from_id") REFERENCES "quotations"("quotation_id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Items ──────────────────────────────────────────────────────────────
CREATE TABLE "quotation_items" (
    "quotation_item_id" TEXT NOT NULL,
    "quotation_id" TEXT NOT NULL,
    "kind" "QuotationItemKind" NOT NULL,
    "cylinder_type_id" TEXT,
    "item_name" VARCHAR(200) NOT NULL,
    "hsn_code" VARCHAR(20) NOT NULL,
    "unit_price" DECIMAL(12, 4),
    "discount_per_unit" DECIMAL(12, 4),
    "cylinder_capacity_kg" DECIMAL(8, 2),
    "basic_price_per_kg" DECIMAL(12, 4),
    "discount_per_kg" DECIMAL(12, 4),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "notes" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotation_items_pkey" PRIMARY KEY ("quotation_item_id")
);

CREATE INDEX "quotation_items_quotation_id_sort_order_idx"
    ON "quotation_items"("quotation_id", "sort_order");

ALTER TABLE "quotation_items"
    ADD CONSTRAINT "quotation_items_quotation_id_fkey"
    FOREIGN KEY ("quotation_id") REFERENCES "quotations"("quotation_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "quotation_items"
    ADD CONSTRAINT "quotation_items_cylinder_type_id_fkey"
    FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types"("cylinder_type_id")
    ON DELETE SET NULL ON UPDATE CASCADE;
