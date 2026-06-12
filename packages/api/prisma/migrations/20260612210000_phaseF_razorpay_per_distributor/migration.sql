-- Phase F (2026-06-12) — Razorpay per-distributor customer-portal payments.
--
-- Two surfaces:
--   distributors:
--     razorpay_enabled         BOOLEAN — super-admin toggle per tenant
--     razorpay_key_id          TEXT    — public key, distributor-owned
--     razorpay_key_secret      TEXT    — PLAINTEXT (accepted risk
--                                       matching gst_credentials posture
--                                       — see CLAUDE.md "Accepted security
--                                       risks" section, audit 2026-06-12)
--     razorpay_webhook_secret  TEXT    — PLAINTEXT, distributor-owned
--                                       webhook secret from their Razorpay
--                                       dashboard
--
--   payment_transactions:
--     razorpay_order_id        TEXT — Razorpay order id (NOT a PK)
--     razorpay_payment_id      TEXT — Razorpay payment id
--     razorpay_signature       TEXT — HMAC verified server-side (stored
--                                     for audit / dispute investigation,
--                                     NEVER returned in any API response)
--
-- ENCRYPTION POSTURE: plaintext at rest, matching gst_credentials.
-- See CLAUDE.md "Accepted security risks" → "Plaintext sensitive
-- columns in gst_credentials and (Phase F) distributors Razorpay fields"
-- for the rationale + the v1.1 coordinated-encryption-pass plan.
--
-- ANDROID IMPACT: none (server only).

ALTER TABLE "distributors"
  ADD COLUMN "razorpay_enabled"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "razorpay_key_id"          TEXT,
  ADD COLUMN "razorpay_key_secret"      TEXT,
  ADD COLUMN "razorpay_webhook_secret"  TEXT;

ALTER TABLE "payment_transactions"
  ADD COLUMN "razorpay_order_id"   TEXT,
  ADD COLUMN "razorpay_payment_id" TEXT,
  ADD COLUMN "razorpay_signature"  TEXT;

CREATE INDEX "payment_transactions_razorpay_order_id_idx"
  ON "payment_transactions"("razorpay_order_id");
