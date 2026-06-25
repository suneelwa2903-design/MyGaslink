-- Backdated-Inventory-Adjustment: track when stock was settled
ALTER TABLE "orders" ADD COLUMN "inventory_adjusted_at" TIMESTAMP(3);
