-- AlterTable
ALTER TABLE "users" ADD COLUMN     "source_contact_id" TEXT;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_source_contact_id_fkey" FOREIGN KEY ("source_contact_id") REFERENCES "customer_contacts"("contact_id") ON DELETE SET NULL ON UPDATE CASCADE;
