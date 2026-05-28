-- WI-1.4: extra metadata captured by the Incoming Fulls / Outgoing Empties
-- modals. All nullable so existing rows + non-using event types stay
-- untouched.
ALTER TABLE "inventory_events"
  ADD COLUMN "amount" DECIMAL(12, 2),
  ADD COLUMN "condition" TEXT,
  ADD COLUMN "authorization_ref" TEXT;
