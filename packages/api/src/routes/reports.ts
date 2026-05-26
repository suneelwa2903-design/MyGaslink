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
