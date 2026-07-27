-- 2026-07-27 Mini-op #5 — Expenses feature (13-category taxonomy).
-- Fixed enum; new column requires a schema migration.
CREATE TYPE "ExpenseCategory" AS ENUM (
    'fuel','vehicle_maintenance','salaries_wages','rent','utilities',
    'loading_unloading','cylinder_deposits','office_supplies','communication',
    'insurance','taxes_licenses','bank_charges','other'
);

CREATE TABLE "expenses" (
    "expense_id"       TEXT NOT NULL,
    "distributor_id"   TEXT NOT NULL,
    "expense_date"     TEXT NOT NULL,
    "category"         "ExpenseCategory" NOT NULL,
    "amount"           DECIMAL(18,4) NOT NULL,
    "description"      VARCHAR(500) NOT NULL,
    "payment_method"   "PaymentMethod" NOT NULL DEFAULT 'cash',
    "vendor_name"      VARCHAR(200),
    "vehicle_id"       TEXT,
    "driver_id"        TEXT,
    "reference_number" VARCHAR(100),
    "notes"            VARCHAR(1000),
    "created_by"       TEXT NOT NULL,
    "created_at"       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMPTZ NOT NULL,
    "deleted_at"       TIMESTAMPTZ,
    CONSTRAINT "expenses_pkey" PRIMARY KEY ("expense_id")
);

CREATE INDEX "expenses_distributor_id_expense_date_idx"
  ON "expenses" ("distributor_id", "expense_date" DESC);
CREATE INDEX "expenses_distributor_id_category_expense_date_idx"
  ON "expenses" ("distributor_id", "category", "expense_date" DESC);
CREATE INDEX "expenses_vehicle_id_idx" ON "expenses" ("vehicle_id");
CREATE INDEX "expenses_driver_id_idx" ON "expenses" ("driver_id");

ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_distributor_id_fkey"
  FOREIGN KEY ("distributor_id") REFERENCES "distributors" ("distributor_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_vehicle_id_fkey"
  FOREIGN KEY ("vehicle_id") REFERENCES "vehicles" ("vehicle_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_driver_id_fkey"
  FOREIGN KEY ("driver_id") REFERENCES "drivers" ("driver_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users" ("user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
