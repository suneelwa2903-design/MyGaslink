-- Adds razorpay_payment_link (nullable TEXT) to gaslink_billing_cycles.
-- Super-admin pastes a Razorpay hosted payment link URL (created manually
-- in the Razorpay dashboard) into the Send Invoice modal; the URL is
-- persisted per-cycle so re-sends reuse the same link. When non-null,
-- the outbound billing-invoice email renders a Pay Now button pointing
-- at this URL.
--
-- Distinct from the existing razorpay_order_id + razorpay_payment_id
-- columns used by the Phase-E programmatic Razorpay integration (Pay
-- Now button inside the tenant's Subscription tab). Both can coexist:
-- the tenant may pay via the pasted link, via the in-app Pay Now
-- button, or via bank transfer — whichever they prefer.

ALTER TABLE "gaslink_billing_cycles"
  ADD COLUMN "razorpay_payment_link" TEXT;
