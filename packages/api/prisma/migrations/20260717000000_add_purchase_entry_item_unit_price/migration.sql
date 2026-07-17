-- Mini-Operator (2026-07-17): add per-line unit price to purchase entries so
-- resellers can record what they paid per full received. Existing rows get
-- 0.0000 by default so nothing outside the new UI observes any change.
--
-- Total per line = fulls_received * unit_price, computed at query/PDF time
-- (kept out of the DB to avoid a triggered denorm — the derived value is
-- cheap to compute and there's no place we sort/filter by it yet).
ALTER TABLE "purchase_entry_items"
  ADD COLUMN "unit_price" DECIMAL(18, 4) NOT NULL DEFAULT 0;
