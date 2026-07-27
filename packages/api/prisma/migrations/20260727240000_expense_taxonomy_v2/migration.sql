-- Mini-op #5 v3 (2026-07-27) — expense taxonomy tightening.
--
-- 1. Add paid_to_name column to expenses.
-- 2. Add show_paid_to / paid_to_required / paid_to_label / paid_to_placeholder
--    columns to expense_categories.
-- 3. Tighten field-reveal config on 4 existing categories so the Driver
--    picker + Vehicle picker only appear where the money is directly
--    tied to a specific driver / vehicle from the fleet tables.
-- 4. Seed 7 new leaf categories per existing tenant so users can classify
--    spend more precisely than the original 13 allowed.

-- ─── 1. expenses.paid_to_name ────────────────────────────────────────────
ALTER TABLE "expenses" ADD COLUMN "paid_to_name" VARCHAR(200);

-- ─── 2. expense_categories.paid_to_* ─────────────────────────────────────
ALTER TABLE "expense_categories"
  ADD COLUMN "show_paid_to"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "paid_to_required"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "paid_to_label"       VARCHAR(60),
  ADD COLUMN "paid_to_placeholder" VARCHAR(120);

-- ─── 3. Tighten field-reveal on existing system leaves ──────────────────
-- salaries_wages: was a mixed bucket (driver+helper+office). Turn OFF
-- the Driver picker and turn ON the freeform Paid-to. Users who need
-- driver salary specifically now have a dedicated leaf (see step 4).
UPDATE "expense_categories" SET
  show_driver          = false,
  driver_required      = false,
  show_paid_to         = true,
  paid_to_required     = true,
  paid_to_label        = 'Paid to (staff name)',
  paid_to_placeholder  = 'e.g. Raju (driver) OR Ravi (helper)',
  hint                 = 'For driver salary specifically, use the "Driver Salary" category instead — it pulls the driver from the fleet list.'
WHERE code = 'salaries_wages' AND is_system = true;

-- loading_unloading: was showing Driver. In reality the depot loaders
-- get the cash, not our driver. Switch to Paid-to freeform (optional).
UPDATE "expense_categories" SET
  show_driver          = false,
  driver_required      = false,
  show_paid_to         = true,
  paid_to_required     = false,
  paid_to_label        = 'Labor / loader name',
  paid_to_placeholder  = 'e.g. Depot loader team'
WHERE code = 'loading_unloading' AND is_system = true;

-- rent: was reading landlord into vendor_name. Move it to paid_to_name so
-- reports can slice "who paid whom" without confusing rent with a vendor.
UPDATE "expense_categories" SET
  show_paid_to         = true,
  paid_to_required     = true,
  paid_to_label        = 'Landlord name',
  paid_to_placeholder  = 'e.g. Sri Ramesh (owner)',
  vendor_label         = 'Property / building name (optional)',
  vendor_placeholder   = 'e.g. Godown #4, Kondapur'
WHERE code = 'rent' AND is_system = true;

-- insurance: legacy generic bucket. Turn OFF both dropdowns — users are
-- now directed to Vehicle Insurance, Godown Insurance, or Staff Health
-- Insurance below.
UPDATE "expense_categories" SET
  show_vehicle         = false,
  vehicle_required     = false,
  show_driver          = false,
  driver_required      = false,
  hint                 = 'Prefer the specific leaves below — Vehicle Insurance, Godown Insurance, or Staff Health Insurance — for cleaner reports.'
WHERE code = 'insurance' AND is_system = true;

-- ─── 4. Seed 7 new leaves per existing tenant ───────────────────────────
DO $$
DECLARE
    d_id TEXT;
    h_vehicle TEXT;
    h_staff TEXT;
    h_facility TEXT;
BEGIN
    FOR d_id IN SELECT distributor_id FROM distributors WHERE deleted_at IS NULL
    LOOP
        SELECT expense_category_id INTO h_vehicle  FROM expense_categories WHERE distributor_id = d_id AND code = '__hdr_vehicle';
        SELECT expense_category_id INTO h_staff    FROM expense_categories WHERE distributor_id = d_id AND code = '__hdr_staff';
        SELECT expense_category_id INTO h_facility FROM expense_categories WHERE distributor_id = d_id AND code = '__hdr_facility';

        -- Vehicle Insurance
        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, show_vehicle, vehicle_required, vendor_label, vendor_placeholder, reference_label, reference_placeholder, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_vehicle, 'vehicle_insurance', 'Vehicle Insurance', false, true, 25, true, true, 'Insurer', 'e.g. Bajaj Allianz', 'Policy #', 'Insurance policy number', NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'vehicle_insurance');

        -- Vehicle Road Tax / RTO / Permits
        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, show_vehicle, vehicle_required, vendor_label, vendor_placeholder, reference_label, reference_placeholder, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_vehicle, 'vehicle_road_tax', 'Vehicle Road Tax / RTO', false, true, 30, true, true, 'Department', 'e.g. RTO Telangana', 'Challan #', 'Payment challan / receipt', NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'vehicle_road_tax');

        -- Driver Salary
        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, show_driver, driver_required, vendor_label, vendor_placeholder, reference_label, reference_placeholder, hint, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_staff, 'driver_salary', 'Driver Salary', false, true, 5, true, true, 'Month / period', 'e.g. July 2026', 'Reference #', 'Payslip # / bank ref', 'Pulls the driver from your fleet list. Use "Salaries & wages" or "Helper / Loader Wages" for others.', NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'driver_salary');

        -- Helper / Loader Wages
        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, show_paid_to, paid_to_required, paid_to_label, paid_to_placeholder, reference_label, reference_placeholder, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_staff, 'helper_wages', 'Helper / Loader Wages', false, true, 15, true, true, 'Helper / loader name', 'e.g. Ramu (loader)', 'Reference #', 'Any receipt / note ID', NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'helper_wages');

        -- Office Staff Salary
        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, show_paid_to, paid_to_required, paid_to_label, paid_to_placeholder, reference_label, reference_placeholder, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_staff, 'office_staff_salary', 'Office Staff Salary', false, true, 25, true, true, 'Staff name', 'e.g. Priya (accountant)', 'Reference #', 'Payslip # / bank ref', NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'office_staff_salary');

        -- Staff Health Insurance
        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, show_paid_to, paid_to_required, paid_to_label, paid_to_placeholder, vendor_label, vendor_placeholder, reference_label, reference_placeholder, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_staff, 'staff_health_insurance', 'Staff Health Insurance', false, true, 30, true, true, 'Beneficiary (staff name)', 'e.g. Raju (driver) family', 'Insurer', 'e.g. HDFC Ergo', 'Policy #', 'Insurance policy number', NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'staff_health_insurance');

        -- Godown Insurance
        INSERT INTO expense_categories (expense_category_id, distributor_id, parent_id, code, name, is_header, is_system, sort_order, vendor_label, vendor_placeholder, reference_label, reference_placeholder, updated_at)
        SELECT gen_random_uuid()::text, d_id, h_facility, 'godown_insurance', 'Godown Insurance', false, true, 15, 'Insurer', 'e.g. Bajaj Allianz', 'Policy #', 'Insurance policy number', NOW()
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE distributor_id = d_id AND code = 'godown_insurance');
    END LOOP;
END $$;
