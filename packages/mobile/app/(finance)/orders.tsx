/**
 * Phase A1 (2026-06-12) — finance orders (read-only).
 *
 * Compact read-only counterpart to (admin)/orders.tsx. Mirrors that
 * screen's data shape + list + detail-modal pattern but drops every
 * mutating action (create, dispatch, assign driver, cancel, returns)
 * — finance staff need order context to answer customer queries but
 * have no business creating or progressing them.
 *
 * Why a real screen instead of a re-export: admin/orders.tsx mutates
 * via internal modals and never navigates to other routes, so a
 * re-export would actually have worked URL-wise — but it would also
 * have surfaced the FAB + Assign Driver + Cancel + Returns affordances
 * that the spec explicitly excludes. Building a focused read-only
 * screen is the cleaner separation than gating ~100 conditionals
 * inside admin's 3119-line file.
 *
 * Server gate: every read endpoint hit here
 *   (`GET /orders`, `GET /orders/:id`)
 * is `requireRole('super_admin','distributor_admin','finance','inventory'...)`
 * in routes/orders.ts so finance has access by default.
 *
 * Reached from the finance More tab → "Orders" menu item (added in
 * (finance)/more.tsx as part of A4).
 */
import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  FlatList,
  Modal,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { useTheme, formatINR } from '../../src/theme';
import { Card, Badge, EmptyState, SelectField } from '../../src/components/ui';
import { orderStatusLabel, orderStatusVariant } from '@gaslink/shared';

// ─── Shape ──────────────────────────────────────────────────────────────────

interface OrderItem {
  orderItemId: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  quantity: number;
  deliveredQuantity?: number | null;
  emptiesCollected?: number | null;
  unitPrice: number;
  totalPrice: number;
}

interface Order {
  orderId: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  deliveryDate: string;
  status: string;
  totalAmount: number;
  driverName?: string | null;
  specialInstructions?: string | null;
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  items: OrderItem[];
}

type StatusFilter =
  | 'all'
  | 'pending_assignment'
  | 'assigned'
  | 'dispatching'
  | 'out_for_delivery'
  | 'delivered'
  | 'modified_delivered'
  | 'cancelled';

const STATUS_OPTIONS: { label: string; value: StatusFilter }[] = [
  { label: 'All', value: 'all' },
  { label: orderStatusLabel('pending_assignment'), value: 'pending_assignment' },
  { label: orderStatusLabel('assigned'), value: 'assigned' },
  { label: orderStatusLabel('dispatching'), value: 'dispatching' },
  { label: orderStatusLabel('out_for_delivery'), value: 'out_for_delivery' },
  { label: orderStatusLabel('delivered'), value: 'delivered' },
  { label: orderStatusLabel('modified_delivered'), value: 'modified_delivered' },
  { label: orderStatusLabel('cancelled'), value: 'cancelled' },
];

