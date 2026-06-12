-- Phase E (2026-06-12) — Razorpay subscription payments on BillingCycle.
--
-- Five new nullable columns. Order + payment ids come from Razorpay's
-- /v1/orders + /v1/payments responses; signature is the HMAC the
-- frontend handler returns and we verify before flipping status to
-- paid. paid_at is the wall-clock the verify-payment or webhook handler
-- ran (NOT the dueDate the cycle was issued for). payment_method is
-- Razorpay's classification (`upi`, `card`, `netbanking`, ...) read
-- from the fetched payment object.
--
-- No unique on razorpay_order_id: Razorpay's `orders.create` is
-- idempotent on `receipt`, so callers retrying a failed create get the
-- same order id back; we still want the row to take it. Webhook
-- handler uses updateMany(razorpayOrderId) → safe regardless.
--
-- ANDROID IMPACT: none (server only).

ALTER TABLE "gaslink_billing_cycles"
  ADD COLUMN "razorpay_order_id"   TEXT,
  ADD COLUMN "razorpay_payment_id" TEXT,
  ADD COLUMN "razorpay_signature"  TEXT,
  ADD COLUMN "paid_at"             TIMESTAMP(3),
  ADD COLUMN "payment_method"      TEXT;

CREATE INDEX "gaslink_billing_cycles_razorpay_order_id_idx"
  ON "gaslink_billing_cycles"("razorpay_order_id");
