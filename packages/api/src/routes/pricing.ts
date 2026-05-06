import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import * as pricingService from '../services/pricingService.js';
import * as gstApiTracker from '../services/gstApiTracker.js';
import * as seatRequestService from '../services/seatRequestService.js';
import { generateBillingInvoicePdf } from '../services/pdf/billingInvoicePdfService.js';
import { validate } from '../middleware/validate.js';
import { param } from '../utils/params.js';
import { z } from 'zod';

const router = Router();

// GET /api/pricing/tiers - list all pricing tiers
router.get('/tiers', requireRole('super_admin'), async (_req, res) => {
  try {
    const tiers = await pricingService.listPricingTiers();
    return sendSuccess(res, { tiers });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/pricing/seat-limits - get seat limits for current distributor
router.get('/seat-limits', async (req, res) => {
  try {
    // Super_admin must select a tenant via X-Distributor-Id header.
    const distributorId = req.user!.distributorId;
    if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');

    const limits = await pricingService.getSeatLimits(distributorId);
    if (!limits) return sendSuccess(res, { limits: null, message: 'No subscription plan assigned' });
    return sendSuccess(res, limits);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/pricing/gst-usage - current month GST API usage
router.get('/gst-usage', async (req, res) => {
  try {
    const distributorId = req.user!.distributorId;
    if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');

    const month = req.query.month ? parseInt(req.query.month as string, 10) : undefined;
    const year = req.query.year ? parseInt(req.query.year as string, 10) : undefined;

    const usage = await gstApiTracker.getGstApiUsage(distributorId, month, year);
    return sendSuccess(res, { usage });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/pricing/gst-usage/history - GST API usage history
router.get('/gst-usage/history', async (req, res) => {
  try {
    const distributorId = req.user!.distributorId;
    if (!distributorId) return sendError(res, 'Distributor ID required', 400, 'NO_DISTRIBUTOR_SELECTED');

    const history = await gstApiTracker.getGstApiUsageHistory(distributorId);
    return sendSuccess(res, { history });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/pricing/gst-usage/all - all distributors usage (super admin)
router.get('/gst-usage/all', requireRole('super_admin'), async (req, res) => {
  try {
    const month = req.query.month ? parseInt(req.query.month as string, 10) : undefined;
    const year = req.query.year ? parseInt(req.query.year as string, 10) : undefined;
    const usage = await gstApiTracker.getAllGstApiUsage(month, year);
    return sendSuccess(res, { usage });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// POST /api/pricing/seat-requests - create seat request
router.post('/seat-requests',
  validate(z.object({
    requestedRole: z.string(),
    reason: z.string().optional(),
  })),
  async (req, res) => {
    try {
      const request = await seatRequestService.createSeatRequest({
        distributorId: req.user!.distributorId!,
        requestedRole: req.body.requestedRole,
        requestedBy: req.user!.userId,
        reason: req.body.reason,
      });
      return sendCreated(res, request);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/pricing/seat-requests - list seat requests
router.get('/seat-requests', async (req, res) => {
  try {
    // Super_admin without an X-Distributor-Id header sees all distributors;
    // every other role is locked to their JWT distributorId by middleware.
    const distributorId = req.user!.distributorId ?? undefined;

    const requests = await seatRequestService.listSeatRequests(distributorId, req.query.status as string);
    return sendSuccess(res, { requests });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// PUT /api/pricing/seat-requests/:id/approve - approve seat request (super admin)
router.put('/seat-requests/:id/approve', requireRole('super_admin'), async (req, res) => {
  try {
    const result = await seatRequestService.approveSeatRequest(param(req.params.id), req.user!.userId);
    return sendSuccess(res, result);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// PUT /api/pricing/seat-requests/:id/reject - reject seat request (super admin)
router.put('/seat-requests/:id/reject', requireRole('super_admin'), async (req, res) => {
  try {
    const result = await seatRequestService.rejectSeatRequest(param(req.params.id), req.user!.userId);
    return sendSuccess(res, result);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/pricing/billing-invoice/:cycleId - download billing invoice PDF
router.get('/billing-invoice/:cycleId', requireRole('super_admin'), async (req, res) => {
  try {
    const cycleId = param(req.params.cycleId);
    const pdf = await generateBillingInvoicePdf(cycleId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="gaslink-invoice-${cycleId.slice(-6)}.pdf"`);
    res.send(pdf);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

export default router;
