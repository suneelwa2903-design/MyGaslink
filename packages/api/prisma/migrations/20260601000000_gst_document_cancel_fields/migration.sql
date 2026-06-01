-- GROUP-7S: persist NIC cancellation context on gst_documents.
-- Before this migration, the reason free-text was sent to NIC (CnlRem) but
-- never stored on the domain row — only buried in gst_api_logs.request_payload,
-- making post-hoc GST audit queries impossible. Reason code was guessed from
-- keyword-matching the free text (CnlRsn '1'-'4').

ALTER TABLE "gst_documents"
  ADD COLUMN "cancel_reason"         TEXT,
  ADD COLUMN "cancel_reason_code"    TEXT,
  ADD COLUMN "cancelled_by_user_id"  TEXT;

ALTER TABLE "gst_documents"
  ADD CONSTRAINT "gst_documents_cancelled_by_user_id_fkey"
  FOREIGN KEY ("cancelled_by_user_id")
  REFERENCES "users" ("user_id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
