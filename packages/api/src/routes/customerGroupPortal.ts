/**
 * Feature A (2026-07-15): READ-ONLY HQ customer group portal router.
 *
 * Mounted at /api/customer-group-portal. Gated to role=customer_hq
 * only (never composed with requireRole('customer') — that gate
 * protects the Razorpay money endpoints on customerPortal.ts).
 *
 * DEFENCE-IN-DEPTH: a top-level middleware in this router 405s any
 * non-GET method. Even if a future handler is accidentally declared
 * as router.post(), the request would be rejected before reaching it.
 * All exported handlers are read-only wrappers around
 * customerGroupPortalService.
 *
 * The invoice PDF endpoint reuses the existing single-invoice PDF
 * generator via the ownership-verified detail path — the PDF service
 * itself doesn't need to know about groups.
 *
 * The group ledger PDF (/ledger/pdf) is intentionally NOT wired in
 * this commit — it depends on generateGroupLedgerPdf which lands in
 * Step 7E along with the web UI. Added there instead of a stub here.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { param } from '../utils/params.js';
import { requireRole, requireGroupAccess } from '../middleware/auth.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/apiResponse.js';
import * as service from '../services/customerGroupPortalService.js';
import { generateInvoicePdf } from '../services/pdf/invoicePdfService.js';
import { generateGroupLedgerPdf } from '../services/pdf/customerLedgerPdfService.js';
import { prisma } from '../lib/prisma.js';

type ServiceError = { message: string; statusCode?: number; code?: string };

const router = Router();

// Compose the customer_hq role check + group resolution on the whole
// router. Downstream handlers can assume req.visibleCustomerIds is set.
router.use(requireRole('customer_hq'));
router.use(requireGroupAccess);

// Method guard — defence-in-depth against future accidental writes.
router.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      data: null,
      error: 'Method not allowed on the HQ portal — read-only',
      code: 'METHOD_NOT_ALLOWED',
    });
  }
  next();
});

// GET /dashboard?customerId=&from=&to=
//
// 2026-07-19 — dashboard now accepts an optional single-property and
// date-range filter. Absent params default to the whole group + the
// current month (backward compatible with the old response shape).
router.get('/dashboard', async (req, res) => {
  try {
    const filters = {
      customerId: req.query.customerId as string | undefined,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    };
    const data = await service.getDashboard(
      req.user!.distributorId!,
      req.visibleCustomerIds!,
      filters,
    );
    return sendSuccess(res, data);
  } catch (err: unknown) {
    const e = err as ServiceError;
    return sendError(res, e.message, e.statusCode || 500);
  }
});

// GET /orders?customerId=&status=&from=&to=&page=&pageSize=
router.get('/orders', async (req, res) => {
  try {
    const filters = {
      customerId: req.query.customerId as string | undefined,
      status: req.query.status as string | undefined,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      page: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
    };
    const result = await service.getGroupOrders(
      req.user!.distributorId!,
      req.visibleCustomerIds!,
      filters,
    );
    return sendSuccess(res, { orders: result.data, meta: result.meta }, 200, result.meta);
  } catch (err: unknown) {
    const e = err as ServiceError;
    return sendError(res, e.message, e.statusCode || 500);
  }
});

// GET /orders/:orderId
router.get('/orders/:orderId', async (req, res) => {
  try {
    const order = await service.getGroupOrderById(
      req.user!.distributorId!,
      req.visibleCustomerIds!,
      param(req.params.orderId),
    );
    return sendSuccess(res, order);
  } catch (err: unknown) {
    const e = err as ServiceError;
    return sendError(res, e.message, e.statusCode || 500);
  }
});

// GET /invoices?customerId=&status=&from=&to=&page=&pageSize=
router.get('/invoices', async (req, res) => {
  try {
    const filters = {
      customerId: req.query.customerId as string | undefined,
      status: req.query.status as string | undefined,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      page: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
    };
    const result = await service.getGroupInvoices(
      req.user!.distributorId!,
      req.visibleCustomerIds!,
      filters,
    );
    return sendSuccess(res, { invoices: result.data, meta: result.meta }, 200, result.meta);
  } catch (err: unknown) {
    const e = err as ServiceError;
    return sendError(res, e.message, e.statusCode || 500);
  }
});

// GET /invoices/:invoiceId
router.get('/invoices/:invoiceId', async (req, res) => {
  try {
    const invoice = await service.getGroupInvoiceById(
      req.user!.distributorId!,
      req.visibleCustomerIds!,
      param(req.params.invoiceId),
    );
    return sendSuccess(res, invoice);
  } catch (err: unknown) {
    const e = err as ServiceError;
    return sendError(res, e.message, e.statusCode || 500);
  }
});

// GET /invoices/:invoiceId/pdf
router.get('/invoices/:invoiceId/pdf', async (req, res) => {
  try {
    // Ownership check first — reuse getGroupInvoiceById's tenant +
    // group scoping. Throws GroupPortalError 404 if the invoice
    // doesn't belong to a visible customer.
    await service.getGroupInvoiceById(
      req.user!.distributorId!,
      req.visibleCustomerIds!,
      param(req.params.invoiceId),
    );
    // PDF service is single-invoice; no group awareness needed once
    // ownership is verified.
    const buffer = await generateInvoicePdf(
      param(req.params.invoiceId),
      req.user!.distributorId!,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${req.params.invoiceId}.pdf"`);
    return res.send(buffer);
  } catch (err: unknown) {
    const e = err as ServiceError;
    return sendError(res, e.message, e.statusCode || 500);
  }
});

// GET /ledger?customerId=&from=&to=
router.get('/ledger', async (req, res) => {
  try {
    const data = await service.getGroupLedger(
      req.user!.distributorId!,
      req.visibleCustomerIds!,
      {
        customerId: req.query.customerId as string | undefined,
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
      },
    );
    return sendSuccess(res, data);
  } catch (err: unknown) {
    const e = err as ServiceError;
    return sendError(res, e.message, e.statusCode || 500);
  }
});

// GET /ledger/pdf?customerId=&from=&to= — Step 7E group consolidated ledger.
router.get('/ledger/pdf', async (req, res) => {
  try {
    // Resolve group name for the PDF header. requireGroupAccess already
    // verified tenant + group; this is a name-only fetch.
    const group = await prisma.customerGroup.findFirst({
      where: { id: req.user!.groupId!, distributorId: req.user!.distributorId! },
      select: { name: true },
    });
    if (!group) return sendNotFound(res, 'Group');
    const buffer = await generateGroupLedgerPdf(
      req.user!.distributorId!,
      req.visibleCustomerIds!,
      group.name,
      {
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        customerId: req.query.customerId as string | undefined,
      },
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="group-statement.pdf"`);
    return res.send(buffer);
  } catch (err: unknown) {
    const e = err as ServiceError;
    return sendError(res, e.message, e.statusCode || 500);
  }
});

// GET /payments?customerId=&from=&to=&page=&pageSize=
router.get('/payments', async (req, res) => {
  try {
    const result = await service.getGroupPayments(
      req.user!.distributorId!,
      req.visibleCustomerIds!,
      {
        customerId: req.query.customerId as string | undefined,
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        page: req.query.page ? Number(req.query.page) : undefined,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      },
    );
    return sendSuccess(res, { payments: result.data, meta: result.meta }, 200, result.meta);
  } catch (err: unknown) {
    const e = err as ServiceError;
    return sendError(res, e.message, e.statusCode || 500);
  }
});

// GET /aging
router.get('/aging', async (req, res) => {
  try {
    const data = await service.getGroupAging(
      req.user!.distributorId!,
      req.visibleCustomerIds!,
    );
    return sendSuccess(res, data);
  } catch (err: unknown) {
    const e = err as ServiceError;
    return sendError(res, e.message, e.statusCode || 500);
  }
});

// GET /profile
router.get('/profile', async (req, res) => {
  try {
    if (!req.user?.groupId) return sendNotFound(res, 'Group');
    const data = await service.getProfile(
      req.user!.distributorId!,
      req.user.groupId,
    );
    return sendSuccess(res, data);
  } catch (err: unknown) {
    const e = err as ServiceError;
    return sendError(res, e.message, e.statusCode || 500);
  }
});

export default router;
