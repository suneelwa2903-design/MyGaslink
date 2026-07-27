-- Mini-op #7 v2 (2026-07-27) — semantic clarity: all quotation price /
-- discount fields now store GST-INCLUSIVE values.
--
-- The distributor enters "the final rate my customer will actually pay
-- per unit / per KG" (which is inclusive of GST), because that's how
-- LPG rate quotes are talked about in the market. The pre-GST basic is
-- derived — never entered directly.
--
-- Renaming columns to make the semantic explicit at the DB layer too:
--   unit_price           → price_incl_gst
--   discount_per_unit    → discount_incl_gst
--   basic_price_per_kg   → price_per_kg_incl_gst   (was a misnomer once
--                                                    prices moved to inclusive)
--   discount_per_kg      → discount_per_kg_incl_gst

ALTER TABLE "quotation_items" RENAME COLUMN "unit_price"          TO "price_incl_gst";
ALTER TABLE "quotation_items" RENAME COLUMN "discount_per_unit"   TO "discount_incl_gst";
ALTER TABLE "quotation_items" RENAME COLUMN "basic_price_per_kg"  TO "price_per_kg_incl_gst";
ALTER TABLE "quotation_items" RENAME COLUMN "discount_per_kg"     TO "discount_per_kg_incl_gst";
