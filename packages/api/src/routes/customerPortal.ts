import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import * as portalService from '../services/customerPortalService.js';
import * as paymentService from '../services/paymentService.js';
import {
  createRazorpayOrder,
  verifyHandlerSignature,
  isMockKey,
  type RazorpayCreds,
} from '../services/razorpayService.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.js';
import { mapCustomer, mapOrder, mapOrders, mapInvoices, mapCustomerInvoiceDetail, mapPayment, mapPayments } from '../utils/mappers.js';
import { z } from 'zod';

type ServiceError = { message: string; statusCode?: number; code?: string };

const router = Router();

// All routes in this module require 'customer' role.
// The customer's distributorId and customerId come from the JWT payload.

// GET /api/customer-portal/dashboard
router.get('/dashboard',
  requireRole('customer'),
  async (req, res) => {
  try {
    if (!req.user!.customerId) {
      return sendError(res, 'No customer linked to this account', 400);
    }
    const stats = await portalService.getCustomerDashboard(
      req.user!.distributorId!, req.user!.customerId,
      { from: req.query.from as string, to: req.query.to as string }
    );
    return sendSuccess(res, stats);
  } catch (err: unknown) {
    const e = err as ServiceError;
    return sendError(res, e.message, e.statusCode || 500);
  }
});

// ─── Orders ───────────────────────────────────────────────────────────────