export default function FinanceOrdersScreen() {
  const { dark, colors, accent } = useTheme();
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const queryParams: Record<string, unknown> = {};
  if (status !== 'all') queryParams.status = status;
  if (search.trim()) queryParams.search = search.trim();

  const { data, isLoading, refetch, isRefetching } = useApiQuery<{ orders: Order[] }>(
    ['fin-orders', status, search.trim()],
    '/orders',
    queryParams,
  );
  const orders = data?.orders ?? [];

  const renderRow = ({ item }: { item: Order }) => (
    <TouchableOpacity onPress={() => setSelectedId(item.orderId)} activeOpacity={0.7}>
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
          <View style={{ flex: 1, marginRight: 8 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>{item.orderNumber}</Text>
            <Text style={{ fontSize: 14, color: accent.red, fontWeight: '500', marginTop: 2 }}>{item.customerName}</Text>
          </View>
          <Badge label={orderStatusLabel(item.status || '')} variant={orderStatusVariant(item.status || '')} />
        </View>
        <View style={{ flexDirection: 'row', gap: 16, marginTop: 4 }}>
          <View>
            <Text style={{ fontSize: 11, color: colors.textSecondary }}>Delivery</Text>
            <Text style={{ fontSize: 13, fontWeight: '500', color: colors.text }}>{item.deliveryDate}</Text>
          </View>
          <View>
            <Text style={{ fontSize: 11, color: colors.textSecondary }}>Total</Text>
            <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>{formatINR(item.totalAmount)}</Text>
          </View>
          {item.driverName ? (
            <View>
              <Text style={{ fontSize: 11, color: colors.textSecondary }}>Driver</Text>
              <Text style={{ fontSize: 13, fontWeight: '500', color: colors.text }}>{item.driverName}</Text>
            </View>
          ) : null}
        </View>
      </Card>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 8 }}>
        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: 8,
          backgroundColor: dark ? colors.inputBg : '#f8fafc',
          borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
          borderWidth: 1, borderColor: colors.divider,
        }}>
          <Ionicons name="search" size={18} color={colors.textMuted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search by order number or customer"
            placeholderTextColor={colors.textMuted}
            style={{ flex: 1, fontSize: 14, color: colors.text, paddingVertical: 0 }}
          />
        </View>
        <SelectField
          label="Status"
          value={status}
          options={STATUS_OPTIONS}
          onChange={(v) => setStatus(v as StatusFilter)}
          accent={accent.red}
        />
      </View>

      <FlatList
        data={orders}
        keyExtractor={(o) => o.orderId}
        renderItem={renderRow}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16, gap: 10 }}
        refreshControl={<RefreshControl refreshing={isLoading || isRefetching} onRefresh={refetch} />}
        ListEmptyComponent={<EmptyState title="No orders" description="No orders match the selected filter" />}
      />

      {selectedId && (
        <OrderDetailModal
          orderId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Read-only detail modal ─────────────────────────────────────────────────

function OrderDetailModal({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const { dark, colors, accent } = useTheme();
  const { data: order, isLoading } = useApiQuery<Order>(['fin-order-detail', orderId], `/orders/${orderId}`);
  const sectionBg = dark ? colors.inputBg : '#f8fafc';

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen">
      <SafeAreaProvider>
        <SafeAreaView edges={['top','bottom','left','right']} style={{ flex: 1, backgroundColor: colors.bg }}>
          <View style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            paddingHorizontal: 16, paddingVertical: 12,
            borderBottomWidth: 1, borderBottomColor: colors.divider,
            backgroundColor: dark ? colors.cardBg : colors.bg,
          }}>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="close" size={26} color={colors.text} />
            </TouchableOpacity>
            <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>Order Detail</Text>
            <View style={{ width: 26 }} />
          </View>

          {isLoading || !order ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator size="large" color={accent.red} />
            </View>
          ) : (
            <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
              <View style={{ gap: 4 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text }}>{order.orderNumber}</Text>
                    <Text style={{ fontSize: 15, color: accent.red, fontWeight: '500', marginTop: 2 }}>{order.customerName}</Text>
                  </View>
                  <Badge label={orderStatusLabel(order.status || '')} variant={orderStatusVariant(order.status || '')} />
                </View>
              </View>

              <View style={{ flexDirection: 'row', gap: 24 }}>
                <View>
                  <Text style={{ fontSize: 12, color: colors.textMuted, marginBottom: 2 }}>Delivery Date</Text>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>{order.deliveryDate}</Text>
                </View>
                <View>
                  <Text style={{ fontSize: 12, color: colors.textMuted, marginBottom: 2 }}>Total</Text>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>{formatINR(order.totalAmount)}</Text>
                </View>
                {order.driverName ? (
                  <View>
                    <Text style={{ fontSize: 12, color: colors.textMuted, marginBottom: 2 }}>Driver</Text>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>{order.driverName}</Text>
                  </View>
                ) : null}
              </View>

              <View style={{ backgroundColor: sectionBg, borderRadius: 12, padding: 14, gap: 8 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Items
                </Text>
                {(order.items ?? []).map((it) => (
                  <View key={it.orderItemId} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, color: colors.text }}>{it.cylinderTypeName}</Text>
                      <Text style={{ fontSize: 12, color: colors.textMuted }}>
                        Ordered {it.quantity}
                        {typeof it.deliveredQuantity === 'number' ? `  •  Delivered ${it.deliveredQuantity}` : ''}
                        {typeof it.emptiesCollected === 'number' ? `  •  Empties ${it.emptiesCollected}` : ''}
                      </Text>
                    </View>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>{formatINR(it.totalPrice)}</Text>
                  </View>
                ))}
              </View>

              {order.invoiceNumber ? (
                <View style={{ backgroundColor: sectionBg, borderRadius: 12, padding: 14, gap: 4 }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    Invoice
                  </Text>
                  <Text style={{ fontSize: 14, color: colors.text }}>{order.invoiceNumber}</Text>
                  <Text style={{ fontSize: 12, color: colors.textMuted }}>
                    Switch to the Invoices tab to download the PDF.
                  </Text>
                </View>
              ) : null}

              {order.specialInstructions ? (
                <View style={{ backgroundColor: sectionBg, borderRadius: 12, padding: 14, gap: 4 }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    Notes
                  </Text>
                  <Text style={{ fontSize: 14, color: colors.text }}>{order.specialInstructions}</Text>
                </View>
              ) : null}
            </ScrollView>
          )}
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}
