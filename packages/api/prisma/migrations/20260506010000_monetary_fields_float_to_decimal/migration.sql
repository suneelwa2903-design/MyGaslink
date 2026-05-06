-- Migrate all 35 monetary fields from DOUBLE PRECISION (Float) to NUMERIC(18, 4) (Decimal).
-- Uses ALTER COLUMN TYPE with USING ::NUMERIC so existing data is preserved.
-- Non-monetary Floats (latitude/longitude, gstRate, capacity in KG, percentage discounts)
-- are intentionally left as DOUBLE PRECISION.

ALTER TABLE "customer_cylinder_discounts"
  ALTER COLUMN "discount_per_unit" SET DATA TYPE NUMERIC(18, 4) USING "discount_per_unit"::NUMERIC(18, 4);

ALTER TABLE "customer_ledger_entries"
  ALTER COLUMN "amount_delta" SET DATA TYPE NUMERIC(18, 4) USING "amount_delta"::NUMERIC(18, 4);

ALTER TABLE "cylinder_prices"
  ALTER COLUMN "price" SET DATA TYPE NUMERIC(18, 4) USING "price"::NUMERIC(18, 4);

ALTER TABLE "empty_cylinder_prices"
  ALTER COLUMN "empty_cylinder_price" SET DATA TYPE NUMERIC(18, 4) USING "empty_cylinder_price"::NUMERIC(18, 4);

ALTER TABLE "orders"
  ALTER COLUMN "total_amount" SET DATA TYPE NUMERIC(18, 4) USING "total_amount"::NUMERIC(18, 4);

ALTER TABLE "order_items"
  ALTER COLUMN "unit_price"        SET DATA TYPE NUMERIC(18, 4) USING "unit_price"::NUMERIC(18, 4),
  ALTER COLUMN "discount_per_unit" SET DATA TYPE NUMERIC(18, 4) USING "discount_per_unit"::NUMERIC(18, 4),
  ALTER COLUMN "total_price"       SET DATA TYPE NUMERIC(18, 4) USING "total_price"::NUMERIC(18, 4);

ALTER TABLE "invoices"
  ALTER COLUMN "total_amount"       SET DATA TYPE NUMERIC(18, 4) USING "total_amount"::NUMERIC(18, 4),
  ALTER COLUMN "amount_paid"        SET DATA TYPE NUMERIC(18, 4) USING "amount_paid"::NUMERIC(18, 4),
  ALTER COLUMN "outstanding_amount" SET DATA TYPE NUMERIC(18, 4) USING "outstanding_amount"::NUMERIC(18, 4),
  ALTER COLUMN "cgst_value"         SET DATA TYPE NUMERIC(18, 4) USING "cgst_value"::NUMERIC(18, 4),
  ALTER COLUMN "sgst_value"         SET DATA TYPE NUMERIC(18, 4) USING "sgst_value"::NUMERIC(18, 4),
  ALTER COLUMN "igst_value"         SET DATA TYPE NUMERIC(18, 4) USING "igst_value"::NUMERIC(18, 4);

ALTER TABLE "invoice_items"
  ALTER COLUMN "unit_price"        SET DATA TYPE NUMERIC(18, 4) USING "unit_price"::NUMERIC(18, 4),
  ALTER COLUMN "discount_per_unit" SET DATA TYPE NUMERIC(18, 4) USING "discount_per_unit"::NUMERIC(18, 4),
  ALTER COLUMN "total_price"       SET DATA TYPE NUMERIC(18, 4) USING "total_price"::NUMERIC(18, 4);

ALTER TABLE "credit_notes"
  ALTER COLUMN "total_amount" SET DATA TYPE NUMERIC(18, 4) USING "total_amount"::NUMERIC(18, 4);

ALTER TABLE "debit_notes"
  ALTER COLUMN "total_amount" SET DATA TYPE NUMERIC(18, 4) USING "total_amount"::NUMERIC(18, 4);

ALTER TABLE "payment_transactions"
  ALTER COLUMN "amount" SET DATA TYPE NUMERIC(18, 4) USING "amount"::NUMERIC(18, 4);

ALTER TABLE "payment_allocations"
  ALTER COLUMN "allocated_amount" SET DATA TYPE NUMERIC(18, 4) USING "allocated_amount"::NUMERIC(18, 4);

ALTER TABLE "gaslink_billing_cycles"
  ALTER COLUMN "total_amount_excl_gst"  SET DATA TYPE NUMERIC(18, 4) USING "total_amount_excl_gst"::NUMERIC(18, 4),
  ALTER COLUMN "total_gst_amount"       SET DATA TYPE NUMERIC(18, 4) USING "total_gst_amount"::NUMERIC(18, 4),
  ALTER COLUMN "total_amount_incl_gst"  SET DATA TYPE NUMERIC(18, 4) USING "total_amount_incl_gst"::NUMERIC(18, 4);

ALTER TABLE "gaslink_billing_items"
  ALTER COLUMN "unit_price_excl_gst"  SET DATA TYPE NUMERIC(18, 4) USING "unit_price_excl_gst"::NUMERIC(18, 4),
  ALTER COLUMN "discount_amount"      SET DATA TYPE NUMERIC(18, 4) USING "discount_amount"::NUMERIC(18, 4),
  ALTER COLUMN "line_total_excl_gst"  SET DATA TYPE NUMERIC(18, 4) USING "line_total_excl_gst"::NUMERIC(18, 4),
  ALTER COLUMN "line_gst_amount"      SET DATA TYPE NUMERIC(18, 4) USING "line_gst_amount"::NUMERIC(18, 4),
  ALTER COLUMN "line_total_incl_gst"  SET DATA TYPE NUMERIC(18, 4) USING "line_total_incl_gst"::NUMERIC(18, 4);

ALTER TABLE "pricing_tiers"
  ALTER COLUMN "monthly_price"            SET DATA TYPE NUMERIC(18, 4) USING "monthly_price"::NUMERIC(18, 4),
  ALTER COLUMN "extra_seat_price_admin"   SET DATA TYPE NUMERIC(18, 4) USING "extra_seat_price_admin"::NUMERIC(18, 4),
  ALTER COLUMN "extra_seat_price_driver"  SET DATA TYPE NUMERIC(18, 4) USING "extra_seat_price_driver"::NUMERIC(18, 4),
  ALTER COLUMN "customer_portal_price"    SET DATA TYPE NUMERIC(18, 4) USING "customer_portal_price"::NUMERIC(18, 4),
  ALTER COLUMN "gst_api_overage_price"    SET DATA TYPE NUMERIC(18, 4) USING "gst_api_overage_price"::NUMERIC(18, 4);

ALTER TABLE "seat_requests"
  ALTER COLUMN "price_per_month" SET DATA TYPE NUMERIC(18, 4) USING "price_per_month"::NUMERIC(18, 4);

ALTER TABLE "accountability_logs"
  ALTER COLUMN "cost_amount" SET DATA TYPE NUMERIC(18, 4) USING "cost_amount"::NUMERIC(18, 4);
