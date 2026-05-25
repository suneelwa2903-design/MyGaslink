import { useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApiQuery } from '../../src/hooks/useApi';
import { MetricCard, Card } from '../../src/components/ui';
import { useTheme, formatINR } from '../../src/theme';

// Uniform height so all four Current Status cards line up regardless of content.
const CARD_MIN_HEIGHT = 116;

interface CustomerDashboard {
  // Always-current (state)
  outstandingAmount: number;
  overdueAmount: number;
  pendingOrders: number;
  emptyCylinders: number;
  emptiesByType: Array<{ cylinderTypeName: string; capacity: number; withCustomerQty: number }>;
  // Date-filtered (activity within range)
  totalOrders: number;
  ordersDelivered: number;
  amountDelivered: number;
  paymentsReceived: number;
  range: { from: string; to: string };
}

function firstOfMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0];
}

export default function CustomerDashboardScreen() {
  const { colors, accent } = useTheme();

  // Activity date range — defaults to the current month (1st → today).
  const [fromDate, setFromDate] = useState(firstOfMonth);
  const [toDate, setToDate] = useState(() => new Date().toISOString().split('T')[0]);

  const { data, isLoading, refetch } = useApiQuery<CustomerDashboard>(
    ['customer-dashboard', fromDate, toDate],
    '/customer-portal/dashboard',
    { from: fromDate, to: toDate },
  );

  // FIX 3: show ALL non-zero balances (including negatives, where the customer
  // has returned more empties than cylinders received), and derive the headline
  // total from exactly these rows so the number always equals the breakdown sum.
  const emptiesWithYou = (data?.emptiesByType ?? []).filter((t) => t.withCustomerQty !== 0);
  const emptiesTotal = emptiesWithYou.reduce((sum, t) => sum + t.withCustomerQty, 0);

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
            <MetricCard title="Outstanding" value={formatINR(data?.outstandingAmount)} color={accent.orange} minHeight={CARD_MIN_HEIGHT} />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard title="Overdue" value={formatINR(data?.overdueAmount)} color={accent.red} minHeight={CARD_MIN_HEIGHT} />
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard title="Pending Orders" value={data?.pendingOrders ?? 0} color={accent.blue} minHeight={CARD_MIN_HEIGHT} />
          </View>
          <View style={{ flex: 1 }}>
            <Card style={{ minHeight: CARD_MIN_HEIGHT }}>
              <Text style={{ fontSize: 13, color: colors.textSecondary, fontWeight: '500' }}>
                Empty Cylinders With You
              </Text>
              {emptiesWithYou.length > 0 ? (
                <>
                  <Text style={{ fontSize: 24, fontWeight: '700', color: accent.green, marginTop: 4 }}>
                    {emptiesTotal}
                  </Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 }}>
                    {emptiesWithYou.map((t) => (
                      <Text
                        key={t.cylinderTypeName}
                        style={{ fontSize: 12, color: t.withCustomerQty < 0 ? accent.orange : colors.textSecondary, width: '50%', marginTop: 2 }}
                      >
                        {t.cylinderTypeName}: {t.withCustomerQty}
                        {t.withCustomerQty < 0 ? ' (excess returned)' : ''}
                      </Text>
                    ))}
                  </View>
                </>
              ) : (
                <Text style={{ fontSize: 13, color: colors.textMuted, marginTop: 8 }}>
                  0 — All cylinders returned
                </Text>
              )}
            </Card>
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
            <MetricCard title="Orders" value={data?.totalOrders ?? 0} color={accent.blue} minHeight={CARD_MIN_HEIGHT} />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard title="Delivered" value={data?.ordersDelivered ?? 0} color={accent.green} minHeight={CARD_MIN_HEIGHT} />
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard title="Amount Delivered" value={formatINR(data?.amountDelivered)} color={accent.purple} minHeight={CARD_MIN_HEIGHT} />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard title="Payments Made" value={formatINR(data?.paymentsReceived)} color={accent.green} minHeight={CARD_MIN_HEIGHT} />
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
