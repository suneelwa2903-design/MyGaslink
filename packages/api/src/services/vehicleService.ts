import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';

export async function listVehicles(distributorId: string, status?: string) {
  const where: Prisma.VehicleWhereInput = { distributorId, deletedAt: null };
  if (status) where.status = status as any;

  return prisma.vehicle.findMany({
    where,
    include: {
      vehicleInventory: true,
      vehicleAssignments: {
        where: { isReconciled: false },
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

export async function updateVehicle(id: string, distributorId: string, data: Record<string, any>) {
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

export async function getVehicleInventory(vehicleId: string) {
  return prisma.vehicleInventory.findMany({
    where: { vehicleId },
  });
}

export async function updateVehicleInventory(
  vehicleId: string,
  cylinderTypeId: string,
  data: { fullQuantity?: number; emptyQuantity?: number }
) {
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
  return prisma.cancelledStockEvent.findMany({
    where: { distributorId, vehicleId },
    include: {
      order: { select: { orderNumber: true } },
      cylinderType: { select: { typeName: true } },
      driver: { select: { driverName: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}
