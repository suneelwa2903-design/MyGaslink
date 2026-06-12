import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { HiOutlineEye } from 'react-icons/hi2';
import toast from 'react-hot-toast';
import type { Invoice, PaginationMeta } from '@gaslink/shared';
import { InvoiceStatus, invoiceStatusLabel, invoiceStatusVariant } from '@gaslink/shared';
import { apiGet, apiPost, getErrorMessage } from '@/lib/api';
import { Button, Select, Modal, Badge, Loader, EmptyState, Input } from '@/components/ui';
import { cn } from '@/lib/cn';

// Phase F (2026-06-12): Razorpay checkout.js loader — singleton
// promise matching Anah pattern (and Phase E SubscriptionTab). Loaded
// once across both pay-now-for-subscription and pay-now-for-invoice
// flows; no duplicate script tags.
let razorpayScriptPromise: Promise<boolean> | null = null;
function loadRazorpayScript(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if ((window as Window & { Razorpay?: unknown }).Razorpay) return Promise.resolve(true);
  if (!razorpayScriptPromise) {
    razorpayScriptPromise = new Promise<boolean>((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.async = true;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.body.appendChild(s);
    });
  }
  return razorpayScriptPromise;
}

interface RazorpayWindow extends Window {
  Razorpay?: new (opts: {
    key: string;
    amount: number;
    currency: string;
    name: string;
    description: string;
    order_id: string;
    handler: (resp: {
      razorpay_order_id?: string;
      razorpay_payment_id?: string;
      razorpay_signature?: string;
    }) => void | Promise<void>;
    modal?: { ondismiss?: () => void };
    theme?: { color?: string };
  }) => { open: () => void; on: (event: string, cb: (resp: { error?: { description?: string } }) => void) => void };
}

interface DistributorPortalInfo {
  distributorId: string;
  businessName: string;
  razorpayEnabled?: boolean;
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);
}

