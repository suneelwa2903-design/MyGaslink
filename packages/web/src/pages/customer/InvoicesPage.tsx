import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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

  const statusOptions = Object.values(InvoiceStatus).map((s) => ({
    value: s,
    label: t(`enums.invoiceStatus.${s}`, s.replace(/_/g, ' ')),
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white">{t('customerPortal.invoices.title')}</h1>
        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">{t('customerPortal.invoices.subtitle')}</p>
      </div>

      <div className="card p-4">
        <Select options={statusOptions} placeholder={t('customerPortal.invoices.allStatuses')} value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : invoices.length === 0 ? (
        <EmptyState title={t('customerPortal.invoices.noInvoices')} description={t('customerPortal.invoices.noInvoicesDesc')} />
      ) : (
        <>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('customerPortal.invoices.tableHeaders.invoiceNumber')}</th>
                  <th>{t('customerPortal.invoices.tableHeaders.issueDate')}</th>
                  <th>{t('customerPortal.invoices.tableHeaders.dueDate')}</th>
                  <th>{t('customerPortal.invoices.tableHeaders.total')}</th>
                  <th>{t('customerPortal.invoices.tableHeaders.paid')}</th>
                  <th>{t('customerPortal.invoices.tableHeaders.outstanding')}</th>
                  <th>{t('customerPortal.invoices.tableHeaders.status')}</th>
                  <th>{t('customerPortal.invoices.tableHeaders.view')}</th>
                </tr>
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
                    <td><Badge variant={STATUS_VARIANTS[inv.status] || 'neutral'}>{t(`enums.invoiceStatus.${inv.status}`, inv.status.replace(/_/g, ' '))}</Badge></td>
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
              <p className="text-sm text-surface-500 dark:text-surface-400">{t('customerPortal.invoices.pageOf', { page: meta.page, total: meta.totalPages })}</p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('customerPortal.invoices.previous')}</Button>
                <Button variant="secondary" size="sm" disabled={page >= meta.totalPages} onClick={() => setPage(page + 1)}>{t('customerPortal.invoices.next')}</Button>
              </div>
            </div>
          )}
        </>
      )}

      {viewInvoice && (
        <Modal open={!!viewInvoice} onClose={() => setViewInvoice(null)} title={t('customerPortal.invoices.viewModal.title', { invoiceNumber: viewInvoice.invoiceNumber })} size="lg">
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div><p className="text-xs text-surface-400">{t('customerPortal.invoices.viewModal.issueDate')}</p><p className="text-sm font-medium">{new Date(viewInvoice.issueDate).toLocaleDateString('en-IN')}</p></div>
              <div><p className="text-xs text-surface-400">{t('customerPortal.invoices.viewModal.dueDate')}</p><p className="text-sm font-medium">{new Date(viewInvoice.dueDate).toLocaleDateString('en-IN')}</p></div>
              <div><p className="text-xs text-surface-400">{t('customerPortal.invoices.viewModal.status')}</p><Badge variant={STATUS_VARIANTS[viewInvoice.status] || 'neutral'}>{t(`enums.invoiceStatus.${viewInvoice.status}`, viewInvoice.status)}</Badge></div>
              <div><p className="text-xs text-surface-400">{t('customerPortal.invoices.viewModal.outstanding')}</p><p className="text-sm font-bold text-red-500">{formatCurrency(viewInvoice.outstandingAmount)}</p></div>
            </div>

            <div className="table-container">
              <table className="table">
                <thead><tr>
                  <th>{t('customerPortal.invoices.viewModal.description')}</th>
                  <th>{t('customerPortal.invoices.viewModal.qty')}</th>
                  <th>{t('customerPortal.invoices.viewModal.unitPrice')}</th>
                  <th>{t('customerPortal.invoices.viewModal.gstPercent')}</th>
                  <th>{t('customerPortal.invoices.viewModal.total')}</th>
                </tr></thead>
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
              <p className="text-lg font-bold text-surface-900 dark:text-white">{t('customerPortal.invoices.viewModal.totalLabel', { amount: formatCurrency(viewInvoice.totalAmount) })}</p>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
