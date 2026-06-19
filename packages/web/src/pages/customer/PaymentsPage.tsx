import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { HiOutlineEye, HiOutlinePlus } from 'react-icons/hi2';
import type { Payment, PaginationMeta } from '@gaslink/shared';
import { PaymentAllocationStatus, localTodayISO } from '@gaslink/shared';
import { apiGet, apiPost, getErrorMessage } from '@/lib/api';
import { Button, Input, Select, Modal, Badge, Loader, EmptyState } from '@/components/ui';

/** Wire shape from GET /customer-portal/payments/my-submissions */
interface CustomerSubmission {
  submissionId: string;
  amount: number;
  paymentMethod: string;
  transactionDate: string;
  referenceNumber: string | null;
  notes: string | null;
  attachmentUrl: string | null;
  status: 'pending_verification' | 'verified' | 'rejected';
  rejectionReason: string | null;
  resultingPaymentId: string | null;
  createdAt: string;
}

const SUBMISSION_STATUS_VARIANTS: Record<string, 'success' | 'warning' | 'danger'> = {
  pending_verification: 'warning',
  verified: 'success',
  rejected: 'danger',
};

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
  const [reportPaymentOpen, setReportPaymentOpen] = useState(false);

  // 3-fix bundle Fix 2 (2026-06-12): Download Statement + date range pickers
  // were moved to the customer Dashboard so the Payments screen is purely
  // a payment history list. The endpoint (/customers/:id/ledger/pdf) and
  // mobile behaviour mirror this — see DashboardPage.tsx for the new home.

  const { data, isLoading } = useQuery({
    queryKey: ['customer-payments', page],
    queryFn: () => apiGet<{ payments: Payment[]; meta: PaginationMeta }>('/customer-portal/payments', { page, pageSize: 25 }),
  });

  // WI-PENDING-PAYMENTS: self-reported submissions go here. Kept separate
  // from the cleared payments list above so totals never mix verified
  // money with unverified claims.
  const { data: submissionsData } = useQuery({
    queryKey: ['customer-payment-submissions'],
    queryFn: () => apiGet<{ submissions: CustomerSubmission[] }>('/customer-portal/payments/my-submissions'),
  });
  const submissions = submissionsData?.submissions ?? [];

  const payments = data?.payments ?? [];
  const meta = data?.meta;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">{t('customerPortal.payments.title')}</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">{t('customerPortal.payments.subtitle')}</p>
        </div>
        <Button onClick={() => setReportPaymentOpen(true)}>
          <HiOutlinePlus className="h-4 w-4" /> Report a Payment
        </Button>
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
                    <td>{formatCurrency(p.allocatedAmount ?? 0)}</td>
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

      {/* WI-PENDING-PAYMENTS: Pending verifications section — only when there are any. */}
      {submissions.length > 0 && (
        <div className="space-y-2">
          <div>
            <h2 className="text-lg font-semibold text-surface-900 dark:text-white">Pending Verifications</h2>
            <p className="text-xs text-surface-500 dark:text-surface-400">
              Payments you reported here are reviewed by the distributor&apos;s team before they appear in your cleared payment history.
            </p>
          </div>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Amount</th>
                  <th>Method</th>
                  <th>Reference</th>
                  <th>Status</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {submissions.map((s) => (
                  <tr key={s.submissionId}>
                    <td>{new Date(s.transactionDate).toLocaleDateString('en-IN')}</td>
                    <td className="font-medium">{formatCurrency(s.amount)}</td>
                    <td><Badge variant="neutral">{s.paymentMethod.replace(/_/g, ' ')}</Badge></td>
                    <td className="text-xs">{s.referenceNumber || '-'}</td>
                    <td>
                      <Badge variant={SUBMISSION_STATUS_VARIANTS[s.status] || 'neutral'}>
                        {s.status === 'pending_verification' ? 'Pending' : s.status === 'verified' ? 'Verified' : 'Rejected'}
                      </Badge>
                    </td>
                    <td className="text-xs">
                      {s.status === 'rejected' && s.rejectionReason ? (
                        <span className="text-red-600 dark:text-red-400">{s.rejectionReason}</span>
                      ) : s.notes ? (
                        <span>{s.notes}</span>
                      ) : (
                        <span className="text-surface-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {reportPaymentOpen && (
        <ReportPaymentModal
          onClose={() => setReportPaymentOpen(false)}
        />
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

// ─── Report a Payment modal ─────────────────────────────────────────────────
// WI-PENDING-PAYMENTS: customer self-reports a payment made via off-portal
// channels (cash to driver, bank transfer, cheque). Lands as
// PaymentSubmission status=pending_verification until office verifies.

export interface ReportPaymentModalProps {
  onClose: () => void;
  /** Optional invoice context — pre-fills amount + pendingInvoiceIds. */
  invoiceId?: string;
  invoiceOutstanding?: number;
}

export function ReportPaymentModal({ onClose, invoiceId, invoiceOutstanding }: ReportPaymentModalProps) {
  const queryClient = useQueryClient();
  // Anti-pattern #21: use localTodayISO (local-TZ YYYY-MM-DD), not
  // toISOString().slice(0,10) which returns the UTC calendar date.
  const todayStr = localTodayISO();
  const [amount, setAmount] = useState(
    invoiceOutstanding ? invoiceOutstanding.toFixed(2) : '',
  );
  const [paymentMethod, setPaymentMethod] = useState<string>('upi');
  const [transactionDate, setTransactionDate] = useState(todayStr);
  const [referenceNumber, setReferenceNumber] = useState('');
  const [notes, setNotes] = useState('');

  const submitMutation = useMutation({
    mutationFn: () =>
      apiPost('/customer-portal/payments/submit', {
        amount: Number(amount),
        paymentMethod,
        transactionDate,
        referenceNumber: referenceNumber || undefined,
        notes: notes || undefined,
        pendingInvoiceIds: invoiceId ? [invoiceId] : undefined,
      }),
    onSuccess: () => {
      toast.success('Your payment has been reported. Our team will verify and update your account shortly.');
      queryClient.invalidateQueries({ queryKey: ['customer-payment-submissions'] });
      onClose();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const methodOptions = [
    { value: 'cash', label: 'Cash' },
    { value: 'upi', label: 'UPI' },
    { value: 'bank_transfer', label: 'Bank Transfer' },
    { value: 'cheque', label: 'Cheque' },
    { value: 'online', label: 'Online' },
  ];

  const canSubmit = Number(amount) > 0 && !!transactionDate;

  return (
    <Modal open={true} onClose={onClose} title="Report a Payment" size="md">
      <div className="space-y-4">
        <p className="text-sm text-surface-600 dark:text-surface-400">
          Use this to report payments you made through channels outside this portal — cash to the
          delivery driver, bank transfer, UPI, cheque, etc. Your distributor&apos;s team will verify
          and update your balance.
        </p>
        <div>
          <label className="block text-xs text-surface-400 mb-1">Amount (₹)</label>
          <Input
            type="number"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-surface-400 mb-1">Method</label>
            <Select
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
              options={methodOptions}
            />
          </div>
          <div>
            <label className="block text-xs text-surface-400 mb-1">Payment Date</label>
            <input
              type="date"
              value={transactionDate}
              onChange={(e) => setTransactionDate(e.target.value)}
              max={todayStr}
              className="input py-2 w-full"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs text-surface-400 mb-1">Reference / UTR (optional)</label>
          <Input
            value={referenceNumber}
            onChange={(e) => setReferenceNumber(e.target.value)}
            placeholder="UPI ref / cheque no. / UTR"
          />
        </div>
        <div>
          <label className="block text-xs text-surface-400 mb-1">Notes (optional)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="input w-full"
            placeholder="Any additional context for the verifier"
          />
        </div>
        <div className="flex justify-end gap-2 pt-4 border-t border-surface-200 dark:border-surface-700">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!canSubmit || submitMutation.isPending}
            onClick={() => submitMutation.mutate()}
          >
            Submit
          </Button>
        </div>
      </div>
    </Modal>
  );
}

