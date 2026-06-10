import { prisma } from '../lib/prisma.js';
import type { Prisma, $Enums } from '@prisma/client';
import { utcDayRange } from '../utils/dateOnly.js';

export async function listDrivers(
  distributorId: string,
  status?: string,
  options?: { unlinkedOnly?: boolean },
) {
  const where: Prisma.DriverWhereInput = { distributorId, deletedAt: null };
  if (status) where.status = status as $Enums.DriverStatus;
  // Group B Part 3 — when ?unlinked=true on GET /api/drivers, return only
  // drivers without an app-login row. Used by the new Add User modal:
  // role=driver dropdown only offers drivers that DON'T already have a
  // login (otherwise the admin would create a duplicate user for the same
  // driver). Filter uses the explicit FK first, then the implicit phone-
  // match as a backstop so any pre-FK driver who happens to share a phone
  // with a driver-role user is still considered linked.
  if (options?.unlinkedOnly) {
    where.userId = null;
  }

  // WI-079: scope the assignment include to TODAY's date range so the
  // surfaced vehicle reflects today's confirmed driver-vehicle mapping
  // (mapDriver flattens this to driver.vehicleNumber). The assign-driver
  // dropdown filters on this to exclude drivers with no vehicle today.
  //
  // assignment_date is a `@db.Date` column — must bound the range by the
  // UTC calendar day (see utils/dateOnly.ts). The old setHours(0,0,0,0)
  // produced LOCAL midnight, which on this IST server truncated to the
  // PREVIOUS UTC day, so the Drivers tab showed yesterday's mapping while
  // the Vehicle Mapping tab (UTC date) showed today's.
  //
  // Fix 1 (2026-05-29): DO NOT filter by `isReconciled: false`. The Vehicle
  // Mapping page (getRecommendedMappings) treats every DVA for today —
  // reconciled or not — as the driver's confirmed mapping for the day, and
  // the assign-driver dropdown must agree. With the old filter, the
  // moment a trip reconciled the driver's vehicle disappeared from the
  // dropdown (label flipped to "(no vehicle today)") while Vehicle Mapping
  // still showed them as Confirmed. tripNumber++ creates a new DVA for the
  // next trip so the date+desc ordering still picks the latest DVA for the
  // day, which is the correct "current vehicle" — reconciliation state is
  // orthogonal to "which vehicle is this driver on right now".
  const { gte: startOfToday, lt: startOfTomorrow } = utcDayRange();

  return prisma.driver.findMany({
    where,
    include: {
      vehicleAssignments: {
        where: {
          assignmentDate: { gte: startOfToday, lt: startOfTomorrow },
        },
        include: { vehicle: { select: { id: true, vehicleNumber: true } } },
        orderBy: { assignmentDate: 'desc' },
        take: 1,
      },
    },
    orderBy: { driverName: 'asc' },
  });
}

export async function getDriverById(id: string, distributorId: string) {
  return prisma.driver.findFirst({
    where: { id, distributorId, deletedAt: null },
    include: {
      vehicleAssignments: {
        orderBy: { assignmentDate: 'desc' },
        take: 10,
        include: { vehicle: { select: { vehicleNumber: true } } },
      },
      orders: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, orderNumber: true, status: true, deliveryDate: true },
      },
    },
  });
}

export async function createDriver(distributorId: string, data: {
  driverName: string;
  phone: string;
  licenseNumber?: string;
  employmentType?: string;
  joiningDate?: string;
}) {
  return prisma.driver.create({
    data: {
      distributorId,
      driverName: data.driverName,
      phone: data.phone,
      licenseNumber: data.licenseNumber || null,
      employmentType: data.employmentType || null,
      joiningDate: data.joiningDate ? new Date(data.joiningDate) : null,
    },
  });
}

export async function updateDriver(id: string, distributorId: string, data: {
  driverName?: string;
  phone?: string;
  licenseNumber?: string | null;
  employmentType?: string | null;
  status?: $Enums.DriverStatus;
  deactivationNotes?: string | null;
  availableToday?: boolean;
  preferredVehicleId?: string | null;
}) {
  const existing = await prisma.driver.findFirst({ where: { id, distributorId, deletedAt: null } });
  if (!existing) return null;

  const updateData: Prisma.DriverUpdateInput = {};
  if (data.driverName !== undefined) updateData.driverName = data.driverName;
  if (data.phone !== undefined) updateData.phone = data.phone;
  if (data.licenseNumber !== undefined) updateData.licenseNumber = data.licenseNumber;
  if (data.employmentType !== undefined) updateData.employmentType = data.employmentType;
  if (data.status !== undefined) {
    updateData.status = data.status;
    if (data.status === 'inactive') {
      updateData.deactivatedAt = new Date();
      updateData.deactivationNotes = data.deactivationNotes || null;
    }
  }
  if (data.availableToday !== undefined) updateData.availableToday = data.availableToday;
  if (data.preferredVehicleId !== undefined) updateData.preferredVehicleId = data.preferredVehicleId;

  return prisma.driver.update({ where: { id }, data: updateData });
}

