import { Router, type Request } from 'express';
import { requireRole } from '../middleware/auth.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/apiResponse.js';
import { REPORTS, reportToCsv, type ReportFilters } from '../services/reportsService.js';

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
    groupBy: q.groupBy === 'trip' ? 'trip' : q.groupBy === 'day' ? 'day' : undefined,
  };
}

// GET /api/reports/:reportType            → JSON { columns, rows, totals?, chart? }
// GET /api/reports/:reportType?format=csv → text/csv attachment
router.get('/:reportType',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
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
