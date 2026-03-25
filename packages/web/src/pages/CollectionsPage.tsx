import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { HiOutlineArrowDownTray } from 'react-icons/hi2';
import type { CollectionsDashboard } from '@gaslink/shared';
import { apiGet } from '@/lib/api';
import { Button, Badge, Loader, EmptyState } from '@/components/ui';
import { cn } from '@/lib/cn';

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);
}

export default function CollectionsPage() {
  const { data: collections, isLoading } = useQuery({
    queryKey: ['collections-dashboard'],
    queryFn: () => apiGet<CollectionsDashboard[]>('/analytics/collections'),
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

      {isLoading ? (
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
                  <td>{c.overduesDays > 0 ? <Badge variant="danger">{c.overduesDays}d</Badge> : <span className="text-surface-400">-</span>}</td>
                  <td>{c.creditPeriodDays}d</td>
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
      )}
    </div>
  );
}
