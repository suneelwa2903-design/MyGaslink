-- Mini-op #7 v3 (2026-07-27) — CC recipients on quotations.
ALTER TABLE "quotations" ADD COLUMN "cc_emails" JSONB NOT NULL DEFAULT '[]';