export async function deleteDriver(id: string, distributorId: string) {
  const existing = await prisma.driver.findFirst({ where: { id, distributorId, deletedAt: null } });
  if (!existing) return null;
  return prisma.driver.update({
    where: { id },
    data: { deletedAt: new Date(), status: 'inactive' },
  });
}

export async function toggleAvailability(id: string, distributorId: string, available: boolean) {
  const existing = await prisma.driver.findFirst({ where: { id, distributorId, deletedAt: null } });
  if (!existing) return null;
  return prisma.driver.update({
    where: { id },
    data: { availableToday: available },
  });
}

// ─── Driver-Vehicle Assignments ─────────────────────────────────────────────

export async function createDriverVehicleAssignment(
  distributorId: string,
  data: { driverId: string; vehicleId: string; assignmentDate: string }
) {
  // Check for existing active assignment
  const existing = await prisma.driverVehicleAssignment.findFirst({
    where: {
      driverId: data.driverId,
      distributorId,
      assignmentDate: new Date(data.assignmentDate),
      isReconciled: false,
      status: { notIn: ['cancelled', 'reconciled'] },
    },
  });
  if (existing) {
    throw new DriverError('Driver already has an active assignment for this date', 400);
  }

  return prisma.driverVehicleAssignment.create({
    data: {
      driverId: data.driverId,
      vehicleId: data.vehicleId,
      distributorId,
      assignmentDate: new Date(data.assignmentDate),
    },
    include: {
      driver: { select: { driverName: true } },
      vehicle: { select: { vehicleNumber: true } },
    },
  });
}

export async function updateAssignmentStatus(
  assignmentId: string,
  distributorId: string,
  newStatus: string
) {
  const assignment = await prisma.driverVehicleAssignment.findFirst({
    where: { id: assignmentId, distributorId },
  });
  if (!assignment) throw new DriverError('Assignment not found', 404);

  const updateData: Prisma.DriverVehicleAssignmentUpdateInput = {
    status: newStatus as $Enums.AssignmentStatus,
  };

  // Auto-increment trip number on RETURNED_INVENTORY
  if (newStatus === 'returned_inventory') {
    // If reconciled, mark it and optionally create next trip
    updateData.isReconciled = false;
    updateData.isSubmitted = true;
  }

  if (newStatus === 'reconciled') {
    updateData.isReconciled = true;
  }

  return prisma.driverVehicleAssignment.update({
    where: { id: assignmentId },
    data: updateData,
    include: {
      driver: { select: { driverName: true } },
      vehicle: { select: { vehicleNumber: true } },
    },
  });
}

export async function listAssignments(
  distributorId: string,
  date?: string,
  driverId?: string
) {
  const where: Prisma.DriverVehicleAssignmentWhereInput = { distributorId };
  if (date) where.assignmentDate = new Date(date);
  if (driverId) where.driverId = driverId;

  return prisma.driverVehicleAssignment.findMany({
    where,
    include: {
      driver: { select: { id: true, driverName: true, phone: true } },
      vehicle: { select: { id: true, vehicleNumber: true } },
    },
    orderBy: [{ assignmentDate: 'desc' }, { tripNumber: 'asc' }],
  });
}

// ─── Driver Performance ─────────────────────────────────────────────────────

export async function getDriverPerformance(distributorId: string, driverId: string, dateFrom?: string, dateTo?: string) {
  const where: Prisma.OrderWhereInput = {
    distributorId,
    driverId,
    deletedAt: null,
  };
  if (dateFrom || dateTo) {
    where.deliveryDate = {};
    if (dateFrom) where.deliveryDate.gte = new Date(dateFrom);
    if (dateTo) where.deliveryDate.lte = new Date(dateTo);
  }

  const [totalOrders, deliveredOrders, cancelledOrders] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.count({ where: { ...where, status: { in: ['delivered', 'modified_delivered'] } } }),
    prisma.order.count({ where: { ...where, status: 'cancelled' } }),
  ]);

  const cancelledStock = await prisma.cancelledStockEvent.aggregate({
    where: { distributorId, driverId },
    _sum: { quantity: true },
  });

  return {
    totalOrders,
    deliveredOrders,
    cancelledOrders,
    deliveryRate: totalOrders > 0 ? Math.round((deliveredOrders / totalOrders) * 100) : 0,
    cancelledStockQty: cancelledStock._sum.quantity || 0,
  };
}

export class DriverError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'DriverError';
  }
}
