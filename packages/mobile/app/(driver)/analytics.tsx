import { useState } from 'react';
import { View, Text, ScrollView, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { Card, MetricCard, DateInput, MIN_DATE_FLOOR, todayLocalIso, Button } from '../../src/components/ui';
import { useTheme, ACCENT, formatINR } from '../../src/theme';
import type { Order } from '@gaslink/shared';
import { Badge } from '../../src/components/ui';
import { orderStatusLabel, orderStatusVariant } from '@gaslink/shared';

// WI-PENDING-PAYMENTS post-smoke FIX-C: wire shape returned by
// GET /api/drivers/me/payment-submissions for the recent-submissions
// block under My Performance.
interface RecentSubmission {
  submissionId: string;
  customerName?: string;
  customer?: { customerName: string };
  amount: number;
  paymentMethod: string;
  status: 'pending_verification' | 'verified' | 'rejected';
  transactionDate: string;
  rejectionReason?: string | null;
}

const SUBMISSION_STATUS_LABEL = {
  pending_verification: 'Pending',
  verified: 'Verified',
  rejected: 'Rejected',
} as const;

const SUBMISSION_STATUS_VARIANT: Record<string, 'warning' | 'success' | 'danger'> = {
  pending_verification: 'warning',
  verified: 'success',
  rejected: 'danger',
};

interface DriverPerformanceRow {
  driverId: string;
  driverName: string;
  totalOrders: number;
  deliveredOrders: number;
  cancelledOrders: number;
  deliveryRate: number;
}

/** Returns a YYYY-MM-DD string for a date offset by `offsetDays` from today. */
function offsetDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export default function DriverAnalyticsScreen() {
  const { colors } = useTheme();
  const router = useRouter();

  const [dateFrom, setDateFrom] = useState<string>(() => offsetDate(-7));
  const [dateTo, setDateTo] = useState<string>(() => offsetDate(0));

  const {
    data: perfData,
    isLoading: metricsLoading,
    refetch: refetchMetrics,
  } = useApiQuery<DriverPerformanceRow[]>(
    ['driver-analytics-performance', dateFrom, dateTo],
    '/analytics/driver-performance',
    { dateFrom, dateTo },
  );

  // data[0] may be undefined when date range has no activity
  const perf = perfData?.[0];

  // WI-PENDING-PAYMENTS post-smoke FIX-C: limit reduced from 10 → 7 so
  // the Recent Payments Submitted block above doesn't get pushed off
  // the visible viewport on smaller phones.
  const { data: recentOrdersResponse, isLoading: ordersLoading, refetch: refetchOrders } = useApiQuery<{ orders: Order[] }>(
    ['driver-recent-deliveries'],
    '/orders',
    { limit: 7 },
  );
  const recentOrders: Order[] = recentOrdersResponse?.orders ?? [];

  // WI-PENDING-PAYMENTS post-smoke FIX-C: last 5 payment submissions
  // by this driver — render under "My Performance" with a +Add Payment
  // CTA that routes to submit-payment WITHOUT a customer param (the
  // screen has a picker mode for that case).
  const { data: submissionsResponse, isLoading: submissionsLoading, refetch: refetchSubmissions } = useApiQuery<{
    submissions: RecentSubmission[];
  }>(
    ['driver-submissions-recent'],
    '/drivers/me/payment-submissions',
    { pageSize: 5 },
  );
  const recentSubmissions: RecentSubmission[] = submissionsResponse?.submissions ?? [];

  const isLoading = metricsLoading || ordersLoading || submissionsLoading;

  const refetch = () => {
    refetchMetrics();
    refetchOrders();
    refetchSubmissions();
  };

  const metricCards = [
    {
      title: 'Delivered',
      value: perf?.deliveredOrders ?? 0,
      color: ACCENT.green,
    },
    {
      title: 'Cancelled',
      value: perf?.cancelledOrders ?? 0,
      color: ACCENT.orange,
    },
    {
      title: 'Total Orders',
      value: perf?.totalOrders ?? 0,
      color: ACCENT.blue,
    },
    {
      title: 'Delivery Rate',
      value: perf != null ? `${perf.deliveryRate.toFixed(1)}%` : '--',
      color: ACCENT.purple,
    },
  ];


  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
      >
        <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 4 }}>
          My Performance
        </Text>

        {/* Date range filters — P1-3 sweep (2026-06-09): native DateInput
            with min/max constraints prevents the From > To inversion that
            the prior text inputs allowed (and silently produced an empty
            result set with no UI signal). */}
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            <DateInput
              label="From"
              value={dateFrom}
              onChange={setDateFrom}
              minDate={MIN_DATE_FLOOR}
              maxDate={dateTo || todayLocalIso()}
            />
          </View>
          <View style={{ flex: 1 }}>
            <DateInput
              label="To"
              value={dateTo}
              onChange={setDateTo}
              minDate={dateFrom || MIN_DATE_FLOOR}
              maxDate={todayLocalIso()}
            />
          </View>
        </View>

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

        {/* WI-PENDING-PAYMENTS post-smoke FIX-C: Recent Payments Submitted
            block. Lives at the bottom of "My Performance" because tracking
            how many of your self-reported payments cleared is a
            performance signal for the driver. */}
        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 8 }}>
          Recent Payments Submitted
        </Text>
        {submissionsLoading && recentSubmissions.length === 0 ? (
          <View style={{ paddingVertical: 12, alignItems: 'center' }}>
            <ActivityIndicator size="small" color={ACCENT.red} />
          </View>
        ) : recentSubmissions.length === 0 ? (
          <Card>
            <Text style={{ fontSize: 13, color: colors.textSecondary, textAlign: 'center', paddingVertical: 8 }}>
              No payments submitted yet.
            </Text>
          </Card>
        ) : (
          recentSubmissions.map((s) => (
            <Card key={s.submissionId}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>
                    {s.customer?.customerName ?? s.customerName ?? 'Customer'}
                  </Text>
                  <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                    {formatINR(s.amount)} · {s.paymentMethod.replace(/_/g, ' ')} · {new Date(s.transactionDate).toLocaleDateString('en-IN')}
                  </Text>
                  {s.status === 'rejected' && s.rejectionReason && (
                    <Text style={{ fontSize: 11, color: ACCENT.red, marginTop: 2 }}>
                      {s.rejectionReason}
                    </Text>
                  )}
                </View>
                <Badge
                  label={SUBMISSION_STATUS_LABEL[s.status]}
                  variant={SUBMISSION_STATUS_VARIANT[s.status]}
                />
              </View>
            </Card>
          ))
        )}
        <View style={{ marginTop: 4 }}>
          <Button
            title="+ Add Payment"
            variant="secondary"
            onPress={() => router.push('/(driver)/submit-payment')}
          />
        </View>

        {/* Recent Activity */}
        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 16 }}>
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
                      {order.items.map((item) => {
                        // WI-103: for modified deliveries show the qty actually
                        // delivered, not the ordered qty.
                        const qty = order.status === 'modified_delivered' && item.deliveredQuantity && item.deliveredQuantity > 0
                          ? item.deliveredQuantity
                          : item.quantity;
                        return `${item.cylinderTypeName} x${qty}`;
                      }).join(', ')}
                    </Text>
                  )}
                  {order.items && order.items.reduce((sum, item) => sum + (item.emptiesCollected ?? 0), 0) > 0 && (
                    <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                      {'↩'} {order.items.reduce((sum, item) => sum + (item.emptiesCollected ?? 0), 0)} empties collected
                    </Text>
                  )}
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Badge
                    label={orderStatusLabel(order.status || '')}
                    variant={orderStatusVariant(order.status || '')}
                  />
                  {order.totalAmount != null && (
                    <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>
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