// GET /api/customer-portal/orders
router.get('/orders',
  requireRole('customer'),
  async (req, res) => {
  try {
    if (!req.user!.customerId) {
      return sendError(res, 'No customer linked to this account', 400);
    }
    const result = await portalService.getMyOrders(
      req.user!.distributorId!, req.user!.customerId,
      {
        status: req.query.status as string,
        from: req.query.from as string,
        to: req.query.to as string,
        page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
        pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined,
      }
    );
    return sendSuccess(res, { orders: mapOrders(result.data) }, 200, result.meta);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/customer-portal/orders/:id
router.get('/orders/:id',
  requireRole('customer'),
  async (req, res) => {
  try {
    if (!req.user!.customerId) {
      return sendError(res, 'No customer linked to this account', 400);
    }
    const order = await portalService.getMyOrderById(
      req.user!.distributorId!, req.user!.customerId, param(req.params.id)
    );
    if (!order) return sendNotFound(res, 'Order');
    return sendSuccess(res, mapOrder(order));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// POST /api/customer-portal/orders
router.post('/orders',
  requireRole('customer'),
  validate(z.object({
    deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    specialInstructions: z.string().max(500).optional(),
    items: z.array(z.object({
      cylinderTypeId: z.string().uuid(),
      quantity: z.number().int().positive(),
    })).min(1),
    // WI-122: optional payment-commitment fields supplied when the customer
    // confirms a promise-to-pay after the overdue gate prompts them.
    promisedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    promisedAmount: z.number().positive().optional(),
    acknowledged: z.boolean().optional(),
  })),
  auditLog('create', 'customer_order'),
  async (req, res) => {
    try {
      if (!req.user!.customerId) {
        return sendError(res, 'No customer linked to this account', 400);
      }
      const order = await portalService.createMyOrder(
        req.user!.distributorId!, req.user!.customerId, req.user!.userId, req.body
      );
      return sendCreated(res, mapOrder(order));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// PATCH /api/customer-portal/orders/:id/cancel
router.patch('/orders/:id/cancel',
  requireRole('customer'),
  auditLog('cancel', 'customer_order'),
  async (req, res) => {
    try {
      if (!req.user!.customerId) {
        return sendError(res, 'No customer linked to this account', 400);
      }
      const order = await portalService.getMyOrderById(
        req.user!.distributorId!, req.user!.customerId, param(req.params.id)
      );
      if (!order) return sendNotFound(res, 'Order');
      // Customer self-cancel is allowed only before a driver is assigned.
      // Once a driver is tagged (pending_dispatch) the customer must contact
      // the distributor to cancel.
      const cancellableStatuses = ['pending_driver_assignment'];
      if (!cancellableStatuses.includes(order.status)) {
        return sendError(res, 'Order cannot be cancelled at this stage', 400);
      }
      const { cancelOrder } = await import('../services/orderService.js');
      const cancelled = await cancelOrder(
        param(req.params.id), req.user!.distributorId!, req.user!.userId, 'Cancelled by customer'
      );
      return sendSuccess(res, mapOrder(cancelled));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// PATCH /api/customer-portal/orders/:id — customer modifies quantities (WI-093)
// Quantity-only edit of the customer's own order while still pending.
router.patch('/orders/:id',
  requireRole('customer'),
  validate(z.object({
    items: z.array(z.object({
      cylinderTypeId: z.string().uuid(),
      quantity: z.number().int().positive(),
    })).min(1),
    // WI-125: optionally reschedule the delivery date (today/tomorrow only,
    // enforced in the service).
    deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })),
  auditLog('update', 'customer_order'),
  async (req, res) => {
    try {
      if (!req.user!.customerId) {
        return sendError(res, 'No customer linked to this account', 400);
      }
      const order = await portalService.modifyMyOrder(
        req.user!.distributorId!, req.user!.customerId, param(req.params.id), req.body.items, req.body.deliveryDate,
      );
      return sendSuccess(res, mapOrder(order));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/customer-portal/orders/:id/dispute — WI-127
router.post('/orders/:id/dispute',
  requireRole('customer'),
  validate(z.object({ reason: z.string().min(1).max(500) })),
  auditLog('dispute', 'customer_order'),
  async (req, res) => {
    try {
      if (!req.user!.customerId) {
        return sendError(res, 'No customer linked to this account', 400);
      }
      const result = await portalService.raiseDispute(
        req.user!.distributorId!, req.user!.customerId, param(req.params.id), req.body.reason,
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// ─── Invoices ─────────────────────────────────────────────────────────────

// GET /api/customer-portal/invoices
router.get('/invoices',
  requireRole('customer'),
  async (req, res) => {
  try {
    if (!req.user!.customerId) {
      return sendError(res, 'No customer linked to this account', 400);
    }
    const result = await portalService.getMyInvoices(
      req.user!.distributorId!, req.user!.customerId,
      {
        status: req.query.status as string,
        from: req.query.from as string,
        to: req.query.to as string,
        page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
        pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined,
      }
    );
    return sendSuccess(res, { invoices: mapInvoices(result.data) }, 200, result.meta);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/customer-portal/invoices/with-gst - invoices with GST document details
router.get('/invoices/with-gst',
  requireRole('customer'),
  async (req, res) => {
  try {
    if (!req.user!.customerId) {
      return sendError(res, 'No customer linked to this account', 400);
    }
    const invoices = await portalService.getCustomerInvoices(
      req.user!.distributorId!,
      req.user!.customerId,
      {
        dateFrom: req.query.dateFrom as string,
        dateTo: req.query.dateTo as string,
        status: req.query.status as string,
      }
    );
    return sendSuccess(res, mapInvoices(invoices));
  } catch (err: unknown) {
    const e = err as ServiceError;
    return sendError(res, e.message, 500);
  }
});

// GET /api/customer-portal/invoices/download-summary
router.get('/invoices/download-summary',
  requireRole('customer'),
  async (req, res) => {
  try {
    if (!req.user!.customerId) {
      return sendError(res, 'No customer linked to this account', 400);
    }
    const { dateFrom, dateTo } = req.query as { dateFrom: string; dateTo: string };
    if (!dateFrom || !dateTo) return sendError(res, 'dateFrom and dateTo required', 400);
    const summary = await portalService.getInvoiceSummaryForDownload(
      req.user!.distributorId!, req.user!.customerId, dateFrom, dateTo
    );
    return sendSuccess(res, summary);
  } catch (err: unknown) {
    const e = err as ServiceError;
    return sendError(res, e.message, 500);
  }
});

// GET /api/customer-portal/invoices/:id
router.get('/invoices/:id',
  requireRole('customer'),
  async (req, res) => {
  try {
    if (!req.user!.customerId) {
      return sendError(res, 'No customer linked to this account', 400);
    }
    const invoice = await portalService.getMyInvoiceById(
      req.user!.distributorId!, req.user!.customerId, param(req.params.id)
    );
    if (!invoice) return sendNotFound(res, 'Invoice');
    // P0-1: customer-portal-specific shape (lineTotal, subtotal, cgstAmount,
    // payments[] flat). The admin /api/invoices/:id endpoint continues to
    // use mapInvoice with schema-native names; only this customer endpoint
    // returns the customer-friendly shape.
    return sendSuccess(res, mapCustomerInvoiceDetail(invoice));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/customer-portal/invoices/:id/pdf — WI-126, gate widened in P0-2 (007d780)
// Customer-scoped invoice PDF. The shared /api/invoices/:id/pdf is admin-only
// and scopes by distributor (an IDOR for customers), so the portal needs its
// own customer-scoped route. Gate is invoice-status only: issued /
// partially_paid / paid. The linked order's status is NOT checked — see the
// in-body comment at the gate for the CGST Rule 56 / opening-balance rationale.
router.get('/invoices/:id/pdf',
  requireRole('customer'),
  async (req, res) => {
  try {
    if (!req.user!.customerId) {
      return sendError(res, 'No customer linked to this account', 400);
    }
    const invoice = await portalService.getMyInvoiceById(
      req.user!.distributorId!, req.user!.customerId, param(req.params.id)
    );
    if (!invoice) return sendNotFound(res, 'Invoice');

    // P0-2: allow PDF download for any non-draft, non-cancelled invoice.
    // Was previously also gated on `order.status IN [delivered,
    // modified_delivered]` — that hid downloads for opening-balance
    // invoices (no linked order) and historical invoices whose order
    // status had drifted. Indian GST law (CGST Rule 56) requires 8-year
    // retention; the customer-facing app must let customers retrieve any
    // invoice they ever received.
    //
    // Group 1 (2026-06-11): also allow OB-flagged invoices on status
    // 'overdue' (the importer's default — see customerService.ts:606).
    // The PDF renderer at invoicePdfService.ts branches on
    // isOpeningBalance and returns the "Opening Balance Certificate".
    // Cancelled and draft OB rows are still blocked — they're not
    // statutory artefacts (matches the P0-2 test contract).
    const allowedStatuses = ['issued', 'partially_paid', 'paid'];
    const isOpeningBalance = (invoice as { isOpeningBalance?: boolean }).isOpeningBalance === true;
    const obAllowed = isOpeningBalance && invoice.status === 'overdue';
    if (!obAllowed && !allowedStatuses.includes(invoice.status)) {
      return sendError(res, 'A PDF is not available for this invoice', 403);
    }

    const { generateInvoicePdf } = await import('../services/pdf/invoicePdfService.js');
    const pdfBuffer = await generateInvoicePdf(invoice.id, req.user!.distributorId!);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="invoice-${invoice.invoiceNumber}.pdf"`,
      'Content-Length': String(pdfBuffer.length),
    });
    return res.send(pdfBuffer);
  } catch (err: unknown) {
    const e = err as ServiceError;
    return sendError(res, e.message, e.statusCode || 500);
  }
});

// ─── Payments ─────────────────────────────────────────────────────────────

// GET /api/customer-portal/payments
router.get('/payments',
  requireRole('customer'),
  async (req, res) => {
  try {
    if (!req.user!.customerId) {
      return sendError(res, 'No customer linked to this account', 400);
    }
    const result = await portalService.getMyPayments(
      req.user!.distributorId!, req.user!.customerId,
      {
        from: req.query.from as string,
        to: req.query.to as string,
        page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
        pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined,
      }
    );
    return sendSuccess(res, { payments: mapPayments(result.data) }, 200, result.meta);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/customer-portal/payments/:id
router.get('/payments/:id',
  requireRole('customer'),
  async (req, res) => {
  try {
    if (!req.user!.customerId) {
      return sendError(res, 'No customer linked to this account', 400);
    }
    const payment = await portalService.getMyPaymentById(
      req.user!.distributorId!, req.user!.customerId, param(req.params.id)
    );
    if (!payment) return sendNotFound(res, 'Payment');
    return sendSuccess(res, mapPayment(payment));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// ─── Balance & Account ──────────────────────────────────────────────────

// GET /api/customer-portal/balance
router.get('/balance',
  requireRole('customer'),
  async (req, res) => {
  try {
    if (!req.user!.customerId) {
      return sendError(res, 'No customer linked to this account', 400);
    }
    const balance = await portalService.getMyBalance(
      req.user!.distributorId!, req.user!.customerId
    );
    return sendSuccess(res, balance);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/customer-portal/account
router.get('/account',
  requireRole('customer'),
  async (req, res) => {
  try {
    if (!req.user!.customerId) {
      return sendError(res, 'No customer linked to this account', 400);
    }
    const account = await portalService.getMyAccount(
      req.user!.distributorId!, req.user!.customerId
    );
    if (!account) return sendNotFound(res, 'Account');
    return sendSuccess(res, mapCustomer(account));
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// PUT /api/customer-portal/account
router.put('/account',
  requireRole('customer'),
  validate(z.object({
    phone: z.string().min(10).max(15).optional(),
    email: z.string().email().optional(),
    shippingAddressLine1: z.string().max(500).optional(),
    shippingAddressLine2: z.string().max(500).optional(),
    shippingCity: z.string().max(100).optional(),
    shippingState: z.string().max(100).optional(),
    shippingPincode: z.string().max(10).optional(),
  })),
  auditLog('update', 'customer_profile'),
  async (req, res) => {
    try {
      if (!req.user!.customerId) {
        return sendError(res, 'No customer linked to this account', 400);
      }
      const result = await portalService.updateMyProfile(
        req.user!.distributorId!, req.user!.customerId, req.body
      );
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// GET /api/customer-portal/distributor
router.get('/distributor',
  requireRole('customer'),
  async (req, res) => {
  try {
    const info = await portalService.getMyDistributorInfo(req.user!.distributorId!);
    return sendSuccess(res, info);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// ─── Phase F: Razorpay customer-portal payments ─────────────────────────────
//
// Per-distributor model: each tenant configures their own Razorpay
// account; money flows direct from customer to distributor (GasLink
// never touches it). This is the key Phase E→F difference.
//
// Three endpoints:
//   POST /invoices/:id/create-payment-order  — customer authenticated
//   POST /invoices/:id/verify-payment        — customer authenticated
//   (webhook lives at /api/customer-portal/webhooks/razorpay/:distributorId
//    in razorpayCustomerWebhook.ts — mounted BEFORE the authenticated
//    customer-portal router so Razorpay can post to it.)
//
// Tenant isolation: routes resolve the distributor from the invoice
// (NOT the request body), then use distributor.razorpayKeyId /
// razorpayKeySecret as the SDK credentials. Cross-distributor reuse
// is structurally impossible — the customer's JWT pins their
// distributorId, and we verify the invoice belongs to that
// distributorId before any Razorpay call.

const customerPaymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 30 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, data: null, error: 'Too many payment requests', code: 'RATE_LIMITED' },
});

/**
 * Resolve the distributor's Razorpay credentials. Returns null when
 * the tenant has not enabled Razorpay (or has not configured all
 * three fields). Routes handle null by returning 400
 * RAZORPAY_NOT_ENABLED.
 */
async function getDistributorRazorpayCreds(distributorId: string): Promise<RazorpayCreds | null> {
  const dist = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { razorpayEnabled: true, razorpayKeyId: true, razorpayKeySecret: true },
  });
  if (!dist || !dist.razorpayEnabled || !dist.razorpayKeyId || !dist.razorpayKeySecret) {
    return null;
  }
  return { keyId: dist.razorpayKeyId, keySecret: dist.razorpayKeySecret };
}

const createCustomerPaymentOrderSchema = z.object({
  // Customer specifies the amount they want to pay. Allows partial
  // payments (e.g., paying ₹500 against a ₹2,000 invoice). Server
  // bounds to (0, outstandingAmount].
  amount: z.number().positive(),
});

// POST /api/customer-portal/invoices/:id/create-payment-order
router.post('/invoices/:id/create-payment-order',
  customerPaymentLimiter,
  requireRole('customer'),
  validate(createCustomerPaymentOrderSchema),
  auditLog('create_payment_order', 'invoice'),
  async (req, res) => {
    try {
      if (!req.user!.customerId) return sendError(res, 'No customer linked to this account', 400);
      const invoiceId = param(req.params.id);

      const invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, distributorId: req.user!.distributorId!, deletedAt: null },
        select: {
          id: true, invoiceNumber: true, customerId: true,
          outstandingAmount: true, totalAmount: true,
        },
      });
      if (!invoice) return sendNotFound(res, 'Invoice not found');

      // Cross-customer guard: the customer pays only their own invoices.
      if (invoice.customerId !== req.user!.customerId) {
        return sendError(res, 'Invoice does not belong to this customer', 403, 'CROSS_CUSTOMER_ACCESS');
      }

      const outstanding = Number(invoice.outstandingAmount);
      if (outstanding <= 0) {
        return sendError(res, 'Invoice has no outstanding balance', 400, 'ALREADY_PAID');
      }
      const amount = Number(req.body.amount);
      if (amount <= 0 || amount > outstanding) {
        return sendError(
          res,
          `Amount must be between ₹1 and ₹${outstanding.toFixed(2)}`,
          400,
          'AMOUNT_OUT_OF_BOUNDS',
        );
      }

      const creds = await getDistributorRazorpayCreds(req.user!.distributorId!);
      if (!creds) {
        return sendError(res, 'Online payments are not enabled for this distributor', 400, 'RAZORPAY_NOT_ENABLED');
      }

      const order = await createRazorpayOrder(creds, {
        amountInPaise: Math.round(amount * 100),
        // receipt uses invoiceId so the webhook can reverse-look-up.
        receipt: invoice.id,
        notes: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          customerId: invoice.customerId,
          distributorId: req.user!.distributorId!,
        },
      });

      return sendCreated(res, {
        razorpayOrderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: creds.keyId,                  // public key — frontend needs it
        mock: isMockKey(creds.keyId),         // dev fallback indicator
        invoiceNumber: invoice.invoiceNumber,
      });
    } catch (err: unknown) {
      const e = err as ServiceError;
      logger.error('customer-portal create-payment-order failed', {
        invoiceId: req.params.id,
        err: (err as Error).message,
      });
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// POST /api/customer-portal/invoices/:id/verify-payment
const verifyCustomerPaymentSchema = z.object({
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
  amount: z.number().positive(),
});

router.post('/invoices/:id/verify-payment',
  customerPaymentLimiter,
  requireRole('customer'),
  validate(verifyCustomerPaymentSchema),
  auditLog('verify_payment', 'invoice'),
  async (req, res) => {
    try {
      if (!req.user!.customerId) return sendError(res, 'No customer linked to this account', 400);
      const invoiceId = param(req.params.id);
      const { razorpayOrderId, razorpayPaymentId, razorpaySignature, amount } = req.body;

      const invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, distributorId: req.user!.distributorId!, deletedAt: null },
        select: {
          id: true, invoiceNumber: true, customerId: true,
          outstandingAmount: true,
        },
      });
      if (!invoice) return sendNotFound(res, 'Invoice not found');
      if (invoice.customerId !== req.user!.customerId) {
        return sendError(res, 'Invoice does not belong to this customer', 403, 'CROSS_CUSTOMER_ACCESS');
      }

      // Idempotency: if the same razorpayPaymentId already has a row,
      // return success without re-creating. Defends the verify +
      // webhook race the same way the Phase E idempotency check does
      // but on the payment row rather than on a status field.
      const existing = await prisma.paymentTransaction.findFirst({
        where: { razorpayPaymentId, distributorId: req.user!.distributorId! },
      });
      if (existing) {
        return sendSuccess(res, { alreadyPaid: true, payment: mapPayment(existing) });
      }

      const creds = await getDistributorRazorpayCreds(req.user!.distributorId!);
      if (!creds) {
        return sendError(res, 'Online payments are not enabled for this distributor', 400, 'RAZORPAY_NOT_ENABLED');
      }

      const signatureValid = verifyHandlerSignature(creds, razorpayOrderId, razorpayPaymentId, razorpaySignature);
      if (!signatureValid) {
        return sendError(res, 'Invalid payment signature', 400, 'INVALID_SIGNATURE');
      }

      // Route the recording through paymentService.createPayment so
      // allocation + ledger + invoice-flip logic stays in one place
      // (anti-pattern #N: don't duplicate the payment recording
      // logic). The shared service writes the forensic ids in the
      // same transaction.
      const payment = await paymentService.createPayment(
        req.user!.distributorId!,
        null, // userId — customer-initiated, no staff user
        {
          customerId: req.user!.customerId,
          amount,
          paymentMethod: 'upi', // Razorpay-classified method may be
                                // updated later; default to upi for
                                // the most common case.
          referenceNumber: razorpayPaymentId,
          transactionDate: new Date().toISOString().slice(0, 10),
          allocations: [{ invoiceId: invoice.id, amount }],
          razorpay: { razorpayOrderId, razorpayPaymentId, razorpaySignature },
        },
      );

      return sendSuccess(res, { payment: mapPayment(payment) });
    } catch (err: unknown) {
      const e = err as ServiceError;
      logger.error('customer-portal verify-payment failed', {
        invoiceId: req.params.id,
        err: (err as Error).message,
      });
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

export default router;
