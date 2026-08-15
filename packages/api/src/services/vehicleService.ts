import { prisma } from '../lib/prisma.js';
import type { Prisma, $Enums } from '@prisma/client';
import { VehicleStatus } from '@prisma/client';
import { startOfUtcDay } from '../utils/dateOnly.js';

const VALID_VEHICLE_STATUSES = new Set<string>(Object.values(VehicleStatus));

export async function listVehicles(distributorId: string, status?: string) {
  const where: Prisma.VehicleWhereInput = { distributorId, deletedAt: null };
  // 2026-08-15 — accept a comma-separated list of statuses ("idle,dispatched")
  // as well as a single value. Previously the whole string was cast to one
  // VehicleStatus enum, so any multi-status caller (Corp. Loads vehicle
  // dropdown) made Prisma throw "Invalid value for argument status" and the
  // request failed. We ALSO drop any token that isn't a real VehicleStatus
  // member (the corp page was passing "reconciled", an assignment status, which
  // otherwise makes Prisma reject the whole `in` list). Split → filter → `in`;
  // a lone valid value passes through unchanged; if nothing valid remains the
  // filter is omitted (returns all).
  if (status) {
    const parts = status.split(',').map((s) => s.trim())
      .filter((s) => VALID_VEHICLE_STATUSES.has(s));
    if (parts.length > 1) where.status = { in: parts as $Enums.VehicleStatus[] };
    else if (parts.length === 1) where.status = parts[0] as $Enums.VehicleStatus;
  }

  return prisma.vehicle.findMany({
    where,
    include: {
      vehicleInventory: true,
      // Fetch the most recent assignment regardless of reconciled status — for
      // an idle vehicle the active assignment is empty, but the modal still
      // needs the *last known* driver as the default to auto-fill. Mapper
      // derives `currentDriverName` from this and strips the rest.
      vehicleAssignments: {
        include: { driver: { select: { id: true, driverName: true } } },
        orderBy: { assignmentDate: 'desc' },
        take: 1,
      },
    },
    orderBy: { vehicleNumber: 'asc' },
  });
}

export async function getVehicleById(id: string, distributorId: string) {
  return prisma.vehicle.findFirst({
    where: { id, distributorId, deletedAt: null },
    include: {
      vehicleInventory: true,
      vehicleAssignments: {
        orderBy: { assignmentDate: 'desc' },
        take: 10,
        include: { driver: { select: { driverName: true } } },
      },
      cancelledStockEvents: {
        where: { status: { in: ['on_vehicle', 'pending_return'] } },
        include: { cylinderType: { select: { typeName: true } } },
      },
    },
  });
}

export async function createVehicle(distributorId: string, data: {
  vehicleNumber: string;
  vehicleType?: string;
  capacity?: number;
}) {
  return prisma.vehicle.create({
    data: {
      distributorId,
      vehicleNumber: data.vehicleNumber,
      vehicleType: data.vehicleType || null,
      capacity: data.capacity || null,
    },
  });
}

export async function updateVehicle(id: string, distributorId: string, data: {
  vehicleNumber?: string;
  vehicleType?: string | null;
  capacity?: number | null;
  status?: $Enums.VehicleStatus;
  deactivationNotes?: string | null;
}) {
  const existing = await prisma.vehicle.findFirst({ where: { id, distributorId, deletedAt: null } });
  if (!existing) return null;

  const updateData: Prisma.VehicleUpdateInput = {};
  if (data.vehicleNumber !== undefined) updateData.vehicleNumber = data.vehicleNumber;
  if (data.vehicleType !== undefined) updateData.vehicleType = data.vehicleType;
  if (data.capacity !== undefined) updateData.capacity = data.capacity;
  if (data.status !== undefined) {
    updateData.status = data.status;
    if (data.status === 'inactive') {
      updateData.deactivatedAt = new Date();
      updateData.deactivationNotes = data.deactivationNotes || null;
    }
  }

  return prisma.vehicle.update({ where: { id }, data: updateData });
}

export async function deleteVehicle(id: string, distributorId: string) {
  const existing = await prisma.vehicle.findFirst({ where: { id, distributorId, deletedAt: null } });
  if (!existing) return null;
  return prisma.vehicle.update({
    where: { id },
    data: { deletedAt: new Date(), status: 'inactive' },
  });
}

export async function getVehicleInventory(vehicleId: string, distributorId: string) {
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!vehicle) return [];
  return prisma.vehicleInventory.findMany({
    where: { vehicleId },
  });
}

export async function updateVehicleInventory(
  vehicleId: string,
  cylinderTypeId: string,
  distributorId: string,
  data: { fullQuantity?: number; emptyQuantity?: number }
) {
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!vehicle) throw new Error('Vehicle not found');
  return prisma.vehicleInventory.upsert({
    where: { vehicleId_cylinderTypeId: { vehicleId, cylinderTypeId } },
    create: {
      vehicleId,
      cylinderTypeId,
      fullQuantity: data.fullQuantity ?? 0,
      emptyQuantity: data.emptyQuantity ?? 0,
    },
    update: {
      fullQuantity: data.fullQuantity,
      emptyQuantity: data.emptyQuantity,
    },
  });
}

export async function getCancelledStockByVehicle(distributorId: string, vehicleId: string) {
  // WI-094c: scope to TODAY's still-on-vehicle cancelled stock. The model has
  // no tripNumber, so we approximate "current" by date + status: hide events
  // already handled by the inventory team (returned_to_depot / reconciled) and
  // events from prior days. Without this the driver app showed stale events
  // from earlier trips/days that were long since returned to the depot.
  return prisma.cancelledStockEvent.findMany({
    where: {
      distributorId,
      vehicleId,
      cancellationDate: { gte: startOfUtcDay() },
      status: { notIn: ['returned_to_depot', 'reconciled'] },
    },
    include: {
      // WI-094 (Issue 8): include the customer so the driver app can show
      // who the cancelled order was for. Nested under order.customer; the
      // mobile reads item.order?.customer?.customerName.
      order: { select: { orderNumber: true, customer: { select: { customerName: true } } } },
      cylinderType: { select: { typeName: true } },
      driver: { select: { driverName: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}
