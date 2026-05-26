import { useState, useCallback } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { Card, Badge, EmptyState } from '../../src/components/ui';
import { useTheme, formatINR } from '../../src/theme';
import { useDistributorStore } from '../../src/stores/distributorStore';
import type { Order, OrderItem, PaginationMeta } from '@gaslink/shared';

// The orders list endpoint can carry a couple of legacy/aliased numeric fields
// the card renders defensively (e.g. `deliverQuantity`/`lineTotal`). Model them
// as optional extensions so the access sites stay typed without `any`.
type OrderItemRow = OrderItem & {
  deliverQuantity?: number;
  sellingPrice?: number;
  lineTotal?: number;
};

type OrderRow = Order & {
  totalAmountInclGst?: number;
};

// ── Status config ────────────────────────────────────────────────────────────

const STATUS_FILTERS = [
  { label: 'All', value: '' },
  { label: 'Pending', value: 'pending_driver_assignment' },
  { label: 'Dispatched', value: 'pending_dispatch' },
  { label: 'In Transit', value: 'pending_delivery' },
  { label: 'Delivered', value: 'delivered' },
  { label: 'Cancelled', value: 'cancelled' },
];

const STATUS_VARIANTS: Record<string, 'info' | 'warning' | 'success' | 'danger' | 'neutral'> = {
  pending_driver_assignment: 'warning',
  pending_dispatch: 'info',
  pending_delivery: 'info',
  delivered: 'success',
  modified_delivered: 'success',
  cancelled: 'danger',
};

const STATUS_LABELS: Record<string, string> = {
  pending_driver_assignment: 'Pending Assignment',
  pending_dispatch: 'Pending Dispatch',
  pending_delivery: 'In Transit',
  delivered: 'Delivered',
  modified_delivered: 'Modified Delivered',
  cancelled: 'Cancelled',
};

// ── Pill component ───────────────────────────────────────────────────────────

function Pill({
  label,
  active,
  activeColor,
  inactiveBg,
  inactiveText,
  onPress,
}: {
  label: string;
  active: boolean;
  activeColor: string;
  inactiveBg: string;
  inactiveText: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{
        height: 36,
        paddingHorizontal: 16,
        paddingVertical: 0,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: active ? activeColor : inactiveBg,
      }}
    >
      <Text style={{ fontSize: 13, fontWeight: '600', color: active ? '#fff' : inactiveText }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ── Main Screen ──────────────────────────────────────────────────────────────

export default function OrdersScreen() {
  const { dark, colors, accent } = useTheme();
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const { selectedDistributorId } = useDistributorStore();

  const params: Record<string, unknown> = { page, limit: 25 };
  if (statusFilter) params.status = statusFilter;
  if (selectedDistributorId) params.distributorId = selectedDistributorId;

  const { data, isLoading, refetch } = useApiQuery<
    { orders: OrderRow[]; pagination?: PaginationMeta } | OrderRow[]
  >(
    ['sa-orders', statusFilter, String(page), selectedDistributorId ?? 'all'],
    '/orders',
    params,
  );

  const orders: OrderRow[] = Array.isArray(data) ? data : data?.orders ?? [];
  const pagination: PaginationMeta | undefined = Array.isArray(data) ? undefined : data?.pagination;

  const handleRefresh = useCallback(() => {
    setPage(1);
    refetch();
  }, [refetch]);

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Status filter pills */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}
      >
        {STATUS_FILTERS.map((f) => (
          <Pill
            key={f.value}
            label={f.label}
            active={statusFilter === f.value}
            activeColor={accent.red}
            inactiveBg={dark ? colors.cardBg : colors.inputBg}
            inactiveText={colors.textSecondary}
            onPress={() => { setStatusFilter(f.value); setPage(1); }}
          />
        ))}
      </ScrollView>

      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={handleRefresh} />}
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text }}>Orders</Text>
          <Text style={{ fontSize: 13, color: colors.textSecondary }}>
            {pagination ? `${pagination.total} total` : `${orders.length} shown`}
          </Text>
        </View>

        {isLoading && orders.length === 0 ? (
          <ActivityIndicator size="large" color={accent.red} style={{ marginTop: 40 }} />
        ) : orders.length === 0 ? (
          <EmptyState title="No orders" description={statusFilter ? 'Try a different filter' : 'No orders yet'} />
        ) : (
          <>
            {orders.map((order) => (
              <Card key={order.orderId} style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
                {/* Header */}
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                  <View style={{ flex: 1, marginRight: 8 }}>
                    <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }} numberOfLines={1}>
                      {order.customerName ?? `Order #${order.orderId.slice(-6)}`}
                    </Text>
                    <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                      {new Date(order.orderDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </Text>
                  </View>
                  <Badge
                    label={STATUS_LABELS[order.status] ?? order.status.replace(/_/g, ' ')}
                    variant={STATUS_VARIANTS[order.status] ?? 'neutral'}
                  />
                </View>

                {/* Items summary */}
                {order.items && order.items.length > 0 && (
                  <View style={{
                    backgroundColor: dark ? colors.inputBg : colors.cardBg,
                    borderRadius: 10,
                    padding: 10,
                    gap: 4,
                    marginBottom: 8,
                  }}>
                    {order.items.map((item: OrderItemRow, idx: number) => (
                      <View key={idx} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: 13, color: colors.textSecondary }} numberOfLines={1}>
                          {item.cylinderTypeName ?? item.cylinderTypeId ?? 'Cylinder'} x{item.deliverQuantity ?? item.quantity ?? 0}
                        </Text>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>
                          {formatINR(item.lineTotal ?? (item.sellingPrice ?? 0) * (item.deliverQuantity ?? item.quantity ?? 0))}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}

                {/* Footer */}
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  {order.driverName ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Ionicons name="person-outline" size={14} color={colors.textSecondary} />
                      <Text style={{ fontSize: 12, color: colors.textSecondary }}>{order.driverName}</Text>
                    </View>
                  ) : (
                    <View />
                  )}
                  <Text style={{ fontWeight: '800', fontSize: 16, color: colors.text }}>
                    {formatINR(order.totalAmount ?? order.totalAmountInclGst ?? 0)}
                  </Text>
                </View>
              </Card>
            ))}

            {/* Pagination */}
            {pagination && pagination.totalPages > 1 && (
              <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 16, marginTop: 8 }}>
                <TouchableOpacity
                  disabled={page <= 1}
                  onPress={() => setPage((p) => Math.max(1, p - 1))}
                  style={{ opacity: page <= 1 ? 0.3 : 1 }}
                >
                  <Ionicons name="chevron-back" size={24} color={colors.text} />
                </TouchableOpacity>
                <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>
                  Page {page} of {pagination.totalPages}
                </Text>
                <TouchableOpacity
                  disabled={page >= pagination.totalPages}
                  onPress={() => setPage((p) => p + 1)}
                  style={{ opacity: page >= pagination.totalPages ? 0.3 : 1 }}
                >
                  <Ionicons name="chevron-forward" size={24} color={colors.text} />
                </TouchableOpacity>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
