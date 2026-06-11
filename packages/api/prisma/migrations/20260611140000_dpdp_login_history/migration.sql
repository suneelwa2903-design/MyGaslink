-- DPDP §43 — per-attempt login history.
-- Captures every login attempt (success AND failure), plus
-- password-reset events. userId is NULLABLE so brute-force attempts
-- against non-existent emails still produce a row.

-- CreateTable
CREATE TABLE "login_history" (
    "login_history_id" TEXT NOT NULL,
    "user_id" TEXT,
    "distributor_id" TEXT,
    "success" BOOLEAN NOT NULL,
    "fail_reason" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_history_pkey" PRIMARY KEY ("login_history_id")
);

-- CreateIndex
CREATE INDEX "login_history_user_id_created_at_idx" ON "login_history"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "login_history_distributor_id_created_at_idx" ON "login_history"("distributor_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "login_history_created_at_idx" ON "login_history"("created_at" DESC);

-- AddForeignKey
ALTER TABLE "login_history" ADD CONSTRAINT "login_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
