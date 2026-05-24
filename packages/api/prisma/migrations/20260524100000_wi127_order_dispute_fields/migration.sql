-- WI-127: customer dispute lifecycle fields on orders.
ALTER TABLE "orders"
  ADD COLUMN "dispute_raised_at" TIMESTAMP(3),
  ADD COLUMN "dispute_resolved_at" TIMESTAMP(3),
  ADD COLUMN "dispute_resolution_note" TEXT,
  ADD COLUMN "dispute_reopened_at" TIMESTAMP(3),
  ADD COLUMN "dispute_reopen_reason" TEXT;
