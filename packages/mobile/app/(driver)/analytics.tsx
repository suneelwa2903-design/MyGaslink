import { View, Text, ScrollView, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { Card, MetricCard } from '../../src/components/ui';
import { useTheme, ACCENT, formatINR } from '../../src/theme';
import type { Order } from '@gaslink/shared';

interface DriverMetrics {
  totalOrders?: number;
  pendingDeliveries?: number;
  completedToday?: number;
  deliveredToday?: number;
  avgOrderValue?: number;
}

export default function DriverAnalyticsScreen() {
  const { dark, colors } = useTheme();

  const { data: metrics, isLoading: metricsLoading, refetch: refetchMetrics } = useApiQuery<DriverMetrics>(
    ['driver-analytics-metrics'],
    '/analytics/header-metrics',
  );

  const { data: recentOrdersResponse, isLoading: ordersLoading, refetch: refetchOrders } = useApiQuery<{ orders: Order[] }>(
    ['driver-recent-deliveries'],
    '/orders',
    { limit: 10 },
  );
  const recentOrders: Order[] = recentOrdersResponse?.orders ?? [];

  const isLoading = metricsLoading || ordersLoading;

  const refetch = () => {
    refetchMetrics();
    refetchOrders();
  };

  const deliveredOrders = recentOrders?.filter((o) => o.status === 'delivered') ?? [];
  const pendingOrders = recentOrders?.filter((o) => o.status === 'pending_delivery') ?? [];

  const metricCards = [
    {
      title: 'Completed Today',
      value: metrics?.completedToday ?? metrics?.deliveredToday ?? deliveredOrders.length,
      color: ACCENT.green,
      icon: 'checkmark-circle-outline' as const,
    },
    {
      title: 'Pending Deliveries',
      value: metrics?.pendingDeliveries ?? pendingOrders.length,
      color: ACCENT.orange,
      icon: 'time-outline' as const,
    },
    {
      title: 'Total Orders',
      value: metrics?.totalOrders ?? (recentOrders?.length ?? 0),
      color: ACCENT.blue,
      icon: 'receipt-outline' as const,
    },
    {
      title: 'Avg Order Value',
      value: metrics?.avgOrderValue ? formatINR(metrics.avgOrderValue) : '--',
      color: ACCENT.purple,
      icon: 'stats-chart-outline' as const,
    },
  ];

  const statusColor = (status: string) => {
    switch (status) {
      case 'delivered': return ACCENT.green;
      case 'pending_delivery': return ACCENT.orange;
      case 'pending_dispatch': return ACCENT.blue;
      default: return colors.textMuted;
    }
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
      >
        <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 4 }}>
          My Performance
        </Text>

        {/* Metric cards - 2 column grid. Icons dropped: MetricCard expects
            React.ReactNode but metricCards holds Ionicons name strings —
            passing a string into a <View> trips RN's text-in-view guard. */}
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard
              title={metricCards[0].title}
              value={metricCards[0].value}
              color={metricCards[0].color}
            />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard
              title={metricCards[1].title}
              value={metricCards[1].value}
              color={metricCards[1].color}
            />
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard
              title={metricCards[2].title}
              value={metricCards[2].value}
              color={metricCards[2].color}
            />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard
              title={metricCards[3].title}
              value={metricCards[3].value}
              color={metricCards[3].color}
            />
          </View>
        </View>

        {/* Recent Activity */}
        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 8 }}>
          Recent Activity
        </Text>

        {isLoading && !recentOrders ? (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <ActivityIndicator size="large" color={ACCENT.red} />
          </View>
        ) : (!recentOrders || recentOrders.length === 0) ? (
          <Card>
            <View style={{ alignItems: 'center', paddingVertical: 24 }}>
              <Ionicons name="receipt-outline" size={40} color={colors.textMuted} />
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text, marginTop: 8 }}>
                No recent activity
              </Text>
              <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 4, textAlign: 'center' }}>
                Your delivery history will appear here
              </Text>
            </View>
          </Card>
        ) : (
          recentOrders.map((order) => (
            <Card key={order.orderId}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '600', fontSize: 14, color: colors.text }}>
                    {order.orderNumber}
                  </Text>
                  <Text style={{ fontSize: 13, color: ACCENT.blue, marginTop: 2 }}>
                    {order.customerName}
                  </Text>
                  {order.items && order.items.length > 0 && (
                    <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                      {order.items.map((item) => `${item.cylinderTypeName} x${item.quantity}`).join(', ')}
                    </Text>
                  )}
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <View style={{
                    height: 24,
                    borderRadius: 12,
                    paddingHorizontal: 10,
                    backgroundColor: dark
                      ? `${statusColor(order.status || '')}22`
                      : `${statusColor(order.status || '')}18`,
                    justifyContent: 'center',
                  }}>
                    <Text style={{
                      fontSize: 11,
                      fontWeight: '600',
                      color: statusColor(order.status || ''),
                      textTransform: 'capitalize',
                    }}>
                      {(order.status || '').replace(/_/g, ' ')}
                    </Text>
                  </View>
                  {order.totalAmount != null && (
                    <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text, marginTop: 4 }}>
                      {formatINR(order.totalAmount)}
                    </Text>
                  )}
                </View>
              </View>
            </Card>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
