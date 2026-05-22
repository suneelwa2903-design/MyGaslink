import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { HiOutlineEye, HiOutlineDocumentArrowDown } from 'react-icons/hi2';
import type { Payment, PaginationMeta } from '@gaslink/shared';
import { PaymentAllocationStatus } from '@gaslink/shared';
import { api, apiGet } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { Button, Modal, Badge, Loader, EmptyState } from '@/components/ui';

const ALLOCATION_VARIANTS: Record<string, 'success' | 'warning' | 'neutral'> = {
  [PaymentAllocationStatus.FULLY_ALLOCATED]: 'success',
  [PaymentAllocationStatus.PARTIALLY_ALLOCATED]: 'warning',
  [PaymentAllocationStatus.UNALLOCATED]: 'neutral',
};

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);
}

export default function CustomerPaymentsPage() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [viewPayment, setViewPayment] = useState<Payment | null>(null);
  const customerId = useAuthStore((s) => s.user?.customerId);
  const [stmtFrom, setStmtFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0];
  });
  const [stmtTo, setStmtTo] = useState(() => new Date().toISOString().split('T')[0]);

  const handleDownloadStatement = async () => {
    if (!customerId) return;
    try {
      const resp = await api.get(`/customers/${customerId}/ledger/pdf`, {
        params: { from: stmtFrom, to: stmtTo },
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(resp.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'statement.pdf';
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error('Failed to download statement');
    }
  };

  const { data, isLoading } = useQuery({
    queryKey: ['customer-payments', page],
    queryFn: () => apiGet<{ payments: Payment[]; meta: PaginationMeta }>('/customer-portal/payments', { page, pageSize: 25 }),
  });

  const payments = data?.payments ?? [];
  const meta = data?.meta;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">{t('customerPortal.payments.title')}</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">{t('customerPortal.payments.subtitle')}</p>
        </div>
        {customerId && (
          <div className="flex flex-wrap items-end gap-2">
            <input type="date" value={stmtFrom} onChange={(e) => setStmtFrom(e.target.value)} className="input py-2" />
            <input type="date" value={stmtTo} onChange={(e) => setStmtTo(e.target.value)} className="input py-2" />
            <Button variant="secondary" onClick={handleDownloadStatement}>
              <HiOutlineDocumentArrowDown className="h-4 w-4" />
              Download Statement
            </Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : payments.length === 0 ? (
        <EmptyState title={t('customerPortal.payments.noPayments')} description={t('customerPortal.payments.noPaymentsDesc')} />
      ) : (
        <>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('customerPortal.payments.tableHeaders.date')}</th>
                  <th>{t('customerPortal.payments.tableHeaders.amount')}</th>
                  <th>{t('customerPortal.payments.tableHeaders.method')}</th>
                  <th>{t('customerPortal.payments.tableHeaders.reference')}</th>
                  <th>{t('customerPortal.payments.tableHeaders.allocated')}</th>
                  <th>{t('customerPortal.payments.tableHeaders.status')}</th>
                  <th>{t('customerPortal.payments.tableHeaders.view')}</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.paymentId}>
                    <td>{new Date(p.transactionDate).toLocaleDateString('en-IN')}</td>
                    <td className="font-medium text-surface-900 dark:text-white">{formatCurrency(p.amount)}</td>
                    <td><Badge variant="neutral">{t(`enums.paymentMethod.${p.paymentMethod}`, p.paymentMethod.replace(/_/g, ' '))}</Badge></td>
                    <td className="text-xs">{p.referenceNumber || '-'}</td>
                    <td>{formatCurrency(p.allocatedAmount)}</td>
                    <td><Badge variant={ALLOCATION_VARIANTS[p.allocationStatus] || 'neutral'}>{t(`enums.paymentAllocationStatus.${p.allocationStatus}`, p.allocationStatus.replace(/_/g, ' '))}</Badge></td>
                    <td>
                      <button onClick={() => setViewPayment(p)} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-brand-500">
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
              <p className="text-sm text-surface-500 dark:text-surface-400">{t('customerPortal.payments.pageOf', { page: meta.page, total: meta.totalPages })}</p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('customerPortal.payments.previous')}</Button>
                <Button variant="secondary" size="sm" disabled={page >= meta.totalPages} onClick={() => setPage(page + 1)}>{t('customerPortal.payments.next')}</Button>
              </div>
            </div>
          )}
        </>
      )}

      {viewPayment && (
        <Modal open={!!viewPayment} onClose={() => setViewPayment(null)} title={t('customerPortal.payments.viewModal.title')}>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div><p className="text-xs text-surface-400">{t('customerPortal.payments.viewModal.amount')}</p><p className="text-lg font-bold text-surface-900 dark:text-white">{formatCurrency(viewPayment.amount)}</p></div>
              <div><p className="text-xs text-surface-400">{t('customerPortal.payments.viewModal.method')}</p><p className="text-sm font-medium">{t(`enums.paymentMethod.${viewPayment.paymentMethod}`, viewPayment.paymentMethod.replace(/_/g, ' '))}</p></div>
              <div><p className="text-xs text-surface-400">{t('customerPortal.payments.viewModal.date')}</p><p className="text-sm font-medium">{new Date(viewPayment.transactionDate).toLocaleDateString('en-IN')}</p></div>
              <div><p className="text-xs text-surface-400">{t('customerPortal.payments.viewModal.reference')}</p><p className="text-sm font-medium">{viewPayment.referenceNumber || t('customerPortal.payments.viewModal.notAvailable')}</p></div>
            </div>

            {viewPayment.allocations.length > 0 && (
              <div>
                <h4 className="font-semibold text-surface-900 dark:text-white mb-2">{t('customerPortal.payments.viewModal.invoiceAllocations')}</h4>
                <div className="table-container">
                  <table className="table">
                    <thead><tr>
                      <th>{t('customerPortal.payments.viewModal.invoiceHeader')}</th>
                      <th>{t('customerPortal.payments.viewModal.amountHeader')}</th>
                    </tr></thead>
                    <tbody>
                      {viewPayment.allocations.map((a) => (
                        <tr key={a.allocationId}>
                          <td className="font-medium">{a.invoiceNumber}</td>
                          <td>{formatCurrency(a.allocatedAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
