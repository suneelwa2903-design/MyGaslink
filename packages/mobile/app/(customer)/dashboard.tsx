import { useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApiQuery } from '../../src/hooks/useApi';
import { MetricCard } from '../../src/components/ui';
import { useTheme, formatINR, getBadgeColors, formatDate } from '../../src/theme';

interface CustomerDashboard {
  // Always-current (state)
  outstandingAmount: number;
  overdueAmount: number;
  pendingOrders: number;
  emptyCylinders: number;
  // Date-filtered (activity within range)
  totalOrders: number;
  ordersDelivered: number;
  amountDelivered: number;
  paymentsReceived: number;
  range: { from: string; to: string };
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

function firstOfMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0];
}

export default function CustomerDashboardScreen() {
  const { dark, colors, accent } = useTheme();

  // Activity date range — defaults to the current month (1st → today).
  const [fromDate, setFromDate] = useState(firstOfMonth);
  const [toDate, setToDate] = useState(() => new Date().toISOString().split('T')[0]);

  const { data, isLoading, refetch } = useApiQuery<CustomerDashboard>(
    ['customer-dashboard', fromDate, toDate],
    '/customer-portal/dashboard',
    { from: fromDate, to: toDate },
  );

  const dateInputStyle = {
    borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14,
    backgroundColor: colors.inputBg, color: colors.text,
  } as const;

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
      >
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
          Welcome back
        </Text>

        {/* ── Current Status (always current, ignores date range) ── */}
        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 4 }}>
          Current Status
        </Text>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard title="Outstanding" value={formatINR(data?.outstandingAmount)} color={accent.orange} />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard title="Overdue" value={formatINR(data?.overdueAmount)} color={accent.red} />
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard title="Pending Orders" value={data?.pendingOrders ?? 0} color={accent.blue} />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard
              title="Empty Cylinders"
              value={data?.emptyCylinders ?? 0}
              color={accent.green}
              subtitle="With you"
            />
          </View>
        </View>

        {/* ── This Period (date-filtered activity) ── */}
        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 12 }}>
          This Period
        </Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>From</Text>
            <TextInput
              value={fromDate}
              onChangeText={setFromDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={dateInputStyle}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>To</Text>
            <TextInput
              value={toDate}
              onChangeText={setToDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={dateInputStyle}
            />
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard title="Orders" value={data?.totalOrders ?? 0} color={accent.blue} />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard title="Delivered" value={data?.ordersDelivered ?? 0} color={accent.green} />
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard title="Amount Delivered" value={formatINR(data?.amountDelivered)} color={accent.purple} />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard title="Payments Made" value={formatINR(data?.paymentsReceived)} color={accent.green} />
          </View>
        </View>

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
