/**
 * Feature A (2026-07-15): HQ portal Orders list.
 *
 * Read-only. Same table shape as admin OrdersPage but with a Property
 * column showing which group member the order belongs to, and a
 * property filter dropdown fed by the profile response.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  type Order,
  type PaginationMeta,
  orderStatusLabel,
  orderStatusVariant,
  localTodayISO,
  localDateISO,
} from '@gaslink/shared';
import { apiGet } from '@/lib/api';
import { Badge, Loader, EmptyState, Input, Button } from '@/components/ui';

interface HqProperty {
  customerId: string;
  customerName: string;
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(n);
}

export default function HqOrdersPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [customerId, setCustomerId] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return localDateISO(d);
  });
  const [to, setTo] = useState(() => localTodayISO());

  // Properties dropdown — read once from the profile endpoint. Small
  // list (3–50) so staleTime can be generous.
  const { data: profile } = useQuery({
    queryKey: ['hq-profile-properties'],
    queryFn: () => apiGet<{ members: HqProperty[] }>('/customer-group-portal/profile'),
    staleTime: 5 * 60 * 1000,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['hq-orders', page, customerId, status, from, to],
    queryFn: () => apiGet<{ orders: Order[]; meta: PaginationMeta }>(
      '/customer-group-portal/orders',
      { page, pageSize: 25, customerId: customerId || undefined, status: status || undefined, from, to },
    ),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Orders</h1>
        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
          All orders across your group properties.
        </p>
      </div>

      {/* Filters */}
      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div>
            <label className="label" htmlFor="hq-orders-property">Property</label>
            <select
              id="hq-orders-property"
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
            <label className="label" htmlFor="hq-orders-status">Status</label>
            <select
              id="hq-orders-status"
              className="select"
              value={status}
              onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            >
              <option value="">All statuses</option>
              <option value="pending_driver_assignment">Pending Assignment</option>
              <option value="pending_dispatch">Pending Dispatch</option>
              <option value="pending_delivery">Out for Delivery</option>
              <option value="delivered">Delivered</option>
              <option value="modified_delivered">Modified Delivered</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <Input
            label="From"
            type="date"
            value={from}
            onChange={(e) => { setFrom(e.target.value); setPage(1); }}
          />
          <Input
            label="To"
            type="date"
            value={to}
            onChange={(e) => { setTo(e.target.value); setPage(1); }}
          />
          <div className="flex items-end">
            <Button
              variant="secondary"
              onClick={() => {
                setCustomerId(''); setStatus('');
                const d = new Date(); d.setDate(d.getDate() - 30);
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
      ) : (data?.orders?.length ?? 0) === 0 ? (
        <EmptyState title="No orders match these filters" className="py-16" />
      ) : (
        <div className="card">
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Order #</th>
                  <th>Property</th>
                  <th>Order Date</th>
                  <th>Delivery Date</th>
                  <th>Items</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data!.orders.map((o) => (
                  <tr
                    key={o.orderId}
                    className="cursor-pointer hover:bg-surface-50 dark:hover:bg-surface-800/50"
                    onClick={() => navigate(`/hq/orders/${o.orderId}`)}
                  >
                    <td>
                      <span className="font-medium text-surface-900 dark:text-white">{o.orderNumber}</span>
                    </td>
                    <td>
                      <span className="text-sm text-surface-600 dark:text-surface-400">
                        {o.customerName ?? '—'}
                      </span>
                    </td>
                    <td>
                      <span className="text-sm text-surface-600 dark:text-surface-400">
                        {new Date(o.orderDate).toLocaleDateString('en-IN')}
                      </span>
                    </td>
                    <td>
                      <span className="text-sm text-surface-600 dark:text-surface-400">
                        {o.deliveryDate ? new Date(o.deliveryDate).toLocaleDateString('en-IN') : '—'}
                      </span>
                    </td>
                    <td>
                      <span className="text-sm text-surface-600 dark:text-surface-400">
                        {o.items?.map((it) => `${it.deliveredQuantity ?? it.quantity}× ${it.cylinderTypeName ?? '?'}`).join(', ') || '—'}
                      </span>
                    </td>
                    <td>
                      <span className="font-medium text-surface-900 dark:text-white">
                        {formatCurrency(o.totalAmount)}
                      </span>
                    </td>
                    <td>
                      <Badge variant={orderStatusVariant(o.status)}>{orderStatusLabel(o.status)}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data?.meta && data.meta.totalPages > 1 && (
            <div className="flex items-center justify-between p-4 border-t border-surface-200 dark:border-surface-700">
              <p className="text-sm text-surface-500 dark:text-surface-400">
                Page {data.meta.page} of {data.meta.totalPages} · {data.meta.total} orders
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
