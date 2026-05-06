import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import { prisma } from '../lib/prisma.js';
import * as driverService from '../services/driverService.js';
import * as vehicleService from '../services/vehicleService.js';
import { mapDriver, mapDrivers, mapVehicle, mapVehicles, mapAssignment, mapAssignments } from '../utils/mappers.js';
import { z } from 'zod';

// We export two routers: one for drivers, one for vehicles
const driverRouter = Router();
const vehicleRouter = Router();

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVERS
// ═══════════════════════════════════════════════════════════════════════════════

const createDriverSchema = z.object({
  driverName: z.string().min(1).max(100),
  phone: z.string().min(10).max(15),
  licenseNumber: z.string().optional(),
  employmentType: z.string().optional(),
  joiningDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

driverRouter.get('/', async (req, res) => {
  try {
    const drivers = await driverService.listDrivers(
      req.user!.distributorId!, req.query.status as string
    );
    return sendSuccess(res, { drivers: mapDrivers(drivers) });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

driverRouter.get('/:id', async (req, res) => {
  try {
    const driver = await driverService.getDriverById(param(req.params.id), req.user!.distributorId!);
    if (!driver) return sendNotFound(res, 'Driver');
    return sendSuccess(res, mapDriver(driver));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

driverRouter.post('/',
  requireRole('super_admin', 'distributor_admin'),
  validate(createDriverSchema),
  auditLog('create', 'driver'),
  async (req, res) => {
    try {
      const driver = await driverService.createDriver(req.user!.distributorId!, req.body);
      return sendCreated(res, mapDriver(driver));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

driverRouter.put('/:id',
  requireRole('super_admin', 'distributor_admin'),
  validate(createDriverSchema.partial().extend({
    status: z.enum(['active', 'inactive']).optional(),
    availableToday: z.boolean().optional(),
    deactivationNotes: z.string().optional(),
    preferredVehicleId: z.string().uuid().optional(),
  })),
  auditLog('update', 'driver'),
  async (req, res) => {
    try {
      const driver = await driverService.updateDriver(param(req.params.id), req.user!.distributorId!, req.body);
      if (!driver) return sendNotFound(res, 'Driver');
      return sendSuccess(res, mapDriver(driver));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

driverRouter.delete('/:id',
  requireRole('super_admin', 'distributor_admin'),
  auditLog('delete', 'driver'),
  async (req, res) => {
    try {
      const result = await driverService.deleteDriver(param(req.params.id), req.user!.distributorId!);
      if (!result) return sendNotFound(res, 'Driver');
      return sendSuccess(res, { message: 'Driver deactivated' });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// PUT /api/drivers/:id/availability
driverRouter.put('/:id/availability',
  requireRole('super_admin', 'distributor_admin'),
  validate(z.object({ available: z.boolean() })),
  auditLog('toggle_availability', 'driver'),
  async (req, res) => {
    try {
      const driver = await driverService.toggleAvailability(
        param(req.params.id), req.user!.distributorId!, req.body.available
      );
      if (!driver) return sendNotFound(res, 'Driver');
      return sendSuccess(res, mapDriver(driver));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/drivers/:id/performance
driverRouter.get('/:id/performance', async (req, res) => {
  try {
    const perf = await driverService.getDriverPerformance(
      req.user!.distributorId!, param(req.params.id),
      req.query.dateFrom as string, req.query.dateTo as string
    );
    return sendSuccess(res, perf);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// ─── Driver-Vehicle Assignments ─────────────────────────────────────────────

driverRouter.get('/assignments/list', async (req, res) => {
  try {
    const assignments = await driverService.listAssignments(
      req.user!.distributorId!,
      req.query.date as string,
      req.query.driverId as string
    );
    return sendSuccess(res, mapAssignments(assignments));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

driverRouter.post('/assignments',
  requireRole('super_admin', 'distributor_admin'),
  validate(z.object({
    driverId: z.string().uuid(),
    vehicleId: z.string().uuid(),
    assignmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })),
  auditLog('create', 'driver_vehicle_assignment'),
  async (req, res) => {
    try {
      const assignment = await driverService.createDriverVehicleAssignment(
        req.user!.distributorId!, req.body
      );
      return sendCreated(res, mapAssignment(assignment));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

driverRouter.put('/assignments/:id/status',
  requireRole('super_admin', 'distributor_admin', 'driver'),
  validate(z.object({
    status: z.enum(['dispatch_ready', 'loaded_and_dispatched', 'returned_inventory', 'reconciled', 'cancelled']),
  })),
  auditLog('update_status', 'driver_vehicle_assignment'),
  async (req, res) => {
    try {
      const assignment = await driverService.updateAssignmentStatus(
        param(req.params.id), req.user!.distributorId!, req.body.status
      );
      return sendSuccess(res, mapAssignment(assignment));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// ─── Driver "My" Endpoints (for mobile app) ────────────────────────────────

// GET /api/drivers/me/assignment - Get current driver's today assignment
driverRouter.get('/me/assignment',
  requireRole('driver'),
  async (req, res) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const assignments = await driverService.listAssignments(
        req.user!.distributorId!, today, undefined
      );
      // Find assignment for this driver's userId
      const myAssignment = assignments.find((a: any) =>
        a.driver?.userId === req.user!.userId
      );
      if (!myAssignment) {
        // Fallback: look up driver by userId, then find assignment
        const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { phone: true } });
        const driver = user?.phone ? await prisma.driver.findFirst({
          where: { distributorId: req.user!.distributorId!, phone: user.phone, deletedAt: null },
        }) : null;
        if (driver) {
          const driverAssignment = assignments.find((a: any) => a.driverId === driver.id);
          if (driverAssignment) return sendSuccess(res, mapAssignment(driverAssignment));
        }
        return sendSuccess(res, null);
      }
      return sendSuccess(res, mapAssignment(myAssignment));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/drivers/me/vehicle-inventory - Get current driver's vehicle inventory
driverRouter.get('/me/vehicle-inventory',
  requireRole('driver'),
  async (req, res) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { phone: true } });
      const driver = user?.phone ? await prisma.driver.findFirst({
        where: { distributorId: req.user!.distributorId!, phone: user.phone, deletedAt: null },
      }) : null;
      if (!driver) return sendSuccess(res, []);

      // Find today's assignment to get vehicle
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const assignment = await prisma.driverVehicleAssignment.findFirst({
        where: { driverId: driver.id, assignmentDate: today, status: { not: 'cancelled' } },
        orderBy: { createdAt: 'desc' },
      });
      if (!assignment) return sendSuccess(res, []);

      const inv = await vehicleService.getVehicleInventory(assignment.vehicleId, req.user!.distributorId!);
      return sendSuccess(res, inv);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/drivers/me/cancelled-stock - Get cancelled stock on driver's vehicle
driverRouter.get('/me/cancelled-stock',
  requireRole('driver'),
  async (req, res) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { phone: true } });
      const driver = user?.phone ? await prisma.driver.findFirst({
        where: { distributorId: req.user!.distributorId!, phone: user.phone, deletedAt: null },
      }) : null;
      if (!driver) return sendSuccess(res, []);

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const assignment = await prisma.driverVehicleAssignment.findFirst({
        where: { driverId: driver.id, assignmentDate: today, status: { not: 'cancelled' } },
        orderBy: { createdAt: 'desc' },
      });
      if (!assignment) return sendSuccess(res, []);

      const events = await vehicleService.getCancelledStockByVehicle(
        req.user!.distributorId!, assignment.vehicleId
      );
      return sendSuccess(res, events);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// VEHICLES
// ═══════════════════════════════════════════════════════════════════════════════

const createVehicleSchema = z.object({
  vehicleNumber: z.string().min(1).max(20),
  vehicleType: z.string().optional(),
  capacity: z.number().int().positive().optional(),
});

vehicleRouter.get('/', async (req, res) => {
  try {
    const vehicles = await vehicleService.listVehicles(
      req.user!.distributorId!, req.query.status as string
    );
    return sendSuccess(res, { vehicles: mapVehicles(vehicles) });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

vehicleRouter.get('/:id', async (req, res) => {
  try {
    const vehicle = await vehicleService.getVehicleById(param(req.params.id), req.user!.distributorId!);
    if (!vehicle) return sendNotFound(res, 'Vehicle');
    return sendSuccess(res, mapVehicle(vehicle));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

vehicleRouter.post('/',
  requireRole('super_admin', 'distributor_admin'),
  validate(createVehicleSchema),
  auditLog('create', 'vehicle'),
  async (req, res) => {
    try {
      const vehicle = await vehicleService.createVehicle(req.user!.distributorId!, req.body);
      return sendCreated(res, mapVehicle(vehicle));
    } catch (err: any) {
      if (err.code === 'P2002') return sendError(res, 'Vehicle number already exists', 409);
      return sendError(res, err.message);
    }
  }
);

vehicleRouter.put('/:id',
  requireRole('super_admin', 'distributor_admin'),
  validate(createVehicleSchema.partial().extend({
    status: z.enum(['idle', 'dispatched', 'returned', 'inactive']).optional(),
    deactivationNotes: z.string().optional(),
  })),
  auditLog('update', 'vehicle'),
  async (req, res) => {
    try {
      const vehicle = await vehicleService.updateVehicle(param(req.params.id), req.user!.distributorId!, req.body);
      if (!vehicle) return sendNotFound(res, 'Vehicle');
      return sendSuccess(res, mapVehicle(vehicle));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

vehicleRouter.delete('/:id',
  requireRole('super_admin', 'distributor_admin'),
  auditLog('delete', 'vehicle'),
  async (req, res) => {
    try {
      const result = await vehicleService.deleteVehicle(param(req.params.id), req.user!.distributorId!);
      if (!result) return sendNotFound(res, 'Vehicle');
      return sendSuccess(res, { message: 'Vehicle deactivated' });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/vehicles/:id/inventory
vehicleRouter.get('/:id/inventory', async (req, res) => {
  try {
    const inv = await vehicleService.getVehicleInventory(param(req.params.id), req.user!.distributorId!);
    return sendSuccess(res, inv);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// PUT /api/vehicles/:id/inventory
vehicleRouter.put('/:id/inventory',
  requireRole('super_admin', 'distributor_admin', 'inventory'),
  validate(z.object({
    cylinderTypeId: z.string().uuid(),
    fullQuantity: z.number().int().min(0).optional(),
    emptyQuantity: z.number().int().min(0).optional(),
  })),
  auditLog('update', 'vehicle_inventory'),
  async (req, res) => {
    try {
      const result = await vehicleService.updateVehicleInventory(
        param(req.params.id), req.body.cylinderTypeId, req.user!.distributorId!, req.body
      );
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/vehicles/:id/cancelled-stock
vehicleRouter.get('/:id/cancelled-stock', async (req, res) => {
  try {
    const events = await vehicleService.getCancelledStockByVehicle(
      req.user!.distributorId!, param(req.params.id)
    );
    return sendSuccess(res, events);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

export { driverRouter, vehicleRouter };
