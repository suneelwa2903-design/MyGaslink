import { View, Text, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApiQuery } from '../../src/hooks/useApi';
import { Card, MetricCard, EmptyState } from '../../src/components/ui';
import { useTheme, ACCENT, formatDate } from '../../src/theme';

interface TripStockItem {
  cylinderTypeId: string;
  cylinderTypeName: string;
  fullQuantity: number;       // still to deliver
  deliveredQuantity: number;  // delivered today
  emptyQuantity: number;      // empties collected today
}

interface CancelledItem {
  cylinderTypeName: string;
  quantity: number;
  cancellationDate: string;
  status: string;
  order?: {
    orderNumber?: string;
    customer?: {
      customerName?: string;
    };
  };
}

export default function DriverInventoryScreen() {
  const { dark, colors } = useTheme();

  // /me/trip-stock derives the truck cargo from orders assigned to this
  // driver for today (not the static admin-managed vehicle_inventory
  // table). Envelope per anti-pattern #9: `{ items: [...] }`.
  const { data: stockResponse, isLoading, refetch } = useApiQuery<{ items: TripStockItem[] }>(
    ['driver-trip-stock'],
    '/drivers/me/trip-stock',
  );
  const stock: TripStockItem[] = stockResponse?.items ?? [];

  const { data: cancelled } = useApiQuery<CancelledItem[]>(
    ['driver-cancelled-stock'],
    '/drivers/me/cancelled-stock',
  );

  const totalFulls = stock.reduce((s, item) => s + (item.fullQuantity ?? 0), 0);
  const totalEmpties = stock.reduce((s, item) => s + (item.emptyQuantity ?? 0), 0);
  const totalCancelled = cancelled?.reduce((s, item) => s + (item.quantity ?? 0), 0) ?? 0;

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
      >
        <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 4 }}>Vehicle Stock</Text>

        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard title="Full Cylinders" value={totalFulls} color={ACCENT.green} />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard title="Empty Collected" value={totalEmpties} color={ACCENT.blue} />
          </View>
        </View>

        {totalCancelled > 0 && (
          <MetricCard title="Cancelled (To Return)" value={totalCancelled} color={ACCENT.red} subtitle="Return these to depot" />
        )}

        {/* Per cylinder type breakdown */}
        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 8 }}>By Cylinder Type</Text>

        {(!stock || stock.length === 0) ? (
          <EmptyState title="No stock loaded" description="Stock will appear once your trip is loaded" />
        ) : (
          stock.map((item) => (
            <Card key={item.cylinderTypeId}>
              <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text, marginBottom: 8 }}>
                {item.cylinderTypeName}
              </Text>
              <View style={{ flexDirection: 'row', gap: 16 }}>
                <View style={{
                  flex: 1,
                  backgroundColor: dark ? 'rgba(16,185,129,0.15)' : '#ecfdf5',
                  padding: 10, borderRadius: 10, alignItems: 'center',
                }}>
                  <Text style={{ fontSize: 20, fontWeight: '800', color: ACCENT.green }}>{item.fullQuantity}</Text>
                  <Text style={{ fontSize: 11, color: dark ? ACCENT.green : '#059669', marginTop: 2 }}>Full</Text>
                </View>
                <View style={{
                  flex: 1,
                  backgroundColor: dark ? 'rgba(59,130,246,0.15)' : '#eef7ff',
                  padding: 10, borderRadius: 10, alignItems: 'center',
                }}>
                  <Text style={{ fontSize: 20, fontWeight: '800', color: ACCENT.blue }}>{item.emptyQuantity}</Text>
                  <Text style={{ fontSize: 11, color: dark ? ACCENT.blue : '#1a6df5', marginTop: 2 }}>Empty</Text>
                </View>
              </View>
            </Card>
          ))
        )}

        {/* Cancelled stock */}
        {cancelled && cancelled.length > 0 && (
          <>
            <Text style={{ fontSize: 16, fontWeight: '700', color: ACCENT.red, marginTop: 8 }}>Cancelled Stock</Text>
            {cancelled.map((item, i) => (
              <Card key={i}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <View>
                    <Text style={{ fontWeight: '600', color: colors.text }}>{item.cylinderTypeName}</Text>
                    <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>Cancelled: {formatDate(item.cancellationDate)}</Text>
                    {item.order?.customer?.customerName ? (
                      <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                        {item.order.customer.customerName}
                      </Text>
                    ) : null}
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ fontSize: 18, fontWeight: '800', color: ACCENT.red }}>{item.quantity}</Text>
                    <Text style={{ fontSize: 11, color: colors.textMuted, textTransform: 'uppercase' }}>
                      {(item.status || '').replace(/_/g, ' ')}
                    </Text>
                  </View>
                </View>
              </Card>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
