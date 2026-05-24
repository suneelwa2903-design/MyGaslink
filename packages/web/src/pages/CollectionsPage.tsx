import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { HiOutlineArrowDownTray, HiOutlinePhone } from 'react-icons/hi2';
import type { CollectionsDashboard, OverdueCallListEntry } from '@gaslink/shared';
import { apiGet, apiPut } from '@/lib/api';
import { Button, Badge, Loader, EmptyState } from '@/components/ui';
import { cn } from '@/lib/cn';

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);
}

function formatDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// WI-122: OVERDUE_ORDER_OVERRIDE pending actions — customers blocked at
// escalation level 3 who need a one-time admin override to place an order.
interface OverrideAction {
  actionId: string;
  entityId: string;
  description: string;
  status: string;
  createdAt: string;
}

export default function CollectionsPage() {
  const [view, setView] = useState<'call-list' | 'all' | 'blocked'>('call-list');
  const queryClient = useQueryClient();

  const { data: collections, isLoading } = useQuery({
    queryKey: ['collections-dashboard'],
    queryFn: () => apiGet<CollectionsDashboard[]>('/analytics/collections'),
  });

  // Reuses the same /analytics/overdue-call-list endpoint that the dashboard uses.
  const { data: callList, isLoading: callListLoading } = useQuery({
    queryKey: ['overdue-call-list'],
    queryFn: () => apiGet<OverdueCallListEntry[]>('/analytics/overdue-call-list'),
  });

  // WI-122: blocked customers (level-3) awaiting a one-time override approval.
  const { data: blocked, isLoading: blockedLoading } = useQuery({
    queryKey: ['collections-overrides'],
    queryFn: () => apiGet<{ actions: OverrideAction[] }>('/pending-actions?module=collections&status=open'),
  });
  const overrideActions = (blocked?.actions ?? []).filter(
    (a) => (a as unknown as { actionType?: string }).actionType === 'OVERDUE_ORDER_OVERRIDE',
  );

  const approveOverride = useMutation({
    mutationFn: (actionId: string) => apiPut(`/pending-actions/${actionId}/approve`, {}),
    onSuccess: () => {
      toast.success('Override approved — the customer may place one order.');
      queryClient.invalidateQueries({ queryKey: ['collections-overrides'] });
    },
    onError: () => toast.error('Could not approve override'),
  });

  const handleExport = async () => {
    try {
      const response = await fetch('/api/analytics/export?type=collections', {
        headers: { Authorization: `Bearer ${JSON.parse(localStorage.getItem('gaslink-auth') || '{}').state?.accessToken || ''}` },
      });
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'collections-report.xlsx';
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success('Report downloaded');
    } catch {
      toast.error('Failed to export report');
    }
  };

  const totalDue = collections?.reduce((sum, c) => sum + c.totalDue, 0) ?? 0;
  const totalOverdue = collections?.reduce((sum, c) => sum + c.overdueDue, 0) ?? 0;
  const totalMissing = collections?.reduce((sum, c) => sum + c.missingCylinders, 0) ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Collections</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">Customer dues and cylinder tracking</p>
        </div>
        <Button variant="secondary" onClick={handleExport}>
          <HiOutlineArrowDownTray className="h-4 w-4" />Export to Excel
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="metric-card">
          <p className="metric-label">Total Due</p>
          <p className="metric-value">{formatCurrency(totalDue)}</p>
        </div>
        <div className="metric-card">
          <p className="metric-label">Total Overdue</p>
          <p className="metric-value text-red-500">{formatCurrency(totalOverdue)}</p>
        </div>
        <div className="metric-card">
          <p className="metric-label">Missing Cylinders</p>
          <p className="metric-value text-amber-500">{totalMissing}</p>
        </div>
      </div>

      {/* View toggle */}
      <div className="border-b border-surface-200 dark:border-surface-700">
        <div className="flex gap-4">
          <button
            onClick={() => setView('call-list')}
            className={cn(
              'pb-2 text-sm font-medium border-b-2 transition-colors',
              view === 'call-list' ? 'border-brand-500 text-brand-600 dark:text-brand-400' : 'border-transparent text-surface-500 hover:text-surface-700 dark:hover:text-surface-300',
            )}
          >
            Call list {callList?.length ? `(${callList.length})` : ''}
          </button>
          <button
            onClick={() => setView('all')}
            className={cn(
              'pb-2 text-sm font-medium border-b-2 transition-colors',
              view === 'all' ? 'border-brand-500 text-brand-600 dark:text-brand-400' : 'border-transparent text-surface-500 hover:text-surface-700 dark:hover:text-surface-300',
            )}
          >
            All collections
          </button>
          <button
            onClick={() => setView('blocked')}
            className={cn(
              'pb-2 text-sm font-medium border-b-2 transition-colors',
              view === 'blocked' ? 'border-brand-500 text-brand-600 dark:text-brand-400' : 'border-transparent text-surface-500 hover:text-surface-700 dark:hover:text-surface-300',
            )}
          >
            Blocked {overrideActions.length ? `(${overrideActions.length})` : ''}
          </button>
        </div>
      </div>

      {/* CALL LIST view: customers past credit period, sorted by days overdue desc */}
      {view === 'call-list' && (
        callListLoading ? (
          <div className="flex justify-center py-20"><Loader size="lg" /></div>
        ) : !callList?.length ? (
          <EmptyState title="No overdue customers" description="No customers are past their credit period right now." />
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Outstanding</th>
                    <th>Overdue invoices</th>
                    <th>Days overdue</th>
                    <th>Phone</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {callList.map((c) => (
                    <tr key={c.customerId}>
                      <td className="font-medium text-surface-900 dark:text-white">{c.customerName}</td>
                      <td className="font-semibold text-red-500">{formatCurrency(c.totalOutstanding)}</td>
                      <td>{c.overdueInvoiceCount}</td>
                      <td><Badge variant="danger">{c.daysOverdue}d overdue</Badge></td>
                      <td>
                        <a href={`tel:${c.phone}`} className="inline-flex items-center gap-1 text-brand-600 dark:text-brand-400 hover:underline">
                          <HiOutlinePhone className="h-3 w-3" />{c.phone}
                        </a>
                      </td>
                      <td>
                        <a href={`/app/customers?id=${c.customerId}`} className="text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline">View account →</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards (finance walks the floor calling customers) */}
            <div className="md:hidden space-y-3">
              {callList.map((c) => (
                <div key={c.customerId} className="card p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold text-surface-900 dark:text-white">{c.customerName}</p>
                    <Badge variant="danger">{c.daysOverdue}d</Badge>
                  </div>
                  <p className="text-lg font-bold text-red-500">{formatCurrency(c.totalOutstanding)}</p>
                  <p className="text-xs text-surface-500">{c.overdueInvoiceCount} overdue invoice{c.overdueInvoiceCount === 1 ? '' : 's'}</p>
                  <div className="flex gap-2 pt-1">
                    <a
                      href={`tel:${c.phone}`}
                      className="flex-1 inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg bg-brand-500 text-white text-sm font-medium"
                    >
                      <HiOutlinePhone className="h-4 w-4" />Call {c.phone}
                    </a>
                    <a
                      href={`/app/customers?id=${c.customerId}`}
                      className="px-3 py-2 rounded-lg border border-surface-200 dark:border-surface-700 text-sm font-medium text-surface-700 dark:text-surface-300"
                    >
                      Account
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </>
        )
      )}

      {view === 'all' && (
        isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : !collections?.length ? (
        <EmptyState title="No collection data" description="Collection data will appear as invoices are generated." />
      ) : (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Total Due</th>
                <th>Overdue</th>
                <th>Days Overdue</th>
                <th>Credit Period</th>
                <th>Commitment</th>
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
                  <td>{c.overdueDays > 0 ? <Badge variant="danger">{c.overdueDays}d</Badge> : <span className="text-surface-400">-</span>}</td>
                  <td>{c.creditPeriodDays}d</td>
                  <td>
                    {c.latestCommitment ? (
                      <div className="text-xs">
                        <Badge variant={c.latestCommitment.status === 'broken' ? 'danger' : 'warning'}>
                          L{c.latestCommitment.escalationLevel}
                        </Badge>
                        <p className="text-surface-500 mt-1">{formatDate(c.latestCommitment.promisedDate)}</p>
                      </div>
                    ) : (
                      <span className="text-surface-400">—</span>
                    )}
                  </td>
                  <td>{c.missingCylinders > 0 ? <span className="text-red-500 font-medium">{c.missingCylinders}</span> : <span className="text-surface-400">0</span>}</td>
                  <td>{c.missingCylinderValue > 0 ? <span className="text-red-500">{formatCurrency(c.missingCylinderValue)}</span> : <span className="text-surface-400">-</span>}</td>
                  <td>{c.excessEmptyCylinders > 0 ? <span className="text-amber-500 font-medium">{c.excessEmptyCylinders}</span> : <span className="text-surface-400">0</span>}</td>
                  <td className="text-xs">
                    {c.lastPaymentDate ? (
                      <div>
                        <p>{new Date(c.lastPaymentDate).toLocaleDateString('en-IN')}</p>
                        {c.lastPaymentAmount && <p className="text-surface-400">{formatCurrency(c.lastPaymentAmount)}</p>}
                      </div>
                    ) : <span className="text-surface-400">No payments</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      )}

      {/* WI-122: customers blocked at escalation level 3, awaiting a one-time
          override approval before they can place another order. */}
      {view === 'blocked' && (
        blockedLoading ? (
          <div className="flex justify-center py-20"><Loader size="lg" /></div>
        ) : !overrideActions.length ? (
          <EmptyState title="No blocked customers" description="No customers are currently blocked pending an override." />
        ) : (
          <div className="space-y-3">
            {overrideActions.map((a) => (
              <div key={a.actionId} className="card p-4 flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm text-surface-900 dark:text-white">{a.description}</p>
                  <p className="text-xs text-surface-400 mt-1">Requested {formatDate(a.createdAt)}</p>
                </div>
                <Button
                  variant="primary"
                  onClick={() => approveOverride.mutate(a.actionId)}
                  disabled={approveOverride.isPending}
                >
                  Approve Override
                </Button>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
