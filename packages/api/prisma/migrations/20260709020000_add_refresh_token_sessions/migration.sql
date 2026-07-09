-- 20260709020000_add_refresh_token_sessions
--
-- Item 4 (docs/INVESTIGATION-JUL09-B.md) — multi-device refresh sessions.
-- Bumps refresh-token storage from single-slot on `users.refresh_token`
-- to N-slot in a dedicated table. The old column stays present through
-- the compatibility window; auth service writes both places for now and
-- only READS from this table.

CREATE TABLE "refresh_token_sessions" (
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "device_label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "refresh_token_sessions_pkey" PRIMARY KEY ("session_id")
);

CREATE INDEX "refresh_token_sessions_user_id_idx" ON "refresh_token_sessions"("user_id");
CREATE INDEX "refresh_token_sessions_token_hash_idx" ON "refresh_token_sessions"("token_hash");
CREATE INDEX "refresh_token_sessions_expires_at_idx" ON "refresh_token_sessions"("expires_at");

ALTER TABLE "refresh_token_sessions"
  ADD CONSTRAINT "refresh_token_sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("user_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
