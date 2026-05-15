-- WI-035 (WI-A) Pre-dispatch preflight
-- 1. Add `preflight_in_progress` to OrderStatus enum (in canonical position
--    between pending_dispatch and pending_delivery).
-- 2. Add gst_api_logs table for per-call WhiteBooks audit.

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'preflight_in_progress' BEFORE 'pending_delivery';

CREATE TABLE "gst_api_logs" (
    "log_id"           TEXT NOT NULL,
    "distributor_id"   TEXT NOT NULL,
    "invoice_id"       TEXT,
    "order_id"         TEXT,
    "api_type"         TEXT NOT NULL,
    "scope"            TEXT NOT NULL,
    "endpoint"         TEXT NOT NULL,
    "http_status"      INTEGER,
    "status"           TEXT NOT NULL,
    "error_code"       TEXT,
    "error_message"    TEXT,
    "request_payload"  JSONB NOT NULL,
    "response_payload" JSONB,
    "latency_ms"       INTEGER NOT NULL,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gst_api_logs_pkey" PRIMARY KEY ("log_id")
);

CREATE INDEX "gst_api_logs_distributor_id_created_at_idx"
    ON "gst_api_logs" ("distributor_id", "created_at" DESC);
CREATE INDEX "gst_api_logs_invoice_id_idx"
    ON "gst_api_logs" ("invoice_id");
CREATE INDEX "gst_api_logs_order_id_idx"
    ON "gst_api_logs" ("order_id");
