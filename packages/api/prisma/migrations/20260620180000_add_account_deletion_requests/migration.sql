-- M14 v1.0 (IOS-ACCOUNT-DELETION-SPEC §3): account deletion request table.
-- Additive only; no backfill needed. Safe to run on production.

-- CreateEnum
CREATE TYPE "AccountDeletionStatus" AS ENUM ('pending', 'cancelled', 'completed');

-- CreateTable
CREATE TABLE "account_deletion_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "distributor_id" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduled_completion_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "status" "AccountDeletionStatus" NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "request_ip" TEXT,
    "request_user_agent" TEXT,

    CONSTRAINT "account_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_deletion_requests_user_id_key" ON "account_deletion_requests"("user_id");

-- CreateIndex
CREATE INDEX "account_deletion_requests_status_scheduled_completion_at_idx" ON "account_deletion_requests"("status", "scheduled_completion_at");

-- CreateIndex
CREATE INDEX "account_deletion_requests_distributor_id_idx" ON "account_deletion_requests"("distributor_id");

-- AddForeignKey
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
