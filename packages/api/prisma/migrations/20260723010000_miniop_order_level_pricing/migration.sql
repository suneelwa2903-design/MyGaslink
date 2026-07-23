-- 2026-07-23 — Mini-op order-level pricing toggle.
--
-- Two columns:
--   * customers.order_level_pricing_enabled — per-customer switch. When
--     true, the order form surfaces an editable "Rate ₹" input per
--     line (defaulted to catalog price). When false (default),
--     current catalog − discount pricing applies unchanged.
--   * order_items.unit_price_override — the per-line operator entry
--     when the toggle was on. NULL means "use catalog/discount"
--     (same as OFF). Precedence at delivery/invoice time:
--         effectiveUnitPrice = unitPriceOverride ?? (unitPrice − discountPerUnit)
--
-- Both columns are additive / default-safe. Distributor tenants stay
-- at false / NULL and see zero behavior change. The UI toggle itself
-- is gated to accountType='mini_operator' at both service + client.

ALTER TABLE "customers"
  ADD COLUMN "order_level_pricing_enabled" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "order_items"
  ADD COLUMN "unit_price_override" DECIMAL(18,4) NULL;
