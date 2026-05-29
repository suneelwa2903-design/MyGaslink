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
        // WI-036: trip-sheet PDF (WI-038) is keyed by assignment id, so
        // surface it alongside the mapping for confirmed rows.
        assignmentId: todayMapping.id,
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

  // Validate ALL entries up front — never partial-save. Same rules as
  // upsertDailyVehicleMapping. When copying yesterday's mappings forward,
  // this catches the case where a driver/vehicle has gone inactive since
  // and surfaces it before any rows are written.
  const driverIds = [...new Set(toCreate.map((m) => m.driverId))];
  const vehicleIds = [...new Set(toCreate.map((m) => m.vehicleId))];

  const [drivers, vehicles] = await Promise.all([
    prisma.driver.findMany({
      where: { id: { in: driverIds }, distributorId, deletedAt: null },
      select: { id: true, driverName: true, status: true },
    }),
    prisma.vehicle.findMany({
      where: { id: { in: vehicleIds }, distributorId, deletedAt: null },
      select: { id: true, vehicleNumber: true, status: true },
    }),
  ]);
  const driverById = new Map(drivers.map((d) => [d.id, d]));
  const vehicleById = new Map(vehicles.map((v) => [v.id, v]));

  const errors: { driverId: string; vehicleId: string; reason: string }[] = [];
  const seenVehicles = new Map<string, string>(); // vehicleId → driverId
  const seenDrivers = new Set<string>();

  for (const m of toCreate) {
    const driver = driverById.get(m.driverId);
    const vehicle = vehicleById.get(m.vehicleId);
    if (!driver || driver.status !== 'active') {
      errors.push({ driverId: m.driverId, vehicleId: m.vehicleId, reason: 'Driver not found or inactive' });
      continue;
    }
    if (!vehicle || vehicle.status === 'inactive') {
      errors.push({ driverId: m.driverId, vehicleId: m.vehicleId, reason: 'Vehicle not found or inactive' });
      continue;
    }
    if (seenDrivers.has(m.driverId)) {
      errors.push({ driverId: m.driverId, vehicleId: m.vehicleId, reason: `Driver ${driver.driverName} appears more than once in the batch` });
      continue;
    }
    const otherDriverId = seenVehicles.get(m.vehicleId);
    if (otherDriverId && otherDriverId !== m.driverId) {
      const otherDriver = driverById.get(otherDriverId);
      errors.push({
        driverId: m.driverId,
        vehicleId: m.vehicleId,
        reason: `Vehicle ${vehicle.vehicleNumber} is already mapped to ${otherDriver?.driverName ?? 'another driver'} in this batch. Each vehicle can only be assigned to one driver per day.`,
      });
      continue;
    }
    seenDrivers.add(m.driverId);
    seenVehicles.set(m.vehicleId, m.driverId);
  }

  if (errors.length > 0) {
    const err = new AssignmentError(
      `Cannot confirm mappings — ${errors.length} entr${errors.length === 1 ? 'y' : 'ies'} failed validation. ${errors[0].reason}`,
      400,
    );
    (err as AssignmentError & { details?: typeof errors }).details = errors;
    throw err;
  }

  // Replace today's DVAs atomically. Reconciliation rows
  // (reconciliation_empties_returned.dvaId → driver_vehicle_assignments.id) FK
  // back to the DVAs, with no ON DELETE CASCADE in the schema, so a naive
  // deleteMany on DVAs that already have a reconciled trip explodes with
  // "Foreign key constraint violated on reconciliation_empties_returned_dva_id_fkey".
  // Fix 3 (2026-05-29): delete the reconciliation children in the same
  // transaction first so the parent delete is unblocked. The whole thing is
  // wrapped so a mid-step failure leaves the day's DVAs intact.
  const dvasToReplace = await prisma.driverVehicleAssignment.findMany({
    where: { distributorId, assignmentDate: targetDate },
    select: { id: true },
  });
  const dvaIds = dvasToReplace.map((d) => d.id);

  const created = await prisma.$transaction(async (tx) => {
    if (dvaIds.length > 0) {
      await tx.reconciliationEmptiesReturned.deleteMany({
        where: { distributorId, dvaId: { in: dvaIds } },
      });
      await tx.driverVehicleAssignment.deleteMany({
        where: { id: { in: dvaIds } },
      });
    }
    return tx.driverVehicleAssignment.createMany({
      data: toCreate.map(m => ({
        distributorId,
        driverId: m.driverId,
        vehicleId: m.vehicleId,
        assignmentDate: targetDate,
        status: 'dispatch_ready' as const,
        isReconciled: false,
      })),
    });
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

/**
 * Inline single-row upsert from Fleet → Vehicle Mapping.
 *
 * The bulk confirm flow (POST /vehicle-mappings/confirm) replaces every
 * mapping for a date — wrong for an inline edit of one driver's vehicle.
 * This finds the existing assignment for (distributor, driver, date) and
 * swaps the vehicle, or creates one if none exists. Status stays
 * dispatch_ready so the row reads as 'confirmed' in the recommendations
 * view, matching what bulk confirm produces.
 *
 * Validations (mirrored in bulk confirm + filtered for the web dropdown):
 *  A. Vehicle exists, belongs to this tenant, and is not inactive.
 *  B. No OTHER driver is mapped to this vehicle for this date.
 *  C. Driver exists, belongs to this tenant, and is active.
 */
export async function upsertDailyVehicleMapping(
  distributorId: string,
  data: { driverId: string; vehicleId: string; date: string },
) {
  const driver = await prisma.driver.findFirst({
    where: { id: data.driverId, distributorId, deletedAt: null },
  });
  if (!driver) throw new AssignmentError('Driver not found or inactive', 404);
  if (driver.status !== 'active') {
    throw new AssignmentError('Driver not found or inactive', 400);
  }

  const vehicle = await prisma.vehicle.findFirst({
    where: { id: data.vehicleId, distributorId, deletedAt: null },
  });
  if (!vehicle) throw new AssignmentError('Vehicle not found or inactive', 404);
  // VehicleStatus has no 'active' value — the operational meaning of
  // "active" in this domain is "anything other than inactive" (idle,
  // dispatched, returned all count). The frontend filter matches.
  if (vehicle.status === 'inactive') {
    throw new AssignmentError('Vehicle not found or inactive', 400);
  }

  const assignmentDate = new Date(data.date);

  // Vehicle conflict: another driver already holds this vehicle today.
  const conflict = await prisma.driverVehicleAssignment.findFirst({
    where: {
      distributorId,
      assignmentDate,
      vehicleId: data.vehicleId,
      driverId: { not: data.driverId },
    },
    include: { driver: { select: { driverName: true } } },
  });
  if (conflict) {
    throw new AssignmentError(
      `This vehicle is already assigned to ${conflict.driver.driverName} today. Each vehicle can only be assigned to one driver per day.`,
      400,
    );
  }

  const existing = await prisma.driverVehicleAssignment.findFirst({
    where: { distributorId, driverId: data.driverId, assignmentDate },
  });

  if (existing) {
    return prisma.driverVehicleAssignment.update({
      where: { id: existing.id },
      data: { vehicleId: data.vehicleId },
      include: {
        driver: { select: { id: true, driverName: true } },
        vehicle: { select: { id: true, vehicleNumber: true } },
      },
    });
  }

  return prisma.driverVehicleAssignment.create({
    data: {
      distributorId,
      driverId: data.driverId,
      vehicleId: data.vehicleId,
      assignmentDate,
      status: 'dispatch_ready',
      isReconciled: false,
    },
    include: {
      driver: { select: { id: true, driverName: true } },
      vehicle: { select: { id: true, vehicleNumber: true } },
    },
  });
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
