import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import * as billingService from '../services/billingService.js';
import { mapBillingCycle, mapBillingCycles } from '../utils/mappers.js';
import { z } from 'zod';

const router = Router();

// GET /api/billing/cycles
router.get('/cycles', async (req, res) => {
  try {
    const distributorId = req.user!.role === 'super_admin'
      ? (req.query.distributorId as string) || undefined
      : req.user!.distributorId!;

    const result = await billingService.listBillingCycles(distributorId, {
      status: req.query.status as string,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined,
    });
    return sendSuccess(res, { cycles: mapBillingCycles(result.data) }, 200, result.meta);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/billing/cycles/:id
router.get('/cycles/:id', async (req, res) => {
  try {
    const cycle = await billingService.getBillingCycleById(param(req.params.id));
    if (!cycle) return sendNotFound(res, 'Billing cycle');
    // Authorization check
    if (req.user!.role !== 'super_admin' && cycle.distributorId !== req.user!.distributorId) {
      return sendNotFound(res, 'Billing cycle');
    }
    return sendSuccess(res, mapBillingCycle(cycle));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// POST /api/billing/generate
router.post('/generate',
  requireRole('super_admin'),
  validate(z.object({
    distributorId: z.string().uuid(),
    periodType: z.enum(['monthly', 'quarterly', 'half_yearly', 'yearly']),
    periodStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })),
  auditLog('generate', 'billing_cycle'),
  async (req, res) => {
    try {
      const cycle = await billingService.generateBillingCycle(req.body.distributorId, req.body);
      return sendCreated(res, mapBillingCycle(cycle));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// PUT /api/billing/cycles/:id/mark-paid
router.put('/cycles/:id/mark-paid',
  requireRole('super_admin'),
  auditLog('mark_paid', 'billing_cycle'),
  async (req, res) => {
    try {
      const cycle = await billingService.markBillingPaid(param(req.params.id));
      return sendSuccess(res, mapBillingCycle(cycle));
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// POST /api/billing/suspend/:distributorId
router.post('/suspend/:distributorId',
  requireRole('super_admin'),
  auditLog('suspend', 'billing'),
  async (req, res) => {
    try {
      const result = await billingService.suspendForOverdueBilling(param(req.params.distributorId));
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/billing/unsuspend/:distributorId
router.post('/unsuspend/:distributorId',
  requireRole('super_admin'),
  auditLog('unsuspend', 'billing'),
  async (req, res) => {
    try {
      const result = await billingService.unsuspendDistributor(param(req.params.distributorId));
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/billing/mark-overdue (for cron)
router.post('/mark-overdue',
  requireRole('super_admin'),
  auditLog('mark_overdue', 'billing'),
  async (_req, res) => {
    try {
      const result = await billingService.markOverdueBillingCycles();
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

export default router;
