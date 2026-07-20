/**
 * Feature A (2026-07-15): HQ portal consolidated Ledger.
 *
 * Read-only. Shows a merged chronological ledger across all group
 * members, with a Property column. Running balance stays PER-CUSTOMER
 * (see customerGroupPortalService §5D) — never aggregated across the
 * group, because each customer has a different creditPeriodDays clock.
 *
 * Group-statement PDF download hits /customer-group-portal/ledger/pdf
 * — 6-column layout added in Step 7E.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { HiOutlineDocumentArrowDown } from 'react-icons/hi2';
import { localTodayISO, localDateISO } from '@gaslink/shared';
import { api, apiGet } from '@/lib/api';
import { Loader, EmptyState, Input, Button } from '@/components/ui';

interface HqProperty { customerId: string; customerName: string; }

interface HqLedgerRow {
  customerId: string;
  customerName: string;
  orderDate: string;
  cylinderType: string;
  fullCylsDelivered: number;
  amount: number;
  totalAmount: number;
  receivedAmount: number;
  dueAmount: number;
  overDueAmount: number;
  narration: string | null;
  kind: string | null;
}

interface HqLedgerResponse {
  rows: HqLedgerRow[];
  totals: {
    totalDebited: number;
    totalReceived: number;
    netOutstanding: number;
    // 2026-07-20 — period-scoped tiles. See customerGroupPortalService
    // getGroupLedger for the identity guarantee.
    openingBalance: number;
    periodDebited: number;
    periodReceived: number;
    closingBalance: number;
    overdue: number;
  };
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 2,
  }).format(n);
}

export default function HqLedgerPage() {
  const [customerId, setCustomerId] = useState('');
  const [from, setFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 60);
    return localDateISO(d);
  });
  const [to, setTo] = useState(() => localTodayISO());
  const [downloading, setDownloading] = useState(false);

  const { data: profile } = useQuery({
    queryKey: ['hq-profile-properties'],
    queryFn: () => apiGet<{ members: HqProperty[] }>('/customer-group-portal/profile'),
    staleTime: 5 * 60 * 1000,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['hq-ledger', customerId, from, to],
    queryFn: () => apiGet<HqLedgerResponse>(
      '/customer-group-portal/ledger',
      { customerId: customerId || undefined, from, to },
    ),
  });

  const handleDownloadPdf = async () => {
    setDownloading(true);
    try {
      const resp = await api.get('/customer-group-portal/ledger/pdf', {
        params: { customerId: customerId || undefined, from, to },
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(resp.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'group-statement.pdf';
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error('Failed to download group statement');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Ledger</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
            Consolidated ledger across your group. Filter by a single property to see just that one.
          </p>
        </div>
        <Button variant="secondary" onClick={handleDownloadPdf} loading={downloading}>
          <HiOutlineDocumentArrowDown className="h-4 w-4" />
          Download Statement
        </Button>
      </div>

      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="label" htmlFor="hq-ledger-property">Property</label>
            <select
              id="hq-ledger-property"
              className="select"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
            >
              <option value="">All properties</option>
              {profile?.members.map((m) => (
                <option key={m.customerId} value={m.customerId}>{m.customerName}</option>
              ))}
            </select>
          </div>
          <Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <div className="flex items-end">
            <Button
              variant="secondary"
              onClick={() => {
                setCustomerId('');
                const d = new Date(); d.setDate(d.getDate() - 60);
                setFrom(localDateISO(d)); setTo(localTodayISO());
              }}
            >
              Reset
            </Button>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : (
        <>
          {data?.totals && (
            // 2026-07-20 — 5-tile accountant's statement layout:
            // Opening + Debited(period) − Received(period) === Closing.
            // Overdue is a subset of Closing. Tiles reconcile to the
            // visible rows even when the group has pre-range entries.
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              <div className="rounded-lg border border-surface-200 dark:border-surface-700 p-3 bg-white dark:bg-surface-900">
                <p className="text-xs text-surface-500 dark:text-surface-400">Opening Balance</p>
                <p className="text-lg font-semibold mt-1 text-surface-900 dark:text-white">{formatCurrency(data.totals.openingBalance)}</p>
              </div>
              <div className="rounded-lg border border-surface-200 dark:border-surface-700 p-3 bg-white dark:bg-surface-900">
                <p className="text-xs text-surface-500 dark:text-surface-400">Debited (period)</p>
                <p className="text-lg font-semibold mt-1 text-surface-900 dark:text-white">{formatCurrency(data.totals.periodDebited)}</p>
              </div>
              <div className="rounded-lg border border-surface-200 dark:border-surface-700 p-3 bg-white dark:bg-surface-900">
                <p className="text-xs text-surface-500 dark:text-surface-400">Received (period)</p>
                <p className="text-lg font-semibold mt-1 text-emerald-600 dark:text-emerald-400">{formatCurrency(data.totals.periodReceived)}</p>
              </div>
              <div className="rounded-lg border border-brand-500 p-3 bg-brand-500 text-white">
                <p className="text-xs text-white/80">Closing Balance</p>
                <p className="text-lg font-semibold mt-1">{formatCurrency(data.totals.closingBalance)}</p>
              </div>
              <div className={data.totals.overdue > 0
                ? 'rounded-lg border border-flame-500 p-3 bg-flame-500 text-white'
                : 'rounded-lg border border-surface-200 dark:border-surface-700 p-3 bg-white dark:bg-surface-900'
              }>
                <p className={data.totals.overdue > 0 ? 'text-xs text-white/80' : 'text-xs text-surface-500 dark:text-surface-400'}>Overdue</p>
                <p className={data.totals.overdue > 0
                  ? 'text-lg font-semibold mt-1'
                  : 'text-lg font-semibold mt-1 text-surface-500 dark:text-surface-400'
                }>{formatCurrency(data.totals.overdue)}</p>
              </div>
            </div>
          )}

          {(data?.rows?.length ?? 0) === 0 ? (
            <EmptyState title="No ledger entries in this range" className="py-16" />
          ) : (
            <div className="card">
              <div className="table-container">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Property</th>
                      <th>Type</th>
                      <th>Narration</th>
                      <th className="text-right">Amount</th>
                      <th className="text-right">Received</th>
                      <th className="text-right">Due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.rows.map((r, i) => (
                      <tr key={`${r.customerId}-${r.orderDate}-${i}`}>
                        <td>
                          <span className="text-sm text-surface-600 dark:text-surface-400">
                            {new Date(r.orderDate).toLocaleDateString('en-IN')}
                          </span>
                        </td>
                        <td>
                          <span className="text-sm text-surface-700 dark:text-surface-300">{r.customerName}</span>
                        </td>
                        <td>
                          <span className="text-xs text-surface-500 dark:text-surface-400">
                            {r.kind ?? (r.fullCylsDelivered > 0 ? 'Sale' : '—')}
                          </span>
                        </td>
                        <td>
                          <span className="text-sm text-surface-600 dark:text-surface-400">{r.narration ?? '—'}</span>
                        </td>
                        <td className="text-right">
                          <span className="text-sm text-surface-900 dark:text-white">
                            {r.totalAmount ? formatCurrency(r.totalAmount) : '—'}
                          </span>
                        </td>
                        <td className="text-right">
                          <span className="text-sm text-emerald-600 dark:text-emerald-400">
                            {r.receivedAmount ? formatCurrency(r.receivedAmount) : '—'}
                          </span>
                        </td>
                        <td className="text-right">
                          <span className={`text-sm font-medium ${r.dueAmount > 0 ? 'text-flame-600 dark:text-flame-400' : 'text-surface-600 dark:text-surface-400'}`}>
                            {r.dueAmount ? formatCurrency(r.dueAmount) : '—'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
