import { Router, type Request } from 'express';
import { requireRole } from '../middleware/auth.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/apiResponse.js';
import { REPORTS, reportToCsv, type ReportFilters } from '../services/reportsService.js';
import { buildTallyExport } from '../services/tallyExportService.js';

type ServiceError = { message: string; statusCode?: number; code?: string };

const router = Router();

function parseFilters(q: Request['query']): ReportFilters {
  return {
    dateFrom: typeof q.dateFrom === 'string' ? q.dateFrom : undefined,
    dateTo: typeof q.dateTo === 'string' ? q.dateTo : undefined,
    customerId: typeof q.customerId === 'string' ? q.customerId : undefined,
    cylinderTypeId: typeof q.cylinderTypeId === 'string' ? q.cylinderTypeId : undefined,
    driverId: typeof q.driverId === 'string' ? q.driverId : undefined,
    vehicleId: typeof q.vehicleId === 'string' ? q.vehicleId : undefined,
    groupBy:
      q.groupBy === 'trip' ? 'trip'
      : q.groupBy === 'day' ? 'day'
      : q.groupBy === 'customer' ? 'customer'
      : q.groupBy === 'invoice' ? 'invoice'
      : undefined,
    // INVESTIGATION-JUL09 followup — delivery-performance CSV export toggle
    // for appending per-customer breakdown rows under each driver.
    includeCustomers: q.includeCustomers === 'true' || q.includeCustomers === '1',
    // Driver Statement — invoice-status chip filter (client → server pass-through).
    statusFilter:
      q.statusFilter === 'paid' ? 'paid'
      : q.statusFilter === 'partial' ? 'partial'
      : q.statusFilter === 'pending' ? 'pending'
      : q.statusFilter === 'overdue' ? 'overdue'
      : q.statusFilter === 'all' ? 'all'
      : undefined,
  };
}

// GET /api/reports/tally-export → text/xml attachment (Tally import payload).
// Registered BEFORE the generic /:reportType handler so 'tally-export' is
// not interpreted as a key into the JSON-report REPORTS map. The Tally
// export's only output is XML — there is no JSON variant — so it lives
// outside the REPORTS table by design.
router.get('/tally-export',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const dateFrom = typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined;
      const dateTo = typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined;
      const { xml } = await buildTallyExport(req.user!.distributorId!, { dateFrom, dateTo });
      const fromTag = dateFrom ?? 'all';
      const toTag = dateTo ?? 'all';
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="tally-export-${fromTag}_${toTag}.xml"`,
      );
      return res.status(200).send(xml);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  });

// GET /api/reports/delivery-performance/driver/:driverId/pdf
//   Driver Statement PDF for the given driver + date range + status filter.
//   Registered BEFORE the generic /:reportType handler so the path segments
//   aren't misinterpreted.
router.get('/delivery-performance/driver/:driverId/pdf',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const driverId = String(req.params.driverId);
      const from = typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined;
      const to = typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined;
      const statusFilter =
        req.query.statusFilter === 'paid' ? 'paid'
        : req.query.statusFilter === 'partial' ? 'partial'
        : req.query.statusFilter === 'pending' ? 'pending'
        : req.query.statusFilter === 'overdue' ? 'overdue'
        : 'all';
      const { generateDriverStatementPdf } = await import('../services/pdf/driverStatementPdfService.js');
      const pdfBuffer = await generateDriverStatementPdf(
        req.user!.distributorId!, driverId,
        { from, to, statusFilter },
      );
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="driver-statement-${driverId}.pdf"`,
        'Content-Length': String(pdfBuffer.length),
      });
      return res.send(pdfBuffer);
    } catch (err: unknown) {
      const e = err as ServiceError;
      if (e.message === 'Driver not found') return sendNotFound(res, 'Driver');
      return sendError(res, e.message, 500);
    }
  });

// GET /api/reports/:reportType            → JSON { columns, rows, totals?, chart? }
// GET /api/reports/:reportType?format=csv → text/csv attachment
router.get('/:reportType',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory', 'mini_operator_admin'),
  async (req, res) => {
    try {
      const reportType = String(req.params.reportType);
      const fn = REPORTS[reportType];
      if (!fn) return sendNotFound(res, `Unknown report type: ${reportType}`);
      const filters = parseFilters(req.query);

      // Group 5 (2026-06-11): when the caller didn't pass dateFrom AND the
      // distributor has a goLiveDate set, default dateFrom to goLiveDate so
      // legacy paper debt (opening-balance invoices issued on goLiveDate-1)
      // doesn't dominate the dashboard view. The caller can still override
      // explicitly to look at pre-go-live periods.
      if (!filters.dateFrom) {
        const { prisma } = await import('../lib/prisma.js');
        const d = await prisma.distributor.findUnique({
          where: { id: req.user!.distributorId! },
          select: { goLiveDate: true },
        });
        if (d?.goLiveDate) {
          filters.dateFrom = d.goLiveDate.toISOString().split('T')[0];
        }
      }

      const result = await fn(req.user!.distributorId!, filters);

      if (req.query.format === 'csv') {
        const csv = reportToCsv(result);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${reportType}.csv"`);
        return res.status(200).send(csv);
      }
      return sendSuccess(res, result);
    } catch (err: unknown) {
      const e = err as ServiceError;
      return sendError(res, e.message, e.statusCode || 500);
    }
  });

export default router;
