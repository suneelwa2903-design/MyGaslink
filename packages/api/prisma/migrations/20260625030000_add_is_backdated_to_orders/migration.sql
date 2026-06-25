-- Brief 3: backdated order flag
ALTER TABLE "orders" ADD COLUMN "is_backdated" BOOLEAN NOT NULL DEFAULT false;
