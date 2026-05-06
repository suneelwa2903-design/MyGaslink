import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import * as analyticsService from '../services/analyticsService.js';

const router = Router();

// GET /api/analytics/dashboard
router.get('/dashboard',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  async (req, res) => {
  try {
    const stats = await analyticsService.getDashboardStats(req.user!.distributorId!);
    return sendSuccess(res, stats);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/analytics/header-metrics
router.get('/header-metrics',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  async (req, res) => {
  try {
    const [financialMetrics, advancedMetrics] = await Promise.all([
      analyticsService.getHeaderMetrics(req.user!.distributorId!),
      analyticsService.getAdvancedMetrics(req.user!.distributorId!),
    ]);
    return sendSuccess(res, { ...financialMetrics, ...advancedMetrics });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/analytics/empty-cylinders
router.get('/empty-cylinders',
  requireRole('super_admin', 'distributor_admin', 'finance', 'inventory'),
  async (req, res) => {
  try {
    const report = await analyticsService.getEmptyCylindersReport(req.user!.distributorId!);
    return sendSuccess(res, report);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/analytics/due-amounts
router.get('/due-amounts',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  async (req, res) => {
  try {
    const report = await analyticsService.getDueAmountsReport(req.user!.distributorId!);
    return sendSuccess(res, report);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/analytics/top-sales
router.get('/top-sales',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    if (!dateFrom || !dateTo) {
      return sendError(res, 'dateFrom and dateTo query parameters are required', 400);
    }
    const report = await analyticsService.getTopSales(
      req.user!.distributorId!, dateFrom as string, dateTo as string
    );
    return sendSuccess(res, report);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/analytics/driver-performance
router.get('/driver-performance',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  async (req, res) => {
  try {
    const report = await analyticsService.getDriverDeliveryPerformance(
      req.user!.distributorId!,
      req.query.dateFrom as string,
      req.query.dateTo as string
    );
    return sendSuccess(res, report);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/analytics/revenue-trends
router.get('/revenue-trends',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  async (req, res) => {
  try {
    const months = req.query.months ? parseInt(req.query.months as string, 10) : 12;
    const trends = await analyticsService.getRevenueTrends(req.user!.distributorId!, months);
    return sendSuccess(res, trends);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/analytics/customer-lifetime-value
router.get('/customer-lifetime-value',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  async (req, res) => {
  try {
    const report = await analyticsService.getCustomerLifetimeValue(req.user!.distributorId!);
    return sendSuccess(res, report);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/analytics/collections
router.get('/collections',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  async (req, res) => {
  try {
    const report = await analyticsService.getCollectionsDashboard(req.user!.distributorId!);
    return sendSuccess(res, report);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/analytics/overdue-call-list — customers past credit period, sorted by days overdue
router.get('/overdue-call-list',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  async (req, res) => {
    try {
      const list = await analyticsService.getOverdueCallList(req.user!.distributorId!);
      return sendSuccess(res, list);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  });

// GET /api/analytics/advanced-metrics
router.get('/advanced-metrics',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  async (req, res) => {
  try {
    const metrics = await analyticsService.getAdvancedMetrics(req.user!.distributorId!);
    return sendSuccess(res, metrics);
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/analytics/reports - bundled report for AnalyticsPage
router.get('/reports',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    if (!dateFrom || !dateTo) {
      return sendError(res, 'dateFrom and dateTo query parameters are required', 400);
    }

    const distributorId = req.user!.distributorId!;
    const from = dateFrom as string;
    const to = dateTo as string;

    const [revenueTrends, topSales, driverPerf, clv] = await Promise.all([
      analyticsService.getRevenueTrends(distributorId),
      analyticsService.getTopSales(distributorId, from, to),
      analyticsService.getDriverDeliveryPerformance(distributorId, from, to),
      analyticsService.getCustomerLifetimeValue(distributorId),
    ]);

    return sendSuccess(res, {
      revenueByMonth: revenueTrends,
      topCustomers: topSales.map(s => ({
        customerName: s.customerName,
        revenue: s.totalAmount,
        orders: s.orderCount,
      })),
      driverPerformance: driverPerf.map(d => ({
        driverName: d.driverName,
        deliveries: d.deliveredOrders,
        onTimeRate: d.deliveryRate,
      })),
      customerLifetimeValue: clv.map(c => ({
        customerName: c.customerName,
        totalRevenue: c.totalRevenue,
        totalOrders: c.monthsActive,
        firstOrderDate: '',
      })),
    });
  } catch (err) {
    return sendError(res, (err as Error).message);
  }
});

// GET /api/analytics/export/due-amounts - Excel export data
router.get('/export/due-amounts',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  async (req, res) => {
    try {
      const report = await analyticsService.getDueAmountsReport(req.user!.distributorId!);
      return sendSuccess(res, report);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/analytics/export/collections
router.get('/export/collections',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  async (req, res) => {
    try {
      const report = await analyticsService.getCollectionsDashboard(req.user!.distributorId!);
      return sendSuccess(res, report);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

// GET /api/analytics/export/empty-cylinders
router.get('/export/empty-cylinders',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  async (req, res) => {
    try {
      const report = await analyticsService.getEmptyCylindersReport(req.user!.distributorId!);
      return sendSuccess(res, report);
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

export default router;
