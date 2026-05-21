import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import {
  createCustomerSchema, updateCustomerSchema, customerFilterSchema,
  customerBalanceSetupSchema,
} from '@gaslink/shared';
import * as customerService from '../services/customerService.js';
import { mapCustomer, mapCustomers, mapUser } from '../utils/mappers.js';
import { z } from 'zod';

const router = Router();

// GET /api/customers
router.get('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validateQuery(customerFilterSchema),
  async (req, res) => {
    try {
      const result = await customerService.listCustomers(req.user!.distributorId!, (req.validated?.query || req.query) as any);
      return sendSuccess(res, { customers: mapCustomers(result.data) }, 200, result.meta);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/customers/import-csv  (must come before /:id)
const customerImportRowSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  address: z.string().optional(),
  gstin: z.string().optional(),
  creditPeriodDays: z.number().int().min(0).optional(),
  customerType: z.string().optional(),
});

router.post('/import-csv',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(z.object({ rows: z.array(customerImportRowSchema).min(1).max(1000) })),
  auditLog('import', 'customer'),
  async (req, res) => {
    try {
      const result = await customerService.importCustomers(req.user!.distributorId!, req.body.rows);
      return sendSuccess(res, result);
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// POST /api/customers/import-opening-balances
const openingBalanceRowSchema = z.object({
  customerName: z.string().optional(),
  phone: z.string().optional(),
  openingBalance: z.number(),
  notes: z.string().optional(),
}).refine((r) => !!(r.customerName?.trim() || r.phone?.trim()), {
  message: 'either customerName or phone is required',
});

router.post('/import-opening-balances',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(z.object({ rows: z.array(openingBalanceRowSchema).min(1).max(2000) })),
  auditLog('import_opening_balances', 'customer'),
  async (req, res) => {
    try {
      const result = await customerService.importOpeningBalances(
        req.user!.distributorId!, req.user!.userId, req.body.rows,
      );
      return sendSuccess(res, result);
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// GET /api/customers/onboarding/progress
router.get('/onboarding/progress',
  requireRole('super_admin', 'distributor_admin'),
  async (req, res) => {
    try {
      const data = await customerService.getOnboardingProgress(req.user!.distributorId!);
      return sendSuccess(res, data);
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// POST /api/customers/onboarding/dismiss
router.post('/onboarding/dismiss',
  requireRole('super_admin', 'distributor_admin'),
  auditLog('dismiss_onboarding', 'distributor'),
  async (req, res) => {
    try {
      await customerService.dismissOnboarding(req.user!.distributorId!);
      return sendSuccess(res, { ok: true });
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// GET /api/customers/:id
router.get('/:id',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
    try {
      const customer = await customerService.getCustomerById(param(req.params.id), req.user!.distributorId!);
      if (!customer) return sendNotFound(res, 'Customer');
      return sendSuccess(res, mapCustomer(customer));
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/customers
router.post('/',
  requireRole('super_admin', 'distributor_admin', 'inventory'),
  validate(createCustomerSchema),
  auditLog('create', 'customer'),
  async (req, res) => {
    try {
      const customer = await customerService.createCustomer(req.user!.distributorId!, req.body);
      return sendCreated(res, mapCustomer(customer));
    } catch (err: any) {
      const status = err.statusCode || 500;
      return sendError(res, err.message, status);
    }
  }
);

// PUT /api/customers/:id
router.put('/:id',
  requireRole('super_admin', 'distributor_admin', 'inventory'),
  validate(updateCustomerSchema),
  auditLog('update', 'customer'),
  async (req, res) => {
    try {
      const customer = await customerService.updateCustomer(
        param(req.params.id), req.user!.distributorId!, req.body, req.user!.userId
      );
      return sendSuccess(res, mapCustomer(customer));
    } catch (err: any) {
      const status = err.statusCode || 500;
      return sendError(res, err.message, status);
    }
  }
);

// DELETE /api/customers/:id
router.delete('/:id',
  requireRole('super_admin', 'distributor_admin'),
  auditLog('delete', 'customer'),
  async (req, res) => {
    try {
      await customerService.softDeleteCustomer(param(req.params.id), req.user!.distributorId!);
      return sendSuccess(res, { message: 'Customer deleted successfully' });
    } catch (err: any) {
      const status = err.statusCode || 500;
      return sendError(res, err.message, status);
    }
  }
);

// POST /api/customers/:id/modification-requests
router.post('/:id/modification-requests',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(z.object({
    modificationType: z.enum(['update_info', 'credit_limit_change', 'stop_supply', 'resume_supply']),
    reason: z.string().optional(),
    changes: z.any().optional(),
  })),
  auditLog('create', 'customer_modification_request'),
  async (req, res) => {
    try {
      const request = await customerService.createModificationRequest(
        param(req.params.id), req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendCreated(res, request);
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// PUT /api/customers/modification-requests/:requestId/approve
router.put('/modification-requests/:requestId/approve',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  auditLog('approve', 'customer_modification_request'),
  async (req, res) => {
    try {
      const result = await customerService.approveModificationRequest(param(req.params.requestId), req.user!.distributorId!, req.user!.userId);
      return sendSuccess(res, result);
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// PUT /api/customers/modification-requests/:requestId/reject
router.put('/modification-requests/:requestId/reject',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(z.object({ reason: z.string().optional() })),
  auditLog('reject', 'customer_modification_request'),
  async (req, res) => {
    try {
      const result = await customerService.rejectModificationRequest(
        param(req.params.requestId), req.user!.distributorId!, req.user!.userId, req.body.reason
      );
      return sendSuccess(res, result);
    } catch (err: any) {
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

// GET /api/customers/:id/audit-trail
router.get('/:id/audit-trail',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
    try {
      const trail = await customerService.getCustomerAuditTrail(param(req.params.id), req.user!.distributorId!);
      return sendSuccess(res, trail);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/customers/:id/stop-supply
router.post('/:id/stop-supply',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  auditLog('stop_supply', 'customer'),
  async (req, res) => {
    try {
      const result = await customerService.stopSupply(param(req.params.id), req.user!.distributorId!, req.user!.userId);
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/customers/:id/resume-supply
router.post('/:id/resume-supply',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  auditLog('resume_supply', 'customer'),
  async (req, res) => {
    try {
      const result = await customerService.resumeSupply(param(req.params.id), req.user!.distributorId!, req.user!.userId);
      return sendSuccess(res, result);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/customers/:id/balance-setup
router.post('/:id/balance-setup',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  validate(customerBalanceSetupSchema.omit({ customerId: true })),
  auditLog('balance_setup', 'customer'),
  async (req, res) => {
    try {
      const balances = await customerService.setupCustomerBalance(param(req.params.id), req.body.balances);
      return sendSuccess(res, balances);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/customers/:id/portal-access
router.post('/:id/portal-access',
  requireRole('super_admin', 'distributor_admin'),
  validate(z.object({
    email: z.string().email(),
    password: z.string().min(8),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
  })),
  auditLog('provision_portal_access', 'customer'),
  async (req, res) => {
    try {
      const user = await customerService.provisionPortalAccess(
        param(req.params.id), req.user!.distributorId!, req.body
      );
      return sendCreated(res, mapUser(user));
    } catch (err: any) {
      if (err.code === 'P2002') {
        return sendError(res, 'A user with this email already exists', 409, 'CONFLICT');
      }
      return sendError(res, err.message, err.statusCode || 500);
    }
  }
);

export default router;
