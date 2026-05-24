import { View, Text, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApiQuery } from '../../src/hooks/useApi';
import { MetricCard } from '../../src/components/ui';
import { useTheme, formatINR, getBadgeColors, formatDate } from '../../src/theme';

interface CustomerDashboard {
  outstandingAmount: number;
  overdueAmount: number;
  totalOrders: number;
  pendingOrders: number;
  emptyCylinders: number;
  recentOrders: Array<{
    orderId: string;
    orderNumber: string;
    status: string;
    deliveryDate: string;
    totalAmount: number;
  }>;
}

function getOrderBadgeVariant(status: string) {
  switch (status) {
    case 'delivered':
    case 'modified_delivered':
      return 'success' as const;
    case 'cancelled':
      return 'danger' as const;
    case 'pending_delivery':
      return 'warning' as const;
    default:
      return 'info' as const;
  }
}

export default function CustomerDashboardScreen() {
  const { dark, colors, accent } = useTheme();

  const { data, isLoading, refetch } = useApiQuery<CustomerDashboard>(
    ['customer-dashboard'],
    '/customer-portal/dashboard',
  );

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
      >
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
          Welcome back
        </Text>

        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard
              title="Outstanding"
              value={formatINR(data?.outstandingAmount)}
              color={accent.orange}
            />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard
              title="Overdue"
              value={formatINR(data?.overdueAmount)}
              color={accent.red}
            />
          </View>
        </View>

        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard
              title="Total Orders"
              value={data?.totalOrders ?? 0}
              color={accent.blue}
            />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard
              title="Pending"
              value={data?.pendingOrders ?? 0}
              color={accent.orange}
            />
          </View>
        </View>

        <MetricCard
          title="Empty Cylinders With You"
          value={data?.emptyCylinders ?? 0}
          color={accent.green}
          subtitle="Return on next delivery"
        />

        {/* Recent Orders */}
        <View style={{ marginTop: 8 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 12 }}>
            Recent Orders
          </Text>
          {data?.recentOrders?.length ? (
            data.recentOrders.map((order) => {
              const badge = getBadgeColors(getOrderBadgeVariant(order.status), dark);
              return (
                <View
                  key={order.orderId}
                  style={{
                    backgroundColor: colors.cardBg,
                    borderRadius: 12,
                    padding: 14,
                    marginBottom: 8,
                    borderWidth: 1,
                    borderColor: colors.cardBorder,
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <View>
                    <Text style={{ fontWeight: '600', color: colors.text }}>
                      {order.orderNumber}
                    </Text>
                    <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                      {formatDate(order.deliveryDate)}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ fontWeight: '700', color: colors.text }}>
                      {formatINR(order.totalAmount)}
                    </Text>
                    <Text
                      style={{
                        fontSize: 11,
                        fontWeight: '600',
                        marginTop: 2,
                        color: badge.text,
                      }}
                    >
                      {(order.status || '').replace(/_/g, ' ').toUpperCase()}
                    </Text>
                  </View>
                </View>
              );
            })
          ) : (
            <Text style={{ color: colors.textMuted, textAlign: 'center' }}>No recent orders</Text>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
