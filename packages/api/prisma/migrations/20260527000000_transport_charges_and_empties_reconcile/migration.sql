-- Feature 1: per-customer inward transport charge
ALTER TABLE "customers" ADD COLUMN "transport_charge_per_cylinder" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- Feature 2: new inventory event type for reconciliation-time empties returns
ALTER TYPE "InventoryEventType" ADD VALUE 'reconciliation_empties_return';

-- Feature 2: supervisor-verified empties-returned counts at trip-end reconciliation
CREATE TABLE "reconciliation_empties_returned" (
    "id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "dva_id" TEXT NOT NULL,
    "cylinder_type_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reconciliation_empties_returned_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "reconciliation_empties_returned_distributor_id_idx" ON "reconciliation_empties_returned"("distributor_id");
CREATE INDEX "reconciliation_empties_returned_dva_id_idx" ON "reconciliation_empties_returned"("dva_id");
ALTER TABLE "reconciliation_empties_returned" ADD CONSTRAINT "reconciliation_empties_returned_dva_id_fkey" FOREIGN KEY ("dva_id") REFERENCES "driver_vehicle_assignments"("assignment_id") ON DELETE RESTRICT ON UPDATE CASCADE;
