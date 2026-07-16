-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('distributor', 'mini_operator');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'mini_operator_admin';

-- AlterTable
ALTER TABLE "distributors" ADD COLUMN     "account_type" "AccountType" NOT NULL DEFAULT 'distributor';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "driver_name_free_text" TEXT;

-- CreateTable
CREATE TABLE "source_distributors" (
    "source_distributor_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "source_distributors_pkey" PRIMARY KEY ("source_distributor_id")
);

-- CreateTable
CREATE TABLE "purchase_entries" (
    "purchase_entry_id" TEXT NOT NULL,
    "purchase_number" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "source_distributor_id" TEXT,
    "source_distributor_name" TEXT,
    "purchase_date" TEXT NOT NULL,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "purchase_entries_pkey" PRIMARY KEY ("purchase_entry_id")
);

-- CreateTable
CREATE TABLE "purchase_entry_items" (
    "purchase_entry_item_id" TEXT NOT NULL,
    "purchase_entry_id" TEXT NOT NULL,
    "cylinder_type_id" TEXT NOT NULL,
    "fulls_received" INTEGER NOT NULL DEFAULT 0,
    "empties_given_out" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_entry_items_pkey" PRIMARY KEY ("purchase_entry_item_id")
);

-- CreateIndex
CREATE INDEX "source_distributors_distributor_id_idx" ON "source_distributors"("distributor_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_distributors_distributor_id_name_key" ON "source_distributors"("distributor_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_entries_purchase_number_key" ON "purchase_entries"("purchase_number");

-- CreateIndex
CREATE INDEX "purchase_entries_distributor_id_purchase_date_idx" ON "purchase_entries"("distributor_id", "purchase_date" DESC);

-- CreateIndex
CREATE INDEX "purchase_entry_items_purchase_entry_id_idx" ON "purchase_entry_items"("purchase_entry_id");

-- AddForeignKey
ALTER TABLE "source_distributors" ADD CONSTRAINT "source_distributors_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_entries" ADD CONSTRAINT "purchase_entries_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_entries" ADD CONSTRAINT "purchase_entries_source_distributor_id_fkey" FOREIGN KEY ("source_distributor_id") REFERENCES "source_distributors"("source_distributor_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_entry_items" ADD CONSTRAINT "purchase_entry_items_purchase_entry_id_fkey" FOREIGN KEY ("purchase_entry_id") REFERENCES "purchase_entries"("purchase_entry_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_entry_items" ADD CONSTRAINT "purchase_entry_items_cylinder_type_id_fkey" FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types"("cylinder_type_id") ON DELETE RESTRICT ON UPDATE CASCADE;
