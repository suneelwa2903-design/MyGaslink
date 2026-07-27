-- Mini-op #5 v2 (2026-07-27) — Tenant-owned expense taxonomy.
--
-- Converts the fixed ExpenseCategory enum into a distributor-scoped
-- `expense_categories` table with 2-level hierarchy (headers → leaves).
-- Every existing tenant is seeded with 5 headers + 13 leaves matching
-- the previous enum codes; every existing `expenses` row is backfilled
-- to point at its corresponding leaf; then the enum column is dropped.
--
-- Data-lossless. Idempotent-safe via WHERE NOT EXISTS guards.

-- ─── 1. New TaxDeductibleHint enum ────────────────────────────────────────
CREATE TYPE "TaxDeductibleHint" AS ENUM ('capex', 'opex', 'non_deductible', 'uncertain');

-- ─── 2. expense_categories table ──────────────────────────────────────────
CREATE TABLE "expense_categories" (
    "expense_category_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "is_header" BOOLEAN NOT NULL DEFAULT false,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "show_vehicle" BOOLEAN NOT NULL DEFAULT false,
    "vehicle_required" BOOLEAN NOT NULL DEFAULT false,
    "show_driver" BOOLEAN NOT NULL DEFAULT false,
    "driver_required" BOOLEAN NOT NULL DEFAULT false,
    "vendor_label" VARCHAR(60),
    "vendor_placeholder" VARCHAR(120),
    "reference_label" VARCHAR(60),
    "reference_placeholder" VARCHAR(120),
    "hint" VARCHAR(500),
    "reserved_for_import" BOOLEAN NOT NULL DEFAULT false,
    "tax_deductible_hint" "TaxDeductibleHint",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("expense_category_id")
);

CREATE UNIQUE INDEX "expense_categories_distributor_id_code_key"
    ON "expense_categories"("distributor_id", "code");
CREATE INDEX "expense_categories_distributor_id_parent_id_sort_order_idx"
    ON "expense_categories"("distributor_id", "parent_id", "sort_order");
CREATE INDEX "expense_categories_distributor_id_is_active_idx"
    ON "expense_categories"("distributor_id", "is_active");

