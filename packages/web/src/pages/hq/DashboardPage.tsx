/**
 * Feature A (2026-07-15): HQ portal Dashboard.
 *
 * Read-only consolidated view for a customer_hq user across all
 * properties in their group. Reads GET /customer-group-portal/dashboard.
 * All numbers are already computed server-side — this page only lays
 * them out. See customerGroupPortalService.getDashboard for the source
 * shape.
 *
 * 2026-07-19 filters — added Property + From/To at the top so the
 * hotel HQ can drill into a single property + arbitrary period. The
 * KPIs (outstanding / overdue / aging) still reflect the tenant scope
 * because they're state-current; the "This Period" activity cards
 * (fulls delivered, empties collected, amount billed, payments) plus
 * empties-with-clients respect the filter. The property roster at the
 * bottom always lists every property regardless of filter so the HQ
 * user can jump between them.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  HiOutlineCurrencyRupee,
  HiOutlineExclamationTriangle,
  HiOutlineBanknotes,
  HiOutlineArchiveBox,
} from 'react-icons/hi2';
import { localTodayISO, localDateISO } from '@gaslink/shared';
import { apiGet } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { Loader, EmptyState, Badge, Input, Button } from '@/components/ui';
import { cn } from '@/lib/cn';

interface HqDashboard {
  totalOutstanding: number;
  totalOverdue: number;
  aging: {
    bucket0_30: number;
    bucket31_60: number;
    bucket60plus: number;
  };
  activity: {
    range: { from: string; to: string };
    fullsDelivered: Array<{ cylinderTypeId: string; cylinderTypeName: string; quantity: number }>;
    emptiesCollected: Array<{ cylinderTypeId: string; cylinderTypeName: string; quantity: number }>;
    amountBilled: number;
    paymentsReceived: number;
  };
  emptiesWithClients: Array<{
    cylinderTypeId: string;
    cylinderTypeName: string;
    capacity: number;
    quantity: number;
  }>;
  properties: Array<{
    customerId: string;
    customerName: string;
    businessName: string | null;
    gstin: string | null;
    outstanding: number;
    lastDeliveryDate: string | null;
    lastInvoiceDate: string | null;
    isOverdue: boolean;
  }>;
  filters: { customerId: string | null; from: string; to: string };
}

interface HqProperty { customerId: string; customerName: string }

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(n);
}

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN');
}

function firstOfMonth(): string {
  const d = new Date();
  return localDateISO(new Date(d.getFullYear(), d.getMonth(), 1));
}

export default function HqDashboardPage() {
  const { user } = useAuthStore();

  // Filters — property + date range. Defaults to "All properties" +
  // current month so the initial load matches the pre-filter behaviour.
  const [customerId, setCustomerId] = useState('');
  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(() => localTodayISO());

  const { data: profile } = useQuery({
    queryKey: ['hq-profile-properties'],
    queryFn: () => apiGet<{ members: HqProperty[] }>('/customer-group-portal/profile'),
    staleTime: 5 * 60 * 1000,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['hq-dashboard', customerId, from, to],
    queryFn: () => apiGet<HqDashboard>('/customer-group-portal/dashboard', {
      customerId: customerId || undefined, from, to,
    }),
  });

  const selectedProperty = customerId
    ? profile?.members.find((m) => m.customerId === customerId)?.customerName ?? 'Selected property'
    : 'All properties';

  const totalEmptiesWithClients = data?.emptiesWithClients.reduce((s, r) => s + r.quantity, 0) ?? 0;

  // Current Status tiles — state-current outstanding + overdue + empties
  // held, plus period-scoped Payments Received (moved here per user
  // request 2026-07-19 replacing the Properties count tile — the roster
  // at the bottom already conveys that).
  const stateMetrics = data ? [
    {
      label: 'Total Outstanding',
      value: formatCurrency(data.totalOutstanding),
      icon: HiOutlineCurrencyRupee,
      color: 'text-brand-500',
      bg: 'bg-brand-50 dark:bg-brand-500/10',
    },
    {
      label: 'Total Overdue',
      value: formatCurrency(data.totalOverdue),
      icon: HiOutlineExclamationTriangle,
      color: 'text-flame-500',
      bg: 'bg-flame-50 dark:bg-flame-500/10',
    },
    {
      label: 'Empties With Clients',
      value: totalEmptiesWithClients,
      icon: HiOutlineArchiveBox,
      color: 'text-amber-500',
      bg: 'bg-amber-50 dark:bg-amber-500/10',
    },
    {
      label: 'Payments Received',
      value: formatCurrency(data.activity.paymentsReceived),
      icon: HiOutlineBanknotes,
      color: 'text-emerald-500',
      bg: 'bg-emerald-50 dark:bg-emerald-500/10',
    },
  ] : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white">
          Welcome{user?.firstName ? `, ${user.firstName}` : ''}
        </h1>
        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
          Viewing: <span className="font-medium text-surface-700 dark:text-surface-300">{selectedProperty}</span>
          {' · '}
          <span className="text-surface-500 dark:text-surface-400">
            {from} to {to}
          </span>
        </p>
      </div>

      {/* Filters row */}
      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="label" htmlFor="hq-dash-property">Property</label>
            <select
              id="hq-dash-property"
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
              onClick={() => { setCustomerId(''); setFrom(firstOfMonth()); setTo(localTodayISO()); }}
            >
              Reset
            </Button>
          </div>
        </div>
      </div>

      {isLoading || !data ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : (
        <>
          {/* State-current KPIs */}
          <div>
            <h3 className="text-sm font-semibold text-surface-600 dark:text-surface-300 uppercase tracking-wide mb-3">Current Status</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {stateMetrics.map((m) => (
                <div key={m.label} className="metric-card flex items-start gap-4">
                  <div className={cn('flex items-center justify-center h-12 w-12 rounded-xl shrink-0', m.bg)}>
                    <m.icon className={cn('h-6 w-6', m.color)} />
                  </div>
                  <div>
                    <p className="metric-value">{m.value}</p>
                    <p className="metric-label">{m.label}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Per-type breakdown: Fulls Delivered + Empties Collected side-by-side.
              The user removed the 4-tile "This Period" grid above these
              (2026-07-19) — Amount Billed lives on the /invoices page; totals
              across cylinder types read straight from the two lists below. */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card">
              <div className="p-4 border-b border-surface-200 dark:border-surface-700 flex items-center justify-between">
                <h3 className="font-semibold text-surface-900 dark:text-white">Fulls Delivered (Period)</h3>
                <span className="text-xs text-surface-500 dark:text-surface-400">by cylinder type</span>
              </div>
              {data.activity.fullsDelivered.length === 0 ? (
                <EmptyState title="No deliveries in this period" className="py-8" />
              ) : (
                <div className="divide-y divide-surface-100 dark:divide-surface-700">
                  {data.activity.fullsDelivered.map((c) => (
                    <div key={c.cylinderTypeId} className="flex items-center justify-between p-4">
                      <span className="text-sm text-surface-700 dark:text-surface-300">{c.cylinderTypeName}</span>
                      <span className="font-medium text-surface-900 dark:text-white">{c.quantity}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="card">
              <div className="p-4 border-b border-surface-200 dark:border-surface-700 flex items-center justify-between">
                <h3 className="font-semibold text-surface-900 dark:text-white">Empties Collected (Period)</h3>
                <span className="text-xs text-surface-500 dark:text-surface-400">by cylinder type</span>
              </div>
              {data.activity.emptiesCollected.length === 0 ? (
                <EmptyState title="No empties collected in this period" className="py-8" />
              ) : (
                <div className="divide-y divide-surface-100 dark:divide-surface-700">
                  {data.activity.emptiesCollected.map((c) => (
                    <div key={c.cylinderTypeId} className="flex items-center justify-between p-4">
                      <span className="text-sm text-surface-700 dark:text-surface-300">{c.cylinderTypeName}</span>
                      <span className="font-medium text-surface-900 dark:text-white">{c.quantity}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Empties currently WITH clients (state-current, per cylinder type) */}
          <div className="card">
            <div className="p-4 border-b border-surface-200 dark:border-surface-700 flex items-center justify-between">
              <h3 className="font-semibold text-surface-900 dark:text-white">
                Empties Currently With {customerId ? 'Client' : 'Group'}
              </h3>
              <span className="text-xs text-surface-500 dark:text-surface-400">state-current, per cylinder type</span>
            </div>
            {data.emptiesWithClients.length === 0 ? (
              <EmptyState title="No empties held by clients" className="py-8" />
            ) : (
              <div className="divide-y divide-surface-100 dark:divide-surface-700">
                {data.emptiesWithClients.map((c) => (
                  <div key={c.cylinderTypeId} className="flex items-center justify-between p-4">
                    <div>
                      <span className="text-sm text-surface-700 dark:text-surface-300">{c.cylinderTypeName}</span>
                      {c.capacity > 0 && (
                        <span className="ml-2 text-xs text-surface-500 dark:text-surface-400">
                          ({c.capacity} kg)
                        </span>
                      )}
                    </div>
                    <span className={cn(
                      'font-medium',
                      c.quantity < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-surface-900 dark:text-white',
                    )}>
                      {c.quantity}
                      {c.quantity < 0 && <span className="ml-1 text-xs font-normal">(excess returned)</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Aging bar */}
          <div className="card p-4">
            <h3 className="font-semibold text-surface-900 dark:text-white mb-3">Outstanding by Age</h3>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: '0–30 days', value: data.aging.bucket0_30, color: 'text-emerald-600 dark:text-emerald-400' },
                { label: '31–60 days', value: data.aging.bucket31_60, color: 'text-amber-600 dark:text-amber-400' },
                { label: '60+ days', value: data.aging.bucket60plus, color: 'text-flame-600 dark:text-flame-400' },
              ].map((b) => (
                <div key={b.label} className="rounded-lg border border-surface-200 dark:border-surface-700 p-3">
                  <p className="text-xs text-surface-500 dark:text-surface-400">{b.label}</p>
                  <p className={cn('text-lg font-semibold mt-1', b.color)}>{formatCurrency(b.value)}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Properties table */}
          <div className="card">
            <div className="p-4 border-b border-surface-200 dark:border-surface-700 flex items-center justify-between">
              <h3 className="font-semibold text-surface-900 dark:text-white">Properties</h3>
              {customerId && (
                <button
                  className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
                  onClick={() => setCustomerId('')}
                >
                  Clear property filter
                </button>
              )}
            </div>
            {data.properties.length === 0 ? (
              <EmptyState title="No properties in your group yet" className="py-8" />
            ) : (
              <div className="table-container">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Property</th>
                      <th>GSTIN</th>
                      <th>Outstanding</th>
                      <th>Last Delivery</th>
                      <th>Last Invoice</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.properties.map((p) => (
                      <tr
                        key={p.customerId}
                        className={cn(
                          'cursor-pointer',
                          customerId === p.customerId && 'bg-brand-50 dark:bg-brand-500/10',
                        )}
                        onClick={() => setCustomerId(customerId === p.customerId ? '' : p.customerId)}
                      >
                        <td>
                          <div>
                            <p className="font-medium text-surface-900 dark:text-white">{p.customerName}</p>
                            {p.businessName && (
                              <p className="text-xs text-surface-500 dark:text-surface-400">{p.businessName}</p>
                            )}
                          </div>
                        </td>
                        <td>
                          <span className="text-sm text-surface-600 dark:text-surface-400">{p.gstin ?? '—'}</span>
                        </td>
                        <td>
                          <span className="font-medium text-surface-900 dark:text-white">
                            {formatCurrency(p.outstanding)}
                          </span>
                        </td>
                        <td>
                          <span className="text-sm text-surface-600 dark:text-surface-400">{formatDate(p.lastDeliveryDate)}</span>
                        </td>
                        <td>
                          <span className="text-sm text-surface-600 dark:text-surface-400">{formatDate(p.lastInvoiceDate)}</span>
                        </td>
                        <td>
                          {p.isOverdue
                            ? <Badge variant="danger">Overdue</Badge>
                            : <Badge variant="success">OK</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
