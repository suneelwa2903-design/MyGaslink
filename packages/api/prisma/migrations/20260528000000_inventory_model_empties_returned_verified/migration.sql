-- Inventory model rework: separate "empties returned (supervisor-verified)"
-- from "empties collected at doorstep". Only reconciliation_empties_return
-- events feed this new column; collection/returns_collection now stay as
-- audit-only buckets (they keep populating `collected_empties`) and no
-- longer drive depot closing-empties balance. Closing-empties formula in
-- computeSummaryForDate switches from collected_empties → empties_returned_verified.
ALTER TABLE "inventory_summaries"
  ADD COLUMN "empties_returned_verified" INTEGER NOT NULL DEFAULT 0;
