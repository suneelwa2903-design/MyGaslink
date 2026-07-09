import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated } from '../utils/apiResponse.js';
import {
  incomingFullsSchema, outgoingEmptiesSchema, manualAdjustmentSchema,
  cancelledStockReturnSchema,
  emptiesReturnSchema,
  localTodayISO,
} from '@gaslink/shared';
import * as inventoryService from '../services/inventoryService.js';
import {
  getPendingBackdatedAdjustments,
  getBackdatedAdjustmentHistory,
} from '../services/backdatedAdjustmentService.js';
import { recordEmptiesReturn, EmptiesReturnError } from '../services/emptiesReturnService.js';
import { mapInventorySummaries, mapInventoryEvent, mapInventoryEvents } from '../utils/mappers.js';
import { z } from 'zod';

type ServiceError = { message: string; statusCode?: number; code?: string };

const router = Router();

// GET /api/inventory/summary (defaults to today)
router.get('/summary',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
  try {
    // Phase D (2026-06-12): local TZ, not UTC. Server runs with
    // TZ=Asia/Kolkata so this aligns with the inventory_summaries.
    // summary_date column which is keyed by local-TZ midnight.
    const date = localTodayISO();
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

// POST /api/inventory/empties-return — item 7 (2026-07-09)
// Lightweight "customer X returned N empties" event. NO order, NO invoice,
// NO money movement — pure stock movement. See emptiesReturnService.ts.
router.post('/empties-return',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(emptiesReturnSchema),
  auditLog('empties_return', 'inventory'),
  async (req, res) => {
    try {
      const result = await recordEmptiesReturn(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendCreated(res, result);
    } catch (err) {
      if (err instanceof EmptiesReturnError) {
        return sendError(res, err.message, err.statusCode);
      }
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/inventory/initial-balance — onboarding-time opening-stock entry
//
// Group 2 (2026-06-11): the body now accepts an optional `replaceExisting`
// boolean. When omitted/false, any pre-existing `initial_balance` event(s)
// for the submitted cylinder types cause a 409 with per-type current
// values so the web modal can prompt for confirmation. With `true`, the
// prior events are hard-deleted before the new ones are written.
router.post('/initial-balance',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(z.object({
    entries: z.array(z.object({
      cylinderTypeId: z.string().uuid(),
      openingFulls: z.number().int().min(0),
      openingEmpties: z.number().int().min(0),
    })).min(1).max(50),
    // Optional as-of-date picker (G2c). Backend already supported it
    // but the prior /onboarding modal never sent it; now plumbed through.
    eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    replaceExisting: z.boolean().optional(),
  })),
  auditLog('initial_balance', 'inventory'),
  async (req, res) => {
    try {
      const result = await inventoryService.recordInitialBalance(
        req.user!.distributorId!, req.user!.userId, req.body,
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      if (err instanceof inventoryService.InitialBalanceConflictError) {
        // 409 + structured payload so the UI can show "Replace [type] X→Y?"
        // Bypasses sendError so we can attach `details` (existing values).
        return res.status(409).json({
          success: false,
          data: null,
          error: err.message,
          code: 'OPENING_STOCK_CONFLICT',
          details: {
            requiresConfirmation: true,
            conflicts: err.conflicts,
          },
        });
      }
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
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

// WI-3 — GET /api/inventory/manual-adjustments  (Adjustment History tab)
// Returns paginated manual_adjustment events with cylinder type + entered-by
// hydrated. Filter by date range, cylinder type, and bucket (fulls/empties/all).
// Pass format=csv for a downloadable spreadsheet.
router.get('/manual-adjustments',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
    try {
      const result = await inventoryService.listManualAdjustments(
        req.user!.distributorId!,
        {
          bucket: req.query.bucket as 'fulls' | 'empties' | 'all' | undefined,
          cylinderTypeId: req.query.cylinderTypeId as string | undefined,
          dateFrom: req.query.dateFrom as string | undefined,
          dateTo: req.query.dateTo as string | undefined,
          page: req.query.page ? Number(req.query.page) : undefined,
          pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
        },
      );
      if (req.query.format === 'csv') {
        const header = ['Date', 'Cylinder Type', 'Bucket', 'Quantity', 'Reason', 'Entered By'];
        const lines = result.data.map((r) => [
          r.eventDate.toISOString().slice(0, 10),
          r.cylinderTypeName,
          r.bucket,
          String(r.quantity),
          (r.reason ?? '').replace(/"/g, '""'),
          (r.enteredByName ?? '').replace(/"/g, '""'),
        ].map((v) => `"${v}"`).join(','));
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="manual-adjustments.csv"');
        return res.send([header.join(','), ...lines].join('\n'));
      }
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// WI-3 — PATCH /api/inventory/manual-adjustments/:id (admin-only)
// Edit just the notes/reason text on an existing adjustment, within 24h
// of creation. Numeric change (qty/bucket) is immutable so the summary
// stays consistent.
router.patch('/manual-adjustments/:id',
  requireRole('super_admin', 'distributor_admin'),
  validate(z.object({ notes: z.string().min(1).max(500) })),
  auditLog('update', 'manual_adjustment'),
  async (req, res) => {
    try {
      const updated = await inventoryService.updateManualAdjustmentNotes(
        req.user!.distributorId!, param(req.params.id), req.body.notes,
      );
      return sendSuccess(res, mapInventoryEvent(updated));
    } catch (err) {
      const e = err as { message: string; statusCode?: number };
      return sendError(res, e.message, e.statusCode ?? 500);
    }
  }
);

// GET /api/inventory/backdated-adjustments/pending
// Backdated orders whose stock has not yet been settled. Drives the
// pending list on the Backdated Adjustments tab.
router.get('/backdated-adjustments/pending',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
    try {
      const rows = await getPendingBackdatedAdjustments(req.user!.distributorId!);
      return sendSuccess(res, rows);
    } catch (err) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode ?? 500);
    }
  },
);

// GET /api/inventory/backdated-adjustments/history
// The most-recent backdated_inventory_adjustment events (50). Drives
// the inline history section on the Backdated Adjustments tab.
router.get('/backdated-adjustments/history',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
    try {
      const rows = await getBackdatedAdjustmentHistory(req.user!.distributorId!);
      return sendSuccess(res, rows);
    } catch (err) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode ?? 500);
    }
  },
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

// ─── WI-4 — Stock Mismatch Records ──────────────────────────────────────────

const mismatchLineSchema = z.object({
  mismatchType: z.enum(['empties_short', 'fulls_short', 'both']),
  cylinderTypeId: z.string().uuid(),
  qtyUnaccounted: z.number().int().positive(),
  unitAmount: z.number().min(0),
  totalAmount: z.number().min(0),
});

const createMismatchReportSchema = z.object({
  vehicleId: z.string().uuid(),
  tripDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  accountableParty: z.enum(['driver', 'customer']),
  driverId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  resolutionAction: z.enum(['write_off', 'settle_against_due']),
  resolutionNotes: z.string().min(1, 'Resolution notes are required').max(1000),
  lines: z.array(mismatchLineSchema).min(1),
});

// POST /api/inventory/mismatch-reports
router.post('/mismatch-reports',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(createMismatchReportSchema),
  auditLog('create', 'stock_mismatch_report'),
  async (req, res) => {
    try {
      const { createMismatchReport } = await import('../services/stockMismatchService.js');
      const result = await createMismatchReport(
        req.user!.distributorId!, req.user!.userId, req.body,
      );
      return sendCreated(res, result);
    } catch (err) {
      const e = err as { message: string; statusCode?: number };
      return sendError(res, e.message, e.statusCode ?? 500);
    }
  }
);

// GET /api/inventory/mismatch-reports — paginated, filterable Mismatch Log.
router.get('/mismatch-reports',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
    try {
      const { listMismatchReports } = await import('../services/stockMismatchService.js');
      const result = await listMismatchReports(req.user!.distributorId!, {
        vehicleId: req.query.vehicleId as string | undefined,
        driverId: req.query.driverId as string | undefined,
        customerId: req.query.customerId as string | undefined,
        status: req.query.status as 'open' | 'resolved' | undefined,
        mismatchType: req.query.mismatchType as 'empties_short' | 'fulls_short' | 'both' | undefined,
        dateFrom: req.query.dateFrom as string | undefined,
        dateTo: req.query.dateTo as string | undefined,
        page: req.query.page ? Number(req.query.page) : undefined,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      });
      if (req.query.format === 'csv') {
        const header = ['Date', 'Vehicle', 'Driver/Customer', 'Type', 'Cylinder', 'Qty', 'Unit ₹', 'Total ₹', 'Resolution', 'Status', 'Notes'];
        const lines = result.data.map((r) => [
          r.tripDate,
          r.vehicleNumber,
          r.accountableParty === 'driver' ? (r.driverName ?? '—') : (r.customerName ?? '—'),
          r.mismatchType,
          r.cylinderTypeName,
          String(r.qtyUnaccounted),
          String(r.unitAmount),
          String(r.totalAmount),
          r.resolutionAction,
          r.status,
          (r.resolutionNotes ?? '').replace(/"/g, '""'),
        ].map((v) => `"${v}"`).join(','));
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="mismatch-log.csv"');
        return res.send([header.join(','), ...lines].join('\n'));
      }
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// PATCH /api/inventory/mismatch-reports/:id — admin notes/resolution edit
// within 24 hours of creation.
router.patch('/mismatch-reports/:id',
  requireRole('super_admin', 'distributor_admin'),
  validate(z.object({
    resolutionNotes: z.string().min(1).max(1000).optional(),
    resolutionAction: z.enum(['write_off', 'settle_against_due']).optional(),
  })),
  auditLog('update', 'stock_mismatch_report'),
  async (req, res) => {
    try {
      const { updateMismatchReport } = await import('../services/stockMismatchService.js');
      const updated = await updateMismatchReport(
        req.user!.distributorId!, param(req.params.id), req.body,
      );
      return sendSuccess(res, updated);
    } catch (err) {
      const e = err as { message: string; statusCode?: number };
      return sendError(res, e.message, e.statusCode ?? 500);
    }
  }
);

export default router;
