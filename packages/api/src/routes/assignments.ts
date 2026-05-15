import { Router } from 'express';
import type { Request, Response } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import { z } from 'zod';
import * as assignmentService from '../services/assignmentService.js';
import { mapAssignment, mapAssignments } from '../utils/mappers.js';

const router = Router();

// GET /api/assignments/vehicle-mappings?date=2026-03-23
router.get('/vehicle-mappings',
  requireRole('distributor_admin', 'super_admin', 'inventory'),
  async (req: Request, res: Response) => {
    try {
      const date = (req.query.date as string) || new Date().toISOString().split('T')[0];
      const result = await assignmentService.getRecommendedMappings(req.user!.distributorId!, date);
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return sendError(res, message, 500);
    }
  }
);

// POST /api/assignments/vehicle-mappings/confirm
router.post('/vehicle-mappings/confirm',
  requireRole('distributor_admin', 'super_admin', 'inventory'),
  validate(z.object({
    date: z.string(),
    mappings: z.array(z.object({
      driverId: z.string().uuid(),
      vehicleId: z.string().uuid(),
    })).optional(),
  })),
  auditLog('confirm_vehicle_mappings', 'assignment'),
  async (req: Request, res: Response) => {
    try {
      const result = await assignmentService.bulkConfirmMappings(
        req.user!.distributorId!, req.user!.userId, req.body.date, req.body.mappings
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return sendError(res, message, 500);
    }
  }
);

// PUT /api/assignments/vehicle-mappings — inline upsert of one driver's vehicle
// for a date. Distinct from POST /vehicle-mappings/confirm which replaces the
// entire day's mappings.
router.put('/vehicle-mappings',
  requireRole('distributor_admin', 'super_admin', 'inventory'),
  validate(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    driverId: z.string().uuid(),
    vehicleId: z.string().uuid(),
  })),
  auditLog('upsert_vehicle_mapping', 'assignment'),
  async (req: Request, res: Response) => {
    try {
      const updated = await assignmentService.upsertDailyVehicleMapping(
        req.user!.distributorId!, req.body,
      );
      return sendSuccess(res, mapAssignment(updated));
    } catch (err: unknown) {
      if (err instanceof assignmentService.AssignmentError) {
        return sendError(res, err.message, err.statusCode);
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      return sendError(res, message, 500);
    }
  }
);

// POST /api/assignments/order-recommendations
router.post('/order-recommendations',
  requireRole('distributor_admin', 'super_admin', 'inventory'),
  validate(z.object({
    orderIds: z.array(z.string().uuid()).min(1),
  })),
  async (req: Request, res: Response) => {
    try {
      const result = await assignmentService.getOrderDriverRecommendations(
        req.user!.distributorId!, req.body.orderIds
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return sendError(res, message, 500);
    }
  }
);

// GET /api/assignments — list this distributor's driver-vehicle assignments
router.get('/',
  requireRole('distributor_admin', 'super_admin', 'inventory'),
  async (req: Request, res: Response) => {
    try {
      const rows = await assignmentService.listDriverVehicleAssignments(req.user!.distributorId!);
      return sendSuccess(res, mapAssignments(rows));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return sendError(res, message, 500);
    }
  }
);

// POST /api/assignments — create a driver-vehicle assignment
router.post('/',
  requireRole('distributor_admin', 'super_admin', 'inventory'),
  validate(z.object({
    driverId: z.string().uuid(),
    vehicleId: z.string().uuid(),
    assignmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })),
  auditLog('create', 'assignment'),
  async (req: Request, res: Response) => {
    try {
      const created = await assignmentService.createDriverVehicleAssignment(
        req.user!.distributorId!, req.body
      );
      return sendCreated(res, mapAssignment(created));
    } catch (err: unknown) {
      if (err instanceof assignmentService.AssignmentError) {
        return sendError(res, err.message, err.statusCode);
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      return sendError(res, message, 500);
    }
  }
);

// DELETE /api/assignments/:id — delete with ownership check
router.delete('/:id',
  requireRole('distributor_admin', 'super_admin'),
  auditLog('delete', 'assignment'),
  async (req: Request, res: Response) => {
    try {
      const deleted = await assignmentService.deleteDriverVehicleAssignment(
        param(req.params.id), req.user!.distributorId!
      );
      if (!deleted) return sendNotFound(res, 'Assignment');
      return sendSuccess(res, { message: 'Assignment deleted' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return sendError(res, message, 500);
    }
  }
);

// POST /api/assignments/bulk-assign
router.post('/bulk-assign',
  requireRole('distributor_admin', 'super_admin', 'inventory'),
  validate(z.object({
    assignments: z.array(z.object({
      orderId: z.string().uuid(),
      driverId: z.string().uuid(),
      vehicleId: z.string().uuid(),
    })).min(1),
  })),
  auditLog('bulk_assign', 'assignment'),
  async (req: Request, res: Response) => {
    try {
      const result = await assignmentService.bulkSmartAssign(
        req.user!.distributorId!, req.user!.userId, req.body.assignments
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return sendError(res, message, 500);
    }
  }
);

export default router;
