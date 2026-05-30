import { View, Text, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { Card, Badge, MetricCard, EmptyState } from '../../src/components/ui';
import { useTheme, formatINR } from '../../src/theme';
import { orderStatusLabel, orderStatusVariant } from '@gaslink/shared';

interface HeaderMetric {
  label: string;
  value: number;
  change?: number;
  changeLabel?: string;
}

interface DashboardData {
  totalOrders?: number;
  pendingOrders?: number;
  deliveredToday?: number;
  totalRevenue?: number;
  totalCustomers?: number;
  activeDrivers?: number;
  closingFulls?: number;
  closingEmpties?: number;
  recentOrders?: { orderId: string; orderNumber: string; customerName: string; status: string; totalAmount: number }[];
}

export default function AnalyticsScreen() {
  const { dark, colors, accent } = useTheme();

  const { data: dashboard, isLoading: dashLoading, refetch: refetchDash } = useApiQuery<DashboardData>(
    ['inv-analytics-dashboard'],
    '/analytics/dashboard',
  );

  const { data: headerMetrics, isLoading: headerLoading, refetch: refetchHeader } = useApiQuery<HeaderMetric[]>(
    ['inv-analytics-header'],
    '/analytics/header-metrics',
  );

  const isLoading = dashLoading || headerLoading;
  const handleRefresh = () => { refetchDash(); refetchHeader(); };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingTop: 12, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={handleRefresh} />}
      >
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
          Analytics
        </Text>

        {/* Header Metrics Row */}
        {headerMetrics && headerMetrics.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingRight: 4 }}>
            {headerMetrics.map((m, i) => (
              <View key={i} style={{
                backgroundColor: colors.cardBg, borderRadius: 14, padding: 14,
                borderWidth: 1, borderColor: colors.cardBorder, minWidth: 130,
              }}>
                <Text style={{ fontSize: 11, color: colors.textSecondary, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.3 }}>
                  {m.label}
                </Text>
                <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginTop: 4 }}>
                  {m.value}
                </Text>
                {m.change !== undefined && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 4 }}>
                    <Ionicons
                      name={m.change >= 0 ? 'trending-up' : 'trending-down'}
                      size={14}
                      color={m.change >= 0 ? accent.green : '#ef4444'}
                    />
                    <Text style={{ fontSize: 11, fontWeight: '600', color: m.change >= 0 ? accent.green : '#ef4444' }}>
                      {Math.abs(m.change)}% {m.changeLabel || ''}
                    </Text>
                  </View>
                )}
              </View>
            ))}
          </ScrollView>
        )}

        {/* Key Metrics Grid */}
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard title="Total Orders" value={dashboard?.totalOrders ?? 0} color={accent.blue} />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard title="Pending" value={dashboard?.pendingOrders ?? 0} color={accent.orange} />
          </View>
        </View>

        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard title="Delivered Today" value={dashboard?.deliveredToday ?? 0} color={accent.green} />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard title="Active Drivers" value={dashboard?.activeDrivers ?? 0} color={accent.purple} />
          </View>
        </View>

        {/* Inventory Snapshot */}
        <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 }}>
          Inventory Snapshot
        </Text>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard title="Closing Full" value={dashboard?.closingFulls ?? 0} color={accent.green} />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard title="Closing Empty" value={dashboard?.closingEmpties ?? 0} color={accent.blue} />
          </View>
        </View>

        {/* Revenue */}
        {(dashboard?.totalRevenue ?? 0) > 0 && (
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{
                width: 44, height: 44, borderRadius: 12,
                backgroundColor: dark ? 'rgba(16,185,129,0.12)' : '#ecfdf5',
                alignItems: 'center', justifyContent: 'center',
              }}>
                <Ionicons name="cash-outline" size={22} color={accent.green} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, color: colors.textSecondary, fontWeight: '600' }}>Total Revenue</Text>
                <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text }}>{formatINR(dashboard?.totalRevenue ?? 0)}</Text>
              </View>
            </View>
          </Card>
        )}

        {/* Recent Orders */}
        <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 }}>
          Recent Orders
        </Text>

        {(!dashboard?.recentOrders || dashboard.recentOrders.length === 0) ? (
          <EmptyState title="No recent orders" description="Orders will appear here once created" />
        ) : (
          dashboard.recentOrders.slice(0, 5).map((order) => (
            <Card key={order.orderId}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>#{order.orderNumber}</Text>
                  <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>{order.customerName}</Text>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>{formatINR(order.totalAmount)}</Text>
                  {/*
                    Canonical labels from @gaslink/shared. "Pending Assignment"
                    and "Pending Dispatch" are slightly longer than the
                    previous "Pending" / "Dispatch" shorthand — if it ever
                    overflows the metric card layout, prefer a narrower Badge
                    width over re-introducing local labels.
                  */}
                  <Badge variant={orderStatusVariant(order.status)} label={orderStatusLabel(order.status)} />
                </View>
              </View>
            </Card>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

