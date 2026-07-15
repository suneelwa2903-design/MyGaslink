-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'customer_hq';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "group_id" TEXT;

-- CreateTable
CREATE TABLE "customer_groups" (
    "id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "customer_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_group_members" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_groups_distributor_id_idx" ON "customer_groups"("distributor_id");

-- CreateIndex
CREATE INDEX "customer_group_members_customer_id_idx" ON "customer_group_members"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_group_members_group_id_customer_id_key" ON "customer_group_members"("group_id", "customer_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "customer_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_groups" ADD CONSTRAINT "customer_groups_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_group_members" ADD CONSTRAINT "customer_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "customer_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_group_members" ADD CONSTRAINT "customer_group_members_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
