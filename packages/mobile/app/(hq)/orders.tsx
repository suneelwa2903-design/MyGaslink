/**
 * HQ Orders (2026-07-19) — consolidated orders across every property
 * in the group. Web parity: packages/web/src/pages/hq/OrdersPage.tsx.
 *
 * Security: GET /api/customer-group-portal/orders. `visibleCustomerIds`
 * is populated by requireGroupAccess — the mobile client never sends a
 * customerId from URL params, so property drill-down is entirely
 * server-scoped.
 */
import { useMemo, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApiQuery } from '../../src/hooks/useApi';
import { Card, EmptyState, ScreenSkeleton, Badge, SelectField } from '../../src/components/ui';
import { useTheme, formatINR } from '../../src/theme';
import type { Order } from '@gaslink/shared';

interface OrdersResponse {
  orders: Order[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

const STATUS_OPTIONS = [
  { label: 'All statuses', value: '' },
  { label: 'Pending', value: 'pending_driver_assignment,pending_dispatch,pending_delivery' },
  { label: 'Delivered', value: 'delivered,modified_delivered' },
  { label: 'Cancelled', value: 'cancelled' },
];

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function statusBadge(status: string) {
  const s = String(status);
  if (s.includes('delivered')) return { label: 'Delivered', variant: 'success' as const };
  if (s === 'cancelled') return { label: 'Cancelled', variant: 'danger' as const };
  if (s.startsWith('pending')) return { label: 'Pending', variant: 'warning' as const };
  return { label: s, variant: 'neutral' as const };
}

export default function HqOrdersScreen() {
  const { colors } = useTheme();
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);

  const params = useMemo(() => {
    const p: Record<string, string | number> = { page, pageSize: 25 };
    if (statusFilter) p.status = statusFilter;
    return p;
  }, [page, statusFilter]);

  const { data, isLoading, refetch, isRefetching } = useApiQuery<OrdersResponse>(
    ['hq-orders', JSON.stringify(params)],
    '/customer-group-portal/orders',
    params,
  );

  const orders = data?.orders ?? [];
  const totalPages = data?.meta.totalPages ?? 1;

  if (isLoading && !data) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScreenSkeleton />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => { void refetch(); }} />}
      >
        <Card>
          <SelectField
            label="Status"
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={(v) => { setStatusFilter(v); setPage(1); }}
          />
        </Card>

        {orders.length === 0 ? (
          <Card>
            <EmptyState
              title="No orders"
              description={statusFilter ? 'No orders match the current filter.' : 'No orders across your group properties yet.'}
            />
          </Card>
        ) : (
          <Card>
            {orders.map((o, idx) => {
              const b = statusBadge(o.status);
              return (
                <View
                  key={o.orderId}
                  style={{
                    paddingVertical: 12,
                    borderBottomWidth: idx === orders.length - 1 ? 0 : 1,
                    borderBottomColor: colors.divider,
                    gap: 6,
                  }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14 }} numberOfLines={1}>
                        {o.orderNumber}
                      </Text>
                      <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                        {o.customerName}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14 }}>
                        {formatINR(o.totalAmount ?? 0)}
                      </Text>
                      <View style={{ marginTop: 4 }}>
                        <Badge variant={b.variant} label={b.label} />
                      </View>
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
                    <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                      Order: {fmtDate(o.orderDate)}
                    </Text>
                    <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                      Delivery: {fmtDate(o.deliveryDate)}
                    </Text>
                    {o.driverName && (
                      <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                        Driver: {o.driverName}
                      </Text>
                    )}
                  </View>
                </View>
              );
            })}
          </Card>
        )}

        {totalPages > 1 && (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 }}>
            <TouchableOpacity
              onPress={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              style={{
                paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8,
                borderWidth: 1, borderColor: colors.cardBorder,
                opacity: page <= 1 ? 0.4 : 1,
              }}
            >
              <Text style={{ color: colors.text, fontWeight: '600' }}>Prev</Text>
            </TouchableOpacity>
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
              Page {page} / {totalPages}
            </Text>
            <TouchableOpacity
              onPress={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              style={{
                paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8,
                borderWidth: 1, borderColor: colors.cardBorder,
                opacity: page >= totalPages ? 0.4 : 1,
              }}
            >
              <Text style={{ color: colors.text, fontWeight: '600' }}>Next</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={{ height: 8 }} />
      </ScrollView>
    </SafeAreaView>
  );
}
