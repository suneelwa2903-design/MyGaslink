import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { UserRole } from '@gaslink/shared';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  HiOutlineCurrencyRupee,
  HiOutlineTruck,
  HiOutlineCube,
  HiOutlineClock,
  HiOutlineExclamationTriangle,
  HiOutlineBanknotes,
  HiOutlineCheckCircle,
  HiOutlineXCircle,
} from 'react-icons/hi2';
import {
  type AnalyticsMetrics,
  type DashboardStats,
  type OverdueCallListEntry,
  type PendingAction,
  PendingActionStatus,
  PendingActionSeverity,
} from '@gaslink/shared';
import { apiGet, apiPut, getErrorMessage } from '@/lib/api';
import { Button, Badge, Loader, EmptyState, Modal } from '@/components/ui';
import { cn } from '@/lib/cn';
import ReportsPanel from '@/pages/ReportsPage';
import PendingActionsPanel from '@/pages/PendingActionsPage';

interface Insight { icon: string; text: string; severity: 'critical' | 'warning' | 'info'; link?: string; }

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
  const { user, selectedDistributorId } = useAuthStore();
  const isSuperAdmin = user?.role === UserRole.SUPER_ADMIN;
  const role = user?.role;
  const isFinance = role === UserRole.FINANCE;
  const isInventory = role === UserRole.INVENTORY;
  const isDriver = role === UserRole.DRIVER;
  const isAdminLike = role === UserRole.DISTRIBUTOR_ADMIN || (isSuperAdmin && !!selectedDistributorId);

  const [tab, setTab] = useState<'dashboard' | 'overview' | 'reports' | 'pending-actions'>('dashboard');
  const [resolveAction, setResolveAction] = useState<PendingAction | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 1); return d.toISOString().split('T')[0];
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().split('T')[0]);

  // Super admin needs a distributor selected to view analytics data
  const hasDistributor = isSuperAdmin ? !!selectedDistributorId : true;

  const { data: metrics, isLoading: metricsLoading } = useQuery({
    queryKey: ['analytics-metrics', dateFrom, dateTo],
    queryFn: () => apiGet<AnalyticsMetrics>('/analytics/header-metrics', { dateFrom, dateTo }),
    enabled: hasDistributor,
  });

  const { data: dashboardStats, isLoading: dashboardLoading } = useQuery({
    queryKey: ['dashboard-stats-analytics', dateFrom, dateTo],
    queryFn: () => apiGet<DashboardStats>('/analytics/dashboard', { dateFrom, dateTo }),
    enabled: tab === 'dashboard' && hasDistributor,
  });

  const { data: insights } = useQuery({
    queryKey: ['analytics-insights'],
    queryFn: () => apiGet<Insight[]>('/analytics/insights'),
    enabled: tab === 'overview' && hasDistributor,
  });

  const { data: pendingActions, isLoading: pendingActionsLoading } = useQuery({
    queryKey: ['pending-actions', { status: 'open' }],
    queryFn: () => apiGet<{ actions: PendingAction[] }>('/pending-actions', { status: 'open' }),
    select: (data) => data.actions,
    enabled: tab === 'dashboard',
  });

  // ─── Role-aware morning briefing data ────────────────────────────────────────
  // Section A — stock summary (admin-like + inventory)
  const wantStock = tab === 'dashboard' && hasDistributor && (isAdminLike || isInventory);
  const { data: stockSummary } = useQuery({
    queryKey: ['inventory-summary-today'],
    queryFn: () => apiGet<Array<{
      cylinderTypeId: string; cylinderTypeName: string;
      closingFulls: number; closingEmpties: number;
      thresholdWarning: number | null; thresholdCritical: number | null;
    }>>('/inventory/summary'),
    enabled: wantStock,
  });

  // Section C — overdue call list (admin-like + finance)
  const wantCallList = tab === 'dashboard' && hasDistributor && (isAdminLike || isFinance);
  const { data: callList } = useQuery({
    queryKey: ['overdue-call-list'],
    queryFn: () => apiGet<OverdueCallListEntry[]>('/analytics/overdue-call-list'),
    enabled: wantCallList,
  });

  // Threshold alerts for Inventory role (already-low stock)
  const { data: thresholdAlerts } = useQuery({
    queryKey: ['inventory-threshold-alerts'],
    queryFn: () => apiGet<Array<{ cylinderTypeId: string; cylinderTypeName: string; currentStock: number; level: 'warning' | 'critical'; threshold: number }>>('/inventory/threshold-alerts'),
    enabled: tab === 'dashboard' && hasDistributor && isInventory,
  });

  // Unallocated / partially-allocated payments for Finance — explicit
  // server-side filter, sorted by amount desc, top 20 (display caps at 5).
  const { data: unallocatedPayments } = useQuery({
    queryKey: ['payments-unallocated-finance'],
    queryFn: () => apiGet<{ payments: Array<{ paymentId: string; amount: number; allocationStatus: string; transactionDate: string; unallocatedAmount: number; customer?: { customerName?: string } }> }>('/payments', {
      allocationStatus: 'unallocated,partially_allocated',
      sortBy: 'amount',
      sortOrder: 'desc',
      pageSize: 20,
    }),
    select: (d) => d.payments,
    enabled: tab === 'dashboard' && hasDistributor && isFinance,
  });

  // GST failures for Finance
  const { data: gstFailures } = useQuery({
    queryKey: ['invoices-irn-failed'],
    queryFn: () => apiGet<{ invoices: Array<{ invoiceId: string; invoiceNumber: string; totalAmount: number; irnStatus: string }> }>('/invoices', { irnStatus: 'failed', pageSize: 5 }),
    select: (d) => d.invoices.slice(0, 5),
    enabled: tab === 'dashboard' && hasDistributor && isFinance,
  });

  // Today's reconciliation pending for Inventory
  const { data: pendingReconciliation } = useQuery({
    queryKey: ['inventory-reconciliation-today'],
    queryFn: () => apiGet<Array<{ assignmentId: string; tripNumber: string; vehicleNumber: string; driverName: string; status: string }>>('/inventory/reconciliation'),
    enabled: tab === 'dashboard' && hasDistributor && isInventory,
  });

  // Onboarding banner (admin-like only)
  const { data: onboarding } = useQuery({
    queryKey: ['onboarding-progress'],
    queryFn: () => apiGet<{ show: boolean; requiredDoneCount: number; requiredTotal: number }>('/customers/onboarding/progress'),
    enabled: tab === 'dashboard' && hasDistributor && isAdminLike,
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

  // Four dashboard metric cards. Trimmed from eight on founder feedback:
  // Orders Today / Delivered were redundant with the Today's Dispatch
  // section, Revenue was a contextless raw number, and Pending Actions
  // already has its own dedicated section below. Each remaining card is
  // clickable and routes to where you'd actually act on it — note the
  // links go to /app/collections and /app/billing-payments, NOT /app/billing
  // (which redirects to Settings).
  const dashboardMetrics = dashboardStats
    ? [
        { label: 'Pending Orders', value: dashboardStats.pendingOrders, icon: HiOutlineClock, color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-500/10', link: '/app/orders?status=pending_driver_assignment', hint: 'Orders placed but not yet assigned to a driver. Assign drivers to dispatch them.' },
        { label: 'Outstanding Amount', value: formatCurrency(dashboardStats.totalOutstanding), icon: HiOutlineBanknotes, color: 'text-flame-500', bg: 'bg-flame-50 dark:bg-flame-500/10', link: '/app/collections', hint: 'Total owed across all unpaid invoices. Click to see the breakdown by customer.' },
        { label: 'Overdue Invoices', value: dashboardStats.overdueInvoices, icon: HiOutlineExclamationTriangle, color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-500/10', link: '/app/billing-payments?status=overdue', hint: 'Invoices past their credit-period due date. Requires immediate collection action.' },
        { label: 'Inventory Alerts', value: dashboardStats.inventoryAlerts, icon: HiOutlineCube, color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-500/10', link: '/app/inventory', hint: 'Cylinder types at or below their warning/critical stock threshold.' },
      ]
    : [];

  const tabs = [
    { key: 'dashboard' as const, label: 'Dashboard' },
    { key: 'overview' as const, label: 'Overview' },
    { key: 'reports' as const, label: 'Reports' },
    { key: 'pending-actions' as const, label: 'Pending Actions' },
  ];

  if (isSuperAdmin && !selectedDistributorId) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Analytics</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">Business insights and reports</p>
        </div>
        <div className="flex items-center justify-center min-h-[50vh]">
          <div className="text-center">
            <p className="text-lg font-medium text-surface-700 dark:text-surface-300">Select a distributor to view analytics</p>
            <p className="mt-1 text-sm text-surface-500 dark:text-surface-400 mb-4">
              Use the distributor selector in the top bar to choose a distributor.
            </p>
            <button
              onClick={() => navigate('/app/distributors')}
              className="text-sm font-medium text-brand-600 dark:text-brand-400 underline"
            >
              View all distributors →
            </button>
          </div>
        </div>
      </div>
    );
  }

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
      {tab === 'dashboard' && isDriver && (
        <div className="card p-8 text-center">
          <h2 className="text-lg font-semibold text-surface-900 dark:text-white mb-2">Please use the mobile app</h2>
          <p className="text-sm text-surface-500 dark:text-surface-400">
            Driver workflows (trips, deliveries, reconciliation) are designed for the mobile app. Open Re-New GasLink on your phone to continue.
          </p>
        </div>
      )}

      {tab === 'dashboard' && !isDriver && (
        dashboardLoading ? <div className="flex justify-center py-20"><Loader size="lg" /></div> : (
          <div className="space-y-6">
            {isAdminLike && onboarding?.show && (
              <div
                onClick={() => navigate('/app/settings?tab=onboarding')}
                className="cursor-pointer p-4 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 flex items-center justify-between gap-4"
              >
                <div>
                  <p className="font-semibold text-amber-800 dark:text-amber-300">Get started — finish setup</p>
                  <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">{onboarding.requiredDoneCount} of {onboarding.requiredTotal} steps complete · open Settings → Onboarding</p>
                </div>
                <span className="text-amber-600 dark:text-amber-400 font-medium">→</span>
              </div>
            )}
            {/* ─── Section A — STOCK POSITION (admin / inventory) ──────────── */}
            {(isAdminLike || isInventory) && (
              <div className="card p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-surface-900 dark:text-white">Stock position</h3>
                  <button onClick={() => navigate('/app/inventory')} className="text-xs font-medium text-brand-600 dark:text-brand-400">View Inventory →</button>
                </div>
                {!stockSummary?.length ? (
                  <p className="text-sm text-surface-500">No cylinder types configured.</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {stockSummary.map((s) => {
                      const status = s.thresholdCritical != null && s.closingFulls <= s.thresholdCritical
                        ? { label: 'CRITICAL', variant: 'danger' as const }
                        : s.thresholdWarning != null && s.closingFulls <= s.thresholdWarning
                        ? { label: 'WARNING', variant: 'warning' as const }
                        : { label: 'OK', variant: 'success' as const };
                      return (
                        <div key={s.cylinderTypeId} className="p-3 rounded-lg bg-surface-50 dark:bg-surface-800/50">
                          <div className="flex items-center justify-between mb-1">
                            <p className="text-sm font-semibold text-surface-900 dark:text-white">{s.cylinderTypeName}</p>
                            <Badge variant={status.variant}>{status.label}</Badge>
                          </div>
                          <p className="text-xs text-surface-500">Fulls: <span className="font-semibold text-surface-900 dark:text-white">{s.closingFulls}</span> · Empties: <span className="font-semibold text-surface-900 dark:text-white">{s.closingEmpties}</span></p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ─── Section B — TODAY'S DISPATCH (admin only) ──────────────── */}
            {isAdminLike && dashboardStats && (
              <div className="card p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-surface-900 dark:text-white">Today's dispatch</h3>
                  <button onClick={() => navigate('/app/orders?status=pending_driver_assignment')} className="text-xs font-medium text-brand-600 dark:text-brand-400">Assign drivers →</button>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-500/10 cursor-pointer" onClick={() => navigate('/app/orders?status=pending_driver_assignment')}>
                    <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{dashboardStats.pendingOrders}</p>
                    <p className="text-xs text-surface-600 dark:text-surface-400">Pending dispatch</p>
                  </div>
                  <div className="p-3 rounded-lg bg-brand-50 dark:bg-brand-500/10">
                    <p className="text-2xl font-bold text-brand-600 dark:text-brand-400">{dashboardStats.ordersToday}</p>
                    <p className="text-xs text-surface-600 dark:text-surface-400">Orders today</p>
                  </div>
                  <div className="p-3 rounded-lg bg-accent-50 dark:bg-accent-500/10">
                    <p className="text-2xl font-bold text-accent-600 dark:text-accent-400">{dashboardStats.deliveredToday}</p>
                    <p className="text-xs text-surface-600 dark:text-surface-400">Delivered today</p>
                  </div>
                </div>
              </div>
            )}

            {/* ─── Section C — COLLECTIONS DUE TODAY (admin / finance) ─────── */}
            {(isAdminLike || isFinance) && (
              <div className="card p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-surface-900 dark:text-white">Call these customers today</h3>
                  <button onClick={() => navigate('/app/collections')} className="text-xs font-medium text-brand-600 dark:text-brand-400">View all →</button>
                </div>
                {!callList?.length ? (
                  <p className="text-sm text-surface-500">No customers past their credit period. 🎉</p>
                ) : (
                  <div className="space-y-2">
                    {callList.slice(0, 8).map((c) => (
                      <div key={c.customerId} className="flex items-center justify-between gap-3 p-3 rounded-lg bg-surface-50 dark:bg-surface-800/50">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-surface-900 dark:text-white truncate">{c.customerName}</p>
                          <p className="text-xs text-surface-500">
                            <a href={`tel:${c.phone}`} className="text-brand-600 dark:text-brand-400 hover:underline">{c.phone}</a> · {c.overdueInvoiceCount} invoice{c.overdueInvoiceCount === 1 ? '' : 's'}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm font-semibold text-red-500">{formatCurrency(c.totalOutstanding)}</p>
                          <Badge variant="danger">{c.daysOverdue}d overdue</Badge>
                        </div>
                      </div>
                    ))}
                    {callList.length > 8 && (
                      <p className="text-xs text-surface-400 text-center pt-2">Showing 8 of {callList.length} customers</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ─── Finance-only: Unallocated payments + GST failures ────────── */}
            {isFinance && (
              <>
                <div className="card p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-surface-900 dark:text-white">Unallocated payments</h3>
                    <button onClick={() => navigate('/app/billing-payments')} className="text-xs font-medium text-brand-600 dark:text-brand-400">View payments →</button>
                  </div>
                  {!unallocatedPayments?.length ? (
                    <p className="text-sm text-surface-500">All payments fully allocated.</p>
                  ) : (
                    <div className="space-y-2">
                      {unallocatedPayments.map((p) => (
                        <div key={p.paymentId} className="flex items-center justify-between gap-3 p-3 rounded-lg bg-surface-50 dark:bg-surface-800/50">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-surface-900 dark:text-white truncate">{p.customer?.customerName ?? 'Unknown customer'}</p>
                            <p className="text-xs text-surface-500">{new Date(p.transactionDate).toLocaleDateString('en-IN')} · {p.allocationStatus.replace(/_/g, ' ')}</p>
                          </div>
                          <p className="text-sm font-semibold text-amber-500">{formatCurrency(p.unallocatedAmount ?? p.amount)}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="card p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-surface-900 dark:text-white">GST failures</h3>
                    <button onClick={() => navigate('/app/billing-payments?irnStatus=failed')} className="text-xs font-medium text-brand-600 dark:text-brand-400">View invoices →</button>
                  </div>
                  {!gstFailures?.length ? (
                    <p className="text-sm text-surface-500">No failed IRNs.</p>
                  ) : (
                    <div className="space-y-2">
                      {gstFailures.map((inv) => (
                        <div key={inv.invoiceId} className="flex items-center justify-between gap-3 p-3 rounded-lg bg-red-50 dark:bg-red-500/10">
                          <p className="text-sm font-medium text-surface-900 dark:text-white">{inv.invoiceNumber}</p>
                          <p className="text-sm font-semibold text-red-500">{formatCurrency(inv.totalAmount)}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {/* ─── Inventory-only: Pending reconciliation + threshold alerts ── */}
            {isInventory && (
              <>
                <div className="card p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-surface-900 dark:text-white">Vehicles pending reconciliation</h3>
                    <button onClick={() => navigate('/app/reconciliation')} className="text-xs font-medium text-brand-600 dark:text-brand-400">View →</button>
                  </div>
                  {!pendingReconciliation?.length ? (
                    <p className="text-sm text-surface-500">No vehicles awaiting reconciliation.</p>
                  ) : (
                    <div className="space-y-2">
                      {pendingReconciliation.slice(0, 8).map((a) => (
                        <div key={a.assignmentId} className="flex items-center justify-between gap-3 p-3 rounded-lg bg-surface-50 dark:bg-surface-800/50">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-surface-900 dark:text-white">Trip {a.tripNumber} · {a.vehicleNumber}</p>
                            <p className="text-xs text-surface-500">{a.driverName}</p>
                          </div>
                          <Badge variant="warning">{a.status.replace(/_/g, ' ')}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="card p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-surface-900 dark:text-white">Threshold alerts</h3>
                    <button onClick={() => navigate('/app/inventory')} className="text-xs font-medium text-brand-600 dark:text-brand-400">View inventory →</button>
                  </div>
                  {!thresholdAlerts?.length ? (
                    <p className="text-sm text-surface-500">All cylinder types above warning threshold.</p>
                  ) : (
                    <div className="space-y-2">
                      {thresholdAlerts.map((a) => (
                        <div key={a.cylinderTypeId} className="flex items-center justify-between gap-3 p-3 rounded-lg bg-surface-50 dark:bg-surface-800/50">
                          <p className="text-sm font-medium text-surface-900 dark:text-white">{a.cylinderTypeName}</p>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-surface-500">{a.currentStock} fulls (≤ {a.threshold})</span>
                            <Badge variant={a.level === 'critical' ? 'danger' : 'warning'}>{a.level.toUpperCase()}</Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {/* ─── Existing dashboard metrics (admin only) ─────────────────── */}
            {isAdminLike && (
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
                    <p className="text-xs text-surface-400 dark:text-surface-500 mt-1 leading-snug">{metric.hint}</p>
                  </div>
                </div>
              ))}
            </div>
            )}

            {/* Pending Actions Section */}
            <div className="card p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-surface-900 dark:text-white">Pending Actions</h3>
                <button onClick={() => setTab('pending-actions')} className="text-xs font-medium text-brand-600 dark:text-brand-400">View all →</button>
              </div>
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
                { label: 'Amount in Market', value: formatCurrency(metrics.amountInMarket ?? 0), icon: HiOutlineCurrencyRupee, color: 'text-brand-500', bg: 'bg-brand-50 dark:bg-brand-500/10', hint: 'Total value of stock and credit currently out with customers (unrecovered cash + cylinders).' },
                { label: 'Collected Amount', value: formatCurrency(metrics.collectedAmount ?? 0), icon: HiOutlineCurrencyRupee, color: 'text-accent-500', bg: 'bg-accent-50 dark:bg-accent-500/10', hint: 'Payments received from customers in the selected period.' },
                { label: 'Due Amount', value: formatCurrency(metrics.dueAmount ?? 0), icon: HiOutlineCurrencyRupee, color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-500/10', hint: 'Amount owed by customers that is within the credit period (not yet overdue).' },
                { label: 'Overdue Amount', value: formatCurrency(metrics.overdueAmount ?? 0), icon: HiOutlineCurrencyRupee, color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-500/10', hint: 'Invoices past their credit-period due date. Requires immediate collection action.' },
                { label: 'Cylinder Utilization', value: formatPercent(metrics.cylinderUtilizationRate ?? 0), icon: HiOutlineCube, color: 'text-brand-500', bg: 'bg-brand-50 dark:bg-brand-500/10', hint: 'Share of dispatched cylinders that come back as empties (collected ÷ delivered, last 30 days). Low = cylinders stuck with customers.' },
                { label: 'Avg Turnaround', value: `${(metrics.averageTurnaroundDays ?? 0).toFixed(1)} days`, icon: HiOutlineTruck, color: 'text-flame-500', bg: 'bg-flame-50 dark:bg-flame-500/10', hint: 'Average days between a cylinder being delivered and its empty being collected. Lower is better.' },
                { label: 'Delivery Efficiency', value: formatPercent(metrics.deliveryEfficiency ?? 0), icon: HiOutlineTruck, color: 'text-accent-500', bg: 'bg-accent-50 dark:bg-accent-500/10', hint: '% of orders successfully delivered vs total (last 30 days). Industry benchmark: >90%.' },
                { label: 'Inventory Shrinkage', value: formatPercent(metrics.inventoryShrinkage ?? 0), icon: HiOutlineCube, color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-500/10', hint: 'Cylinders recorded as missing/lost across customer balances. High = deposit leakage or loss.' },
              ].map((m) => (
                <div key={m.label} className="metric-card flex items-start gap-4">
                  <div className={cn('flex items-center justify-center h-12 w-12 rounded-xl shrink-0', m.bg)}>
                    <m.icon className={cn('h-6 w-6', m.color)} />
                  </div>
                  <div>
                    <p className="metric-value text-xl">{m.value}</p>
                    <p className="metric-label">{m.label}</p>
                    <p className="text-xs text-surface-400 dark:text-surface-500 mt-1 leading-snug">{m.hint}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* ─── Insights (TASK 2 Part B) — computed from live data ───────── */}
            <div className="card p-5">
              <h3 className="font-semibold text-surface-900 dark:text-white mb-4">Insights</h3>
              {!insights?.length ? (
                <p className="text-sm text-surface-500">No insights right now — everything looks healthy. 🎉</p>
              ) : (
                <ul className="space-y-2">
                  {insights.map((ins, i) => (
                    <li
                      key={i}
                      onClick={() => ins.link && navigate(ins.link)}
                      className={cn(
                        'flex items-center gap-3 p-3 rounded-lg text-sm',
                        ins.link && 'cursor-pointer hover:ring-1 hover:ring-brand-500/30',
                        ins.severity === 'critical' ? 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300'
                          : ins.severity === 'warning' ? 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300'
                          : 'bg-surface-50 dark:bg-surface-800/50 text-surface-700 dark:text-surface-300',
                      )}
                    >
                      <span className="text-lg shrink-0">{ins.icon}</span>
                      <span className="flex-1">{ins.text}</span>
                      {ins.link && <span className="text-xs opacity-60">→</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )
      )}

      {/* Reports Tab — the 6 filterable reports (TASK 1), embedded in Analytics */}
      {tab === 'reports' && <ReportsPanel />}

      {/* Pending Actions Tab — the full filterable list, embedded in Analytics */}
      {tab === 'pending-actions' && <PendingActionsPanel embedded />}
    </div>
  );
}
