import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound, sendForbidden } from '../utils/apiResponse.js';
import { generateCustomerLedgerPdf } from '../services/pdf/customerLedgerPdfService.js';
import {
  createCustomerSchema, updateCustomerSchema, customerFilterSchema,
  customerBalanceSetupSchema,
} from '@gaslink/shared';
import * as customerService from '../services/customerService.js';
import { mapCustomer, mapCustomers, mapUser } from '../utils/mappers.js';
import { z } from 'zod';

type ServiceError = { message: string; statusCode?: number; code?: string };

const router = Router();

// GET /api/customers
// FLOAT-001 (2026-06-17): driver role added so the walk-in flow on mobile can
// search the tenant's customer book. The route already scopes by
// req.user.distributorId so tenant isolation holds — driver only sees their
// own tenant's customers. POST /customers stays admin-only (mutations gated).
router.get('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'driver', 'mini_operator_admin'),
  validateQuery(customerFilterSchema),
  async (req, res) => {
    try {
      const result = await customerService.listCustomers(req.user!.distributorId!, (req.validated?.query || req.query) as Parameters<typeof customerService.listCustomers>[1]);
      // meta nested in data — see invoices.ts list comment (commit 4faa018).
      return sendSuccess(res, { customers: mapCustomers(result.data), meta: result.meta }, 200, result.meta);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/customers/import-csv  (must come before /:id)
const customerImportRowSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  // 2026-06-11: optional `business_name` column for the legal / billing
  // entity name (typically B2B). Customer.businessName is the canonical
  // field; `name` stays the operator-friendly contact label.
  businessName: z.string().optional(),
  address: z.string().optional(),
  // Group 3 (2026-06-11): structured address columns. When supplied, they
  // take precedence over the auto-parse of the single `address` field.
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  pincode: z.string().optional(),
  // Group D2 (2026-06-11): optional shipping address columns. Absent →
  // delivery uses the billing address. Present → customer ships to a
  // separate location.
  shippingLine1: z.string().optional(),
  shippingLine2: z.string().optional(),
  shippingCity: z.string().optional(),
  shippingState: z.string().optional(),
  shippingPincode: z.string().optional(),
  gstin: z.string().optional(),
  email: z.string().optional(),
  creditPeriodDays: z.number().int().min(0).optional(),
  customerType: z.string().optional(),
  transportChargePerCylinder: z.number().min(0).optional(),
});

router.post('/import-csv',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(z.object({ rows: z.array(customerImportRowSchema).min(1).max(1000) })),
  auditLog('import', 'customer'),
  async (req, res) => {
    try {
      const result = await customerService.importCustomers(req.user!.distributorId!, req.body.rows);
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/customers/import-empty-balances — Group 4 (2026-06-11)
const emptyBalanceRowSchema = z.object({
  customerName: z.string().optional(),
  phone: z.string().optional(),
  cylinderType: z.string().min(1),
  emptyQuantity: z.number().int().min(0),
}).refine((r) => !!(r.customerName?.trim() || r.phone?.trim()), {
  message: 'either customerName or phone is required',
});

router.post('/import-empty-balances',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(z.object({ rows: z.array(emptyBalanceRowSchema).min(1).max(5000) })),
  auditLog('import_empty_balances', 'customer'),
  async (req, res) => {
    try {
      const result = await customerService.importEmptyBalances(
        req.user!.distributorId!, req.body.rows,
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/customers/import-opening-balances
const openingBalanceRowSchema = z.object({
  customerName: z.string().optional(),
  phone: z.string().optional(),
  openingBalance: z.number(),
  notes: z.string().optional(),
  // Group 3: optional per-row as-of-date. YYYY-MM-DD.
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).refine((r) => !!(r.customerName?.trim() || r.phone?.trim()), {
  message: 'either customerName or phone is required',
});

router.post('/import-opening-balances',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(z.object({
    rows: z.array(openingBalanceRowSchema).min(1).max(2000),
    // Group 3 (2026-06-11): when true, existing OB invoices for matched
    // customers are deleted before the new ones are created. Defaults to
    // false — re-running the same CSV is then a no-op.
    replaceExisting: z.boolean().optional(),
  })),
  auditLog('import_opening_balances', 'customer'),
  async (req, res) => {
    try {
      const result = await customerService.importOpeningBalances(
        req.user!.distributorId!, req.user!.userId, req.body.rows,
        { replaceExisting: req.body.replaceExisting === true },
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// GET /api/customers/onboarding/progress
router.get('/onboarding/progress',
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const data = await customerService.getOnboardingProgress(req.user!.distributorId!);
      return sendSuccess(res, data);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/customers/onboarding/dismiss
router.post('/onboarding/dismiss',
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
  auditLog('dismiss_onboarding', 'distributor'),
  async (req, res) => {
    try {
      await customerService.dismissOnboarding(req.user!.distributorId!);
      return sendSuccess(res, { ok: true });
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// GET /api/customers/:id
router.get('/:id',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
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

// GET /api/customers/:id/contacts
//
// Group B Part 7 Bug 1+6 — used by the Add User modal's role=Customer flow:
// admin picks a customer, then a secondary picker shows that customer's
// CONTACT rows (name + phone + email). Picking a contact prefills the new
// user's name/phone/email. The endpoint is split from GET /api/customers/:id
// so the picker doesn't fetch the full customer with all its relations just
// to read the contacts subtree.
router.get('/:id/contacts',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const customer = await customerService.getCustomerById(param(req.params.id), req.user!.distributorId!);
      if (!customer) return sendNotFound(res, 'Customer');
      // Map each contact to { contactId, name, phone, email, isPrimary }
      // — the schema-native shape the picker expects.
      const contacts = (customer.contacts ?? []).map((c) => ({
        contactId: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        isPrimary: c.isPrimary,
      }));
      return sendSuccess(res, { contacts });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/customers/:id/ledger/pdf — customer statement PDF (WI-092)
// Accessible to staff roles and to the customer themselves (own statement only).
router.get('/:id/ledger/pdf',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'customer', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const customerId = param(req.params.id);
      if (req.user!.role === 'customer' && req.user!.customerId !== customerId) {
        return sendForbidden(res, 'You can only download your own statement');
      }
      const from = typeof req.query.from === 'string' ? req.query.from : undefined;
      const to = typeof req.query.to === 'string' ? req.query.to : undefined;
      const pdfBuffer = await generateCustomerLedgerPdf(req.user!.distributorId!, customerId, { from, to });
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="statement-${customerId}.pdf"`,
        'Content-Length': String(pdfBuffer.length),
      });
      return res.send(pdfBuffer);
    } catch (err: unknown) {
      const e = err as ServiceError;
      if (e.message === 'Customer not found') return sendNotFound(res, 'Customer');
      return sendError(res, e.message, 500);
    }
  }
);

// POST /api/customers
router.post('/',
  requireRole('super_admin', 'distributor_admin', 'inventory', 'mini_operator_admin'),
  validate(createCustomerSchema),
  auditLog('create', 'customer'),
  async (req, res) => {
    try {
      const result = await customerService.createCustomer(req.user!.distributorId!, req.body);
      // Group E1 (2026-06-11): envelope now ships an optional `warnings`
      // array alongside the Customer fields. Front-end shows them as an
      // amber banner (soft signal that the row saved but something is
      // worth reviewing — currently: duplicate-GSTIN multi-branch).
      return sendCreated(res, { ...mapCustomer(result.customer), warnings: result.warnings });
    } catch (err: unknown) {
      const e = err as ServiceError;
      const status = e.statusCode || 500;
      return sendError(res, e.message, status);
    }
  }
);

// PUT /api/customers/:id
router.put('/:id',
  requireRole('super_admin', 'distributor_admin', 'inventory', 'finance', 'mini_operator_admin'),
  validate(updateCustomerSchema),
  auditLog('update', 'customer'),
  async (req, res) => {
    try {
      // Per-field role guard: only super_admin / distributor_admin / finance
      // can change customer.status. Inventory keeps general-edit access
      // (address / phone / credit period) but is barred from suspending or
      // closing accounts.
      if (req.body.status !== undefined) {
        const statusAllowed: ReadonlyArray<string> = ['super_admin', 'distributor_admin', 'finance'];
        if (!statusAllowed.includes(req.user!.role)) {
          return sendForbidden(res, 'You do not have permission to change customer status');
        }
      }
      const result = await customerService.updateCustomer(
        param(req.params.id), req.user!.distributorId!, req.body, req.user!.userId
      );
      return sendSuccess(res, { ...mapCustomer(result.customer), warnings: result.warnings });
    } catch (err: unknown) {
      const e = err as ServiceError;
      const status = e.statusCode || 500;
      return sendError(res, e.message, status);
    }
  }
);

// DELETE /api/customers/:id
router.delete('/:id',
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
  auditLog('delete', 'customer'),
  async (req, res) => {
    try {
      await customerService.softDeleteCustomer(param(req.params.id), req.user!.distributorId!);
      return sendSuccess(res, { message: 'Customer deleted successfully' });
    } catch (err: unknown) {
      const e = err as ServiceError;
      const status = e.statusCode || 500;
      return sendError(res, e.message, status);
    }
  }
);

// POST /api/customers/:id/modification-requests
router.post('/:id/modification-requests',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
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
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// PUT /api/customers/modification-requests/:requestId/approve
router.put('/modification-requests/:requestId/approve',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  auditLog('approve', 'customer_modification_request'),
  async (req, res) => {
    try {
      const result = await customerService.approveModificationRequest(param(req.params.requestId), req.user!.distributorId!, req.user!.userId);
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// PUT /api/customers/modification-requests/:requestId/reject
router.put('/modification-requests/:requestId/reject',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(z.object({ reason: z.string().optional() })),
  auditLog('reject', 'customer_modification_request'),
  async (req, res) => {
    try {
      const result = await customerService.rejectModificationRequest(
        param(req.params.requestId), req.user!.distributorId!, req.user!.userId, req.body.reason
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// GET /api/customers/:id/audit-trail
router.get('/:id/audit-trail',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
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
  requireRole('super_admin', 'distributor_admin', 'inventory', 'mini_operator_admin'),
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
  requireRole('super_admin', 'distributor_admin', 'inventory', 'mini_operator_admin'),
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

// GET /api/customers/:id/balance — Fix B (2026-06-11)
//
// Read every CustomerInventoryBalance row for a customer. Tenant-scoped:
// returns 403 CROSS_TENANT_ACCESS when the customer id doesn't belong to
// the caller's tenant — matches the POST /balance-setup pattern
// established in Group 4 (K7). The two endpoints now respond identically
// to the same probe.
router.get('/:id/balance',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const { prisma } = await import('../lib/prisma.js');
      const customerId = param(req.params.id);
      const customer = await prisma.customer.findFirst({
        where: { id: customerId, distributorId: req.user!.distributorId!, deletedAt: null },
        select: { id: true },
      });
      if (!customer) return sendError(res, 'Customer does not belong to this distributor', 403, 'CROSS_TENANT_ACCESS');
      const rows = await prisma.customerInventoryBalance.findMany({
        where: { customerId },
        include: { cylinderType: { select: { id: true, typeName: true } } },
        orderBy: { cylinderType: { typeName: 'asc' } },
      });
      return sendSuccess(res, {
        balances: rows.map((r) => ({
          cylinderTypeId: r.cylinderTypeId,
          cylinderTypeName: r.cylinderType.typeName,
          withCustomerQty: r.withCustomerQty,
          pendingReturns: r.pendingReturns,
          missingQty: r.missingQty,
          updatedAt: r.lastUpdated.toISOString(),
        })),
      });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/customers/:id/balance-setup
//
// Group 4 (2026-06-11): the service now requires distributorId so the
// CrossTenantError path returns 403 with CROSS_TENANT_ACCESS instead of
// silently writing to another distributor's customer (K7 in the audit).
router.post('/:id/balance-setup',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(customerBalanceSetupSchema.omit({ customerId: true })),
  auditLog('balance_setup', 'customer'),
  async (req, res) => {
    try {
      const balances = await customerService.setupCustomerBalance(
        param(req.params.id),
        req.user!.distributorId!,
        req.body.balances,
      );
      return sendSuccess(res, balances);
    } catch (err) {
      if (err instanceof customerService.CrossTenantError) {
        return sendError(res, err.message, 403, 'CROSS_TENANT_ACCESS');
      }
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/customers/:id/portal-access
router.post('/:id/portal-access',
  requireRole('super_admin', 'distributor_admin', 'mini_operator_admin'),
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
    } catch (err: unknown) {
      const e = err as ServiceError;
      if (e.code === 'P2002') {
        return sendError(res, 'A user with this email already exists', 409, 'CONFLICT');
      }
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

export default router;
