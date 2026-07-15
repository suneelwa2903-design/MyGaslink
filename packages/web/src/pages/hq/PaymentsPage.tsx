/**
 * Feature A (2026-07-15): HQ portal Payments list.
 *
 * Read-only. Shows every cleared payment across the group, with the
 * property (member customer) and the invoices each payment was
 * allocated against.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { localTodayISO, localDateISO } from '@gaslink/shared';
import { apiGet } from '@/lib/api';
import { Loader, EmptyState, Input, Button } from '@/components/ui';

interface HqProperty { customerId: string; customerName: string; }

interface HqPayment {
  paymentId: string;
  customerId: string;
  customerName: string;
  businessName: string | null;
  amount: number;
  paymentMethod: string;
  transactionDate: string;
  referenceNumber: string | null;
  notes: string | null;
  invoicesApplied: Array<{ invoiceNumber: string | null; amount: number }>;
}

interface HqPaymentsResponse {
  payments: HqPayment[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(n);
}

export default function HqPaymentsPage() {
  const [page, setPage] = useState(1);
  const [customerId, setCustomerId] = useState('');
  const [from, setFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 60);
    return localDateISO(d);
  });
  const [to, setTo] = useState(() => localTodayISO());

  const { data: profile } = useQuery({
    queryKey: ['hq-profile-properties'],
    queryFn: () => apiGet<{ members: HqProperty[] }>('/customer-group-portal/profile'),
    staleTime: 5 * 60 * 1000,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['hq-payments', page, customerId, from, to],
    queryFn: () => apiGet<HqPaymentsResponse>(
      '/customer-group-portal/payments',
      { page, pageSize: 25, customerId: customerId || undefined, from, to },
    ),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Payments</h1>
        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
          All cleared payments across your group properties.
        </p>
      </div>

      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="label" htmlFor="hq-pay-property">Property</label>
            <select
              id="hq-pay-property"
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
          <Input label="From" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
          <Input label="To" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
          <div className="flex items-end">
            <Button
              variant="secondary"
              onClick={() => {
                setCustomerId('');
                const d = new Date(); d.setDate(d.getDate() - 60);
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
      ) : (data?.payments?.length ?? 0) === 0 ? (
        <EmptyState title="No payments in this range" className="py-16" />
      ) : (
        <div className="card">
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Property</th>
                  <th>Amount</th>
                  <th>Method</th>
                  <th>Reference</th>
                  <th>Applied To</th>
                </tr>
              </thead>
              <tbody>
                {data!.payments.map((p) => (
                  <tr key={p.paymentId}>
                    <td>
                      <span className="text-sm text-surface-600 dark:text-surface-400">
                        {new Date(p.transactionDate).toLocaleDateString('en-IN')}
                      </span>
                    </td>
                    <td>
                      <span className="text-sm text-surface-700 dark:text-surface-300">{p.customerName}</span>
                    </td>
                    <td>
                      <span className="font-medium text-surface-900 dark:text-white">{formatCurrency(p.amount)}</span>
                    </td>
                    <td>
                      <span className="text-xs text-surface-500 dark:text-surface-400 uppercase">{p.paymentMethod.replace(/_/g, ' ')}</span>
                    </td>
                    <td>
                      <span className="text-sm text-surface-600 dark:text-surface-400">{p.referenceNumber ?? '—'}</span>
                    </td>
                    <td>
                      <div className="text-xs text-surface-500 dark:text-surface-400 space-y-0.5">
                        {p.invoicesApplied.length === 0 ? (
                          <span>Unallocated</span>
                        ) : (
                          p.invoicesApplied.map((a, i) => (
                            <div key={i}>
                              <span>{a.invoiceNumber ?? '—'}: {formatCurrency(a.amount)}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data?.meta && data.meta.totalPages > 1 && (
            <div className="flex items-center justify-between p-4 border-t border-surface-200 dark:border-surface-700">
              <p className="text-sm text-surface-500 dark:text-surface-400">
                Page {data.meta.page} of {data.meta.totalPages} · {data.meta.total} payments
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