ALTER TABLE "expense_categories"
    ADD CONSTRAINT "expense_categories_distributor_id_fkey"
    FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "expense_categories"
    ADD CONSTRAINT "expense_categories_parent_id_fkey"
    FOREIGN KEY ("parent_id") REFERENCES "expense_categories"("expense_category_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 3. Seed 5 headers + 13 leaves per existing distributor ───────────────
-- Idempotent via WHERE NOT EXISTS on (distributor_id, code).
-- Header codes are prefixed __hdr_ to avoid ever colliding with a leaf code.
DO $$
DECLARE
    d_id TEXT;
    h_vehicle TEXT;
    h_staff TEXT;
    h_facility TEXT;
    h_compliance TEXT;
    h_misc TEXT;
BEGIN
    FOR d_id IN SELECT distributor_id FROM distributors WHERE deleted_at IS NULL
    LOOP
        -- Headers (idempotent per-tenant). Capture the freshly-generated id
        -- so we can reference it when inserting the leaves.
        INSERT INTO expense_categories (expense_category_id, distributor_id, code, name, is_header, is_system, sort_order, updated_at)
        SELECT gen_random_uuid()::text, d_id, '__hdr_vehicle', 'Vehicle Costs', true, true, 10, NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = '__hdr_vehicle')
        RETURNING expense_category_id INTO h_vehicle;
        IF h_vehicle IS NULL THEN
            SELECT expense_category_id INTO h_vehicle FROM expense_categories WHERE distributor_id = d_id AND code = '__hdr_vehicle';
        END IF;

        INSERT INTO expense_categories (expense_category_id, distributor_id, code, name, is_header, is_system, sort_order, updated_at)
        SELECT gen_random_uuid()::text, d_id, '__hdr_staff', 'Staff Costs', true, true, 20, NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = '__hdr_staff')
        RETURNING expense_category_id INTO h_staff;
        IF h_staff IS NULL THEN
            SELECT expense_category_id INTO h_staff FROM expense_categories WHERE distributor_id = d_id AND code = '__hdr_staff';
        END IF;

        INSERT INTO expense_categories (expense_category_id, distributor_id, code, name, is_header, is_system, sort_order, updated_at)
        SELECT gen_random_uuid()::text, d_id, '__hdr_facility', 'Facility Costs', true, true, 30, NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = '__hdr_facility')
        RETURNING expense_category_id INTO h_facility;
        IF h_facility IS NULL THEN
            SELECT expense_category_id INTO h_facility FROM expense_categories WHERE distributor_id = d_id AND code = '__hdr_facility';
        END IF;

        INSERT INTO expense_categories (expense_category_id, distributor_id, code, name, is_header, is_system, sort_order, updated_at)
        SELECT gen_random_uuid()::text, d_id, '__hdr_compliance', 'Compliance & Finance', true, true, 40, NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = '__hdr_compliance')
        RETURNING expense_category_id INTO h_compliance;
        IF h_compliance IS NULL THEN
            SELECT expense_category_id INTO h_compliance FROM expense_categories WHERE distributor_id = d_id AND code = '__hdr_compliance';
        END IF;

        INSERT INTO expense_categories (expense_category_id, distributor_id, code, name, is_header, is_system, sort_order, updated_at)
        SELECT gen_random_uuid()::text, d_id, '__hdr_misc', 'Miscellaneous', true, true, 50, NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = '__hdr_misc')
        RETURNING expense_category_id INTO h_misc;
        IF h_misc IS NULL THEN
            SELECT expense_category_id INTO h_misc FROM expense_categories WHERE distributor_id = d_id AND code = '__hdr_misc';
        END IF;

        -- 13 system leaves under the right headers. Guarded per-tenant.
        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, show_vehicle, vehicle_required, show_driver, vendor_label, vendor_placeholder, reference_label, reference_placeholder, hint, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_vehicle, 'fuel', 'Fuel', false, true, 10, true, true, true, 'Petrol pump', 'e.g. HP Petrol Pump', 'Bill #', 'From the fuel bill', NULL, NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'fuel');

        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, show_vehicle, vehicle_required, show_driver, vendor_label, vendor_placeholder, reference_label, reference_placeholder, hint, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_vehicle, 'vehicle_maintenance', 'Vehicle maintenance', false, true, 20, true, true, false, 'Service center', 'e.g. Bosch Service', 'Invoice #', 'From the service invoice', NULL, NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'vehicle_maintenance');

        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, show_vehicle, vehicle_required, show_driver, vendor_label, vendor_placeholder, reference_label, reference_placeholder, hint, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_staff, 'salaries_wages', 'Salaries & wages', false, true, 10, false, false, true, 'Paid to (helper / staff)', 'e.g. Ravi (helper)', 'Reference #', 'Any receipt / note ID', 'Pick a driver from the dropdown for driver salary. For helpers or other staff, type in "Paid to".', NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'salaries_wages');

        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, show_vehicle, vehicle_required, show_driver, vendor_label, vendor_placeholder, reference_label, reference_placeholder, hint, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_staff, 'loading_unloading', 'Loading / unloading', false, true, 20, false, false, true, 'Labor / vendor', 'e.g. Ramu (loader)', 'Reference #', 'Any receipt / note ID', NULL, NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'loading_unloading');

        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, show_vehicle, vehicle_required, show_driver, vendor_label, vendor_placeholder, reference_label, reference_placeholder, hint, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_facility, 'rent', 'Rent', false, true, 10, false, false, false, 'Landlord', 'Landlord name', 'Receipt #', 'Rent receipt number', NULL, NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'rent');

        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, show_vehicle, vehicle_required, show_driver, vendor_label, vendor_placeholder, reference_label, reference_placeholder, hint, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_facility, 'utilities', 'Utilities', false, true, 20, false, false, false, 'Provider', 'e.g. TSSPDCL, Metro Water', 'Bill / account #', 'Utility bill number', NULL, NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'utilities');

        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, show_vehicle, vehicle_required, show_driver, vendor_label, vendor_placeholder, reference_label, reference_placeholder, hint, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_facility, 'office_supplies', 'Office supplies', false, true, 30, false, false, false, 'Store', 'e.g. Reliance Trends', 'Bill #', 'From the bill', NULL, NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'office_supplies');

        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, show_vehicle, vehicle_required, show_driver, vendor_label, vendor_placeholder, reference_label, reference_placeholder, hint, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_facility, 'communication', 'Communication', false, true, 40, false, false, false, 'Provider', 'e.g. Airtel, Jio', 'Bill / account #', 'Utility bill number', NULL, NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'communication');

        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, show_vehicle, vehicle_required, show_driver, vendor_label, vendor_placeholder, reference_label, reference_placeholder, hint, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_compliance, 'insurance', 'Insurance', false, true, 10, true, false, true, 'Insurer', 'e.g. Bajaj Allianz', 'Policy #', 'Insurance policy number', 'Pick a Vehicle for vehicle insurance, or a Driver for staff health / accident cover.', NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'insurance');

        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, show_vehicle, vehicle_required, show_driver, vendor_label, vendor_placeholder, reference_label, reference_placeholder, hint, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_compliance, 'taxes_licenses', 'Taxes & licenses', false, true, 20, false, false, false, 'Department', 'e.g. GST, RTO', 'Challan #', 'Payment challan / receipt', NULL, NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'taxes_licenses');

        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, show_vehicle, vehicle_required, show_driver, vendor_label, vendor_placeholder, reference_label, reference_placeholder, hint, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_compliance, 'bank_charges', 'Bank charges', false, true, 30, false, false, false, 'Bank', 'e.g. HDFC, SBI', 'Transaction #', 'Statement reference', NULL, NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'bank_charges');

        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, show_vehicle, vehicle_required, show_driver, vendor_label, vendor_placeholder, reference_label, reference_placeholder, hint, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_compliance, 'cylinder_deposits', 'Cylinder deposits', false, true, 40, false, false, false, 'Supplier', 'e.g. HPCL depot', 'Deposit receipt #', 'From deposit slip', NULL, NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'cylinder_deposits');

        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, show_vehicle, vehicle_required, show_driver, vendor_label, vendor_placeholder, reference_label, reference_placeholder, hint, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_misc, 'other', 'Other', false, true, 10, true, false, true, 'Vendor (optional)', 'Vendor name', 'Reference # (optional)', 'Any reference', NULL, NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'other');
    END LOOP;
