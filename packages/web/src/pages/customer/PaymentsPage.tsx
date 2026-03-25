import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HiOutlineEye } from 'react-icons/hi2';
import type { Payment, PaginationMeta } from '@gaslink/shared';
import { PaymentAllocationStatus } from '@gaslink/shared';
import { apiGet } from '@/lib/api';
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
  const [page, setPage] = useState(1);
  const [viewPayment, setViewPayment] = useState<Payment | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['customer-payments', page],
    queryFn: () => apiGet<{ payments: Payment[]; meta: PaginationMeta }>('/customer-portal/payments', { page, pageSize: 25 }),
  });

  const payments = data?.payments ?? [];
  const meta = data?.meta;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white">My Payments</h1>
        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">View your payment history</p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : payments.length === 0 ? (
        <EmptyState title="No payments" description="Your payment history will appear here." />
      ) : (
        <>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr><th>Date</th><th>Amount</th><th>Method</th><th>Reference</th><th>Allocated</th><th>Status</th><th>View</th></tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.paymentId}>
                    <td>{new Date(p.transactionDate).toLocaleDateString('en-IN')}</td>
                    <td className="font-medium text-surface-900 dark:text-white">{formatCurrency(p.amount)}</td>
                    <td><Badge variant="neutral">{p.paymentMethod.replace(/_/g, ' ')}</Badge></td>
                    <td className="text-xs">{p.referenceNumber || '-'}</td>
                    <td>{formatCurrency(p.allocatedAmount)}</td>
                    <td><Badge variant={ALLOCATION_VARIANTS[p.allocationStatus] || 'neutral'}>{p.allocationStatus.replace(/_/g, ' ')}</Badge></td>
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
              <p className="text-sm text-surface-500 dark:text-surface-400">Page {meta.page} of {meta.totalPages}</p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button variant="secondary" size="sm" disabled={page >= meta.totalPages} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          )}
        </>
      )}

      {viewPayment && (
        <Modal open={!!viewPayment} onClose={() => setViewPayment(null)} title="Payment Details">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div><p className="text-xs text-surface-400">Amount</p><p className="text-lg font-bold text-surface-900 dark:text-white">{formatCurrency(viewPayment.amount)}</p></div>
              <div><p className="text-xs text-surface-400">Method</p><p className="text-sm font-medium">{viewPayment.paymentMethod.replace(/_/g, ' ')}</p></div>
              <div><p className="text-xs text-surface-400">Date</p><p className="text-sm font-medium">{new Date(viewPayment.transactionDate).toLocaleDateString('en-IN')}</p></div>
              <div><p className="text-xs text-surface-400">Reference</p><p className="text-sm font-medium">{viewPayment.referenceNumber || 'N/A'}</p></div>
            </div>

            {viewPayment.allocations.length > 0 && (
              <div>
                <h4 className="font-semibold text-surface-900 dark:text-white mb-2">Invoice Allocations</h4>
                <div className="table-container">
                  <table className="table">
                    <thead><tr><th>Invoice</th><th>Amount</th></tr></thead>
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
