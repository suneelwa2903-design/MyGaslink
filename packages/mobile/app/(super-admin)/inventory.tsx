import { useState, useCallback } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApiQuery } from '../../src/hooks/useApi';
import { Card, MetricCard, Badge, EmptyState } from '../../src/components/ui';
import { useTheme, type ThemeColors } from '../../src/theme';
import { useDistributorStore } from '../../src/stores/distributorStore';
import type { InventorySummary, InventoryForecast } from '@gaslink/shared';

// The super-admin inventory endpoints return a few extra (un-typed-in-shared)
// fields the screen renders defensively. Model them as optional extensions so
// the access sites stay type-checked without an `any`.
type InventorySummaryRow = InventorySummary & {
  cylinderTypeId?: string;
  name?: string;
  weightKg?: number;
  inTransit?: number;
  withCustomers?: number;
};

type InventoryForecastRow = InventoryForecast & {
  avgDailyUsage?: number;
  daysUntilEmpty?: number;
  reorderDate?: string;
};

interface ThresholdAlert {
  alertId?: string;
  cylinderTypeName?: string;
  message?: string;
  severity?: string;
  currentLevel?: number;
  threshold?: number;
}

// ── Sub-tabs ─────────────────────────────────────────────────────────────────

type SubTab = 'summary' | 'forecast' | 'alerts';

const SUB_TABS: { label: string; value: SubTab }[] = [
  { label: 'Summary', value: 'summary' },
  { label: 'Forecast', value: 'forecast' },
  { label: 'Alerts', value: 'alerts' },
];

// ── Pill ─────────────────────────────────────────────────────────────────────

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

