import { useState, useCallback } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { MetricCard, Card, Badge, EmptyState } from '../../src/components/ui';
import { useTheme, formatINR } from '../../src/theme';
import { useDistributorStore } from '../../src/stores/distributorStore';
import type { DashboardStats, AnalyticsMetrics, Distributor, CollectionsDashboard } from '@gaslink/shared';

// ── Sub-tab types ────────────────────────────────────────────────────────────

type SubTab = 'dashboard' | 'overview' | 'collections' | 'reports';

const SUB_TABS: { label: string; value: SubTab }[] = [
  { label: 'Dashboard', value: 'dashboard' },
  { label: 'Overview', value: 'overview' },
  { label: 'Collections', value: 'collections' },
  { label: 'Reports', value: 'reports' },
];

// ── Pill component ───────────────────────────────────────────────────────────

function Pill({
  label,
  active,
  activeColor,
  inactiveBg,
  inactiveText,
  onPress,
}: {
  label: string;
  active: boolean;
  activeColor: string;
  inactiveBg: string;
  inactiveText: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{
        height: 36,
        paddingHorizontal: 16,
        paddingVertical: 0,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: active ? activeColor : inactiveBg,
      }}
    >
      <Text style={{ fontSize: 13, fontWeight: '600', color: active ? '#fff' : inactiveText }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ── Main Screen ──────────────────────────────────────────────────────────────

export default function AnalyticsScreen() {
  const { dark, colors, accent } = useTheme();
  const [tab, setTab] = useState<SubTab>('dashboard');
  const [showDistPicker, setShowDistPicker] = useState(false);

  const { selectedDistributorId, selectedDistributorName, setSelectedDistributor, clearSelectedDistributor } =
    useDistributorStore();

  // Distributor list for the picker
  const { data: distributorsData } = useApiQuery<{ distributors: Distributor[] } | Distributor[]>(
    ['sa-distributors-list'],
    '/distributors',
  );
  const distributors: Distributor[] = Array.isArray(distributorsData)
    ? distributorsData
    : (distributorsData as any)?.distributors ?? [];

  // Build query params for distributor scoping
  const distParams = selectedDistributorId ? { distributorId: selectedDistributorId } : {};

  // ─ Dashboard data
  const { data: stats, isLoading: dashLoading, refetch: refetchDash } = useApiQuery<DashboardStats>(
    ['sa-dashboard', selectedDistributorId ?? 'all'],
    '/analytics/dashboard',
    distParams,
    { enabled: tab === 'dashboard' },
  );

  // ─ Overview (header metrics)
  const { data: metrics, isLoading: metricsLoading, refetch: refetchMetrics } = useApiQuery<AnalyticsMetrics>(
    ['sa-metrics', selectedDistributorId ?? 'all'],
    '/analytics/header-metrics',
    distParams,
    { enabled: tab === 'overview' || tab === 'dashboard' },
  );

  // ─ Collections
  const { data: collections, isLoading: collectionsLoading, refetch: refetchCollections } = useApiQuery<
    CollectionsDashboard[] | { collections: CollectionsDashboard[] }
  >(
    ['sa-collections', selectedDistributorId ?? 'all'],
    '/analytics/collections',
    distParams,
    { enabled: tab === 'collections' },
  );
  const collectionsList: CollectionsDashboard[] = Array.isArray(collections)
    ? collections
    : (collections as any)?.collections ?? [];

  // ─ Reports
  const { data: reports, isLoading: reportsLoading, refetch: refetchReports } = useApiQuery<{
    revenueByMonth: { month: string; revenue: number }[];
    topCustomers: { customerName: string; revenue: number; orders: number }[];
    driverPerformance: { driverName: string; deliveries: number; onTimeRate: number }[];
    customerLifetimeValue: { customerName: string; totalRevenue: number; totalOrders: number; firstOrderDate: string }[];
  }>(
    ['sa-reports', selectedDistributorId ?? 'all'],
    '/analytics/reports',
    distParams,
    { enabled: tab === 'reports' },
  );

  const handleRefresh = useCallback(() => {
    if (tab === 'dashboard') { refetchDash(); refetchMetrics(); }
    if (tab === 'overview') refetchMetrics();
    if (tab === 'collections') refetchCollections();
    if (tab === 'reports') refetchReports();
  }, [tab, refetchDash, refetchMetrics, refetchCollections, refetchReports]);

  const isLoading = tab === 'dashboard' ? dashLoading : tab === 'overview' ? metricsLoading : tab === 'collections' ? collectionsLoading : reportsLoading;

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* ── Distributor Switcher ─────────────────────────────────────────── */}
      <TouchableOpacity
        onPress={() => setShowDistPicker(!showDistPicker)}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginHorizontal: 16,
          marginTop: 8,
          marginBottom: 4,
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderRadius: 12,
          backgroundColor: dark ? colors.cardBg : colors.inputBg,
          borderWidth: 1,
          borderColor: selectedDistributorId ? accent.red : colors.cardBorder,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
          <Ionicons name="business-outline" size={18} color={selectedDistributorId ? accent.red : colors.textSecondary} />
          <Text
            style={{ fontSize: 14, fontWeight: '600', color: selectedDistributorId ? colors.text : colors.textSecondary }}
            numberOfLines={1}
          >
            {selectedDistributorName ?? 'All Distributors (Platform-wide)'}
          </Text>
        </View>
        <Ionicons name={showDistPicker ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />
      </TouchableOpacity>

      {showDistPicker && (
        <View
          style={{
            marginHorizontal: 16,
            marginBottom: 4,
            backgroundColor: dark ? colors.cardBg : '#fff',
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.cardBorder,
            maxHeight: 220,
          }}
        >
          <ScrollView nestedScrollEnabled>
            {/* Platform-wide option */}
            <TouchableOpacity
              onPress={() => { clearSelectedDistributor(); setShowDistPicker(false); }}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 12,
                borderBottomWidth: 1,
                borderBottomColor: colors.divider,
                backgroundColor: !selectedDistributorId ? (dark ? colors.inputBg : '#f0f9ff') : 'transparent',
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: !selectedDistributorId ? '700' : '500', color: !selectedDistributorId ? accent.blue : colors.text }}>
                All Distributors (Platform-wide)
              </Text>
            </TouchableOpacity>
            {distributors.map((d) => {
              const isSelected = selectedDistributorId === d.distributorId;
              return (
                <TouchableOpacity
                  key={d.distributorId}
                  onPress={() => { setSelectedDistributor(d.distributorId, d.businessName); setShowDistPicker(false); }}
                  style={{
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.divider,
                    backgroundColor: isSelected ? (dark ? colors.inputBg : '#fef2f2') : 'transparent',
                  }}
                >
                  <Text style={{ fontSize: 14, fontWeight: isSelected ? '700' : '500', color: isSelected ? accent.red : colors.text }}>
                    {d.businessName}
                  </Text>
                  {d.state ? (
                    <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 1 }}>{d.state}</Text>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* ── Sub-tab pills ────────────────────────────────────────────────── */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}
      >
        {SUB_TABS.map((t) => (
          <Pill
            key={t.value}
            label={t.label}
            active={tab === t.value}
            activeColor={accent.red}
            inactiveBg={dark ? colors.cardBg : colors.inputBg}
            inactiveText={colors.textSecondary}
            onPress={() => setTab(t.value)}
          />
        ))}
      </ScrollView>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={handleRefresh} />}
      >
        {/* ════ DASHBOARD TAB ════ */}
        {tab === 'dashboard' && (
          <>
            <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
              {selectedDistributorName ? `${selectedDistributorName}` : 'Platform Dashboard'}
            </Text>

            <Text style={sectionLabel(colors)}>Today</Text>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <MetricCard title="Orders" value={stats?.ordersToday ?? 0} color={accent.blue} />
              </View>
              <View style={{ flex: 1 }}>
                <MetricCard title="Delivered" value={stats?.deliveredToday ?? 0} color={accent.green} />
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <MetricCard title="Revenue" value={formatINR(stats?.revenueToday)} color={accent.green} />
              </View>
              <View style={{ flex: 1 }}>
                <MetricCard title="Pending" value={stats?.pendingOrders ?? 0} color={accent.orange} />
              </View>
            </View>

            <Text style={sectionLabel(colors)}>System Health</Text>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <MetricCard title="Overdue Invoices" value={stats?.overdueInvoices ?? 0} color={accent.red} />
              </View>
              <View style={{ flex: 1 }}>
                <MetricCard title="Inventory Alerts" value={stats?.inventoryAlerts ?? 0} color={accent.orange} />
              </View>
            </View>
            <MetricCard
              title="Pending Actions"
              value={stats?.pendingActions ?? 0}
              color={accent.orange}
              subtitle="Require attention"
            />
          </>
        )}

        {/* ════ OVERVIEW TAB ════ */}
        {tab === 'overview' && (
          <>
            <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
              Financial Overview
            </Text>

            {metricsLoading ? (
              <ActivityIndicator size="large" color={accent.red} style={{ marginTop: 40 }} />
            ) : !metrics ? (
              <EmptyState title="No data" description="Metrics not available" />
            ) : (
              <>
                <Text style={sectionLabel(colors)}>Financial Health</Text>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <MetricCard title="Outstanding" value={formatINR(metrics.dueAmount)} color={accent.orange} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <MetricCard title="Overdue" value={formatINR(metrics.overdueAmount)} color={accent.red} />
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <MetricCard title="Capital in Market" value={formatINR(metrics.amountInMarket)} color={accent.purple} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <MetricCard title="Collected" value={formatINR(metrics.collectedAmount)} color={accent.green} />
                  </View>
                </View>

                <Text style={sectionLabel(colors)}>Efficiency</Text>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <MetricCard
                      title="Cylinder Utilization"
                      value={`${((metrics.cylinderUtilizationRate ?? 0) * 100).toFixed(0)}%`}
                      color={accent.blue}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <MetricCard
                      title="Avg Turnaround"
                      value={`${(metrics.averageTurnaroundDays ?? 0).toFixed(1)}d`}
                      color={accent.purple}
                    />
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <MetricCard
                      title="Shrinkage"
                      value={`${((metrics.inventoryShrinkage ?? 0) * 100).toFixed(1)}%`}
                      color={(metrics.inventoryShrinkage ?? 0) > 0.02 ? accent.red : accent.green}
                      subtitle={(metrics.inventoryShrinkage ?? 0) > 0.02 ? 'Above threshold' : 'Normal'}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <MetricCard
                      title="Delivery Efficiency"
                      value={`${((metrics.deliveryEfficiency ?? 0) * 100).toFixed(0)}%`}
                      color={accent.green}
                    />
                  </View>
                </View>
              </>
            )}
          </>
        )}

        {/* ════ COLLECTIONS TAB ════ */}
        {tab === 'collections' && (
          <>
            <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
              Collections
            </Text>

            {collectionsLoading ? (
              <ActivityIndicator size="large" color={accent.red} style={{ marginTop: 40 }} />
            ) : collectionsList.length === 0 ? (
              <EmptyState title="No collections" description="No collection data available" />
            ) : (
              collectionsList.map((c: any, i: number) => (
                <Card key={c.customerId ?? i} style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text, flex: 1 }} numberOfLines={1}>
                      {c.customerName ?? c.distributorName ?? `Entry ${i + 1}`}
                    </Text>
                    <Text style={{ fontWeight: '800', fontSize: 15, color: accent.green }}>
                      {formatINR(c.collected ?? c.totalCollected ?? 0)}
                    </Text>
                  </View>
                  {(c.outstanding != null || c.totalOutstanding != null) && (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
                      <Text style={{ fontSize: 13, color: colors.textSecondary }}>Outstanding</Text>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: accent.orange }}>
                        {formatINR(c.outstanding ?? c.totalOutstanding ?? 0)}
                      </Text>
                    </View>
                  )}
                </Card>
              ))
            )}
          </>
        )}

        {/* ════ REPORTS TAB ════ */}
        {tab === 'reports' && (
          <>
            <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
              Reports
            </Text>

            {reportsLoading ? (
              <ActivityIndicator size="large" color={accent.red} style={{ marginTop: 40 }} />
            ) : !reports ? (
              <EmptyState title="No reports" description="Report data not available" />
            ) : (
              <>
                {/* Revenue by Month */}
                {reports.revenueByMonth && reports.revenueByMonth.length > 0 && (
                  <>
                    <Text style={sectionLabel(colors)}>Revenue by Month</Text>
                    {reports.revenueByMonth.map((r) => (
                      <Card key={r.month} style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text style={{ fontWeight: '600', fontSize: 14, color: colors.text }}>{r.month}</Text>
                          <Text style={{ fontWeight: '800', fontSize: 15, color: accent.green }}>{formatINR(r.revenue)}</Text>
                        </View>
                      </Card>
                    ))}
                  </>
                )}

                {/* Top Customers */}
                {reports.topCustomers && reports.topCustomers.length > 0 && (
                  <>
                    <Text style={sectionLabel(colors)}>Top Customers</Text>
                    {reports.topCustomers.slice(0, 10).map((c, i) => (
                      <Card key={c.customerName + i} style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontWeight: '700', fontSize: 14, color: colors.text }} numberOfLines={1}>
                              {c.customerName}
                            </Text>
                            <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                              {c.orders} orders
                            </Text>
                          </View>
                          <Text style={{ fontWeight: '800', fontSize: 15, color: accent.green }}>{formatINR(c.revenue)}</Text>
                        </View>
                      </Card>
                    ))}
                  </>
                )}

                {/* Driver Performance */}
                {reports.driverPerformance && reports.driverPerformance.length > 0 && (
                  <>
                    <Text style={sectionLabel(colors)}>Driver Performance</Text>
                    {reports.driverPerformance.map((d, i) => (
                      <Card key={d.driverName + i} style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontWeight: '700', fontSize: 14, color: colors.text }}>{d.driverName}</Text>
                            <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                              {d.deliveries} deliveries
                            </Text>
                          </View>
                          <Text style={{ fontWeight: '700', fontSize: 14, color: d.onTimeRate >= 0.9 ? accent.green : accent.orange }}>
                            {(d.onTimeRate * 100).toFixed(0)}% on-time
                          </Text>
                        </View>
                      </Card>
                    ))}
                  </>
                )}
              </>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sectionLabel(colors: any) {
  return {
    fontSize: 14,
    fontWeight: '600' as const,
    color: colors.textSecondary,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    marginTop: 8,
  };
}
