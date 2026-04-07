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
} from 'react-icons/hi2';
import {
  type Invoice,
  type PaginationMeta,
  type CylinderType,
  type DistributorSettings,
  InvoiceStatus,
  IrnStatus,
  EwbStatus,
  GstMode,
  createCreditNoteSchema,
  type CreateCreditNoteInput,
  createDebitNoteSchema,
  type CreateDebitNoteInput,
  PaymentMethod,
} from '@gaslink/shared';
import { api, apiGet, apiPost, getErrorMessage } from '@/lib/api';
import { Button, Input, Select, Modal, Badge, Loader, EmptyState } from '@/components/ui';
import { cn } from '@/lib/cn';

const STATUS_VARIANTS: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
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

export default function InvoicesPage() {
  const queryClient = useQueryClient();
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

  // Check if distributor has GST enabled
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => apiGet<DistributorSettings>('/settings'),
    staleTime: 5 * 60 * 1000,
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

  const { data: cylinderTypes } = useQuery({
    queryKey: ['cylinder-types'],
    queryFn: () => apiGet<{ cylinderTypes: CylinderType[] }>('/cylinder-types'),
    select: (data) => data.cylinderTypes,
    staleTime: 10 * 60 * 1000,
  });

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
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Invoices</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">Manage invoices and billing</p>
        </div>
      </div>

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
                    <td className="font-medium text-surface-900 dark:text-white">{inv.invoiceNumber}</td>
                    <td>{inv.customerName || 'N/A'}</td>
                    <td>{new Date(inv.issueDate).toLocaleDateString('en-IN')}</td>
                    <td>{new Date(inv.dueDate).toLocaleDateString('en-IN')}</td>
                    <td className="font-medium">{formatCurrency(inv.totalAmount)}</td>
                    <td className={cn('font-medium', inv.outstandingAmount > 0 && 'text-red-500')}>
                      {formatCurrency(inv.outstandingAmount)}
                    </td>
                    <td><Badge variant={STATUS_VARIANTS[inv.status] || 'neutral'}>{inv.status.replace(/_/g, ' ')}</Badge></td>
                    {gstEnabled && (
                      <td><Badge variant={IRN_VARIANTS[inv.irnStatus] || 'neutral'}>{inv.irnStatus.replace(/_/g, ' ')}</Badge></td>
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
                            <button onClick={() => setCreditNoteInvoice(inv)} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-flame-500" title="Credit Note">
                              <HiOutlineMinusCircle className="h-4 w-4" />
                            </button>
                            <button onClick={() => setDebitNoteInvoice(inv)} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-red-500" title="Debit Note">
                              <HiOutlinePlusCircle className="h-4 w-4" />
                            </button>
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

      {/* Credit Note Modal */}
      {creditNoteInvoice && (
        <CreditNoteModal
          open={!!creditNoteInvoice}
          onClose={() => setCreditNoteInvoice(null)}
          invoice={creditNoteInvoice}
          cylinderTypes={cylinderTypes ?? []}
        />
      )}

      {/* Debit Note Modal */}
      {debitNoteInvoice && (
        <DebitNoteModal
          open={!!debitNoteInvoice}
          onClose={() => setDebitNoteInvoice(null)}
          invoice={debitNoteInvoice}
          cylinderTypes={cylinderTypes ?? []}
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
    </div>
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
          <div><p className="text-xs text-surface-400">Status</p><Badge variant={STATUS_VARIANTS[invoice.status] || 'neutral'}>{invoice.status}</Badge></div>
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
          <div><p className="text-xs text-surface-400">Total Amount</p><p className="font-bold text-lg">{formatCurrency(invoice.totalAmount)}</p></div>
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

function CreditNoteModal({ open, onClose, invoice, cylinderTypes }: { open: boolean; onClose: () => void; invoice: Invoice; cylinderTypes: CylinderType[] }) {
  const queryClient = useQueryClient();
  const { register, handleSubmit, control, formState: { errors } } = useForm<CreateCreditNoteInput>({
    resolver: zodResolver(createCreditNoteSchema),
    defaultValues: { invoiceId: invoice.invoiceId, reason: '', items: [{ cylinderTypeId: '', quantity: 1, unitPrice: 0, gstRate: 18 }] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'items' });

  const mutation = useMutation({
    mutationFn: (data: CreateCreditNoteInput) => apiPost('/invoices/credit-notes', data),
    onSuccess: () => { toast.success('Credit note created'); queryClient.invalidateQueries({ queryKey: ['invoices'] }); onClose(); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const cylinderOptions = cylinderTypes.map((ct) => ({ value: ct.cylinderTypeId, label: ct.typeName }));

  return (
    <Modal open={open} onClose={onClose} title={`Credit Note for ${invoice.invoiceNumber}`} size="lg">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <input type="hidden" {...register('invoiceId')} />
        <Input label="Reason" required error={errors.reason?.message} {...register('reason')} />
        <div>
          <label className="label">Items</label>
          {fields.map((field, index) => (
            <div key={field.id} className="grid grid-cols-4 gap-2 mb-2">
              <Select options={cylinderOptions} placeholder="Type" required {...register(`items.${index}.cylinderTypeId`)} />
              <Input type="number" placeholder="Qty" required {...register(`items.${index}.quantity`, { valueAsNumber: true })} />
              <Input type="number" placeholder="Price" step="0.01" required {...register(`items.${index}.unitPrice`, { valueAsNumber: true })} />
              <div className="flex gap-1">
                <Input type="number" placeholder="GST%" required {...register(`items.${index}.gstRate`, { valueAsNumber: true })} />
                {fields.length > 1 && <button type="button" onClick={() => remove(index)} className="p-1 text-red-500"><HiOutlineTrash className="h-4 w-4" /></button>}
              </div>
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" onClick={() => append({ cylinderTypeId: '', quantity: 1, unitPrice: 0, gstRate: 18 })}>
            <HiOutlinePlus className="h-3 w-3" />Add Item
          </Button>
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

function DebitNoteModal({ open, onClose, invoice, cylinderTypes }: { open: boolean; onClose: () => void; invoice: Invoice; cylinderTypes: CylinderType[] }) {
  const queryClient = useQueryClient();
  const { register, handleSubmit, control, formState: { errors } } = useForm<CreateDebitNoteInput>({
    resolver: zodResolver(createDebitNoteSchema),
    defaultValues: { invoiceId: invoice.invoiceId, reason: '', items: [{ cylinderTypeId: '', quantity: 1, unitPrice: 0, gstRate: 18 }] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'items' });

  const mutation = useMutation({
    mutationFn: (data: CreateDebitNoteInput) => apiPost('/debit-notes', data),
    onSuccess: () => { toast.success('Debit note created'); queryClient.invalidateQueries({ queryKey: ['invoices'] }); onClose(); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const cylinderOptions = cylinderTypes.map((ct) => ({ value: ct.cylinderTypeId, label: ct.typeName }));

  return (
    <Modal open={open} onClose={onClose} title={`Debit Note for ${invoice.invoiceNumber}`} size="lg">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <input type="hidden" {...register('invoiceId')} />
        <Input label="Reason" required error={errors.reason?.message} {...register('reason')} />
        <div>
          <label className="label">Items</label>
          {fields.map((field, index) => (
            <div key={field.id} className="grid grid-cols-4 gap-2 mb-2">
              <Select options={cylinderOptions} placeholder="Type" required {...register(`items.${index}.cylinderTypeId`)} />
              <Input type="number" placeholder="Qty" required {...register(`items.${index}.quantity`, { valueAsNumber: true })} />
              <Input type="number" placeholder="Price" step="0.01" required {...register(`items.${index}.unitPrice`, { valueAsNumber: true })} />
              <div className="flex gap-1">
                <Input type="number" placeholder="GST%" required {...register(`items.${index}.gstRate`, { valueAsNumber: true })} />
                {fields.length > 1 && <button type="button" onClick={() => remove(index)} className="p-1 text-red-500"><HiOutlineTrash className="h-4 w-4" /></button>}
              </div>
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" onClick={() => append({ cylinderTypeId: '', quantity: 1, unitPrice: 0, gstRate: 18 })}>
            <HiOutlinePlus className="h-3 w-3" />Add Item
          </Button>
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
  const { register, handleSubmit, formState: { } } = useForm({
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
        <Input label="Amount" type="number" step="0.01" required {...register('amount', { valueAsNumber: true })} />
        <Select label="Payment Method" options={methodOptions} required {...register('paymentMethod')} />
        <Input label="Reference Number" placeholder="Optional" {...register('referenceNumber')} />
        <Input label="Transaction Date" type="date" required {...register('transactionDate')} />
        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending} variant="accent">Record Payment</Button>
        </div>
      </form>
    </Modal>
  );
}
