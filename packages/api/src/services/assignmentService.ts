/**
 * Smart Assignment Service
 * - Driver-vehicle mapping with previous-day defaults
 * - Order-driver assignment with last-driver recommendation
 * - Bulk operations for efficiency
 */

import { prisma } from '../lib/prisma.js';

// ─── Driver-Vehicle Daily Mapping ───────────────────────────────────────────

/**
 * Get recommended driver-vehicle mappings for a date.
 * Uses previous day's mapping as default.
 */
export async function getRecommendedMappings(distributorId: string, date: string) {
  const targetDate = new Date(date);
  const previousDay = new Date(targetDate);
  previousDay.setDate(previousDay.getDate() - 1);

  // Get previous day's assignments
  const previousMappings = await prisma.driverVehicleAssignment.findMany({
    where: { distributorId, assignmentDate: previousDay },
    include: {
      driver: { select: { id: true, driverName: true, status: true, availableToday: true } },
      vehicle: { select: { id: true, vehicleNumber: true, vehicleType: true, status: true, capacity: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Get current day's assignments (if any already confirmed)
  const currentMappings = await prisma.driverVehicleAssignment.findMany({
    where: { distributorId, assignmentDate: targetDate },
    include: {
      driver: { select: { id: true, driverName: true, status: true, availableToday: true } },
      vehicle: { select: { id: true, vehicleNumber: true, vehicleType: true, status: true, capacity: true } },
    },
  });

  // Get all active drivers and vehicles
  const drivers = await prisma.driver.findMany({
    where: { distributorId, status: 'active', deletedAt: null },
    select: { id: true, driverName: true, availableToday: true },
  });

  const vehicles = await prisma.vehicle.findMany({
    where: { distributorId, status: { not: 'inactive' }, deletedAt: null },
    select: { id: true, vehicleNumber: true, vehicleType: true, capacity: true },
  });

  // Build recommendations
  const recommendations = drivers.map(driver => {
    // Check if already assigned today
    const todayMapping = currentMappings.find(m => m.driverId === driver.id);
    if (todayMapping) {
      return {
        driverId: driver.id,
        driverName: driver.driverName,
        available: driver.availableToday,
        vehicleId: todayMapping.vehicleId,
        vehicleNumber: todayMapping.vehicle?.vehicleNumber ?? null,
        status: 'confirmed' as const,
        source: 'today' as const,
      };
    }

    // Use yesterday's mapping as recommendation
    const yesterdayMapping = previousMappings.find(m => m.driverId === driver.id);
    return {
      driverId: driver.id,
      driverName: driver.driverName,
      available: driver.availableToday,
      vehicleId: yesterdayMapping?.vehicleId ?? null,
      vehicleNumber: yesterdayMapping?.vehicle?.vehicleNumber ?? null,
      status: (yesterdayMapping ? 'recommended' : 'unassigned') as 'recommended' | 'unassigned',
      source: (yesterdayMapping ? 'previous_day' : 'none') as 'previous_day' | 'none',
    };
  });

  return {
    date,
    recommendations,
    allDrivers: drivers,
    allVehicles: vehicles,
    confirmedCount: recommendations.filter(r => r.status === 'confirmed').length,
    recommendedCount: recommendations.filter(r => r.status === 'recommended').length,
    unassignedCount: recommendations.filter(r => r.status === 'unassigned').length,
  };
}

/**
 * Bulk confirm driver-vehicle mappings for a date.
 * Accepts array of {driverId, vehicleId} pairs.
 * If no changes from previous day, just pass empty array to confirm all recommendations.
 */
export async function bulkConfirmMappings(
  distributorId: string,
  _userId: string,
  date: string,
  mappings?: { driverId: string; vehicleId: string }[]
) {
  const targetDate = new Date(date);

  // If no mappings provided, use previous day's mappings as-is
  let toCreate = mappings;
  if (!toCreate || toCreate.length === 0) {
    const previousDay = new Date(targetDate);
    previousDay.setDate(previousDay.getDate() - 1);

    const prev = await prisma.driverVehicleAssignment.findMany({
      where: { distributorId, assignmentDate: previousDay },
      select: { driverId: true, vehicleId: true },
    });
    toCreate = prev;
  }

  if (toCreate.length === 0) {
    return { confirmed: 0, message: 'No mappings to confirm' };
  }

  // Delete existing assignments for this date (replace)
  await prisma.driverVehicleAssignment.deleteMany({
    where: { distributorId, assignmentDate: targetDate },
  });

  // Create new assignments
  const created = await prisma.driverVehicleAssignment.createMany({
    data: toCreate.map(m => ({
      distributorId,
      driverId: m.driverId,
      vehicleId: m.vehicleId,
      assignmentDate: targetDate,
      status: 'dispatch_ready' as const,
      isReconciled: false,
    })),
  });

  return {
    confirmed: created.count,
    date,
    message: `${created.count} driver-vehicle mappings confirmed for ${date}`,
  };
}

// ─── Smart Order-Driver Assignment ──────────────────────────────────────────

/**
 * Get recommended drivers for orders.
 * Uses customer's last delivery driver as default recommendation.
 */
export async function getOrderDriverRecommendations(distributorId: string, orderIds: string[]) {
  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds }, distributorId, deletedAt: null },
    include: {
      customer: { select: { id: true, customerName: true, preferredDriverId: true } },
    },
  });

  const recommendations: {
    orderId: string;
    orderNumber: string;
    customerName: string | undefined;
    recommendedDriverId: string | null;
    recommendedDriverName: string | null;
    source: 'preferred' | 'last_delivery' | 'none';
  }[] = [];

  for (const order of orders) {
    // Priority 1: Customer's preferred driver
    if (order.customer?.preferredDriverId) {
      const driver = await prisma.driver.findFirst({
        where: { id: order.customer.preferredDriverId, status: 'active' },
        select: { id: true, driverName: true },
      });
      if (driver) {
        recommendations.push({
          orderId: order.id,
          orderNumber: order.orderNumber,
          customerName: order.customer.customerName,
          recommendedDriverId: driver.id,
          recommendedDriverName: driver.driverName,
          source: 'preferred',
        });
        continue;
      }
    }

    // Priority 2: Last driver who delivered to this customer
    const lastDelivery = await prisma.order.findFirst({
      where: {
        customerId: order.customerId,
        distributorId,
        status: { in: ['delivered', 'modified_delivered'] },
        driverId: { not: null },
        deletedAt: null,
      },
      orderBy: { deliveredAt: 'desc' },
      select: { driverId: true, driver: { select: { id: true, driverName: true, status: true } } },
    });

    if (lastDelivery?.driver?.status === 'active') {
      recommendations.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerName: order.customer?.customerName,
        recommendedDriverId: lastDelivery.driver.id,
        recommendedDriverName: lastDelivery.driver.driverName,
        source: 'last_delivery',
      });
    } else {
      recommendations.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerName: order.customer?.customerName,
        recommendedDriverId: null,
        recommendedDriverName: null,
        source: 'none',
      });
    }
  }

  return recommendations;
}

