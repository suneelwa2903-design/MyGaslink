import { useQuery } from '@tanstack/react-query';
import {
  HiOutlineClipboardDocumentList,
  HiOutlineDocumentText,
  HiOutlineCurrencyRupee,
} from 'react-icons/hi2';
import type { Order, Invoice } from '@gaslink/shared';
import { apiGet } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { Badge, Loader, EmptyState } from '@/components/ui';
import { cn } from '@/lib/cn';

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);
}

export default function CustomerDashboardPage() {
  const { user } = useAuthStore();

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['customer-dashboard-stats'],
    queryFn: () => apiGet<{
      totalOrders: number;
      pendingOrders: number;
      totalInvoices: number;
      outstandingAmount: number;
      recentOrders: Order[];
      recentInvoices: Invoice[];
    }>('/customer-portal/dashboard'),
  });

  const metrics = stats ? [
    { label: 'Total Orders', value: stats.totalOrders, icon: HiOutlineClipboardDocumentList, color: 'text-brand-500', bg: 'bg-brand-50 dark:bg-brand-500/10' },
    { label: 'Pending Orders', value: stats.pendingOrders, icon: HiOutlineClipboardDocumentList, color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-500/10' },
    { label: 'Total Invoices', value: stats.totalInvoices, icon: HiOutlineDocumentText, color: 'text-accent-500', bg: 'bg-accent-50 dark:bg-accent-500/10' },
    { label: 'Outstanding', value: formatCurrency(stats.outstandingAmount), icon: HiOutlineCurrencyRupee, color: 'text-flame-500', bg: 'bg-flame-50 dark:bg-flame-500/10' },
  ] : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white">
          Welcome, {user?.firstName}!
        </h1>
        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">Your account overview</p>
      </div>

      {statsLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : (
        <>
          {/* KPIs */}
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

          {/* Recent Orders */}
          <div className="card">
            <div className="p-4 border-b border-surface-200 dark:border-surface-700">
              <h3 className="font-semibold text-surface-900 dark:text-white">Recent Orders</h3>
            </div>
            {!stats?.recentOrders?.length ? (
              <EmptyState title="No recent orders" className="py-8" />
            ) : (
              <div className="divide-y divide-surface-100 dark:divide-surface-700">
                {stats.recentOrders.slice(0, 5).map((order) => (
                  <div key={order.orderId} className="flex items-center justify-between p-4">
                    <div>
                      <p className="font-medium text-surface-900 dark:text-white">{order.orderNumber}</p>
                      <p className="text-xs text-surface-400">{new Date(order.orderDate).toLocaleDateString('en-IN')}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-medium text-sm">{formatCurrency(order.totalAmount)}</span>
                      <Badge variant={order.status === 'delivered' ? 'success' : 'info'}>{order.status.replace(/_/g, ' ')}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent Invoices */}
          <div className="card">
            <div className="p-4 border-b border-surface-200 dark:border-surface-700">
              <h3 className="font-semibold text-surface-900 dark:text-white">Recent Invoices</h3>
            </div>
            {!stats?.recentInvoices?.length ? (
              <EmptyState title="No recent invoices" className="py-8" />
            ) : (
              <div className="divide-y divide-surface-100 dark:divide-surface-700">
                {stats.recentInvoices.slice(0, 5).map((inv) => (
                  <div key={inv.invoiceId} className="flex items-center justify-between p-4">
                    <div>
                      <p className="font-medium text-surface-900 dark:text-white">{inv.invoiceNumber}</p>
                      <p className="text-xs text-surface-400">Due: {new Date(inv.dueDate).toLocaleDateString('en-IN')}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-medium text-sm">{formatCurrency(inv.totalAmount)}</span>
                      <Badge variant={inv.status === 'paid' ? 'success' : inv.status === 'overdue' ? 'danger' : 'info'}>{inv.status}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
