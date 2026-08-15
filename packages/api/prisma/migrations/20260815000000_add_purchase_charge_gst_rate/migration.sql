-- Add per-charge GST rate to purchase_entry_charges (freight GST, e.g. GoGas 5%).
-- Additive, non-destructive: NOT NULL DEFAULT 0 so existing rows read as 0% GST.
ALTER TABLE "purchase_entry_charges" ADD COLUMN IF NOT EXISTS "gst_rate" DECIMAL(5,2) NOT NULL DEFAULT 0;
