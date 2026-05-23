-- WI-106: add dispatched_qty to inventory_summaries (dispatch-based accounting).
-- Default 0 so all existing rows are unaffected (flag-off behaviour unchanged).
ALTER TABLE "inventory_summaries" ADD COLUMN "dispatched_qty" INTEGER NOT NULL DEFAULT 0;
