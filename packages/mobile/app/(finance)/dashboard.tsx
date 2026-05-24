import { useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApiQuery } from '../../src/hooks/useApi';
import { useTheme, formatINR, ACCENT } from '../../src/theme';
import { MetricCard, Card, Badge, EmptyState } from '../../src/components/ui';
import type { AnalyticsMetrics, DashboardStats, CollectionsDashboard } from '@gaslink/shared';

type Tab = 'overview' | 'overdue';

export default function FinanceDashboardScreen() {
  const { dark, colors, accent } = useTheme();
  const [tab, setTab] = useState<Tab>('overview');

  const { data: metrics, isLoading, refetch: refetchMetrics } = useApiQuery<AnalyticsMetrics>(
    ['fin-metrics'],
    '/analytics/header-metrics',
  );

  const { data: stats, refetch: refetchStats } = useApiQuery<DashboardStats>(
    ['fin-stats'],
    '/analytics/dashboard',
  );

  const { data: collections, refetch: refetchCollections } = useApiQuery<CollectionsDashboard[]>(
    ['fin-collections-top'],
    '/analytics/collections',
    {},
    { enabled: tab === 'overview' },
  );

  const handleRefresh = () => { refetchMetrics(); refetchStats(); refetchCollections(); };

  const topOverdue = [...(collections ?? [])].sort((a, b) => (b.overdueDue ?? 0) - (a.overdueDue ?? 0)).slice(0, 5);

  const tabs: { label: string; value: Tab }[] = [
    { label: 'Overview', value: 'overview' },
    { label: 'Overdue Customers', value: 'overdue' },
  ];

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Tab Bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}
      >
        {tabs.map((t) => (
          <TouchableOpacity
            key={t.value}
            onPress={() => setTab(t.value)}
            style={{
              paddingHorizontal: 16,
              height: 36,
              borderRadius: 18,
              justifyContent: 'center',
              backgroundColor: tab === t.value ? accent.red : (dark ? colors.inputBg : '#f1f5f9'),
            }}
          >
            <Text style={{
              fontSize: 13,
              fontWeight: '600',
              color: tab === t.value ? '#fff' : colors.textSecondary,
            }}>
              {t.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={handleRefresh} />}
      >
        {tab === 'overview' && (
          <>
            <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
              Analytics
            </Text>

            {/* Receivables */}
            <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Receivables
            </Text>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <MetricCard title="Total Due" value={formatINR(metrics?.dueAmount)} color={accent.orange} />
              </View>
              <View style={{ flex: 1 }}>
                <MetricCard title="Overdue" value={formatINR(metrics?.overdueAmount)} color="#ef4444" />
              </View>
            </View>

            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <MetricCard title="Collected" value={formatINR(metrics?.collectedAmount)} color={accent.green} />
              </View>
              <View style={{ flex: 1 }}>
                <MetricCard title="Unrecovered" value={formatINR(metrics?.unrecoveredAmount)} color={accent.red} />
              </View>
            </View>

            {/* Capital */}
            <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8 }}>
              Capital
            </Text>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <MetricCard title="In Market" value={formatINR(metrics?.amountInMarket)} color={accent.purple} subtitle="Cylinder value with customers" />
              </View>
              <View style={{ flex: 1 }}>
                <MetricCard title="Total Capital" value={formatINR(metrics?.totalCapital)} color={colors.text} />
              </View>
            </View>

            {/* Health Indicators */}
            <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8 }}>
              Health Indicators
            </Text>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <MetricCard
                  title="Shrinkage"
                  value={`${((metrics?.inventoryShrinkage ?? 0) * 100).toFixed(1)}%`}
                  color={(metrics?.inventoryShrinkage ?? 0) > 0.02 ? '#ef4444' : accent.green}
                  subtitle={(metrics?.inventoryShrinkage ?? 0) > 0.02 ? 'Above 2% threshold' : 'Healthy'}
                />
              </View>
              <View style={{ flex: 1 }}>
                <MetricCard
                  title="Delivery Efficiency"
                  value={`${((metrics?.deliveryEfficiency ?? 0) * 100).toFixed(0)}%`}
                  color={accent.blue}
                />
              </View>
            </View>

            {/* Activity */}
            <View style={{ flexDirection: 'row', gap: 12, marginTop: 4 }}>
              <View style={{ flex: 1 }}>
                <MetricCard title="Overdue Invoices" value={stats?.overdueInvoices ?? 0} color="#ef4444" />
              </View>
              <View style={{ flex: 1 }}>
                <MetricCard title="Pending Actions" value={stats?.pendingActions ?? 0} color={accent.orange} />
              </View>
            </View>

            {/* Top Overdue */}
            {topOverdue.length > 0 && (
              <>
                <Text style={{ fontSize: 14, fontWeight: '600', color: '#ef4444', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8 }}>
                  Top Overdue
                </Text>
                {topOverdue.map((c) => (
                  <Card key={c.customerId}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontWeight: '600', color: colors.text }}>{c.customerName}</Text>
                        <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 1 }}>
                          {c.overdueDays}d overdue
                        </Text>
                      </View>
                      <Text style={{ fontWeight: '800', fontSize: 16, color: '#ef4444' }}>{formatINR(c.overdueDue)}</Text>
                    </View>
                  </Card>
                ))}
              </>
            )}
          </>
        )}

        {tab === 'overdue' && (
          <OverdueCustomersView collections={collections} dark={dark} colors={colors} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function OverdueCustomersView({
  collections,
  dark,
  colors,
}: {
  collections: CollectionsDashboard[] | undefined;
  dark: boolean;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const sorted = [...(collections ?? [])].filter((c) => (c.overdueDue ?? 0) > 0).sort((a, b) => (b.overdueDue ?? 0) - (a.overdueDue ?? 0));

  const overdueCardBg = dark ? 'rgba(220, 38, 38, 0.1)' : '#fef2f2';

  return (
    <>
      <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
        Overdue Customers
      </Text>
      <Text style={{ fontSize: 13, color: colors.textSecondary }}>
        {sorted.length} customer{sorted.length !== 1 ? 's' : ''} with overdue balances
      </Text>

      {sorted.length === 0 ? (
        <EmptyState title="No overdue customers" description="All customers are current on payments" />
      ) : (
        sorted.map((c) => (
          <Card key={c.customerId}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <View style={{ flex: 1, marginRight: 8 }}>
                <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>{c.customerName}</Text>
                {c.lastPaymentDate && (
                  <Text style={{ fontSize: 11, color: colors.textSecondary, marginTop: 2 }}>
                    Last paid: {c.lastPaymentDate}
                  </Text>
                )}
              </View>
              <Badge label={`${c.overdueDays}d`} variant="danger" />
            </View>

            <View style={{ backgroundColor: overdueCardBg, borderRadius: 10, padding: 12, gap: 6 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 13, color: colors.textSecondary }}>Total Due</Text>
                <Text style={{ fontSize: 13, fontWeight: '600', color: '#f97316' }}>{formatINR(c.totalDue)}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 13, color: colors.textSecondary }}>Overdue</Text>
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#ef4444' }}>{formatINR(c.overdueDue)}</Text>
              </View>
              {c.missingCylinders > 0 && (
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 13, color: colors.textSecondary }}>Missing Cylinders</Text>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: ACCENT.red }}>
                    {c.missingCylinders} ({formatINR(c.missingCylinderValue)})
                  </Text>
                </View>
              )}
            </View>

            <View style={{
              marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.divider,
              flexDirection: 'row', justifyContent: 'space-between',
            }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>Total Collectible</Text>
              <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text }}>
                {formatINR(c.totalDue + (c.missingCylinderValue ?? 0))}
              </Text>
            </View>
          </Card>
        ))
      )}
    </>
  );
}