export default function CustomerInvoicesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [viewInvoice, setViewInvoice] = useState<Invoice | null>(null);
  // Phase F (2026-06-12): pay-now modal state. payInvoice holds the
  // invoice being paid; payAmount is the customer-editable amount
  // (defaults to outstandingAmount, bounded server-side to (0,
  // outstanding]).
  const [payInvoice, setPayInvoice] = useState<Invoice | null>(null);
  const [payAmount, setPayAmount] = useState<string>('');

  const queryParams: Record<string, unknown> = { page, pageSize: 25 };
  if (statusFilter) queryParams.status = statusFilter;

  const { data, isLoading } = useQuery({
    queryKey: ['customer-invoices', queryParams],
    queryFn: () => apiGet<{ invoices: Invoice[]; meta: PaginationMeta }>('/customer-portal/invoices', queryParams),
  });

  // Phase F (2026-06-12): fetch distributor info to gate the Pay Now
  // button on `razorpayEnabled`. Fail-closed — if the call errors or
  // returns false, no Pay Now button appears. Customer can't tell
  // payments are disabled vs missing.
  const { data: distInfo } = useQuery({
    queryKey: ['customer-portal-distributor'],
    queryFn: () => apiGet<DistributorPortalInfo>('/customer-portal/distributor'),
  });
  const payNowAvailable = distInfo?.razorpayEnabled === true;

  const verifyMutation = useMutation({
    mutationFn: (vars: {
      invoiceId: string;
      razorpayOrderId: string;
      razorpayPaymentId: string;
      razorpaySignature: string;
      amount: number;
    }) =>
      apiPost(`/customer-portal/invoices/${vars.invoiceId}/verify-payment`, {
        razorpayOrderId: vars.razorpayOrderId,
        razorpayPaymentId: vars.razorpayPaymentId,
        razorpaySignature: vars.razorpaySignature,
        amount: vars.amount,
      }),
    onSuccess: () => {
      toast.success('Payment recorded successfully.');
      queryClient.invalidateQueries({ queryKey: ['customer-invoices'] });
      setPayInvoice(null);
      setPayAmount('');
    },
    onError: (e: unknown) => {
      toast.error(getErrorMessage(e) || 'Payment verification failed');
    },
  });

  const handleStartPayment = async () => {
    if (!payInvoice) return;
    const amount = Number(payAmount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > payInvoice.outstandingAmount) {
      toast.error(`Amount must be between ₹1 and ${formatCurrency(payInvoice.outstandingAmount)}`);
      return;
    }
    try {
      const order = await apiPost<{
        razorpayOrderId: string;
        amount: number;
        currency: string;
        keyId: string;
        mock?: boolean;
        invoiceNumber: string;
      }>(`/customer-portal/invoices/${payInvoice.invoiceId}/create-payment-order`, { amount });

      // Mock-mode short circuit (Anah pattern): no real Razorpay
      // modal in dev / before secrets are configured. Verify-payment
      // accepts any signature in mock mode.
      if (order.mock || order.razorpayOrderId.startsWith('mock_rzp_')) {
        await verifyMutation.mutateAsync({
          invoiceId: payInvoice.invoiceId,
          razorpayOrderId: order.razorpayOrderId,
          razorpayPaymentId: `mock_pay_${payInvoice.invoiceId}`,
          razorpaySignature: 'mock_signature',
          amount,
        });
        return;
      }

      const loaded = await loadRazorpayScript();
      const RZP = (window as RazorpayWindow).Razorpay;
      if (!loaded || !RZP) {
        toast.error('Unable to load Razorpay checkout. Please try again.');
        return;
      }
      const rz = new RZP({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        name: distInfo?.businessName ?? 'MyGasLink',
        description: `Invoice ${order.invoiceNumber}`,
        order_id: order.razorpayOrderId,
        handler: async (resp) => {
          try {
            await verifyMutation.mutateAsync({
              invoiceId: payInvoice.invoiceId,
              razorpayOrderId: resp.razorpay_order_id || '',
              razorpayPaymentId: resp.razorpay_payment_id || '',
              razorpaySignature: resp.razorpay_signature || '',
              amount,
            });
          } catch {
            // mutation onError already toasted
          }
        },
        modal: {
          ondismiss: () => {
            toast('Payment cancelled', { icon: 'ℹ️' });
          },
        },
        theme: { color: '#1e40af' },
      });
      rz.on('payment.failed', (resp) => {
        toast.error(resp.error?.description || 'Payment failed. Please retry.');
      });
      rz.open();
    } catch (err) {
      toast.error(getErrorMessage(err) || 'Could not start payment');
    }
  };

  const invoices = data?.invoices ?? [];
  const meta = data?.meta;

  const statusOptions = Object.values(InvoiceStatus).map((s) => ({
    value: s,
    label: invoiceStatusLabel(s),
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
                    <td><Badge variant={invoiceStatusVariant(inv.status)}>{invoiceStatusLabel(inv.status)}</Badge></td>
                    <td>
                      <div className="flex items-center gap-2">
                        {/* Phase F (2026-06-12): Pay Now button — only
                            rendered when the distributor has enabled
                            Razorpay AND the invoice has outstanding
                            balance. Hidden entirely otherwise so the
                            customer doesn't see "payments disabled" UI. */}
                        {payNowAvailable && inv.outstandingAmount > 0 && (
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => {
                              setPayInvoice(inv);
                              setPayAmount(inv.outstandingAmount.toFixed(2));
                            }}
                          >
                            Pay Now
                          </Button>
                        )}
                        <button onClick={() => setViewInvoice(inv)} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-brand-500">
                          <HiOutlineEye className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {payInvoice && (
            <Modal
              open={!!payInvoice}
              onClose={() => {
                setPayInvoice(null);
                setPayAmount('');
              }}
              title={`Pay ${payInvoice.invoiceNumber}`}
              size="sm"
            >
              <div className="space-y-4">
                <p className="text-sm text-surface-600 dark:text-surface-400">
                  Outstanding: <span className="font-semibold text-red-500">{formatCurrency(payInvoice.outstandingAmount)}</span>
                </p>
                <div>
                  <label className="block text-xs text-surface-500 mb-1">Amount to pay (₹)</label>
                  <Input
                    type="number"
                    step="0.01"
                    min="1"
                    max={payInvoice.outstandingAmount}
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                  />
                  <p className="text-xs text-surface-400 mt-1">
                    Partial payments are accepted. Minimum ₹1.
                  </p>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setPayInvoice(null);
                      setPayAmount('');
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    onClick={handleStartPayment}
                    disabled={verifyMutation.isPending}
                  >
                    {verifyMutation.isPending ? 'Processing…' : 'Continue to Payment'}
                  </Button>
                </div>
              </div>
            </Modal>
          )}

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
              <div><p className="text-xs text-surface-400">{t('customerPortal.invoices.viewModal.status')}</p><Badge variant={invoiceStatusVariant(viewInvoice.status)}>{invoiceStatusLabel(viewInvoice.status)}</Badge></div>
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
