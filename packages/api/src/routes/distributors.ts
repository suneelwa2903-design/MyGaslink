import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import { createDistributorSchema, updateDistributorSchema } from '@gaslink/shared';
import * as distributorService from '../services/distributorService.js';
import { mapDistributor, mapDistributors } from '../utils/mappers.js';
import { lookupGstin, geocodeAddress } from '../services/gst/gstinLookup.js';
import { z } from 'zod';

const router = Router();

// GET /api/distributors/gstin-lookup/:gstin — Look up GSTIN details via WhiteBooks
// WI-043: opened to distributor_admin + finance + inventory so the
// customer-create / customer-edit form (WI-040) can autofill from a GSTIN
// without needing a super_admin. Tenant isolation is irrelevant — GSTIN
// data is platform-level (the NIC portal owns it).
router.get(
  '/gstin-lookup/:gstin',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
  try {
    const gstin = (param(req.params.gstin) || '').toUpperCase();
    // Basic validation: 15 alphanumeric chars starting with 2 digits
    // WhiteBooks API will do full validation; we allow sandbox GSTINs here
    if (!gstin || gstin.length !== 15 || !/^[0-9]{2}[A-Z0-9]{13}$/.test(gstin)) {
      return sendError(res, 'Invalid GSTIN format. Must be 15 characters.', 400);
    }
    // WI-058: lookupGstin is tenant-scoped — passes the caller's
    // distributorId so we use their own WhiteBooks credentials rather
    // than picking the first row Prisma happens to return.
    const callerDistributorId = req.user?.distributorId;
    if (!callerDistributorId) {
      return sendError(res, 'Distributor context required to look up GSTIN', 400, 'NO_DISTRIBUTOR_SELECTED');
    }
    const details = await lookupGstin(gstin, callerDistributorId);

    // Attempt geocoding for the registered address (non-blocking)
    let coordinates: { latitude: number; longitude: number } | null = null;
    try {
      coordinates = await geocodeAddress(details.address, details.city, details.state, details.pincode);
    } catch {
      // Geocoding failure is non-critical
    }

    return sendSuccess(res, { ...details, coordinates });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'GSTIN lookup failed';
    return sendError(res, message, 400);
  }
});

// POST /api/distributors/geocode — Geocode an address
router.post('/geocode', requireRole('super_admin'), async (req, res) => {
  try {
    const { address, city, state, pincode } = req.body;
    if (!address && !pincode) {
      return sendError(res, 'Address or pincode is required', 400);
    }
    const coordinates = await geocodeAddress(address || '', city || '', state || '', pincode || '');
    if (!coordinates) {
      return sendError(res, 'Could not geocode the address', 404);
    }
    return sendSuccess(res, coordinates);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/distributors
router.get('/', requireRole('super_admin'), async (_req, res) => {
  try {
    const distributors = await distributorService.listDistributors();
    return sendSuccess(res, { distributors: mapDistributors(distributors) });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/distributors/:id
router.get('/:id', requireRole('super_admin'), async (req, res) => {
  try {
    const distributor = await distributorService.getDistributorById(param(req.params.id));
    if (!distributor) return sendNotFound(res, 'Distributor');
    return sendSuccess(res, mapDistributor(distributor));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// POST /api/distributors
router.post('/',
  requireRole('super_admin'),
  validate(createDistributorSchema),
  auditLog('create', 'distributor'),
  async (req, res) => {
    try {
      const distributor = await distributorService.createDistributor(req.body);
      return sendCreated(res, mapDistributor(distributor));
    } catch (err) {
      // Group L2: surface docCode conflict as a 409 instead of a generic 500.
      const e = err as { statusCode?: number; code?: string; message: string };
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// PUT /api/distributors/:id
router.put('/:id',
  requireRole('super_admin'),
  validate(updateDistributorSchema),
  auditLog('update', 'distributor'),
  async (req, res) => {
    try {
      const existing = await distributorService.getDistributorById(param(req.params.id));
      if (!existing) return sendNotFound(res, 'Distributor');
      // Group L5 (2026-06-11): only super-admin can write isTestTenant.
      // Route is already requireRole('super_admin') so this is defense-
      // in-depth — covers future role expansions and makes the rule
      // local to the field.
      if (req.user!.role !== 'super_admin' && 'isTestTenant' in req.body) {
        delete (req.body as Record<string, unknown>).isTestTenant;
      }
      // Phase F (2026-06-12): same defense-in-depth for the Razorpay
      // credentials. Only super-admin can write them. Strips the four
      // fields cleanly when a non-super-admin somehow lands here.
      if (req.user!.role !== 'super_admin') {
        const body = req.body as Record<string, unknown>;
        delete body.razorpayEnabled;
        delete body.razorpayKeyId;
        delete body.razorpayKeySecret;
        delete body.razorpayWebhookSecret;
      }
      const distributor = await distributorService.updateDistributor(param(req.params.id), req.body);
      return sendSuccess(res, mapDistributor(distributor));
    } catch (err) {
      const e = err as { statusCode?: number; code?: string; message: string };
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// Group 5 (2026-06-11): PUT /api/distributors/:id/go-live-date
// Super-admin only. Sets the distributor's operational go-live date.
// Distributor admins can READ this value via GET /api/settings.
router.put('/:id/go-live-date',
  requireRole('super_admin'),
  validate(z.object({
    goLiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  })),
  auditLog('update', 'distributor'),
  async (req, res) => {
    try {
      const { prisma } = await import('../lib/prisma.js');
      const updated = await prisma.distributor.update({
        where: { id: param(req.params.id) },
        data: {
          goLiveDate: req.body.goLiveDate ? new Date(req.body.goLiveDate) : null,
        },
        select: { id: true, goLiveDate: true },
      });
      return sendSuccess(res, {
        distributorId: updated.id,
        goLiveDate: updated.goLiveDate?.toISOString().split('T')[0] ?? null,
      });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/distributors/:id/settings
router.get('/:id/settings', requireRole('super_admin'), async (req, res) => {
  try {
    const settings = await distributorService.getDistributorSettings(param(req.params.id));
    return sendSuccess(res, settings);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

export default router;
