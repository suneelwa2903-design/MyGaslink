/**
 * Feature A (2026-07-15): HQ portal Invoices list.
 *
 * Read-only. PDF download hits /customer-group-portal/invoices/:id/pdf
 * — ownership is checked server-side before the PDF is generated.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { HiOutlineDocumentArrowDown } from 'react-icons/hi2';
import {
  type Invoice,
  type PaginationMeta,
  invoiceStatusLabel,
  localTodayISO,
  localDateISO,
} from '@gaslink/shared';
import { api, apiGet } from '@/lib/api';
import { Badge, Loader, EmptyState, Input, Button } from '@/components/ui';

interface HqProperty { customerId: string; customerName: string; }

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(n);
}

export default function HqInvoicesPage() {
  const [page, setPage] = useState(1);
  const [customerId, setCustomerId] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 90);
    return localDateISO(d);
  });
  const [to, setTo] = useState(() => localTodayISO());
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const { data: profile } = useQuery({
    queryKey: ['hq-profile-properties'],
    queryFn: () => apiGet<{ members: HqProperty[] }>('/customer-group-portal/profile'),
    staleTime: 5 * 60 * 1000,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['hq-invoices', page, customerId, status, from, to],
    queryFn: () => apiGet<{ invoices: Invoice[]; meta: PaginationMeta }>(
      '/customer-group-portal/invoices',
      { page, pageSize: 25, customerId: customerId || undefined, status: status || undefined, from, to },
    ),
  });

  const handleDownload = async (invoiceId: string, invoiceNumber: string) => {
    setDownloadingId(invoiceId);
    try {
      const resp = await api.get(`/customer-group-portal/invoices/${invoiceId}/pdf`, {
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(resp.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${invoiceNumber}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error('Failed to download invoice PDF');
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Invoices</h1>
        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
          All invoices across your group properties.
        </p>
      </div>

      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div>
            <label className="label" htmlFor="hq-inv-property">Property</label>
            <select
              id="hq-inv-property"
              className="select"
              value={customerId}
              onChange={(e) => { setCustomerId(e.target.value); setPage(1); }}
            >
              <option value="">All properties</option>
              {profile?.members.map((m) => (
                <option key={m.customerId} value={m.customerId}>{m.customerName}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="hq-inv-status">Status</label>
            <select
              id="hq-inv-status"
              className="select"
              value={status}
              onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            >
              <option value="">All statuses</option>
              <option value="issued">Issued</option>
              <option value="partially_paid">Partially Paid</option>
              <option value="paid">Paid</option>
              <option value="overdue">Overdue</option>
            </select>
          </div>
          <Input label="From" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
          <Input label="To" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
          <div className="flex items-end">
            <Button
              variant="secondary"
              onClick={() => {
                setCustomerId(''); setStatus('');
                const d = new Date(); d.setDate(d.getDate() - 90);
                setFrom(localDateISO(d)); setTo(localTodayISO()); setPage(1);
              }}
            >
              Reset
            </Button>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : (data?.invoices?.length ?? 0) === 0 ? (
        <EmptyState title="No invoices match these filters" className="py-16" />
      ) : (
        <div className="card">
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Invoice #</th>
                  <th>Property</th>
                  <th>Issue Date</th>
                  <th>Due Date</th>
                  <th>Amount</th>
                  <th>Outstanding</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data!.invoices.map((inv) => (
                  <tr key={inv.invoiceId}>
                    <td>
                      <span className="font-medium text-surface-900 dark:text-white">{inv.invoiceNumber}</span>
                    </td>
                    <td>
                      <span className="text-sm text-surface-600 dark:text-surface-400">
                        {inv.customerName ?? '—'}
                      </span>
                    </td>
                    <td>
                      <span className="text-sm text-surface-600 dark:text-surface-400">
                        {inv.issueDate ? new Date(inv.issueDate).toLocaleDateString('en-IN') : '—'}
                      </span>
                    </td>
                    <td>
                      <span className="text-sm text-surface-600 dark:text-surface-400">
                        {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString('en-IN') : '—'}
                      </span>
                    </td>
                    <td>
                      <span className="font-medium text-surface-900 dark:text-white">
                        {formatCurrency(inv.totalAmount)}
                      </span>
                    </td>
                    <td>
                      <span className={`font-medium ${(inv.outstandingAmount ?? 0) > 0 ? 'text-flame-600 dark:text-flame-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                        {formatCurrency(inv.outstandingAmount ?? 0)}
                      </span>
                    </td>
                    <td>
                      <Badge variant={
                        inv.status === 'paid' ? 'success' :
                        inv.status === 'overdue' ? 'danger' :
                        inv.status === 'partially_paid' ? 'warning' :
                        'info'
                      }>{invoiceStatusLabel(inv.status)}</Badge>
                    </td>
                    <td>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleDownload(inv.invoiceId, inv.invoiceNumber)}
                        loading={downloadingId === inv.invoiceId}
                      >
                        <HiOutlineDocumentArrowDown className="h-4 w-4" />
                        PDF
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data?.meta && data.meta.totalPages > 1 && (
            <div className="flex items-center justify-between p-4 border-t border-surface-200 dark:border-surface-700">
              <p className="text-sm text-surface-500 dark:text-surface-400">
                Page {data.meta.page} of {data.meta.totalPages} · {data.meta.total} invoices
              </p>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
                  Previous
                </Button>
                <Button variant="secondary" onClick={() => setPage((p) => p + 1)} disabled={page >= data.meta.totalPages}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
