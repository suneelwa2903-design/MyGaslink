-- CreateEnum
CREATE TYPE "ProofType" AS ENUM ('signature', 'photo', 'otp');

-- DropForeignKey
ALTER TABLE "stock_mismatch_records" DROP CONSTRAINT "stock_mismatch_records_customer_id_fkey";

-- DropForeignKey
ALTER TABLE "stock_mismatch_records" DROP CONSTRAINT "stock_mismatch_records_cylinder_type_id_fkey";

-- DropForeignKey
ALTER TABLE "stock_mismatch_records" DROP CONSTRAINT "stock_mismatch_records_distributor_id_fkey";

-- DropForeignKey
ALTER TABLE "stock_mismatch_records" DROP CONSTRAINT "stock_mismatch_records_driver_id_fkey";

-- DropForeignKey
ALTER TABLE "stock_mismatch_records" DROP CONSTRAINT "stock_mismatch_records_vehicle_id_fkey";

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "require_delivery_verification" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "payment_commitments" ALTER COLUMN "updated_at" DROP DEFAULT;

-- CreateTable
CREATE TABLE "delivery_proofs" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "proof_type" "ProofType" NOT NULL,
    "s3_key" TEXT,
    "signing_party_phone" TEXT,
    "otp_code" TEXT,
    "otp_expires_at" TIMESTAMP(3),
    "otp_verified_at" TIMESTAMP(3),
    "captured_lat" DOUBLE PRECISION,
    "captured_lng" DOUBLE PRECISION,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "captured_by" TEXT NOT NULL,

    CONSTRAINT "delivery_proofs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_proofs_order_id_key" ON "delivery_proofs"("order_id");

-- CreateIndex
CREATE INDEX "delivery_proofs_distributor_id_order_id_idx" ON "delivery_proofs"("distributor_id", "order_id");

-- AddForeignKey
ALTER TABLE "delivery_proofs" ADD CONSTRAINT "delivery_proofs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_proofs" ADD CONSTRAINT "delivery_proofs_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_mismatch_records" ADD CONSTRAINT "stock_mismatch_records_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_mismatch_records" ADD CONSTRAINT "stock_mismatch_records_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("vehicle_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_mismatch_records" ADD CONSTRAINT "stock_mismatch_records_cylinder_type_id_fkey" FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types"("cylinder_type_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_mismatch_records" ADD CONSTRAINT "stock_mismatch_records_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("driver_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_mismatch_records" ADD CONSTRAINT "stock_mismatch_records_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "driver_vehicle_assignments_driver_id_assignment_date_trip_numbe" RENAME TO "driver_vehicle_assignments_driver_id_assignment_date_trip_n_key";