export default function InventoryScreen() {
  const { dark, colors, accent } = useTheme();
  const [tab, setTab] = useState<SubTab>('summary');
  const { selectedDistributorId } = useDistributorStore();

  const distParams = selectedDistributorId ? { distributorId: selectedDistributorId } : {};

  // Summary
  const { data: summaryData, isLoading: summaryLoading, refetch: refetchSummary } = useApiQuery<
    InventorySummaryRow[] | { summary: InventorySummaryRow[] }
  >(
    ['sa-inventory-summary', selectedDistributorId ?? 'all'],
    '/inventory/summary',
    distParams,
    { enabled: tab === 'summary' },
  );
  const summary: InventorySummaryRow[] = Array.isArray(summaryData)
    ? summaryData
    : summaryData?.summary ?? [];

  // Forecast
  const { data: forecastData, isLoading: forecastLoading, refetch: refetchForecast } = useApiQuery<
    InventoryForecastRow[] | { forecast: InventoryForecastRow[] }
  >(
    ['sa-inventory-forecast', selectedDistributorId ?? 'all'],
    '/inventory/forecast',
    distParams,
    { enabled: tab === 'forecast' },
  );
  const forecast: InventoryForecastRow[] = Array.isArray(forecastData)
    ? forecastData
    : forecastData?.forecast ?? [];

  // Threshold alerts
  const { data: alertsData, isLoading: alertsLoading, refetch: refetchAlerts } = useApiQuery<
    ThresholdAlert[] | { alerts: ThresholdAlert[] }
  >(
    ['sa-inventory-alerts', selectedDistributorId ?? 'all'],
    '/inventory/threshold-alerts',
    distParams,
    { enabled: tab === 'alerts' },
  );
  const alerts: ThresholdAlert[] = Array.isArray(alertsData)
    ? alertsData
    : alertsData?.alerts ?? [];

  const isLoading = tab === 'summary' ? summaryLoading : tab === 'forecast' ? forecastLoading : alertsLoading;

  const handleRefresh = useCallback(() => {
    if (tab === 'summary') refetchSummary();
    if (tab === 'forecast') refetchForecast();
    if (tab === 'alerts') refetchAlerts();
  }, [tab, refetchSummary, refetchForecast, refetchAlerts]);

  // Aggregate totals for the summary
  const totalFull = summary.reduce((s, r) => s + (r.closingFulls ?? 0), 0);
  const totalEmpty = summary.reduce((s, r) => s + (r.closingEmpties ?? 0), 0);
  const totalInTransit = summary.reduce((s, r) => s + (r.inTransit ?? 0), 0);

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Sub-tab pills */}
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

      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={handleRefresh} />}
      >
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
          Inventory
        </Text>

        {/* ════ SUMMARY TAB ════ */}
        {tab === 'summary' && (
          <>
            {/* Top-level metrics */}
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <MetricCard title="Full Cylinders" value={totalFull} color={accent.green} />
              </View>
              <View style={{ flex: 1 }}>
                <MetricCard title="Empty Cylinders" value={totalEmpty} color={accent.orange} />
              </View>
            </View>
            {totalInTransit > 0 && (
              <MetricCard title="In Transit" value={totalInTransit} color={accent.blue} />
            )}

            {/* Per-cylinder-type breakdown */}
            {summaryLoading && summary.length === 0 ? (
              <ActivityIndicator size="large" color={accent.red} style={{ marginTop: 20 }} />
            ) : summary.length === 0 ? (
              <EmptyState title="No inventory data" description="Inventory summary not available" />
            ) : (
              <>
                <Text style={sectionLabel(colors)}>By Cylinder Type</Text>
                {summary.map((item, i) => (
                  <Card key={item.cylinderTypeId ?? i} style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
                    <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text, marginBottom: 8 }}>
                      {item.cylinderTypeName ?? item.name ?? `Type ${i + 1}`}
                      {item.weightKg ? ` (${item.weightKg}kg)` : ''}
                    </Text>
                    <View style={{ backgroundColor: dark ? colors.inputBg : colors.cardBg, borderRadius: 10, padding: 10, gap: 6 }}>
                      <Row label="Full" value={String(item.closingFulls ?? 0)} color={accent.green} colors={colors} />
                      <Row label="Empty" value={String(item.closingEmpties ?? 0)} color={accent.orange} colors={colors} />
                      {item.inTransit != null && (
                        <Row label="In Transit" value={String(item.inTransit)} color={accent.blue} colors={colors} />
                      )}
                      {item.withCustomers != null && (
                        <Row label="With Customers" value={String(item.withCustomers)} color={accent.purple} colors={colors} />
                      )}
                    </View>
                  </Card>
                ))}
              </>
            )}
          </>
        )}

        {/* ════ FORECAST TAB ════ */}
        {tab === 'forecast' && (
          <>
            {forecastLoading ? (
              <ActivityIndicator size="large" color={accent.red} style={{ marginTop: 40 }} />
            ) : forecast.length === 0 ? (
              <EmptyState title="No forecast data" description="Inventory forecast not available" />
            ) : (
              forecast.map((f: InventoryForecastRow, i: number) => (
                <Card key={f.cylinderTypeId ?? i} style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
                  <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text, marginBottom: 6 }}>
                    {f.cylinderTypeName ?? `Type ${i + 1}`}
                  </Text>
                  <View style={{ backgroundColor: dark ? colors.inputBg : colors.cardBg, borderRadius: 10, padding: 10, gap: 6 }}>
                    {f.currentStock != null && <Row label="Current Stock" value={String(f.currentStock)} color={accent.green} colors={colors} />}
                    {f.avgDailyUsage != null && <Row label="Avg Daily Usage" value={f.avgDailyUsage.toFixed(1)} color={accent.blue} colors={colors} />}
                    {f.daysUntilEmpty != null && (
                      <Row
                        label="Days Until Empty"
                        value={String(f.daysUntilEmpty)}
                        color={f.daysUntilEmpty <= 3 ? accent.red : f.daysUntilEmpty <= 7 ? accent.orange : accent.green}
                        colors={colors}
                      />
                    )}
                    {f.reorderDate && <Row label="Reorder Date" value={f.reorderDate} color={colors.text} colors={colors} />}
                  </View>
                </Card>
              ))
            )}
          </>
        )}

        {/* ════ ALERTS TAB ════ */}
        {tab === 'alerts' && (
          <>
            {alertsLoading ? (
              <ActivityIndicator size="large" color={accent.red} style={{ marginTop: 40 }} />
            ) : alerts.length === 0 ? (
              <EmptyState title="No alerts" description="All inventory levels are healthy" />
            ) : (
              alerts.map((alert: ThresholdAlert, i: number) => (
                <Card key={alert.alertId ?? i} style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                    <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text, flex: 1 }} numberOfLines={1}>
                      {alert.cylinderTypeName ?? alert.message ?? `Alert ${i + 1}`}
                    </Text>
                    <Badge
                      label={alert.severity ?? 'warning'}
                      variant={alert.severity === 'critical' ? 'danger' : alert.severity === 'high' ? 'danger' : 'warning'}
                    />
                  </View>
                  {alert.message && (
                    <Text style={{ fontSize: 13, color: colors.textSecondary }}>{alert.message}</Text>
                  )}
                  {alert.currentLevel != null && alert.threshold != null && (
                    <View style={{ flexDirection: 'row', gap: 16, marginTop: 8 }}>
                      <View>
                        <Text style={{ fontSize: 11, color: colors.textSecondary }}>Current</Text>
                        <Text style={{ fontWeight: '700', fontSize: 14, color: accent.red }}>{alert.currentLevel}</Text>
                      </View>
                      <View>
                        <Text style={{ fontSize: 11, color: colors.textSecondary }}>Threshold</Text>
                        <Text style={{ fontWeight: '700', fontSize: 14, color: accent.orange }}>{alert.threshold}</Text>
                      </View>
                    </View>
                  )}
                </Card>
              ))
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function Row({ label, value, color, colors }: { label: string; value: string; color: string; colors: ThemeColors }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <Text style={{ fontSize: 13, color: colors.textSecondary }}>{label}</Text>
      <Text style={{ fontSize: 14, fontWeight: '700', color }}>{value}</Text>
    </View>
  );
}

function sectionLabel(colors: ThemeColors) {
  return {
    fontSize: 14,
    fontWeight: '600' as const,
    color: colors.textSecondary,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    marginTop: 8,
  };
}
