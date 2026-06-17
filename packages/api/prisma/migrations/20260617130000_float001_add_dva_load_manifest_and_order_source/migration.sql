-- FLOAT-001 (2026-06-17): DVA Load Manifest + Order.order_source
-- See packages/api/prisma/schema.prisma for the full intent and column-level
-- documentation. This migration creates the OrderSource enum, the new
-- order_source column on orders (default 'regular' covers every existing row),
-- and the new dva_load_manifests table with FKs + unique on
-- (dva_id, cylinder_type_id, trip_number).

-- ─── OrderSource enum ─────────────────────────────────────────────────────────
CREATE TYPE "OrderSource" AS ENUM ('regular', 'walk_in');

-- ─── orders.order_source column ───────────────────────────────────────────────
ALTER TABLE "orders"
    ADD COLUMN "order_source" "OrderSource" NOT NULL DEFAULT 'regular';

-- ─── dva_load_manifests table ─────────────────────────────────────────────────
CREATE TABLE "dva_load_manifests" (
    "manifest_id"      TEXT NOT NULL,
    "distributor_id"   TEXT NOT NULL,
    "dva_id"           TEXT NOT NULL,
    "cylinder_type_id" TEXT NOT NULL,
    "trip_number"      INTEGER NOT NULL,
    "total_loaded"     INTEGER NOT NULL,
    "ordered_qty"      INTEGER NOT NULL,
    "float_qty"        INTEGER NOT NULL,
    "confirmed_by"     TEXT NOT NULL,
    "confirmed_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dva_load_manifests_pkey" PRIMARY KEY ("manifest_id")
);

-- Composite unique: one row per (DVA, cylinderType, tripNumber). This is the key
-- design decision to support trip-1 and trip-2 manifests coexisting on the same
-- DVA row (DVA.tripNumber rolls in place across trips).
CREATE UNIQUE INDEX "dva_load_manifests_dva_id_cylinder_type_id_trip_number_key"
    ON "dva_load_manifests" ("dva_id", "cylinder_type_id", "trip_number");

CREATE INDEX "dva_load_manifests_distributor_id_idx"
    ON "dva_load_manifests" ("distributor_id");

CREATE INDEX "dva_load_manifests_dva_id_trip_number_idx"
    ON "dva_load_manifests" ("dva_id", "trip_number");

-- ─── FKs ──────────────────────────────────────────────────────────────────────
ALTER TABLE "dva_load_manifests"
    ADD CONSTRAINT "dva_load_manifests_distributor_id_fkey"
    FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dva_load_manifests"
    ADD CONSTRAINT "dva_load_manifests_dva_id_fkey"
    FOREIGN KEY ("dva_id") REFERENCES "driver_vehicle_assignments"("assignment_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dva_load_manifests"
    ADD CONSTRAINT "dva_load_manifests_cylinder_type_id_fkey"
    FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types"("cylinder_type_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dva_load_manifests"
    ADD CONSTRAINT "dva_load_manifests_confirmed_by_fkey"
    FOREIGN KEY ("confirmed_by") REFERENCES "users"("user_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
