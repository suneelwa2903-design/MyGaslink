import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HiOutlineEye } from 'react-icons/hi2';
import type { Invoice, PaginationMeta } from '@gaslink/shared';
import { InvoiceStatus } from '@gaslink/shared';
import { apiGet } from '@/lib/api';
import { Button, Select, Modal, Badge, Loader, EmptyState } from '@/components/ui';
import { cn } from '@/lib/cn';

const STATUS_VARIANTS: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  [InvoiceStatus.DRAFT]: 'neutral',
  [InvoiceStatus.ISSUED]: 'info',
  [InvoiceStatus.PARTIALLY_PAID]: 'warning',
  [InvoiceStatus.PAID]: 'success',
  [InvoiceStatus.OVERDUE]: 'danger',
  [InvoiceStatus.CANCELLED]: 'danger',
};

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);
}

export default function CustomerInvoicesPage() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [viewInvoice, setViewInvoice] = useState<Invoice | null>(null);

  const queryParams: Record<string, unknown> = { page, pageSize: 25 };
  if (statusFilter) queryParams.status = statusFilter;

  const { data, isLoading } = useQuery({
    queryKey: ['customer-invoices', queryParams],
    queryFn: () => apiGet<{ invoices: Invoice[]; meta: PaginationMeta }>('/customer-portal/invoices', queryParams),
  });

  const invoices = data?.invoices ?? [];
  const meta = data?.meta;

  const statusOptions = Object.values(InvoiceStatus).map((s) => ({ value: s, label: s.replace(/_/g, ' ') }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white">My Invoices</h1>
        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">View your invoices and payment status</p>
      </div>

      <div className="card p-4">
        <Select options={statusOptions} placeholder="All Statuses" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : invoices.length === 0 ? (
        <EmptyState title="No invoices" description="Your invoices will appear here." />
      ) : (
        <>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr><th>Invoice #</th><th>Issue Date</th><th>Due Date</th><th>Total</th><th>Paid</th><th>Outstanding</th><th>Status</th><th>View</th></tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.invoiceId}>
                    <td className="font-medium text-surface-900 dark:text-white">{inv.invoiceNumber}</td>
                    <td>{new Date(inv.issueDate).toLocaleDateString('en-IN')}</td>
                    <td>{new Date(inv.dueDate).toLocaleDateString('en-IN')}</td>
                    <td className="font-medium">{formatCurrency(inv.totalAmount)}</td>
                    <td>{formatCurrency(inv.amountPaid)}</td>
                    <td className={cn('font-medium', inv.outstandingAmount > 0 && 'text-red-500')}>
                      {formatCurrency(inv.outstandingAmount)}
                    </td>
                    <td><Badge variant={STATUS_VARIANTS[inv.status] || 'neutral'}>{inv.status.replace(/_/g, ' ')}</Badge></td>
                    <td>
                      <button onClick={() => setViewInvoice(inv)} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-brand-500">
                        <HiOutlineEye className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {meta && meta.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-surface-500 dark:text-surface-400">Page {meta.page} of {meta.totalPages}</p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button variant="secondary" size="sm" disabled={page >= meta.totalPages} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          )}
        </>
      )}

      {viewInvoice && (
        <Modal open={!!viewInvoice} onClose={() => setViewInvoice(null)} title={`Invoice ${viewInvoice.invoiceNumber}`} size="lg">
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div><p className="text-xs text-surface-400">Issue Date</p><p className="text-sm font-medium">{new Date(viewInvoice.issueDate).toLocaleDateString('en-IN')}</p></div>
              <div><p className="text-xs text-surface-400">Due Date</p><p className="text-sm font-medium">{new Date(viewInvoice.dueDate).toLocaleDateString('en-IN')}</p></div>
              <div><p className="text-xs text-surface-400">Status</p><Badge variant={STATUS_VARIANTS[viewInvoice.status] || 'neutral'}>{viewInvoice.status}</Badge></div>
              <div><p className="text-xs text-surface-400">Outstanding</p><p className="text-sm font-bold text-red-500">{formatCurrency(viewInvoice.outstandingAmount)}</p></div>
            </div>

            <div className="table-container">
              <table className="table">
                <thead><tr><th>Description</th><th>Qty</th><th>Unit Price</th><th>GST%</th><th>Total</th></tr></thead>
                <tbody>
                  {viewInvoice.items.map((item) => (
                    <tr key={item.invoiceItemId}>
                      <td>{item.description}</td>
                      <td>{item.quantity}</td>
                      <td>{formatCurrency(item.unitPrice)}</td>
                      <td>{item.gstRate}%</td>
                      <td className="font-medium">{formatCurrency(item.totalPrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="text-right border-t border-surface-200 dark:border-surface-700 pt-4">
              <p className="text-lg font-bold text-surface-900 dark:text-white">Total: {formatCurrency(viewInvoice.totalAmount)}</p>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