END $$;

-- ─── 4. Add nullable category_id column to expenses ───────────────────────
ALTER TABLE "expenses" ADD COLUMN "category_id" TEXT;

-- ─── 5. Backfill expenses.category_id from the old enum column ────────────
UPDATE "expenses" e
SET "category_id" = ec."expense_category_id"
FROM "expense_categories" ec
WHERE ec."distributor_id" = e."distributor_id"
  AND ec."code" = e."category"::text;

-- ─── 6. Enforce NOT NULL + FK now that every row has a value ──────────────
ALTER TABLE "expenses" ALTER COLUMN "category_id" SET NOT NULL;

ALTER TABLE "expenses"
    ADD CONSTRAINT "expenses_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "expense_categories"("expense_category_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 7. Rebuild indexes: drop old (category, expense_date) index, add new ─
-- The old index name is auto-generated by Prisma against the enum column.
-- We drop it and add the categoryId equivalent.
DROP INDEX IF EXISTS "expenses_distributor_id_category_expense_date_idx";
CREATE INDEX "expenses_distributor_id_category_id_expense_date_idx"
    ON "expenses"("distributor_id", "category_id", "expense_date" DESC);

-- ─── 8. Drop the old enum column + the enum type ─────────────────────────
ALTER TABLE "expenses" DROP COLUMN "category";
DROP TYPE "ExpenseCategory";
