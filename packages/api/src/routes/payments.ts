import { Router } from 'express';
import { param } from '../utils/params.js';
import { requireRole } from '../middleware/auth.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { auditLog } from '../middleware/auditLog.js';
import { sendSuccess, sendError, sendCreated, sendNotFound } from '../utils/apiResponse.js';
import { createPaymentSchema, paymentFilterSchema } from '@gaslink/shared';
import * as paymentService from '../services/paymentService.js';
import * as submissionService from '../services/paymentSubmissionService.js';
import { generatePaymentRegisterPdf } from '../services/pdf/paymentRegisterPdfService.js';
import { mapPayment, mapPayments, mapPaymentSubmission, mapPaymentSubmissions, mapInvoice } from '../utils/mappers.js';
import { prisma } from '../lib/prisma.js';
import { toNum } from '../utils/decimal.js';
import { z } from 'zod';

type ServiceError = { message: string; statusCode?: number; code?: string };

const router = Router();

const allocatePaymentSchema = z.object({
  invoiceId: z.string().uuid(),
  amount: z.number().positive(),
});

// GET /api/payments
router.get('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validateQuery(paymentFilterSchema),
  async (req, res) => {
    try {
      const result = await paymentService.listPayments(req.user!.distributorId!, (req.validated?.query || req.query) as Parameters<typeof paymentService.listPayments>[1]);
      // meta also nested inside data — see comment in invoices.ts list.
      return sendSuccess(res, { payments: mapPayments(result.data), meta: result.meta }, 200, result.meta);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/payments/export?format=csv|pdf
//
// Bulk export of the current payments filter (all pages). CSV returns
// the same columns as the on-screen table; PDF is a landscape A4
// register with the distributor letterhead. Filters honoured:
//   paymentMethod, dateFrom, dateTo, search.
router.get('/export',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const format = String(req.query.format ?? 'csv').toLowerCase();
      if (format !== 'csv' && format !== 'pdf') {
        return sendError(res, "format must be 'csv' or 'pdf'", 400);
      }
      const filters = {
        paymentMethod: typeof req.query.paymentMethod === 'string' ? req.query.paymentMethod : undefined,
        dateFrom: typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined,
        dateTo: typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
      };
      const distributorId = req.user!.distributorId!;

      if (format === 'pdf') {
        const buf = await generatePaymentRegisterPdf(distributorId, filters);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="payment-register-${filters.dateFrom ?? 'all'}_${filters.dateTo ?? 'all'}.pdf"`);
        return res.status(200).send(buf);
      }

      // CSV
      const { data: rows } = await paymentService.listPayments(distributorId, {
        ...filters,
        page: 1,
        pageSize: 10_000,
        sortBy: 'transactionDate',
        sortOrder: 'desc',
      });
      const mapped = mapPayments(rows) as Array<{
        transactionDate?: string;
        customerName?: string;
        amount?: number;
        paymentMethod?: string;
        referenceNumber?: string | null;
        allocations?: { invoiceNumber?: string; invoiceIssueDate?: string }[];
        allocatedAmount?: number;
        unallocatedAmount?: number;
        allocationStatus?: string;
        notes?: string | null;
      }>;
      const esc = (v: unknown): string => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = ['Payment Date','Customer','Amount','Method','Reference','Invoice #','Issue Date','Allocated','Unallocated','Status','Notes'];
      const lines = [header.map(esc).join(',')];
      for (const p of mapped) {
        const allocs = p.allocations ?? [];
        const single = allocs.length === 1 ? allocs[0] : null;
        const bulk = allocs.length > 1 ? allocs.length : 0;
        const invoiceCell = single ? (single.invoiceNumber ?? '-') : bulk > 0 ? `${bulk} invoices` : '-';
        const issueCell = single?.invoiceIssueDate
          ? new Date(single.invoiceIssueDate).toISOString().slice(0, 10)
          : bulk > 0 ? 'Various' : '-';
        lines.push([
          p.transactionDate ? new Date(p.transactionDate).toISOString().slice(0, 10) : '',
          p.customerName ?? '',
          p.amount ?? '',
          (p.paymentMethod ?? '').replace(/_/g, ' '),
          p.referenceNumber ?? '',
          invoiceCell,
          issueCell,
          p.allocatedAmount ?? '',
          p.unallocatedAmount ?? '',
          (p.allocationStatus ?? '').replace(/_/g, ' '),
          p.notes ?? '',
        ].map(esc).join(','));
      }
      const csv = lines.join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="payments-${filters.dateFrom ?? 'all'}_${filters.dateTo ?? 'all'}.csv"`);
      return res.status(200).send(csv);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// POST /api/payments
router.post('/',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(createPaymentSchema),
  auditLog('create', 'payment'),
  async (req, res) => {
    try {
      const payment = await paymentService.createPayment(
        req.user!.distributorId!, req.user!.userId, req.body
      );
      return sendCreated(res, mapPayment(payment));
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

// POST /api/payments/:id/allocate — apply unallocated payment to an invoice
router.post('/:id/allocate',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validate(allocatePaymentSchema),
  auditLog('allocate', 'payment'),
  async (req, res) => {
    try {
      const result = await paymentService.allocatePayment(
        req.user!.distributorId!, req.user!.userId, param(req.params.id), req.body,
      );
      return sendSuccess(res, {
        payment: mapPayment(result.payment),
        invoice: mapInvoice(result.invoice),
      });
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);

const ledgerQuerySchema = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// GET /api/payments/ledger/:customerId
//
// Returns the true ledger timeline (CustomerLedgerEntry rows: invoice
// debit, payment credit, credit/debit note adjustments, opening balance,
// cancellation reversals, accountability charges). Both web and mobile
// LedgerTab components were typed as `LedgerEntry[]` since they shipped,
// but the route previously returned the delivery-aggregate
// `CustomerLedgerResponse = { rows, summary }` (used by the PDF statement
// — kept intact at /api/customers/:id/ledger/pdf). The aggregate shape
// has zero overlap with the `entryType`/`amountDelta`/`entryDate`/
// `narration` fields the UI reads, so every ledger tab silently rendered
// "No ledger entries". Anti-pattern #9 — fixed 2026-06-01 by switching
// this endpoint to return what the UI actually wants. PDF callers stay
// on /api/customers/:id/ledger/pdf, which still calls getCustomerLedger.
router.get('/ledger/:customerId',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  validateQuery(ledgerQuerySchema),
  async (req, res) => {
  try {
    const q = (req.validated?.query || req.query) as { dateFrom?: string; dateTo?: string };
    const distributorId = req.user!.distributorId!;
    const customerId = param(req.params.customerId);

    const entries = await prisma.customerLedgerEntry.findMany({
      where: {
        distributorId,
        customerId,
        ...(q.dateFrom || q.dateTo
          ? { entryDate: {
              ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}),
              ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}),
            } }
          : {}),
      },
      orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }],
    });

    // Group 1 (2026-06-11): enrich invoice_entry rows with empties data so
    // the in-app modal can show the same Empties Collected / Pending /
    // Empties Cost columns the statement PDF has. We also flag opening-
    // balance entries so the UI can pin the b/f row to the top.
    const invoiceIds = Array.from(
      new Set(entries.map((e) => e.invoiceId).filter((x): x is string => !!x)),
    );
    const invoices = invoiceIds.length === 0
      ? []
      : await prisma.invoice.findMany({
          where: { id: { in: invoiceIds }, distributorId },
          select: {
            id: true,
            isOpeningBalance: true,
            order: {
              select: {
                items: {
                  select: {
                    cylinderTypeId: true,
                    quantity: true,
                    deliveredQuantity: true,
                    emptiesCollected: true,
                  },
                },
              },
            },
          },
        });
    const invoiceMap = new Map(invoices.map((i) => [i.id, i]));

    const emptyPrices = await prisma.emptyCylinderPrice.findMany({ where: { distributorId } });
    const emptyPriceMap = new Map<string, number>(
      emptyPrices.map((ep) => [ep.cylinderTypeId, toNum(ep.emptyCylinderPrice)] as const),
    );

    // Walk the full history once to compute the running pending-empties
    // balance per cylinder type so each entry's `pendingEmptyCyls` reflects
    // the state at the moment that entry posted. Matches the statement PDF.
    const pendingPerType = new Map<string, number>();
    const enriched = entries.map((e) => {
      const inv = e.invoiceId ? invoiceMap.get(e.invoiceId) : null;
      let perEntryCollected = 0;
      let perEntryEmptiesCost = 0;
      let perEntryPending = 0;

      if (e.entryType === 'invoice_entry' && inv?.order?.items?.length) {
        for (const it of inv.order.items) {
          const delivered = it.deliveredQuantity ?? it.quantity;
          const collected = it.emptiesCollected ?? 0;
          perEntryCollected += collected;
          const cur = pendingPerType.get(it.cylinderTypeId) ?? 0;
          const next = Math.max(0, cur + delivered - collected);
          pendingPerType.set(it.cylinderTypeId, next);
          perEntryPending += next;
          perEntryEmptiesCost += next * (emptyPriceMap.get(it.cylinderTypeId) ?? 0);
        }
      }

      return {
        id: e.id,
        distributorId: e.distributorId,
        customerId: e.customerId,
        entryType: e.entryType,
        referenceId: e.referenceId,
        invoiceId: e.invoiceId,
        amountDelta: toNum(e.amountDelta),
        narration: e.narration,
        entryDate: e.entryDate.toISOString(),
        createdBy: e.createdBy,
        createdAt: e.createdAt.toISOString(),
        isOpeningBalance: !!inv?.isOpeningBalance,
        emptyCylsCollected: perEntryCollected,
        pendingEmptyCyls: perEntryPending,
        emptyCylsCost: Math.round(perEntryEmptiesCost * 100) / 100,
      };
    });

    return sendSuccess(res, enriched);
  } catch (err: unknown) {
    const e = err as ServiceError;
    return sendError(res, e.message, e.statusCode || 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// WI-PENDING-PAYMENTS — Office endpoints for the verification queue.
//
// RBAC: super_admin | distributor_admin | finance ONLY.
// `inventory` is INTENTIONALLY excluded from approval/rejection — record-
// keeping access (the existing GET / and POST / routes above) is one thing;
// clearing customer balances is another, and inventory shouldn't have the
// second power. Deliberate tightening per WI-PENDING-PAYMENTS decision.
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/payments/pending — list pending submissions awaiting verification
const pendingQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

router.get('/pending',
  requireRole('super_admin', 'distributor_admin', 'finance', 'mini_operator_admin'),
  validateQuery(pendingQuerySchema),
  async (req, res) => {
    try {
      const q = (req.validated?.query || req.query) as z.infer<typeof pendingQuerySchema>;
      const result = await submissionService.listPending(req.user!.distributorId!, q);
      return sendSuccess(
        res,
        { submissions: mapPaymentSubmissions(result.submissions) },
        200,
        result.meta,
      );
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  },
);

// GET /api/payments/pending/count — badge count for the nav
router.get('/pending/count',
  requireRole('super_admin', 'distributor_admin', 'finance', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const count = await submissionService.countPending(req.user!.distributorId!);
      return sendSuccess(res, { count });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  },
);

// POST /api/payments/:id/verify — approve a pending submission
const verifySubmissionSchema = z.object({
  allocations: z
    .array(
      z.object({
        invoiceId: z.string().uuid(),
        amount: z.number().positive(),
      }),
    )
    .optional(),
});

router.post('/:id/verify',
  requireRole('super_admin', 'distributor_admin', 'finance', 'mini_operator_admin'),
  validate(verifySubmissionSchema),
  auditLog('verify', 'payment_submission'),
  async (req, res) => {
    try {
      const { submission, payment } = await submissionService.verifySubmission(
        req.user!.distributorId!,
        param(req.params.id),
        req.user!.userId,
        req.body.allocations,
      );
      return sendSuccess(res, {
        submission: mapPaymentSubmission(submission),
        payment: mapPayment(payment),
      });
    } catch (err: unknown) {
      const e = err as ServiceError;
      if (e.statusCode === 404) return sendNotFound(res, 'Submission');
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

// POST /api/payments/:id/reject — reject a pending submission
const rejectSubmissionSchema = z.object({
  rejectionReason: z.string().min(5).max(500),
});

router.post('/:id/reject',
  requireRole('super_admin', 'distributor_admin', 'finance', 'mini_operator_admin'),
  validate(rejectSubmissionSchema),
  auditLog('reject', 'payment_submission'),
  async (req, res) => {
    try {
      const submission = await submissionService.rejectSubmission(
        req.user!.distributorId!,
        param(req.params.id),
        req.user!.userId,
        req.body.rejectionReason,
      );
      return sendSuccess(res, mapPaymentSubmission(submission));
    } catch (err: unknown) {
      const e = err as ServiceError;
      if (e.statusCode === 404) return sendNotFound(res, 'Submission');
      return sendError(res, e.message, e.statusCode || 500);
    }
  },
);

export default router;
