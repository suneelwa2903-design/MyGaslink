/**
 * Feature A (2026-07-15): HQ portal Dashboard.
 *
 * Read-only consolidated view for a customer_hq user across all
 * properties in their group. Reads GET /customer-group-portal/dashboard.
 * All numbers are already computed server-side — this page only lays
 * them out. See customerGroupPortalService.getDashboard for the source
 * shape.
 */
import { useQuery } from '@tanstack/react-query';
import {
  HiOutlineCurrencyRupee,
  HiOutlineExclamationTriangle,
  HiOutlineCube,
  HiOutlineBuildingOffice2,
} from 'react-icons/hi2';
import { apiGet } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { Loader, EmptyState, Badge } from '@/components/ui';
import { cn } from '@/lib/cn';

interface HqDashboard {
  totalOutstanding: number;
  totalOverdue: number;
  cylindersThisMonth: Array<{
    cylinderTypeId: string;
    cylinderTypeName: string;
    quantity: number;
  }>;
  aging: {
    bucket0_30: number;
    bucket31_60: number;
    bucket60plus: number;
  };
  properties: Array<{
    customerId: string;
    customerName: string;
    businessName: string | null;
    gstin: string | null;
    outstanding: number;
    lastDeliveryDate: string | null;
    lastInvoiceDate: string | null;
    isOverdue: boolean;
  }>;
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(n);
}

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN');
}

export default function HqDashboardPage() {
  const { user } = useAuthStore();
  const { data, isLoading } = useQuery({
    queryKey: ['hq-dashboard'],
    queryFn: () => apiGet<HqDashboard>('/customer-group-portal/dashboard'),
  });

  const metrics = data ? [
    {
      label: 'Total Outstanding',
      value: formatCurrency(data.totalOutstanding),
      icon: HiOutlineCurrencyRupee,
      color: 'text-brand-500',
      bg: 'bg-brand-50 dark:bg-brand-500/10',
    },
    {
      label: 'Total Overdue',
      value: formatCurrency(data.totalOverdue),
      icon: HiOutlineExclamationTriangle,
      color: 'text-flame-500',
      bg: 'bg-flame-50 dark:bg-flame-500/10',
    },
    {
      label: 'Cylinders This Month',
      value: data.cylindersThisMonth.reduce((s, c) => s + c.quantity, 0),
      icon: HiOutlineCube,
      color: 'text-accent-500',
      bg: 'bg-accent-50 dark:bg-accent-500/10',
    },
    {
      label: 'Properties',
      value: data.properties.length,
      icon: HiOutlineBuildingOffice2,
      color: 'text-amber-500',
      bg: 'bg-amber-50 dark:bg-amber-500/10',
    },
  ] : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white">
          Welcome{user?.firstName ? `, ${user.firstName}` : ''}
        </h1>
        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
          Consolidated view across all properties in your group.
        </p>
      </div>

      {isLoading || !data ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {metrics.map((m) => (
              <div key={m.label} className="metric-card flex items-start gap-4">
                <div className={cn('flex items-center justify-center h-12 w-12 rounded-xl shrink-0', m.bg)}>
                  <m.icon className={cn('h-6 w-6', m.color)} />
                </div>
                <div>
                  <p className="metric-value">{m.value}</p>
                  <p className="metric-label">{m.label}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Cylinders this month breakdown */}
          <div className="card">
            <div className="p-4 border-b border-surface-200 dark:border-surface-700">
              <h3 className="font-semibold text-surface-900 dark:text-white">Cylinders Delivered This Month</h3>
            </div>
            {data.cylindersThisMonth.length === 0 ? (
              <EmptyState title="No deliveries this month yet" className="py-8" />
            ) : (
              <div className="divide-y divide-surface-100 dark:divide-surface-700">
                {data.cylindersThisMonth.map((c) => (
                  <div key={c.cylinderTypeId} className="flex items-center justify-between p-4">
                    <span className="text-sm text-surface-700 dark:text-surface-300">{c.cylinderTypeName}</span>
                    <span className="font-medium text-surface-900 dark:text-white">{c.quantity}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Aging bar */}
          <div className="card p-4">
            <h3 className="font-semibold text-surface-900 dark:text-white mb-3">Outstanding by Age</h3>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: '0–30 days', value: data.aging.bucket0_30, color: 'text-emerald-600 dark:text-emerald-400' },
                { label: '31–60 days', value: data.aging.bucket31_60, color: 'text-amber-600 dark:text-amber-400' },
                { label: '60+ days', value: data.aging.bucket60plus, color: 'text-flame-600 dark:text-flame-400' },
              ].map((b) => (
                <div key={b.label} className="rounded-lg border border-surface-200 dark:border-surface-700 p-3">
                  <p className="text-xs text-surface-500 dark:text-surface-400">{b.label}</p>
                  <p className={cn('text-lg font-semibold mt-1', b.color)}>{formatCurrency(b.value)}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Properties table */}
          <div className="card">
            <div className="p-4 border-b border-surface-200 dark:border-surface-700">
              <h3 className="font-semibold text-surface-900 dark:text-white">Properties</h3>
            </div>
            {data.properties.length === 0 ? (
              <EmptyState title="No properties in your group yet" className="py-8" />
            ) : (
              <div className="table-container">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Property</th>
                      <th>GSTIN</th>
                      <th>Outstanding</th>
                      <th>Last Delivery</th>
                      <th>Last Invoice</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.properties.map((p) => (
                      <tr key={p.customerId}>
                        <td>
                          <div>
                            <p className="font-medium text-surface-900 dark:text-white">{p.customerName}</p>
                            {p.businessName && (
                              <p className="text-xs text-surface-500 dark:text-surface-400">{p.businessName}</p>
                            )}
                          </div>
                        </td>
                        <td>
                          <span className="text-sm text-surface-600 dark:text-surface-400">{p.gstin ?? '—'}</span>
                        </td>
                        <td>
                          <span className="font-medium text-surface-900 dark:text-white">
                            {formatCurrency(p.outstanding)}
                          </span>
                        </td>
                        <td>
                          <span className="text-sm text-surface-600 dark:text-surface-400">{formatDate(p.lastDeliveryDate)}</span>
                        </td>
                        <td>
                          <span className="text-sm text-surface-600 dark:text-surface-400">{formatDate(p.lastInvoiceDate)}</span>
                        </td>
                        <td>
                          {p.isOverdue
                            ? <Badge variant="danger">Overdue</Badge>
                            : <Badge variant="success">OK</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
