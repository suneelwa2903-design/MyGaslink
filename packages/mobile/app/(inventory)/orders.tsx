import { useState, useMemo } from 'react';
import { View, Text, FlatList, TouchableOpacity, RefreshControl, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { Card, Badge, EmptyState } from '../../src/components/ui';
import { useTheme, formatINR } from '../../src/theme';
import { orderStatusLabel, orderStatusVariant } from '@gaslink/shared';

// ─── Types ──────────────────────────────────────────────────────────────────

interface OrderItem {
  orderItemId: string;
  cylinderTypeName: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

interface Order {
  orderId: string;
  orderNumber: string;
  customerName: string;
  deliveryDate: string;
  status: string;
  totalAmount: number;
  driverName?: string;
  items?: OrderItem[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const STATUS_TABS = [
  { label: 'All', value: 'all' },
  { label: orderStatusLabel('pending_driver_assignment'), value: 'pending_driver_assignment' },
  { label: orderStatusLabel('pending_delivery'), value: 'pending_delivery' },
  { label: orderStatusLabel('delivered'), value: 'delivered' },
] as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

// ─── Main Screen ────────────────────────────────────────────────────────────

export default function InventoryOrdersScreen() {
  const { dark, colors, accent } = useTheme();
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const queryParams: Record<string, unknown> = { limit: 50 };
  if (statusFilter !== 'all') queryParams.status = statusFilter;

  const { data: ordersData, isLoading, refetch, isRefetching } = useApiQuery<{ orders: Order[]; total: number }>(
    ['inv-orders', statusFilter],
    '/orders',
    queryParams,
  );

  const orders = ordersData?.orders ?? [];

  const filtered = useMemo(() => {
    if (!search.trim()) return orders;
    const q = search.toLowerCase();
    return orders.filter((o) =>
      o.orderNumber?.toLowerCase().includes(q) ||
      o.customerName?.toLowerCase().includes(q) ||
      o.driverName?.toLowerCase().includes(q)
    );
  }, [orders, search]);

  const renderOrder = ({ item }: { item: Order }) => {
    const isExpanded = expandedId === item.orderId;

    return (
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => setExpandedId(isExpanded ? null : item.orderId)}
        style={{ marginHorizontal: 16, marginBottom: 10 }}
      >
        <Card>
          {/* Header row */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>#{item.orderNumber}</Text>
                <Badge
                  label={orderStatusLabel(item.status)}
                  variant={orderStatusVariant(item.status)}
                />
              </View>
              <Text style={{ fontSize: 14, color: colors.textSecondary }}>{item.customerName}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ fontWeight: '700', fontSize: 16, color: colors.text }}>{formatINR(item.totalAmount)}</Text>
              <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 2 }}>{formatDate(item.deliveryDate)}</Text>
            </View>
          </View>

          {/* Driver */}
          {item.driverName && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 }}>
              <Ionicons name="person-outline" size={13} color={colors.textMuted} />
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>{item.driverName}</Text>
            </View>
          )}

          {/* Expanded items */}
          {isExpanded && item.items && item.items.length > 0 && (
            <View style={{
              marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.divider, gap: 4,
            }}>
              {item.items.map((itm) => (
                <View key={itm.orderItemId} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 13, color: colors.textSecondary }}>
                    {itm.cylinderTypeName} x{itm.quantity}
                  </Text>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>{formatINR(itm.totalPrice)}</Text>
                </View>
              ))}
            </View>
          )}
        </Card>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Search */}
      <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 }}>
        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: 8,
          backgroundColor: colors.inputBg, borderRadius: 12, borderWidth: 1, borderColor: colors.inputBorder,
          paddingHorizontal: 12, height: 42,
        }}>
          <Ionicons name="search-outline" size={18} color={colors.textMuted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search orders..."
            placeholderTextColor={colors.textMuted}
            style={{ flex: 1, fontSize: 14, color: colors.text, padding: 0 }}
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')}>
              <Ionicons name="close-circle" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Status Filter Pills */}
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {STATUS_TABS.map((tab) => {
            const isActive = statusFilter === tab.value;
            return (
              <TouchableOpacity
                key={tab.value}
                onPress={() => setStatusFilter(tab.value)}
                style={{
                  height: 36,
                  paddingHorizontal: 16,
                  borderRadius: 18,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: isActive ? accent.red : (dark ? colors.inputBg : '#f1f5f9'),
                }}
              >
                <Text style={{
                  fontSize: 13, fontWeight: '600',
                  color: isActive ? '#fff' : colors.textSecondary,
                }}>
                  {tab.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Order Count */}
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <Text style={{ fontSize: 12, color: colors.textMuted, fontWeight: '600' }}>
          {filtered.length} order{filtered.length !== 1 ? 's' : ''}
        </Text>
      </View>

      {/* Orders List */}
      <FlatList
        data={filtered}
        renderItem={renderOrder}
        keyExtractor={(item) => item.orderId}
        contentContainerStyle={{ paddingBottom: 20 }}
        refreshControl={<RefreshControl refreshing={isLoading || isRefetching} onRefresh={refetch} />}
        ListEmptyComponent={
          <View style={{ padding: 16 }}>
            <EmptyState
              title={isLoading ? 'Loading orders...' : 'No orders found'}
              description={search ? 'Try a different search term' : 'Orders will appear here'}
            />
          </View>
        }
      />
    </SafeAreaView>
  );
}
