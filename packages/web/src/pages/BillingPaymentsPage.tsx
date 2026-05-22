import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import toast from 'react-hot-toast';
import {
  HiOutlineEye,
  HiOutlineDocumentArrowDown,
  HiOutlinePlusCircle,
  HiOutlineMinusCircle,
  HiOutlineBanknotes,
  HiOutlinePlus,
  HiOutlineTrash,
  HiOutlineArrowPath,
  HiOutlineShieldCheck,
  HiOutlineXCircle,
  HiOutlineDocumentText,
  HiOutlineArrowsRightLeft,
} from 'react-icons/hi2';
import {
  type Invoice,
  type Payment,
  type Customer,
  type PaginationMeta,
  type DistributorSettings,
  InvoiceStatus,
  IrnStatus,
  EwbStatus,
  GstMode,
  PaymentMethod,
  PaymentAllocationStatus,
  createCreditNoteSchema,
  type CreateCreditNoteInput,
  createDebitNoteSchema,
  type CreateDebitNoteInput,
  createPaymentSchema,
  type CreatePaymentInput,
  UserRole,
} from '@gaslink/shared';
import { api, apiGet, apiPost, apiPut, getErrorMessage } from '@/lib/api';
import { formatNoteCountLabel } from '@/utils/noteBadge';
import { useAuthStore, selectDistributorId, selectRole } from '@/stores/authStore';
import { Button, Input, Select, Modal, Badge, Loader, EmptyState } from '@/components/ui';
import { cn } from '@/lib/cn';

// ─── Shared constants ────────────────────────────────────────────────────────

const INVOICE_STATUS_VARIANTS: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  [InvoiceStatus.DRAFT]: 'neutral',
  [InvoiceStatus.ISSUED]: 'info',
  [InvoiceStatus.PARTIALLY_PAID]: 'warning',
  [InvoiceStatus.PAID]: 'success',
  [InvoiceStatus.OVERDUE]: 'danger',
  [InvoiceStatus.CANCELLED]: 'danger',
};

const IRN_VARIANTS: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  [IrnStatus.NOT_ATTEMPTED]: 'neutral',
  [IrnStatus.PENDING]: 'warning',
  [IrnStatus.SUCCESS]: 'success',
  [IrnStatus.FAILED]: 'danger',
  [IrnStatus.CANCELLED]: 'danger',
};

const EWB_VARIANTS: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  [EwbStatus.NOT_ATTEMPTED]: 'neutral',
  [EwbStatus.PENDING]: 'warning',
  [EwbStatus.ACTIVE]: 'success',
  [EwbStatus.FAILED]: 'danger',
  [EwbStatus.CANCELLED]: 'danger',
};

const ALLOCATION_VARIANTS: Record<string, 'success' | 'warning' | 'neutral'> = {
  [PaymentAllocationStatus.FULLY_ALLOCATED]: 'success',
  [PaymentAllocationStatus.PARTIALLY_ALLOCATED]: 'warning',
  [PaymentAllocationStatus.UNALLOCATED]: 'neutral',
};

/** Shape returned by GET /invoices/:id/gst-documents */
interface GstDocumentRecord {
  id: string;
  invoiceId: string | null;
  orderId: string | null;
  distributorId: string;
  gstDocNo: string | null;
  docType: string;
  irnStatus: string;
  ewbStatus: string;
  irn: string | null;
  ackNo: string | null;
  ackDate: string | null;
  ewbNo: string | null;
  ewbDate: string | null;
  ewbValidTill: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  isLatest: boolean;
  createdAt: string;
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);
}

// ─── Main Page Component ─────────────────────────────────────────────────────

export default function BillingPaymentsPage() {
  const [tab, setTab] = useState<'invoices' | 'payments'>('invoices');

  const tabs = [
    { key: 'invoices' as const, label: 'Invoices' },
    { key: 'payments' as const, label: 'Payments' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Billing & Payments</h1>
        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">Manage invoices, payments, and allocations</p>
      </div>

      {/* Tabs */}
      <div className="border-b border-surface-200 dark:border-surface-700">
        <div className="flex gap-4">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'pb-2 text-sm font-medium border-b-2 transition-colors',
                tab === t.key ? 'border-brand-500 text-brand-600 dark:text-brand-400' : 'border-transparent text-surface-500 hover:text-surface-700 dark:hover:text-surface-300',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'invoices' && <InvoicesTab />}
      {tab === 'payments' && <PaymentsTab />}
    </div>
  );
}

// ─── Invoices Tab ────────────────────────────────────────────────────────────

