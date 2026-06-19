-- WI-PENDING-PAYMENTS: PaymentSubmission table — self-reported payment
-- claims awaiting office verification. Separate from payment_transactions
-- so unverified claims cannot leak into any existing payment reader
-- (credit gate, Tally export, analytics, customer ledger).
--
-- Invariant: rows with status='pending_verification' MUST NEVER have a
-- non-NULL resulting_payment_id. The verify endpoint calls
-- paymentService.createPayment() which inserts a real payment_transactions
-- row, then writes that id back here.

-- CreateEnum
CREATE TYPE "PaymentSubmissionStatus" AS ENUM ('pending_verification', 'verified', 'rejected');

-- CreateEnum
CREATE TYPE "PaymentSubmittedBy" AS ENUM ('staff', 'driver', 'customer');

-- CreateTable
CREATE TABLE "payment_submissions" (
    "submission_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "payment_method" "PaymentMethod" NOT NULL,
    "transaction_date" DATE NOT NULL,
    "reference_number" TEXT,
    "notes" TEXT,
    "attachment_url" TEXT,
    "pending_invoice_ids" JSONB,
    "status" "PaymentSubmissionStatus" NOT NULL DEFAULT 'pending_verification',
    "submitted_by" "PaymentSubmittedBy" NOT NULL,
    "submitted_by_user_id" TEXT,
    "submitted_by_driver_id" TEXT,
    "verified_by_user_id" TEXT,
    "verified_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "resulting_payment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_submissions_pkey" PRIMARY KEY ("submission_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_submissions_resulting_payment_id_key" ON "payment_submissions"("resulting_payment_id");

-- CreateIndex
CREATE INDEX "payment_submissions_distributor_id_status_idx" ON "payment_submissions"("distributor_id", "status");

-- CreateIndex
CREATE INDEX "payment_submissions_customer_id_status_idx" ON "payment_submissions"("customer_id", "status");

-- CreateIndex
CREATE INDEX "payment_submissions_submitted_by_driver_id_idx" ON "payment_submissions"("submitted_by_driver_id");

-- AddForeignKey
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_submitted_by_user_id_fkey" FOREIGN KEY ("submitted_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_submitted_by_driver_id_fkey" FOREIGN KEY ("submitted_by_driver_id") REFERENCES "drivers"("driver_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_verified_by_user_id_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_resulting_payment_id_fkey" FOREIGN KEY ("resulting_payment_id") REFERENCES "payment_transactions"("payment_id") ON DELETE SET NULL ON UPDATE CASCADE;
