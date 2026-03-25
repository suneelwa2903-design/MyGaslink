import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  HiOutlineCurrencyRupee,
  HiOutlineArrowDownTray,
  HiOutlineTruck,
  HiOutlineCube,
  HiOutlineClipboardDocumentList,
  HiOutlineClock,
  HiOutlineExclamationTriangle,
  HiOutlineBanknotes,
  HiOutlineBell,
  HiOutlineCheckCircle,
  HiOutlineXCircle,
} from 'react-icons/hi2';
import {
  type AnalyticsMetrics,
  type CollectionsDashboard,
  type DashboardStats,
  type PendingAction,
  PendingActionStatus,
  PendingActionSeverity,
} from '@gaslink/shared';
import { apiGet, apiPut, getErrorMessage } from '@/lib/api';
import { Button, Badge, Loader, EmptyState, Modal } from '@/components/ui';
import { cn } from '@/lib/cn';

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);
}

function formatPercent(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

const SEVERITY_VARIANTS: Record<string, 'danger' | 'warning' | 'info' | 'neutral'> = {
  [PendingActionSeverity.CRITICAL]: 'danger',
  [PendingActionSeverity.HIGH]: 'danger',
  [PendingActionSeverity.MEDIUM]: 'warning',
  [PendingActionSeverity.LOW]: 'info',
};

const PA_STATUS_VARIANTS: Record<string, 'success' | 'warning' | 'info' | 'danger' | 'neutral'> = {
  [PendingActionStatus.OPEN]: 'warning',
  [PendingActionStatus.IN_PROGRESS]: 'info',
  [PendingActionStatus.RESOLVED]: 'success',
  [PendingActionStatus.FAILED]: 'danger',
  [PendingActionStatus.SKIPPED]: 'neutral',
};

export default function AnalyticsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'dashboard' | 'overview' | 'collections' | 'reports'>('dashboard');
  const [resolveAction, setResolveAction] = useState<PendingAction | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 1); return d.toISOString().split('T')[0];
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().split('T')[0]);

  const { data: metrics, isLoading: metricsLoading } = useQuery({
    queryKey: ['analytics-metrics', dateFrom, dateTo],
    queryFn: () => apiGet<AnalyticsMetrics>('/analytics/header-metrics', { dateFrom, dateTo }),
  });

  const { data: dashboardStats, isLoading: dashboardLoading } = useQuery({
    queryKey: ['dashboard-stats-analytics', dateFrom, dateTo],
    queryFn: () => apiGet<DashboardStats>('/analytics/dashboard', { dateFrom, dateTo }),
    enabled: tab === 'dashboard',
  });

  const { data: collections, isLoading: collectionsLoading } = useQuery({
    queryKey: ['collections-dashboard'],
    queryFn: () => apiGet<CollectionsDashboard[]>('/analytics/collections'),
    enabled: tab === 'collections',
  });

  const { data: reports, isLoading: reportsLoading } = useQuery({
    queryKey: ['analytics-reports', dateFrom, dateTo],
    queryFn: () => apiGet<{
      revenueByMonth: { month: string; revenue: number }[];
      topCustomers: { customerName: string; revenue: number; orders: number }[];
      driverPerformance: { driverName: string; deliveries: number; onTimeRate: number }[];
      customerLifetimeValue: { customerName: string; totalRevenue: number; totalOrders: number; firstOrderDate: string }[];
    }>('/analytics/reports', { dateFrom, dateTo }),
    enabled: tab === 'reports',
  });

  const { data: pendingActions, isLoading: pendingActionsLoading } = useQuery({
    queryKey: ['pending-actions', { status: 'open' }],
    queryFn: () => apiGet<{ actions: PendingAction[] }>('/pending-actions', { status: 'open' }),
    select: (data) => data.actions,
    enabled: tab === 'dashboard',
  });

  const approveMutation = useMutation({
    mutationFn: (actionId: string) => apiPut(`/pending-actions/${actionId}/approve`),
    onSuccess: () => {
      toast.success('Action approved');
      queryClient.invalidateQueries({ queryKey: ['pending-actions'] });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const rejectMutation = useMutation({
    mutationFn: (actionId: string) => apiPut(`/pending-actions/${actionId}/reject`),
    onSuccess: () => {
      toast.success('Action rejected');
      queryClient.invalidateQueries({ queryKey: ['pending-actions'] });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const resolveMutation = useMutation({
    mutationFn: ({ actionId, notes }: { actionId: string; notes: string }) =>
      apiPut(`/pending-actions/${actionId}/resolve`, { resolutionNotes: notes }),
    onSuccess: () => {
      toast.success('Action resolved');
      queryClient.invalidateQueries({ queryKey: ['pending-actions'] });
      setResolveAction(null);
      setResolutionNotes('');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  function getSlaStatus(slaDeadline: string | null) {
    if (!slaDeadline) return null;
    const deadline = new Date(slaDeadline);
    const now = new Date();
    const hoursLeft = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60);
    if (hoursLeft < 0) return { label: 'Overdue', variant: 'danger' as const };
    if (hoursLeft < 4) return { label: `${Math.round(hoursLeft)}h left`, variant: 'danger' as const };
    if (hoursLeft < 24) return { label: `${Math.round(hoursLeft)}h left`, variant: 'warning' as const };
    return { label: `${Math.round(hoursLeft / 24)}d left`, variant: 'info' as const };
  }

  const handleExportExcel = async (reportType: string) => {
    try {
      const response = await fetch(`/api/analytics/export?type=${reportType}&dateFrom=${dateFrom}&dateTo=${dateTo}`, {
        headers: { Authorization: `Bearer ${JSON.parse(localStorage.getItem('gaslink-auth') || '{}').state?.accessToken || ''}` },
      });
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${reportType}-report.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success('Report downloaded');
    } catch {
      toast.error('Failed to export report');
    }
  };

  const dashboardMetrics = dashboardStats
    ? [
        { label: 'Orders Today', value: dashboardStats.ordersToday, icon: HiOutlineClipboardDocumentList, color: 'text-brand-500', bg: 'bg-brand-50 dark:bg-brand-500/10', link: '/app/orders' },
        { label: 'Delivered', value: dashboardStats.deliveredToday, icon: HiOutlineTruck, color: 'text-accent-500', bg: 'bg-accent-50 dark:bg-accent-500/10', link: '/app/orders?status=delivered' },
        { label: 'Revenue', value: formatCurrency(dashboardStats.revenueToday), icon: HiOutlineCurrencyRupee, color: 'text-accent-600', bg: 'bg-accent-50 dark:bg-accent-500/10', link: '/app/billing' },
        { label: 'Pending Orders', value: dashboardStats.pendingOrders, icon: HiOutlineClock, color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-500/10', link: '/app/orders?status=pending_driver_assignment' },
        { label: 'Overdue Invoices', value: dashboardStats.overdueInvoices, icon: HiOutlineExclamationTriangle, color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-500/10', link: '/app/billing?status=overdue' },
        { label: 'Outstanding Amount', value: formatCurrency(dashboardStats.totalOutstanding), icon: HiOutlineBanknotes, color: 'text-flame-500', bg: 'bg-flame-50 dark:bg-flame-500/10', link: '/app/billing' },
        { label: 'Inventory Alerts', value: dashboardStats.inventoryAlerts, icon: HiOutlineCube, color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-500/10', link: '/app/inventory' },
        { label: 'Pending Actions', value: dashboardStats.pendingActions, icon: HiOutlineBell, color: 'text-brand-500', bg: 'bg-brand-50 dark:bg-brand-500/10', link: '' },
      ]
    : [];

  const tabs = [
    { key: 'dashboard' as const, label: 'Dashboard' },
    { key: 'overview' as const, label: 'Overview' },
    { key: 'collections' as const, label: 'Collections' },
    { key: 'reports' as const, label: 'Reports' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Analytics</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">Business insights and reports</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="input py-2 text-xs" />
          <span className="text-surface-400 text-sm">to</span>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="input py-2 text-xs" />
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-surface-200 dark:border-surface-700">
        <div className="flex gap-4">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'pb-2 text-sm font-medium border-b-2 transition-colors',
                tab === t.key ? 'border-brand-500 text-brand-600 dark:text-brand-400' : 'border-transparent text-surface-500 hover:text-surface-700 dark:hover:text-surface-300',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Dashboard Tab */}
      {tab === 'dashboard' && (
        dashboardLoading ? <div className="flex justify-center py-20"><Loader size="lg" /></div> : (
          <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {dashboardMetrics.map((metric) => (
                <div
                  key={metric.label}
                  className={cn('metric-card flex items-start gap-4', metric.link && 'cursor-pointer hover:ring-2 hover:ring-brand-500/30 transition-shadow')}
                  onClick={() => metric.link && navigate(metric.link)}
                >
                  <div className={cn('flex items-center justify-center h-12 w-12 rounded-xl shrink-0', metric.bg)}>
                    <metric.icon className={cn('h-6 w-6', metric.color)} />
                  </div>
                  <div>
                    <p className="metric-value">{metric.value}</p>
                    <p className="metric-label">{metric.label}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Pending Actions Section */}
            <div className="card p-5">
              <h3 className="font-semibold text-surface-900 dark:text-white mb-4">Pending Actions</h3>
              {pendingActionsLoading ? (
                <div className="flex justify-center py-8"><Loader /></div>
              ) : !pendingActions?.length ? (
                <p className="text-sm text-surface-500">All clear! No items require your attention.</p>
              ) : (
                <div className="space-y-2">
                  {pendingActions.slice(0, 10).map((action) => {
                    const sla = getSlaStatus(action.slaDeadline);
                    return (
                      <div key={action.actionId} className="flex items-start justify-between gap-4 p-3 rounded-lg bg-surface-50 dark:bg-surface-800/50">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <Badge variant={SEVERITY_VARIANTS[action.severity] || 'neutral'}>
                              {action.severity}
                            </Badge>
                            <Badge variant={PA_STATUS_VARIANTS[action.status] || 'neutral'}>
                              {action.status.replace(/_/g, ' ')}
                            </Badge>
                            {sla && (
                              <Badge variant={sla.variant}>
                                <HiOutlineClock className="h-3 w-3 mr-1" />
                                {sla.label}
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm font-medium text-surface-900 dark:text-white">{action.description}</p>
                          <p className="text-xs text-surface-400 mt-1">
                            {action.actionType.replace(/_/g, ' ')} | {action.module.replace(/_/g, ' ')} | {new Date(action.createdAt).toLocaleString('en-IN')}
                          </p>
                        </div>

                        {(action.status === PendingActionStatus.OPEN || action.status === PendingActionStatus.IN_PROGRESS) && (
                          <div className="flex items-center gap-1 shrink-0">
                            {action.requiresApproval && (
                              <>
                                <Button
                                  variant="accent"
                                  size="sm"
                                  onClick={() => approveMutation.mutate(action.actionId)}
                                  loading={approveMutation.isPending}
                                >
                                  <HiOutlineCheckCircle className="h-3 w-3" />
                                  Approve
                                </Button>
                                <Button
                                  variant="danger"
                                  size="sm"
                                  onClick={() => rejectMutation.mutate(action.actionId)}
                                  loading={rejectMutation.isPending}
                                >
                                  <HiOutlineXCircle className="h-3 w-3" />
                                  Reject
                                </Button>
                              </>
                            )}
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setResolveAction(action)}
                            >
                              Resolve
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {pendingActions.length > 10 && (
                    <p className="text-xs text-surface-400 text-center pt-2">
                      Showing 10 of {pendingActions.length} pending actions
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      )}

      {/* Resolve Pending Action Modal */}
      {resolveAction && (
        <Modal open={!!resolveAction} onClose={() => { setResolveAction(null); setResolutionNotes(''); }} title="Resolve Action">
          <div className="space-y-4">
            <p className="text-sm text-surface-700 dark:text-surface-300">{resolveAction.description}</p>
            <div>
              <label className="label">Resolution Notes</label>
              <textarea
                value={resolutionNotes}
                onChange={(e) => setResolutionNotes(e.target.value)}
                className="input min-h-[100px]"
                placeholder="Describe how this was resolved..."
              />
            </div>
            <div className="flex justify-end gap-3">
              <Button variant="secondary" onClick={() => { setResolveAction(null); setResolutionNotes(''); }}>Cancel</Button>
              <Button
                onClick={() => resolveMutation.mutate({ actionId: resolveAction.actionId, notes: resolutionNotes })}
                loading={resolveMutation.isPending}
                disabled={!resolutionNotes.trim()}
              >
                Resolve
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Overview Tab */}
      {tab === 'overview' && (
        metricsLoading ? <div className="flex justify-center py-20"><Loader size="lg" /></div> : !metrics ? (
          <EmptyState title="No metrics available" />
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                { label: 'Amount in Market', value: formatCurrency(metrics.amountInMarket ?? 0), icon: HiOutlineCurrencyRupee, color: 'text-brand-500', bg: 'bg-brand-50 dark:bg-brand-500/10' },
                { label: 'Collected Amount', value: formatCurrency(metrics.collectedAmount ?? 0), icon: HiOutlineCurrencyRupee, color: 'text-accent-500', bg: 'bg-accent-50 dark:bg-accent-500/10' },
                { label: 'Due Amount', value: formatCurrency(metrics.dueAmount ?? 0), icon: HiOutlineCurrencyRupee, color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-500/10' },
                { label: 'Overdue Amount', value: formatCurrency(metrics.overdueAmount ?? 0), icon: HiOutlineCurrencyRupee, color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-500/10' },
                { label: 'Cylinder Utilization', value: formatPercent(metrics.cylinderUtilizationRate ?? 0), icon: HiOutlineCube, color: 'text-brand-500', bg: 'bg-brand-50 dark:bg-brand-500/10' },
                { label: 'Avg Turnaround', value: `${(metrics.averageTurnaroundDays ?? 0).toFixed(1)} days`, icon: HiOutlineTruck, color: 'text-flame-500', bg: 'bg-flame-50 dark:bg-flame-500/10' },
                { label: 'Delivery Efficiency', value: formatPercent(metrics.deliveryEfficiency ?? 0), icon: HiOutlineTruck, color: 'text-accent-500', bg: 'bg-accent-50 dark:bg-accent-500/10' },
                { label: 'Inventory Shrinkage', value: formatPercent(metrics.inventoryShrinkage ?? 0), icon: HiOutlineCube, color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-500/10' },
              ].map((m) => (
                <div key={m.label} className="metric-card flex items-start gap-4">
                  <div className={cn('flex items-center justify-center h-12 w-12 rounded-xl shrink-0', m.bg)}>
                    <m.icon className={cn('h-6 w-6', m.color)} />
                  </div>
                  <div>
                    <p className="metric-value text-xl">{m.value}</p>
                    <p className="metric-label">{m.label}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      )}

      {/* Collections Tab */}
      {tab === 'collections' && (
        collectionsLoading ? <div className="flex justify-center py-20"><Loader size="lg" /></div> : (
          <div className="space-y-4">
            <div className="flex justify-end">
              <Button variant="secondary" size="sm" onClick={() => handleExportExcel('collections')}>
                <HiOutlineArrowDownTray className="h-4 w-4" />Export to Excel
              </Button>
            </div>
            {!collections?.length ? <EmptyState title="No collection data" /> : (
              <div className="table-container">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Total Due</th>
                      <th>Overdue</th>
                      <th>Days Overdue</th>
                      <th>Missing Cylinders</th>
                      <th>Missing Value</th>
                      <th>Excess Empties</th>
                      <th>Last Payment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {collections.map((c) => (
                      <tr key={c.customerId}>
                        <td className="font-medium text-surface-900 dark:text-white">{c.customerName}</td>
                        <td className="font-medium">{formatCurrency(c.totalDue)}</td>
                        <td className={cn('font-medium', c.overdueDue > 0 && 'text-red-500')}>{formatCurrency(c.overdueDue)}</td>
                        <td>{c.overduesDays > 0 ? <Badge variant="danger">{c.overduesDays}d</Badge> : '-'}</td>
                        <td>{c.missingCylinders > 0 ? <span className="text-red-500 font-medium">{c.missingCylinders}</span> : 0}</td>
                        <td>{c.missingCylinderValue > 0 ? <span className="text-red-500">{formatCurrency(c.missingCylinderValue)}</span> : '-'}</td>
                        <td>{c.excessEmptyCylinders > 0 ? <span className="text-amber-500">{c.excessEmptyCylinders}</span> : 0}</td>
                        <td className="text-xs">
                          {c.lastPaymentDate ? (
                            <div>
                              <p>{new Date(c.lastPaymentDate).toLocaleDateString('en-IN')}</p>
                              <p className="text-surface-400">{c.lastPaymentAmount ? formatCurrency(c.lastPaymentAmount) : ''}</p>
                            </div>
                          ) : 'N/A'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      )}

      {/* Reports Tab */}
      {tab === 'reports' && (
        reportsLoading ? <div className="flex justify-center py-20"><Loader size="lg" /></div> : reports ? (
          <div className="space-y-6">
            {/* Revenue Trends */}
            <div className="card p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-surface-900 dark:text-white">Revenue Trends</h3>
                <Button variant="ghost" size="sm" onClick={() => handleExportExcel('revenue')}>
                  <HiOutlineArrowDownTray className="h-3 w-3" />Export
                </Button>
              </div>
              {!reports.revenueByMonth?.length ? <EmptyState title="No revenue data" /> : (
                <div className="space-y-2">
                  {reports.revenueByMonth.map((r) => {
                    const max = Math.max(...reports.revenueByMonth.map((x) => x.revenue));
                    const pct = max > 0 ? (r.revenue / max) * 100 : 0;
                    return (
                      <div key={r.month} className="flex items-center gap-3">
                        <span className="w-20 text-xs text-surface-500 shrink-0">{r.month}</span>
                        <div className="flex-1 h-6 bg-surface-100 dark:bg-surface-700 rounded-full overflow-hidden">
                          <div className="h-full bg-brand-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-xs font-medium text-surface-700 dark:text-surface-300 w-24 text-right">{formatCurrency(r.revenue)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Top Customers */}
            <div className="card p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-surface-900 dark:text-white">Top Customers</h3>
                <Button variant="ghost" size="sm" onClick={() => handleExportExcel('top-customers')}>
                  <HiOutlineArrowDownTray className="h-3 w-3" />Export
                </Button>
              </div>
              {!reports.topCustomers?.length ? <EmptyState title="No data" /> : (
                <div className="table-container">
                  <table className="table">
                    <thead><tr><th>Customer</th><th>Revenue</th><th>Orders</th></tr></thead>
                    <tbody>
                      {reports.topCustomers.map((c, i) => (
                        <tr key={i}>
                          <td className="font-medium text-surface-900 dark:text-white">{c.customerName}</td>
                          <td className="font-medium">{formatCurrency(c.revenue)}</td>
                          <td>{c.orders}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Driver Performance */}
            <div className="card p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-surface-900 dark:text-white">Driver Performance</h3>
                <Button variant="ghost" size="sm" onClick={() => handleExportExcel('driver-performance')}>
                  <HiOutlineArrowDownTray className="h-3 w-3" />Export
                </Button>
              </div>
              {!reports.driverPerformance?.length ? <EmptyState title="No data" /> : (
                <div className="table-container">
                  <table className="table">
                    <thead><tr><th>Driver</th><th>Deliveries</th><th>On-Time Rate</th></tr></thead>
                    <tbody>
                      {reports.driverPerformance.map((d, i) => (
                        <tr key={i}>
                          <td className="font-medium text-surface-900 dark:text-white">{d.driverName}</td>
                          <td>{d.deliveries}</td>
                          <td><Badge variant={d.onTimeRate >= 0.9 ? 'success' : d.onTimeRate >= 0.7 ? 'warning' : 'danger'}>{formatPercent(d.onTimeRate)}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Customer Lifetime Value */}
            <div className="card p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-surface-900 dark:text-white">Customer Lifetime Value</h3>
                <Button variant="ghost" size="sm" onClick={() => handleExportExcel('clv')}>
                  <HiOutlineArrowDownTray className="h-3 w-3" />Export
                </Button>
              </div>
              {!reports.customerLifetimeValue?.length ? <EmptyState title="No data" /> : (
                <div className="table-container">
                  <table className="table">
                    <thead><tr><th>Customer</th><th>Total Revenue</th><th>Total Orders</th><th>First Order</th></tr></thead>
                    <tbody>
                      {reports.customerLifetimeValue.map((c, i) => (
                        <tr key={i}>
                          <td className="font-medium text-surface-900 dark:text-white">{c.customerName}</td>
                          <td className="font-medium">{formatCurrency(c.totalRevenue)}</td>
                          <td>{c.totalOrders}</td>
                          <td>{new Date(c.firstOrderDate).toLocaleDateString('en-IN')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        ) : <EmptyState title="No report data available" />
      )}
    </div>
  );
}