function InvoicesTab() {
  const queryClient = useQueryClient();
  const distributorId = useAuthStore(selectDistributorId);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [irnFilter, setIrnFilter] = useState('');
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0];
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().split('T')[0]);
  const [viewInvoice, setViewInvoice] = useState<Invoice | null>(null);
  const [creditNoteInvoice, setCreditNoteInvoice] = useState<Invoice | null>(null);
  const [debitNoteInvoice, setDebitNoteInvoice] = useState<Invoice | null>(null);
  const [payInvoice, setPayInvoice] = useState<Invoice | null>(null);
  const [cancelIrnInvoice, setCancelIrnInvoice] = useState<Invoice | null>(null);
  const [cancelEwbInvoice, setCancelEwbInvoice] = useState<Invoice | null>(null);

  // Check if distributor has GST enabled — skip when super admin has no
  // distributor selected.
  const { data: settings } = useQuery({
    queryKey: ['settings', distributorId],
    queryFn: () => apiGet<DistributorSettings>('/settings'),
    staleTime: 5 * 60 * 1000,
    enabled: !!distributorId,
  });
  const gstEnabled = settings?.gstMode !== undefined && settings.gstMode !== GstMode.DISABLED;

  const queryParams: Record<string, unknown> = { page, pageSize: 25 };
  if (statusFilter) queryParams.status = statusFilter;
  if (irnFilter) queryParams.irnStatus = irnFilter;
  if (dateFrom) queryParams.dateFrom = dateFrom;
  if (dateTo) queryParams.dateTo = dateTo;

  const { data, isLoading } = useQuery({
    queryKey: ['invoices', queryParams],
    queryFn: () => apiGet<{ invoices: Invoice[]; meta: PaginationMeta }>('/invoices', queryParams),
  });

  // WI-055: cylinder-types query previously fed the CN/DN item grid.
  // The amount-based redesign drops that dependency. Kept here as a
  // comment-only marker so future contributors know the prop was
  // intentionally removed, not accidentally lost.

  const invoices = data?.invoices ?? [];
  const meta = data?.meta;

  // GST mutation hooks
  const generateGstMutation = useMutation({
    mutationFn: (invoiceId: string) => apiPost(`/invoices/${invoiceId}/generate-gst`),
    onSuccess: () => { toast.success('GST generation initiated'); queryClient.invalidateQueries({ queryKey: ['invoices'] }); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const regenerateInvoiceMutation = useMutation({
    mutationFn: (invoiceId: string) => apiPost(`/invoices/${invoiceId}/regenerate`),
    onSuccess: () => { toast.success('Invoice regenerated successfully'); queryClient.invalidateQueries({ queryKey: ['invoices'] }); setViewInvoice(null); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const handleDownloadPdf = async (invoiceId: string) => {
    try {
      const response = await api.get(`/invoices/${invoiceId}/pdf`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(response.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `invoice-${invoiceId}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error('Failed to download PDF');
    }
  };

  return (
    <>
      {/* Filters */}
      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Select
            options={Object.values(InvoiceStatus).map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))}
            placeholder="All Statuses"
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          />
          {gstEnabled && (
            <Select
              options={Object.values(IrnStatus).map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))}
              placeholder="All IRN Statuses"
              value={irnFilter}
              onChange={(e) => { setIrnFilter(e.target.value); setPage(1); }}
            />
          )}
          <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} className="input py-2" />
          <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} className="input py-2" />
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : invoices.length === 0 ? (
        <EmptyState title="No invoices found" description="Invoices will appear here once orders are delivered." />
      ) : (
        <>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Invoice #</th>
                  <th>Customer</th>
                  <th>Issue Date</th>
                  <th>Due Date</th>
                  {/*
                    WI-066: invoice.totalAmount is the GST-inclusive grand
                    total for both fresh AND revised invoices now. The
                    WI-064 'excl. GST' qualifier was an interim safety
                    net while gstReissueService had a unit-mismatch bug
                    (was multiplying base unitPrice × qty instead of
                    deriving inclusive total from original item.totalPrice).
                    The service-layer fix in WI-066 removed the
                    discrepancy, so this column is plain 'Total' again.
                  */}
                  <th>Total</th>
                  <th>Outstanding</th>
                  <th>Status</th>
                  {gstEnabled && <th>GST</th>}
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.invoiceId}>
                    <td className="font-medium text-surface-900 dark:text-white">
                      <span>{inv.invoiceNumber}</span>
                      {/* WI-056 pills + cleanup-fix label format:
                          1 note → "CN" / "DN" (cleaner when most invoices
                                  only have one)
                          N >= 2 → "CN ×N" / "DN ×N" (multiplication-sign
                                  reads as "times", scannable in a busy list).
                          Hover title keeps the verbose phrasing for
                          screen-reader / accessibility. */}
                      {(inv.creditNotesCount ?? 0) > 0 && (
                        <span
                          className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                          title={`${inv.creditNotesCount} credit note${(inv.creditNotesCount ?? 0) > 1 ? 's' : ''}`}
                        >
                          {formatNoteCountLabel(inv.creditNotesCount ?? 0, 'CN')}
                        </span>
                      )}
                      {(inv.debitNotesCount ?? 0) > 0 && (
                        <span
                          className="ml-1 inline-flex items-center rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
                          title={`${inv.debitNotesCount} debit note${(inv.debitNotesCount ?? 0) > 1 ? 's' : ''}`}
                        >
                          {formatNoteCountLabel(inv.debitNotesCount ?? 0, 'DN')}
                        </span>
                      )}
                    </td>
                    <td>{inv.customerName || 'N/A'}</td>
                    <td>{new Date(inv.issueDate).toLocaleDateString('en-IN')}</td>
                    <td>{new Date(inv.dueDate).toLocaleDateString('en-IN')}</td>
                    <td className="font-medium">{formatCurrency(inv.totalAmount)}</td>
                    <td className={cn('font-medium', inv.outstandingAmount > 0 && 'text-red-500')}>
                      {formatCurrency(inv.outstandingAmount)}
                    </td>
                    <td><Badge variant={INVOICE_STATUS_VARIANTS[inv.status] || 'neutral'}>{inv.status.replace(/_/g, ' ')}</Badge></td>
                    {gstEnabled && (
                      <td>
                        {/* WI-077: B2B shows IRN + EWB pills, B2C shows EWB
                            only — B2C never gets an IRN so the old single
                            "NOT ATTEMPTED" IRN pill was misleading. Colour
                            encodes status (success=green, failed=red,
                            not_attempted=grey, pending=yellow). */}
                        <div className="flex gap-1">
                          {inv.customerType === 'B2B' && (
                            <Badge variant={IRN_VARIANTS[inv.irnStatus] || 'neutral'}>IRN</Badge>
                          )}
                          <Badge variant={EWB_VARIANTS[inv.ewbStatus] || 'neutral'}>EWB</Badge>
                        </div>
                      </td>
                    )}
                    <td>
                      <div className="flex items-center gap-1">
                        <button onClick={() => setViewInvoice(inv)} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-brand-500" title="View">
                          <HiOutlineEye className="h-4 w-4" />
                        </button>
                        <button onClick={() => handleDownloadPdf(inv.invoiceId)} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-surface-500" title="Download PDF">
                          <HiOutlineDocumentArrowDown className="h-4 w-4" />
                        </button>
                        {inv.status !== InvoiceStatus.CANCELLED && inv.status !== InvoiceStatus.PAID && (
                          <>
                            <button onClick={() => setPayInvoice(inv)} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-accent-500" title="Record Payment">
                              <HiOutlineBanknotes className="h-4 w-4" />
                            </button>
                            {gstEnabled && (
                              <>
                                <button onClick={() => setCreditNoteInvoice(inv)} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-flame-500" title="Credit Note">
                                  <HiOutlineMinusCircle className="h-4 w-4" />
                                </button>
                                <button onClick={() => setDebitNoteInvoice(inv)} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-red-500" title="Debit Note">
                                  <HiOutlinePlusCircle className="h-4 w-4" />
                                </button>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {meta && meta.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-surface-500 dark:text-surface-400">
                Page {meta.page} of {meta.totalPages} ({meta.total} total)
              </p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button variant="secondary" size="sm" disabled={page >= meta.totalPages} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Invoice Detail Modal */}
      {viewInvoice && (
        <InvoiceDetailModal
          invoice={viewInvoice}
          onClose={() => setViewInvoice(null)}
          gstEnabled={gstEnabled}
          onGenerateGst={(id) => generateGstMutation.mutate(id)}
          generateGstPending={generateGstMutation.isPending}
          onRegenerateInvoice={(id) => regenerateInvoiceMutation.mutate(id)}
          regeneratePending={regenerateInvoiceMutation.isPending}
          onCancelIrn={(inv) => { setViewInvoice(null); setCancelIrnInvoice(inv); }}
          onCancelEwb={(inv) => { setViewInvoice(null); setCancelEwbInvoice(inv); }}
        />
      )}

      {/* Credit Note Modal — WI-055 amount-based, no items */}
      {creditNoteInvoice && (
        <CreditNoteModal
          open={!!creditNoteInvoice}
          onClose={() => setCreditNoteInvoice(null)}
          invoice={creditNoteInvoice}
        />
      )}

      {/* Debit Note Modal — WI-055 amount-based, no items */}
      {debitNoteInvoice && (
        <DebitNoteModal
          open={!!debitNoteInvoice}
          onClose={() => setDebitNoteInvoice(null)}
          invoice={debitNoteInvoice}
        />
      )}

      {/* Pay Invoice Modal */}
      {payInvoice && (
        <PayInvoiceModal
          open={!!payInvoice}
          onClose={() => setPayInvoice(null)}
          invoice={payInvoice}
        />
      )}

      {/* Cancel IRN Modal */}
      {cancelIrnInvoice && (
        <CancelGstModal
          open={!!cancelIrnInvoice}
          onClose={() => setCancelIrnInvoice(null)}
          invoice={cancelIrnInvoice}
          type="irn"
        />
      )}

      {/* Cancel EWB Modal */}
      {cancelEwbInvoice && (
        <CancelGstModal
          open={!!cancelEwbInvoice}
          onClose={() => setCancelEwbInvoice(null)}
          invoice={cancelEwbInvoice}
          type="ewb"
        />
      )}
    </>
  );
}

// ─── Payments Tab ────────────────────────────────────────────────────────────

function PaymentsTab() {
  useQueryClient();
  const [page, setPage] = useState(1);
  const [methodFilter, setMethodFilter] = useState('');
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0];
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().split('T')[0]);
  const [createOpen, setCreateOpen] = useState(false);
  const [viewPayment, setViewPayment] = useState<Payment | null>(null);
  const [allocatePayment, setAllocatePayment] = useState<Payment | null>(null);

  const queryParams: Record<string, unknown> = { page, pageSize: 25 };
  if (methodFilter) queryParams.paymentMethod = methodFilter;
  if (dateFrom) queryParams.dateFrom = dateFrom;
  if (dateTo) queryParams.dateTo = dateTo;

  const { data, isLoading } = useQuery({
    queryKey: ['payments', queryParams],
    queryFn: () => apiGet<{ payments: Payment[]; meta: PaginationMeta }>('/payments', queryParams),
  });

  const payments = data?.payments ?? [];
  const meta = data?.meta;

  const methodOptions = Object.values(PaymentMethod).map((m) => ({ value: m, label: m.replace(/_/g, ' ') }));

  return (
    <>
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)}>
          <HiOutlinePlus className="h-4 w-4" />
          Record Payment
        </Button>
      </div>

      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Select options={methodOptions} placeholder="All Methods" value={methodFilter} onChange={(e) => { setMethodFilter(e.target.value); setPage(1); }} />
          <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} className="input py-2" />
          <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} className="input py-2" />
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : payments.length === 0 ? (
        <EmptyState
          title="No payments found"
          description="Record your first payment to get started."
          action={<Button onClick={() => setCreateOpen(true)}><HiOutlinePlus className="h-4 w-4" />Record Payment</Button>}
        />
      ) : (
        <>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Customer</th>
                  <th>Amount</th>
                  <th>Method</th>
                  <th>Reference</th>
                  <th>Allocated</th>
                  <th>Unallocated</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.paymentId}>
                    <td>{new Date(payment.transactionDate).toLocaleDateString('en-IN')}</td>
                    <td className="font-medium text-surface-900 dark:text-white">{payment.customerName}</td>
                    <td className="font-medium">{formatCurrency(payment.amount)}</td>
                    <td><Badge variant="neutral">{payment.paymentMethod.replace(/_/g, ' ')}</Badge></td>
                    <td className="text-xs">{payment.referenceNumber || '-'}</td>
                    <td>{formatCurrency(payment.allocatedAmount)}</td>
                    <td className={payment.unallocatedAmount > 0 ? 'text-amber-500 font-medium' : ''}>
                      {formatCurrency(payment.unallocatedAmount)}
                    </td>
                    <td>
                      <Badge variant={ALLOCATION_VARIANTS[payment.allocationStatus] || 'neutral'}>
                        {payment.allocationStatus.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setViewPayment(payment)}
                          className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-brand-500"
                          title="View Allocations"
                        >
                          <HiOutlineEye className="h-4 w-4" />
                        </button>
                        {payment.unallocatedAmount > 0 && (
                          <button
                            onClick={() => setAllocatePayment(payment)}
                            className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-accent-500"
                            title="Allocate to Invoice"
                          >
                            <HiOutlineArrowsRightLeft className="h-4 w-4" />
                          </button>
                        )}
                      </div>
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

      {/* Create Payment Modal */}
      {createOpen && <CreatePaymentModal open={createOpen} onClose={() => setCreateOpen(false)} />}

      {/* Allocate Payment Modal */}
      {allocatePayment && (
        <AllocatePaymentModal
          open={!!allocatePayment}
          onClose={() => setAllocatePayment(null)}
          payment={allocatePayment}
        />
      )}

      {/* View Allocations Modal */}
      {viewPayment && (
        <Modal open={!!viewPayment} onClose={() => setViewPayment(null)} title="Payment Allocations" size="lg">
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div><p className="text-xs text-surface-400">Customer</p><p className="text-sm font-medium text-surface-900 dark:text-white">{viewPayment.customerName}</p></div>
              <div><p className="text-xs text-surface-400">Total Amount</p><p className="text-sm font-bold">{formatCurrency(viewPayment.amount)}</p></div>
              <div><p className="text-xs text-surface-400">Method</p><p className="text-sm font-medium">{viewPayment.paymentMethod}</p></div>
              <div><p className="text-xs text-surface-400">Date</p><p className="text-sm font-medium">{new Date(viewPayment.transactionDate).toLocaleDateString('en-IN')}</p></div>
            </div>

            {viewPayment.allocations.length === 0 ? (
              <EmptyState title="No allocations" description="This payment has not been allocated to any invoices." />
            ) : (
              <div className="table-container">
                <table className="table">
                  <thead><tr><th>Invoice #</th><th>Allocated Amount</th><th>Date</th></tr></thead>
                  <tbody>
                    {viewPayment.allocations.map((alloc) => (
                      <tr key={alloc.allocationId}>
                        <td className="font-medium">{alloc.invoiceNumber}</td>
                        <td>{formatCurrency(alloc.allocatedAmount)}</td>
                        <td>{new Date(alloc.createdAt).toLocaleDateString('en-IN')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

// ─── Invoice Detail Modal ────────────────────────────────────────────────────

function InvoiceDetailModal({
  invoice,
  onClose,
  gstEnabled,
  onGenerateGst,
  generateGstPending,
  onRegenerateInvoice,
  regeneratePending,
  onCancelIrn,
  onCancelEwb,
}: {
  invoice: Invoice;
  onClose: () => void;
  gstEnabled: boolean;
  onGenerateGst: (id: string) => void;
  generateGstPending: boolean;
  onRegenerateInvoice: (id: string) => void;
  regeneratePending: boolean;
  onCancelIrn: (inv: Invoice) => void;
  onCancelEwb: (inv: Invoice) => void;
}) {
  const [showGstDocs, setShowGstDocs] = useState(false);

  // Fetch GST documents when section is expanded
  const { data: gstDocs, isLoading: gstDocsLoading } = useQuery({
    queryKey: ['gst-documents', invoice.invoiceId],
    queryFn: () => apiGet<GstDocumentRecord[]>(`/invoices/${invoice.invoiceId}/gst-documents`),
    enabled: gstEnabled && showGstDocs,
  });

  const isIrnSuccess = invoice.irnStatus === IrnStatus.SUCCESS;
  const isEwbActive = invoice.ewbStatus === EwbStatus.ACTIVE;
  const canGenerateGst = gstEnabled
    && invoice.status !== InvoiceStatus.CANCELLED
    && invoice.irnStatus !== IrnStatus.SUCCESS
    && invoice.irnStatus !== IrnStatus.PENDING;
  const canRegenerate = invoice.orderId
    && invoice.status !== InvoiceStatus.CANCELLED;

  return (
    <Modal open onClose={onClose} title={`Invoice ${invoice.invoiceNumber}`} size="lg">
      <div className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div><p className="text-xs text-surface-400">Customer</p><p className="text-sm font-medium text-surface-900 dark:text-white">{invoice.customerName}</p></div>
          <div><p className="text-xs text-surface-400">Issue Date</p><p className="text-sm font-medium">{new Date(invoice.issueDate).toLocaleDateString('en-IN')}</p></div>
          <div><p className="text-xs text-surface-400">Due Date</p><p className="text-sm font-medium">{new Date(invoice.dueDate).toLocaleDateString('en-IN')}</p></div>
          <div><p className="text-xs text-surface-400">Status</p><Badge variant={INVOICE_STATUS_VARIANTS[invoice.status] || 'neutral'}>{invoice.status}</Badge></div>
        </div>

        <div className="table-container">
          <table className="table">
            <thead><tr><th>Description</th><th>HSN</th><th>Qty</th><th>Unit Price</th><th>GST%</th><th>Total</th></tr></thead>
            <tbody>
              {invoice.items.map((item) => (
                <tr key={item.invoiceItemId}>
                  <td>{item.description}</td>
                  <td>{item.hsnCode}</td>
                  <td>{item.quantity}</td>
                  <td>{formatCurrency(item.unitPrice)}</td>
                  <td>{item.gstRate}%</td>
                  <td className="font-medium">{formatCurrency(item.totalPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-surface-200 dark:border-surface-700">
          <div><p className="text-xs text-surface-400">CGST</p><p className="font-medium">{formatCurrency(invoice.cgstValue)}</p></div>
          <div><p className="text-xs text-surface-400">SGST</p><p className="font-medium">{formatCurrency(invoice.sgstValue)}</p></div>
          <div><p className="text-xs text-surface-400">IGST</p><p className="font-medium">{formatCurrency(invoice.igstValue)}</p></div>
          {/* WI-066: invoice.totalAmount is the GST-inclusive grand
              total (matches what the customer pays). The WI-064
              'excl. GST' label was an interim workaround for the
              now-fixed reissue unit-mismatch bug. */}
          <div>
            <p className="text-xs text-surface-400">Total Amount</p>
            <p className="font-bold text-lg">{formatCurrency(invoice.totalAmount)}</p>
          </div>
        </div>

        {/* GST Details - only shown when GST is enabled */}
        {gstEnabled && (
          <>
            {/* IRN / AckNo / EWB info */}
            {(invoice.irn || invoice.ackNo || isEwbActive) && (
              <div className="space-y-2 p-3 bg-accent-50 dark:bg-accent-500/10 rounded-xl">
                {invoice.irn && (
                  <div>
                    <p className="text-xs text-surface-400">IRN</p>
                    <p className="text-xs font-mono break-all text-surface-700 dark:text-surface-300">{invoice.irn}</p>
                  </div>
                )}
                {invoice.ackNo && (
                  <div>
                    <p className="text-xs text-surface-400">Acknowledgement No.</p>
                    <p className="text-sm font-medium text-surface-700 dark:text-surface-300">{invoice.ackNo}</p>
                    {invoice.ackDate && (
                      <p className="text-xs text-surface-400 mt-0.5">Ack Date: {new Date(invoice.ackDate).toLocaleDateString('en-IN')}</p>
                    )}
                  </div>
                )}
                <div className="flex items-center gap-4">
                  <div>
                    <p className="text-xs text-surface-400">IRN Status</p>
                    <Badge variant={IRN_VARIANTS[invoice.irnStatus] || 'neutral'}>{invoice.irnStatus.replace(/_/g, ' ')}</Badge>
                  </div>
                  <div>
                    <p className="text-xs text-surface-400">EWB Status</p>
                    <Badge variant={EWB_VARIANTS[invoice.ewbStatus] || 'neutral'}>{invoice.ewbStatus.replace(/_/g, ' ')}</Badge>
                  </div>
                </div>
              </div>
            )}

            {/* GST Action Buttons */}
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-surface-200 dark:border-surface-700">
              {canGenerateGst && (
                <Button
                  size="sm"
                  variant="accent"
                  onClick={() => onGenerateGst(invoice.invoiceId)}
                  loading={generateGstPending}
                >
                  <HiOutlineShieldCheck className="h-4 w-4 mr-1" />
                  Generate GST
                </Button>
              )}
              {isIrnSuccess && (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => onCancelIrn(invoice)}
                >
                  <HiOutlineXCircle className="h-4 w-4 mr-1" />
                  Cancel IRN
                </Button>
              )}
              {isEwbActive && (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => onCancelEwb(invoice)}
                >
                  <HiOutlineXCircle className="h-4 w-4 mr-1" />
                  Cancel EWB
                </Button>
              )}
              {canRegenerate && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onRegenerateInvoice(invoice.invoiceId)}
                  loading={regeneratePending}
                >
                  <HiOutlineArrowPath className="h-4 w-4 mr-1" />
                  Regenerate Invoice
                </Button>
              )}
            </div>

            {/* WI-039: Credit / Debit Notes section. Approve/Reject are
                only visible to admins; finance can raise notes but not
                approve them. Approved CN/DN expose a Download PDF link. */}
            <InvoiceNotesSection invoiceId={invoice.invoiceId} />

            {/* View GST Documents expandable section */}
            <div className="border-t border-surface-200 dark:border-surface-700 pt-2">
              <button
                type="button"
                onClick={() => setShowGstDocs(!showGstDocs)}
                className="flex items-center gap-1.5 text-sm font-medium text-brand-500 hover:text-brand-600"
              >
                <HiOutlineDocumentText className="h-4 w-4" />
                {showGstDocs ? 'Hide' : 'View'} GST Documents
              </button>

              {showGstDocs && (
                <div className="mt-3">
                  {gstDocsLoading ? (
                    <div className="flex justify-center py-4"><Loader size="sm" /></div>
                  ) : !gstDocs || gstDocs.length === 0 ? (
                    <p className="text-sm text-surface-400 py-2">No GST documents found for this invoice.</p>
                  ) : (
                    <div className="space-y-2">
                      {gstDocs.map((doc) => (
                        <div key={doc.id} className={cn(
                          'p-3 rounded-lg border text-sm',
                          doc.isLatest
                            ? 'border-brand-200 dark:border-brand-500/30 bg-brand-50 dark:bg-brand-500/5'
                            : 'border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/50',
                        )}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-medium text-surface-900 dark:text-white">
                              {doc.docType} {doc.gstDocNo && `- ${doc.gstDocNo}`}
                            </span>
                            <div className="flex items-center gap-2">
                              {doc.isLatest && <Badge variant="info">Latest</Badge>}
                              <Badge variant={IRN_VARIANTS[doc.irnStatus] || 'neutral'}>IRN: {doc.irnStatus}</Badge>
                              <Badge variant={EWB_VARIANTS[doc.ewbStatus] || 'neutral'}>EWB: {doc.ewbStatus}</Badge>
                            </div>
                          </div>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-surface-500 dark:text-surface-400">
                            {doc.irn && <div><span className="text-surface-400">IRN:</span> <span className="font-mono break-all">{doc.irn.slice(0, 20)}...</span></div>}
                            {doc.ackNo && <div><span className="text-surface-400">AckNo:</span> {doc.ackNo}</div>}
                            {doc.ewbNo && <div><span className="text-surface-400">EWB:</span> {doc.ewbNo}</div>}
                            {doc.ewbValidTill && <div><span className="text-surface-400">Valid Till:</span> {new Date(doc.ewbValidTill).toLocaleDateString('en-IN')}</div>}
                          </div>
                          {doc.errorMessage && (
                            <p className="mt-1 text-xs text-red-500">{doc.errorCode}: {doc.errorMessage}</p>
                          )}
                          <p className="text-xs text-surface-400 mt-1">Created: {new Date(doc.createdAt).toLocaleString('en-IN')}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ─── Invoice Notes Section (WI-039) ─────────────────────────────────────────
// Lists credit + debit notes raised against an invoice. Admins see
// Approve / Reject on pending notes; approved notes expose a Download PDF
// link.  Finance can see + raise notes (the raise modals are wired by
// the parent BillingPaymentsPage), but cannot approve.

type CreditNoteRow = {
  creditNoteId: string;
  creditNoteNumber: string | null;
  totalAmount: number;
  reason: string;
  status: string; // 'pending' | 'approved' | 'rejected' | 'issued' | 'cancelled'
  approvedBy: string | null;
  approvedAt: string | null;
  issueDate: string | null;
  createdAt: string;
};

type DebitNoteRow = {
  debitNoteId: string;
  debitNoteNumber: string | null;
  totalAmount: number;
  reason: string;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
  issueDate: string | null;
  createdAt: string;
};

const NOTE_STATUS_VARIANTS: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  pending: 'warning',
  approved: 'success',
  issued: 'success',
  rejected: 'danger',
  cancelled: 'danger',
};

function InvoiceNotesSection({ invoiceId }: { invoiceId: string }) {
  const queryClient = useQueryClient();
  const role = useAuthStore(selectRole);
  const canApprove = role === UserRole.SUPER_ADMIN || role === UserRole.DISTRIBUTOR_ADMIN;
  const [open, setOpen] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<{ kind: 'cn' | 'dn'; id: string; number: string | null } | null>(null);

  const { data: cnData } = useQuery({
    queryKey: ['invoice-credit-notes', invoiceId],
    queryFn: () => apiGet<{ creditNotes: CreditNoteRow[] }>(`/invoices/${invoiceId}/credit-notes`),
    enabled: open,
  });
  const { data: dnData } = useQuery({
    queryKey: ['invoice-debit-notes', invoiceId],
    queryFn: () => apiGet<{ debitNotes: DebitNoteRow[] }>(`/invoices/${invoiceId}/debit-notes`),
    enabled: open,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['invoice-credit-notes', invoiceId] });
    queryClient.invalidateQueries({ queryKey: ['invoice-debit-notes', invoiceId] });
    queryClient.invalidateQueries({ queryKey: ['invoices'] });
  };

  const approveCn = useMutation({
    mutationFn: (id: string) => apiPut(`/invoices/credit-notes/${id}/approve`),
    onSuccess: () => { toast.success('Credit note approved'); refresh(); },
    onError: (e) => toast.error(getErrorMessage(e)),
  });
  const approveDn = useMutation({
    mutationFn: (id: string) => apiPut(`/invoices/debit-notes/${id}/approve`),
    onSuccess: () => { toast.success('Debit note approved'); refresh(); },
    onError: (e) => toast.error(getErrorMessage(e)),
  });
  const rejectCn = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiPut(`/invoices/credit-notes/${id}/reject`, { reason }),
    onSuccess: () => { toast.success('Credit note rejected'); setRejectTarget(null); refresh(); },
    onError: (e) => toast.error(getErrorMessage(e)),
  });
  const rejectDn = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiPut(`/invoices/debit-notes/${id}/reject`, { reason }),
    onSuccess: () => { toast.success('Debit note rejected'); setRejectTarget(null); refresh(); },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const cns = cnData?.creditNotes ?? [];
  const dns = dnData?.debitNotes ?? [];
  const total = cns.length + dns.length;

  const downloadNotePdf = async (kind: 'cn' | 'dn', id: string, number: string | null) => {
    try {
      const path = kind === 'cn'
        ? `/invoices/credit-notes/${id}/pdf`
        : `/invoices/debit-notes/${id}/pdf`;
      const resp = await api.get(path, { responseType: 'blob' });
      const url = window.URL.createObjectURL(resp.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${kind === 'cn' ? 'credit-note' : 'debit-note'}-${number ?? id.slice(0, 8)}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  return (
    <div className="border-t border-surface-200 dark:border-surface-700 pt-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-sm font-medium text-brand-500 hover:text-brand-600"
      >
        <HiOutlineDocumentText className="h-4 w-4" />
        {open ? 'Hide' : 'View'} Credit / Debit Notes
        {open ? '' : total > 0 ? ` (${total})` : ''}
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <NoteList
            title="Credit Notes"
            emptyText="No credit notes raised on this invoice."
            rows={cns.map((cn) => ({
              kind: 'cn' as const,
              id: cn.creditNoteId,
              number: cn.creditNoteNumber,
              amount: cn.totalAmount,
              reason: cn.reason,
              status: cn.status,
              createdAt: cn.createdAt,
            }))}
            canApprove={canApprove}
            onApprove={(id) => approveCn.mutate(id)}
            onReject={(id, number) => setRejectTarget({ kind: 'cn', id, number })}
            onDownload={(id, number) => downloadNotePdf('cn', id, number)}
            approving={approveCn.isPending}
          />
          <NoteList
            title="Debit Notes"
            emptyText="No debit notes raised on this invoice."
            rows={dns.map((dn) => ({
              kind: 'dn' as const,
              id: dn.debitNoteId,
              number: dn.debitNoteNumber,
              amount: dn.totalAmount,
              reason: dn.reason,
              status: dn.status,
              createdAt: dn.createdAt,
            }))}
            canApprove={canApprove}
            onApprove={(id) => approveDn.mutate(id)}
            onReject={(id, number) => setRejectTarget({ kind: 'dn', id, number })}
            onDownload={(id, number) => downloadNotePdf('dn', id, number)}
            approving={approveDn.isPending}
          />
        </div>
      )}

      {rejectTarget && (
        <RejectNoteModal
          target={rejectTarget}
          onClose={() => setRejectTarget(null)}
          onSubmit={(reason) => {
            if (rejectTarget.kind === 'cn') rejectCn.mutate({ id: rejectTarget.id, reason });
            else rejectDn.mutate({ id: rejectTarget.id, reason });
          }}
          submitting={rejectCn.isPending || rejectDn.isPending}
        />
      )}
    </div>
  );
}

type NoteRow = {
  kind: 'cn' | 'dn';
  id: string;
  number: string | null;
  amount: number;
  reason: string;
  status: string;
  createdAt: string;
};

function NoteList({
  title, emptyText, rows, canApprove, onApprove, onReject, onDownload, approving,
}: {
  title: string;
  emptyText: string;
  rows: NoteRow[];
  canApprove: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string, number: string | null) => void;
  onDownload: (id: string, number: string | null) => void;
  approving: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-surface-500 dark:text-surface-400">
        {title}
      </h4>
      {rows.length === 0 ? (
        <p className="text-sm text-surface-400 py-1">{emptyText}</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => {
            const isPending = r.status === 'pending';
            const isApproved = r.status === 'approved' || r.status === 'issued';
            return (
              <div key={r.id} className="rounded-lg border border-surface-200 dark:border-surface-700 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-mono font-medium text-surface-900 dark:text-white">
                    {r.number ?? r.id.slice(0, 8)}
                    <span className="ml-2 text-surface-500 dark:text-surface-400 font-sans font-normal">
                      ₹{Number(r.amount ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={NOTE_STATUS_VARIANTS[r.status] || 'neutral'}>
                      {r.status.replace(/_/g, ' ')}
                    </Badge>
                    {isApproved && (
                      <button
                        type="button"
                        onClick={() => onDownload(r.id, r.number)}
                        className="text-xs text-brand-500 hover:text-brand-600 underline-offset-2 hover:underline"
                      >
                        Download PDF
                      </button>
                    )}
                    {canApprove && isPending && (
                      <>
                        <Button size="sm" variant="accent" onClick={() => onApprove(r.id)} loading={approving}>
                          Approve
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => onReject(r.id, r.number)}>
                          Reject
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                {r.reason && (
                  <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">
                    {r.reason}
                  </p>
                )}
                <p className="mt-1 text-xs text-surface-400">
                  Created: {new Date(r.createdAt).toLocaleString('en-IN')}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RejectNoteModal({
  target, onClose, onSubmit, submitting,
}: {
  target: { kind: 'cn' | 'dn'; id: string; number: string | null };
  onClose: () => void;
  onSubmit: (reason: string) => void;
  submitting: boolean;
}) {
  const [reason, setReason] = useState('');
  const noun = target.kind === 'cn' ? 'Credit Note' : 'Debit Note';
  return (
    <Modal
      open
      onClose={onClose}
      title={`Reject ${noun} ${target.number ?? ''}`.trim()}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!reason.trim()) { toast.error('Please enter a reason'); return; }
          onSubmit(reason.trim());
        }}
        className="space-y-4"
      >
        <p className="text-sm text-surface-500 dark:text-surface-400">
          The reason is recorded in the audit log. The {noun.toLowerCase()} will be
          marked as rejected and the original invoice is left unchanged.
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={500}
          placeholder="Reason for rejection"
          className="input w-full"
          required
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={submitting}>
            Reject
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Cancel GST Modal (IRN / EWB) ──────────────────────────────────────────

function CancelGstModal({ open, onClose, invoice, type }: { open: boolean; onClose: () => void; invoice: Invoice; type: 'irn' | 'ewb' }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: (data: { reason: string }) =>
      apiPost(`/invoices/${invoice.invoiceId}/cancel-${type}`, data),
    onSuccess: () => {
      toast.success(type === 'irn' ? 'IRN cancelled successfully' : 'E-Way Bill cancelled successfully');
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) { toast.error('Please enter a reason'); return; }
    mutation.mutate({ reason: reason.trim() });
  };

  return (
    <Modal open={open} onClose={onClose} title={`Cancel ${type === 'irn' ? 'IRN' : 'E-Way Bill'} for ${invoice.invoiceNumber}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-surface-500 dark:text-surface-400">
          This action will cancel the {type === 'irn' ? 'Invoice Registration Number (IRN)' : 'E-Way Bill'} on the GST portal. This cannot be undone.
        </p>
        <Input
          label="Reason for cancellation"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Enter reason (required)"
          required
        />
        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Go Back</Button>
          <Button type="submit" variant="danger" loading={mutation.isPending}>
            Cancel {type === 'irn' ? 'IRN' : 'EWB'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Credit Note Modal ──────────────────────────────────────────────────────

/**
 * WI-055: Credit Note modal is amount-based.
 *
 * Replaces the prior cylinder-type × quantity × price × GST grid with a
 * single Reason + Amount + Note. The finance team almost always just
 * wants to credit a specific rupee figure for a stated reason; the
 * item-grid abstraction created reconstruction errors and slowed entry.
 *
 * Bounded: amount ≤ invoice.totalAmount (service enforces too).
 */
function CreditNoteModal({ open, onClose, invoice }: { open: boolean; onClose: () => void; invoice: Invoice }) {
  const queryClient = useQueryClient();
  const invoiceTotal = Number(invoice.totalAmount ?? 0);
  const { register, handleSubmit, formState: { errors } } = useForm<CreateCreditNoteInput>({
    resolver: zodResolver(createCreditNoteSchema),
    defaultValues: { invoiceId: invoice.invoiceId, reason: '', amount: 0, note: '' },
  });

  const mutation = useMutation({
    mutationFn: (data: CreateCreditNoteInput) => apiPost('/invoices/credit-notes', data),
    onSuccess: () => { toast.success('Credit note created'); queryClient.invalidateQueries({ queryKey: ['invoices'] }); onClose(); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  return (
    <Modal open={open} onClose={onClose} title={`Credit Note — ${invoice.invoiceNumber}`} size="md">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <input type="hidden" {...register('invoiceId')} />
        <Input
          label="Reason"
          required
          placeholder="e.g. Price correction, returned cylinders, billing error"
          error={errors.reason?.message}
          {...register('reason')}
        />
        <div>
          <Input
            label="Credit Amount (₹)"
            type="number"
            step="0.01"
            min={0.01}
            max={invoiceTotal}
            required
            error={errors.amount?.message}
            {...register('amount', { valueAsNumber: true })}
          />
          <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">
            Invoice total: ₹{invoiceTotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
        </div>
        <div>
          <label className="label">Note <span className="text-xs text-surface-400">(optional)</span></label>
          <textarea
            rows={3}
            placeholder="Additional details for the customer"
            maxLength={500}
            className="w-full rounded-md border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-800 p-2 text-sm"
            {...register('note')}
          />
          {errors.note?.message && (
            <p className="mt-1 text-xs text-red-500">{errors.note.message}</p>
          )}
        </div>
        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>Create Credit Note</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Debit Note Modal ───────────────────────────────────────────────────────

/**
 * WI-055: Debit Note modal is amount-based.
 *
 * Mirrors CreditNoteModal but with NO upper bound — debit notes can
 * legitimately exceed the original invoice total (surcharges, delivery
 * fees, fuel adjustments).
 */
function DebitNoteModal({ open, onClose, invoice }: { open: boolean; onClose: () => void; invoice: Invoice }) {
  const queryClient = useQueryClient();
  const invoiceTotal = Number(invoice.totalAmount ?? 0);
  const { register, handleSubmit, formState: { errors } } = useForm<CreateDebitNoteInput>({
    resolver: zodResolver(createDebitNoteSchema),
    defaultValues: { invoiceId: invoice.invoiceId, reason: '', amount: 0, note: '' },
  });

  const mutation = useMutation({
    // WI-055: fix a pre-existing URL bug — DN create route lives under
    // /api/invoices/debit-notes (same prefix as CN), not /api/debit-notes.
    mutationFn: (data: CreateDebitNoteInput) => apiPost('/invoices/debit-notes', data),
    onSuccess: () => { toast.success('Debit note created'); queryClient.invalidateQueries({ queryKey: ['invoices'] }); onClose(); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  return (
    <Modal open={open} onClose={onClose} title={`Debit Note — ${invoice.invoiceNumber}`} size="md">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <input type="hidden" {...register('invoiceId')} />
        <Input
          label="Reason"
          required
          placeholder="e.g. Delivery surcharge, fuel adjustment, post-billing correction"
          error={errors.reason?.message}
          {...register('reason')}
        />
        <div>
          <Input
            label="Debit Amount (₹)"
            type="number"
            step="0.01"
            min={0.01}
            required
            error={errors.amount?.message}
            {...register('amount', { valueAsNumber: true })}
          />
          <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">
            Invoice total: ₹{invoiceTotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            <span className="ml-2 text-surface-400">(debits can exceed this)</span>
          </p>
        </div>
        <div>
          <label className="label">Note <span className="text-xs text-surface-400">(optional)</span></label>
          <textarea
            rows={3}
            placeholder="Additional details for the customer"
            maxLength={500}
            className="w-full rounded-md border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-800 p-2 text-sm"
            {...register('note')}
          />
          {errors.note?.message && (
            <p className="mt-1 text-xs text-red-500">{errors.note.message}</p>
          )}
        </div>
        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>Create Debit Note</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Pay Invoice Modal ───────────────────────────────────────────────────────

function PayInvoiceModal({ open, onClose, invoice }: { open: boolean; onClose: () => void; invoice: Invoice }) {
  const queryClient = useQueryClient();
  const { register, handleSubmit, formState: { errors } } = useForm({
    defaultValues: {
      customerId: invoice.customerId || '',
      amount: invoice.outstandingAmount,
      paymentMethod: PaymentMethod.CASH as string,
      referenceNumber: '',
      transactionDate: new Date().toISOString().split('T')[0],
    },
  });

  const mutation = useMutation({
    mutationFn: (data: { customerId: string; amount: number; paymentMethod: string; referenceNumber?: string; transactionDate: string }) =>
      apiPost('/payments', {
        ...data,
        allocations: [{ invoiceId: invoice.invoiceId, amount: data.amount }],
      }),
    onSuccess: () => {
      toast.success('Payment recorded');
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const methodOptions = Object.values(PaymentMethod).map((m) => ({ value: m, label: m.replace(/_/g, ' ') }));

  return (
    <Modal open={open} onClose={onClose} title={`Payment for ${invoice.invoiceNumber}`}>
      <form onSubmit={handleSubmit((data) => mutation.mutate({ ...data, amount: Number(data.amount) }))} className="space-y-4">
        <div className="p-3 bg-surface-50 dark:bg-surface-800/50 rounded-xl">
          <p className="text-xs text-surface-400">Outstanding Amount</p>
          <p className="font-bold text-lg text-surface-900 dark:text-white">{formatCurrency(invoice.outstandingAmount)}</p>
        </div>
        <Input label="Amount" type="number" step="0.01" required error={errors.amount?.message} {...register('amount', { valueAsNumber: true })} />
        <Select label="Payment Method" options={methodOptions} required error={errors.paymentMethod?.message} {...register('paymentMethod')} />
        <Input label="Reference Number" placeholder="Optional" {...register('referenceNumber')} />
        <Input label="Transaction Date" type="date" required error={errors.transactionDate?.message} {...register('transactionDate')} />
        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending} variant="accent">Record Payment</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Create Payment Modal ───────────────────────────────────────────────────

function CreatePaymentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [selectedCustomerId, setSelectedCustomerId] = useState('');

  const { data: customers } = useQuery({
    queryKey: ['customers-list'],
    queryFn: () => apiGet<{ customers: Customer[] }>('/customers', { pageSize: 100 }),
    staleTime: 5 * 60 * 1000,
  });

  const { data: customerInvoices } = useQuery({
    queryKey: ['customer-unpaid-invoices', selectedCustomerId],
    queryFn: () => apiGet<{ invoices: Invoice[] }>('/invoices', { customerId: selectedCustomerId, status: 'issued', pageSize: 50 }),
    enabled: !!selectedCustomerId,
  });

  const { register, handleSubmit, control, formState: { errors } } = useForm<CreatePaymentInput>({
    resolver: zodResolver(createPaymentSchema),
    defaultValues: {
      customerId: '',
      amount: 0,
      paymentMethod: PaymentMethod.CASH,
      referenceNumber: '',
      transactionDate: new Date().toISOString().split('T')[0],
      allocations: [],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'allocations' });

  const mutation = useMutation({
    mutationFn: (data: CreatePaymentInput) => apiPost('/payments', data),
    onSuccess: () => {
      toast.success('Payment recorded');
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const customerOptions = (customers?.customers ?? []).map((c) => ({ value: c.customerId, label: c.customerName }));
  const methodOptions = Object.values(PaymentMethod).map((m) => ({ value: m, label: m.replace(/_/g, ' ') }));
  const unpaidInvoices = customerInvoices?.invoices ?? [];
  const invoiceOptions = unpaidInvoices.map((inv) => ({ value: inv.invoiceId, label: `${inv.invoiceNumber} (${formatCurrency(inv.outstandingAmount)})` }));

  return (
    <Modal open={open} onClose={onClose} title="Record Payment" size="lg">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <Select
          label="Customer"
          options={customerOptions}
          placeholder="Select customer"
          required
          error={errors.customerId?.message}
          {...register('customerId', {
            onChange: (e) => setSelectedCustomerId(e.target.value),
          })}
        />

        <div className="grid grid-cols-2 gap-4">
          <Input label="Amount" type="number" step="0.01" required error={errors.amount?.message} {...register('amount', { valueAsNumber: true })} />
          <Select label="Payment Method" options={methodOptions} required error={errors.paymentMethod?.message} {...register('paymentMethod')} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Input label="Reference Number" placeholder="Optional" {...register('referenceNumber')} />
          <Input label="Transaction Date" type="date" required error={errors.transactionDate?.message} {...register('transactionDate')} />
        </div>

        {/* Invoice Allocations */}
        {selectedCustomerId && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="label mb-0">Invoice Allocations (Optional)</label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => append({ invoiceId: '', amount: 0 })}
                disabled={invoiceOptions.length === 0}
              >
                <HiOutlinePlus className="h-3 w-3" />Add Allocation
              </Button>
            </div>
            {fields.map((field, index) => (
              <div key={field.id} className="flex items-start gap-2 mb-2">
                <div className="flex-1">
                  <Select options={invoiceOptions} placeholder="Select invoice" {...register(`allocations.${index}.invoiceId`)} />
                </div>
                <div className="w-32">
                  <Input type="number" step="0.01" placeholder="Amount" {...register(`allocations.${index}.amount`, { valueAsNumber: true })} />
                </div>
                <button type="button" onClick={() => remove(index)} className="mt-1 p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg">
                  <HiOutlineTrash className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>Record Payment</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Allocate Payment Modal (WI-092) ────────────────────────────────────────
// Applies an unallocated (or partially allocated) payment to an open invoice
// for the same customer. The server enforces tenant + customer + amount caps.

function AllocatePaymentModal({ open, onClose, payment }: { open: boolean; onClose: () => void; payment: Payment }) {
  const queryClient = useQueryClient();
  const [invoiceId, setInvoiceId] = useState('');
  const [amount, setAmount] = useState<number>(0);

  const { data: invoiceData, isLoading } = useQuery({
    queryKey: ['customer-open-invoices', payment.customerId],
    queryFn: () => apiGet<{ invoices: Invoice[] }>('/invoices', { customerId: payment.customerId, pageSize: 100 }),
  });

  const openInvoices = (invoiceData?.invoices ?? []).filter(
    (inv) => (inv.status === InvoiceStatus.ISSUED || inv.status === InvoiceStatus.PARTIALLY_PAID) && inv.outstandingAmount > 0,
  );
  const invoiceOptions = openInvoices.map((inv) => ({
    value: inv.invoiceId,
    label: `${inv.invoiceNumber} (${formatCurrency(inv.outstandingAmount)} due)`,
  }));

  const selectedInvoice = openInvoices.find((inv) => inv.invoiceId === invoiceId) ?? null;
  const maxAmount = selectedInvoice
    ? Math.min(payment.unallocatedAmount, selectedInvoice.outstandingAmount)
    : payment.unallocatedAmount;

  const handleSelectInvoice = (id: string) => {
    setInvoiceId(id);
    const inv = openInvoices.find((i) => i.invoiceId === id);
    setAmount(inv ? Math.min(payment.unallocatedAmount, inv.outstandingAmount) : 0);
  };

  const mutation = useMutation({
    mutationFn: () => apiPost(`/payments/${payment.paymentId}/allocate`, { invoiceId, amount: Number(amount) }),
    onSuccess: () => {
      toast.success('Payment allocated');
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!invoiceId) { toast.error('Select an invoice'); return; }
    if (!(amount > 0)) { toast.error('Enter an amount greater than zero'); return; }
    if (amount > maxAmount + 0.001) { toast.error('Amount exceeds the allowable allocation'); return; }
    mutation.mutate();
  };

  return (
    <Modal open={open} onClose={onClose} title={`Allocate Payment — ${payment.customerName}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="p-3 bg-surface-50 dark:bg-surface-800/50 rounded-xl">
          <p className="text-xs text-surface-400">Unallocated Amount</p>
          <p className="font-bold text-lg text-surface-900 dark:text-white">{formatCurrency(payment.unallocatedAmount)}</p>
        </div>
        {isLoading ? (
          <div className="flex justify-center py-6"><Loader /></div>
        ) : invoiceOptions.length === 0 ? (
          <EmptyState title="No open invoices" description="This customer has no invoices with an outstanding balance." />
        ) : (
          <>
            <Select
              label="Invoice"
              options={invoiceOptions}
              placeholder="Select invoice"
              value={invoiceId}
              onChange={(e) => handleSelectInvoice(e.target.value)}
              required
            />
            <div>
              <Input
                label="Amount"
                type="number"
                step="0.01"
                min={0.01}
                max={maxAmount}
                value={amount}
                onChange={(e) => setAmount(e.target.valueAsNumber || 0)}
                required
              />
              {selectedInvoice && (
                <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">
                  Max allocatable: {formatCurrency(maxAmount)} (invoice outstanding {formatCurrency(selectedInvoice.outstandingAmount)})
                </p>
              )}
            </div>
            <div className="flex justify-end gap-3 pt-4">
              <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
              <Button type="submit" variant="accent" loading={mutation.isPending}>Allocate</Button>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}
