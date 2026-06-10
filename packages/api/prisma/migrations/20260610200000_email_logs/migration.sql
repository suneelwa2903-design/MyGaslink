-- Group B Part 2: lightweight outbound-email audit log.
-- Every welcome / OTP / contact-form send writes one row (success, failure,
-- or skipped-because-SMTP-not-configured). Closes the auditability gap
-- surfaced during the SMTP investigation: today the only "did the email
-- go out?" signal is a Winston log line, which is gone the next time pm2
-- rotates its log file.

CREATE TABLE "email_logs" (
    "email_log_id" TEXT NOT NULL,
    "to_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error_text" TEXT,
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_logs_pkey" PRIMARY KEY ("email_log_id")
);

CREATE INDEX "email_logs_type_created_at_idx" ON "email_logs"("type", "created_at");
CREATE INDEX "email_logs_user_id_idx" ON "email_logs"("user_id");
