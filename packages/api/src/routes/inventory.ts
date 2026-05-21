import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated } from '../utils/apiResponse.js';
import {
  incomingFullsSchema, outgoingEmptiesSchema, manualAdjustmentSchema,
  cancelledStockReturnSchema,
} from '@gaslink/shared';
import * as inventoryService from '../services/inventoryService.js';
import { mapInventorySummary, mapInventorySummaries, mapInventoryEvent, mapInventoryEvents } from '../utils/mappers.js';
import { z } from 'zod';

const router = Router();

// GET /api/inventory/summary (defaults to today)
router.get('/summary',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
  try {
    const date = new Date().toISOString().split('T')[0];
    const summaries = await inventoryService.getInventorySummary(req.user!.distributorId!, date);
    return sendSuccess(res, mapInventorySummaries(summaries));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/inventory/summary/:date
router.get('/summary/:date',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
  try {
    const summaries = await inventoryService.getInventorySummary(req.user!.distributorId!, param(req.params.date));
    return sendSuccess(res, mapInventorySummaries(summaries));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// POST /api/inventory/incoming-fulls
router.post('/incoming-fulls',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(incomingFullsSchema),
  auditLog('incoming_fulls', 'inventory'),
  async (req, res) => {
    try {
      const event = await inventoryService.recordIncomingFulls(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendCreated(res, mapInventoryEvent(event));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/inventory/outgoing-empties
router.post('/outgoing-empties',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(outgoingEmptiesSchema),
  auditLog('outgoing_empties', 'inventory'),
  async (req, res) => {
    try {
      const event = await inventoryService.recordOutgoingEmpties(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendCreated(res, mapInventoryEvent(event));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/inventory/initial-balance — onboarding-time opening-stock entry
router.post('/initial-balance',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(z.object({
    entries: z.array(z.object({
      cylinderTypeId: z.string().uuid(),
      openingFulls: z.number().int().min(0),
      openingEmpties: z.number().int().min(0),
    })).min(1).max(50),
    eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })),
  auditLog('initial_balance', 'inventory'),
  async (req, res) => {
    try {
      const result = await inventoryService.recordInitialBalance(
        req.user!.distributorId!, req.user!.userId, req.body,
      );
      return sendSuccess(res, result);
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// POST /api/inventory/manual-adjustment
router.post('/manual-adjustment',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(manualAdjustmentSchema),
  auditLog('manual_adjustment', 'inventory'),
  async (req, res) => {
    try {
      const event = await inventoryService.recordManualAdjustment(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendCreated(res, mapInventoryEvent(event));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/inventory/depot-history
router.get('/depot-history',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
  try {
    const { events, meta } = await inventoryService.getDepotHistory(
      req.user!.distributorId!,
      {
        page: req.query.page ? Number(req.query.page) : undefined,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
        eventType: req.query.eventType as 'incoming_fulls' | 'outgoing_empties' | undefined,
        dateFrom: req.query.dateFrom as string | undefined,
        dateTo: req.query.dateTo as string | undefined,
      }
    );
    return sendSuccess(res, { events: mapInventoryEvents(events), meta });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/inventory/onboarding-stock — WI-080: opening stock recorded
// at onboarding (initial_balance events). Read-only.
router.get('/onboarding-stock',
  requireRole('super_admin', 'distributor_admin', 'inventory', 'finance'),
  async (req, res) => {
    try {
      const rows = await inventoryService.getOnboardingStock(req.user!.distributorId!);
      return sendSuccess(res, rows);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  });

// GET /api/inventory/cancelled-stock
router.get('/cancelled-stock',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
  try {
    const events = await inventoryService.getCancelledStock(
      req.user!.distributorId!,
      {
        status: req.query.status as string,
        vehicleId: req.query.vehicleId as string,
        driverId: req.query.driverId as string,
      }
    );
    return sendSuccess(res, mapInventoryEvents(events));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// POST /api/inventory/cancelled-stock/return
router.post('/cancelled-stock/return',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(cancelledStockReturnSchema),
  auditLog('return_cancelled_stock', 'inventory'),
  async (req, res) => {
    try {
      const results = await inventoryService.returnCancelledStock(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendSuccess(res, results);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/inventory/threshold-alerts
router.get('/threshold-alerts',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
  try {
    const alerts = await inventoryService.checkThresholds(req.user!.distributorId!);
    return sendSuccess(res, alerts);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/inventory/customer-balances  (all customers, optional ?customerId=)
router.get('/customer-balances',
  requireRole('super_admin', 'distributor_admin', 'inventory', 'finance'),
  async (req, res) => {
  try {
    const balances = await inventoryService.getCustomerBalances(
      req.user!.distributorId!,
      req.query.customerId as string
    );
    return sendSuccess(res, balances);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/inventory/customer-balances/:customerId  (single customer)
// Used by the Customers page detail modal. Tenant isolation is enforced
// inside getCustomerBalances — it filters via `customer: { distributorId }`,
// so a customerId belonging to another distributor simply returns [].
router.get('/customer-balances/:customerId',
  requireRole('super_admin', 'distributor_admin', 'inventory', 'finance'),
  async (req, res) => {
  try {
    const balances = await inventoryService.getCustomerBalances(
      req.user!.distributorId!,
      param(req.params.customerId)
    );
    return sendSuccess(res, balances);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// PUT /api/inventory/lock-summary
// Two shapes:
//   { cylinderTypeId, date, lock }  → lock/unlock a single cylinder type
//   { date }                       → lock the whole day (all cylinder types)
// cylinderTypeId and lock are optional; lock defaults to true so the
// frontend's day-level "Lock Day" button can just send { date }.
router.put('/lock-summary',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(z.object({
    cylinderTypeId: z.string().uuid().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    lock: z.boolean().optional().default(true),
  })),
  auditLog('lock_summary', 'inventory'),
  async (req, res) => {
    try {
      const { cylinderTypeId, date, lock } = req.body;
      const result = cylinderTypeId
        ? await inventoryService.lockSummary(
            req.user!.distributorId!,
            cylinderTypeId,
            date,
            req.user!.userId,
            lock,
          )
        : await inventoryService.setSummaryLockForDate(
            req.user!.distributorId!,
            date,
            req.user!.userId,
            lock,
          );
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/inventory/unlock
router.post('/unlock',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })),
  auditLog('unlock_summary', 'inventory'),
  async (req, res) => {
    try {
      const result = await inventoryService.unlockSummariesForDate(
        req.user!.distributorId!,
        req.body.date,
        req.user!.userId
      );
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/inventory/forecast
router.get('/forecast',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
  try {
    const forecast = await inventoryService.getInventoryForecast(req.user!.distributorId!);
    return sendSuccess(res, forecast);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/inventory/reconciliation
router.get('/reconciliation',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
  try {
    const data = await inventoryService.getReconciliationDashboard(req.user!.distributorId!);
    return sendSuccess(res, data);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

export default router;