/**
 * Bulk assign driver + vehicle to multiple orders at once.
 * Supports mixed assignments (different drivers for different orders).
 */
export async function bulkSmartAssign(
  distributorId: string,
  userId: string,
  assignments: { orderId: string; driverId: string; vehicleId: string }[]
) {
  const results: { orderId: string; success: boolean; orderNumber?: string; error?: string }[] = [];

  for (const a of assignments) {
    try {
      const order = await prisma.order.findFirst({
        where: { id: a.orderId, distributorId, deletedAt: null },
      });
      if (!order) throw new Error('Order not found');
      if (!['pending_driver_assignment', 'pending_dispatch'].includes(order.status)) {
        throw new Error(`Order ${order.orderNumber} is ${order.status}`);
      }

      const driver = await prisma.driver.findFirst({
        where: { id: a.driverId, distributorId, status: 'active' },
      });
      if (!driver) throw new Error('Driver not found or inactive');

      await prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: a.orderId },
          data: { driverId: a.driverId, vehicleId: a.vehicleId, status: 'pending_dispatch' },
        });

        await tx.orderStatusLog.create({
          data: {
            orderId: a.orderId,
            oldStatus: order.status,
            newStatus: 'pending_dispatch',
            changedBy: userId,
            notes: `Bulk assigned: ${driver.driverName}`,
          },
        });

        await tx.driverAssignment.create({
          data: { orderId: a.orderId, driverId: a.driverId, assignedBy: userId },
        });
      });

      results.push({ orderId: a.orderId, success: true, orderNumber: order.orderNumber });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      results.push({ orderId: a.orderId, success: false, error: message });
    }
  }

  return {
    total: assignments.length,
    succeeded: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results,
  };
}

// ─── Driver-Vehicle Assignment CRUD ─────────────────────────────────────────
// Backs the Create Assignment modal: a single driver↔vehicle pairing for a
// day (DriverVehicleAssignment). Distinct from the per-order DriverAssignment
// created by bulkSmartAssign above.

export class AssignmentError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function createDriverVehicleAssignment(
  distributorId: string,
  data: { driverId: string; vehicleId: string; assignmentDate: string },
) {
  // Never trust the body — confirm both driver and vehicle are this tenant's.
  const driver = await prisma.driver.findFirst({
    where: { id: data.driverId, distributorId },
  });
  if (!driver) throw new AssignmentError('Driver not found', 404);

  const vehicle = await prisma.vehicle.findFirst({
    where: { id: data.vehicleId, distributorId },
  });
  if (!vehicle) throw new AssignmentError('Vehicle not found', 404);

  const created = await prisma.driverVehicleAssignment.create({
    data: {
      distributorId,
      driverId: data.driverId,
      vehicleId: data.vehicleId,
      assignmentDate: new Date(data.assignmentDate),
    },
    include: {
      driver: { select: { id: true, driverName: true } },
      vehicle: { select: { id: true, vehicleNumber: true } },
    },
  });
  return created;
}

export async function listDriverVehicleAssignments(distributorId: string) {
  const rows = await prisma.driverVehicleAssignment.findMany({
    where: { distributorId },
    include: {
      driver: { select: { id: true, driverName: true } },
      vehicle: { select: { id: true, vehicleNumber: true } },
    },
    orderBy: { assignmentDate: 'desc' },
  });

  // Attach an assigned-orders count: orders on that driver for that date.
  return Promise.all(
    rows.map(async (a) => {
      const assignedOrdersCount = await prisma.order.count({
        where: {
          distributorId,
          driverId: a.driverId,
          deliveryDate: a.assignmentDate,
          deletedAt: null,
        },
      });
      return { ...a, assignedOrdersCount };
    }),
  );
}

export async function deleteDriverVehicleAssignment(id: string, distributorId: string) {
  // Ownership check before delete — only this tenant's assignment.
  const existing = await prisma.driverVehicleAssignment.findFirst({
    where: { id, distributorId },
  });
  if (!existing) return null;
  await prisma.driverVehicleAssignment.delete({ where: { id } });
  return existing;
}
