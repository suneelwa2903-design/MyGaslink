import { View, Text, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { Card, Badge, MetricCard, EmptyState } from '../../src/components/ui';
import { useTheme } from '../../src/theme';
import type { InventoryForecast } from '@gaslink/shared';

export default function AlertsForecastScreen() {
  const { dark, colors, accent } = useTheme();

  const { data: alerts, isLoading: alertsLoading, refetch: refetchAlerts } = useApiQuery<any[]>(
    ['threshold-alerts'],
    '/inventory/threshold-alerts',
  );

  const { data: forecasts, isLoading: forecastLoading, refetch: refetchForecasts } = useApiQuery<InventoryForecast[]>(
    ['inventory-forecast'],
    '/inventory/forecast',
  );

  const isLoading = alertsLoading || forecastLoading;
  const handleRefresh = () => { refetchAlerts(); refetchForecasts(); };

  const criticalAlerts = (alerts ?? []).filter((a) => a.severity === 'critical');
  const warningAlerts = (alerts ?? []).filter((a) => a.severity === 'warning' || a.severity !== 'critical');

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={handleRefresh} />}
      >
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
          Alerts & Forecast
        </Text>

        {/* Alert Summary */}
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard
              title="Critical Alerts"
              value={criticalAlerts.length}
              color={criticalAlerts.length > 0 ? '#ef4444' : accent.green}
            />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard
              title="Warnings"
              value={warningAlerts.length}
              color={warningAlerts.length > 0 ? '#d97706' : accent.green}
            />
          </View>
        </View>

        {/* Threshold Alerts */}
        <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8 }}>
          Stock Alerts
        </Text>

        {(!alerts || alerts.length === 0) ? (
          <Card>
            <View style={{ alignItems: 'center', paddingVertical: 20 }}>
              <Ionicons name="checkmark-circle" size={40} color={accent.green} style={{ marginBottom: 8 }} />
              <Text style={{ fontSize: 15, fontWeight: '700', color: accent.green }}>All stock levels healthy</Text>
              <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>No threshold alerts</Text>
            </View>
          </Card>
        ) : (
          alerts.map((alert: any, i: number) => {
            const isCritical = alert.severity === 'critical';
            const alertBg = isCritical
              ? (dark ? 'rgba(220,38,38,0.12)' : '#fef2f2')
              : (dark ? 'rgba(245,158,11,0.12)' : '#fffbeb');

            return (
              <Card key={alert.cylinderTypeId || i}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>
                    {alert.cylinderTypeName}
                  </Text>
                  <Badge
                    label={isCritical ? 'CRITICAL' : 'WARNING'}
                    variant={isCritical ? 'danger' : 'warning'}
                  />
                </View>

                <View style={{ backgroundColor: alertBg, borderRadius: 10, padding: 12, gap: 6 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 13, color: colors.textSecondary }}>Current Stock</Text>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: isCritical ? '#ef4444' : '#d97706' }}>
                      {alert.currentStock ?? alert.closingFulls ?? 0}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 13, color: colors.textSecondary }}>Threshold</Text>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>
                      {alert.threshold ?? alert.thresholdLevel ?? 0}
                    </Text>
                  </View>
                  {alert.message && (
                    <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 4, fontStyle: 'italic' }}>
                      {alert.message}
                    </Text>
                  )}
                </View>
              </Card>
            );
          })
        )}

        {/* Inventory Forecast */}
        <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 12 }}>
          Demand Forecast
        </Text>

        {(!forecasts || forecasts.length === 0) ? (
          <EmptyState title="No forecast data" description="Insufficient data to generate forecasts" />
        ) : (
          forecasts.map((fc) => {
            const daysRemaining = fc.daysOfStockRemaining ?? 0;
            const daysColor = daysRemaining < 3 ? '#ef4444' : daysRemaining < 7 ? '#d97706' : accent.green;

            return (
              <Card key={fc.cylinderTypeId}>
                {/* Header */}
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <Text style={{ fontWeight: '700', fontSize: 16, color: colors.text }}>{fc.cylinderTypeName}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons
                      name={fc.trendDirection === 'increasing' ? 'trending-up' : fc.trendDirection === 'decreasing' ? 'trending-down' : 'remove'}
                      size={18}
                      color={fc.trendDirection === 'increasing' ? accent.green : fc.trendDirection === 'decreasing' ? '#ef4444' : colors.textMuted}
                    />
                    <Badge
                      label={`${daysRemaining.toFixed(0)}d left`}
                      variant={daysRemaining < 3 ? 'danger' : daysRemaining < 7 ? 'warning' : 'success'}
                    />
                  </View>
                </View>

                {/* Days Progress Bar */}
                <View style={{ backgroundColor: dark ? colors.inputBg : '#f1f5f9', borderRadius: 6, height: 8, marginBottom: 12 }}>
                  <View style={{
                    backgroundColor: daysColor,
                    borderRadius: 6, height: 8,
                    width: `${Math.min((daysRemaining / 14) * 100, 100)}%`,
                  }} />
                </View>

                {/* Metrics Grid */}
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <ForecastStat label="Avg Daily" value={(fc.averageDailyDemand ?? 0).toFixed(1)} dark={dark} colors={colors} />
                  <ForecastStat label="7-Day" value={(fc.forecastedDemand7Days ?? 0).toFixed(0)} dark={dark} colors={colors} />
                  <ForecastStat label="Reorder Qty" value={(fc.recommendedReorderQty ?? 0).toString()} highlight dark={dark} colors={colors} />
                  <ForecastStat
                    label="Trend"
                    value={fc.trendDirection === 'increasing' ? 'Rising' : fc.trendDirection === 'decreasing' ? 'Falling' : 'Stable'}
                    valueColor={fc.trendDirection === 'increasing' ? accent.green : fc.trendDirection === 'decreasing' ? '#ef4444' : colors.textSecondary}
                    dark={dark}
                    colors={colors}
                  />
                </View>
              </Card>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ForecastStat({ label, value, highlight, valueColor, dark, colors }: {
  label: string; value: string; highlight?: boolean; valueColor?: string;
  dark: boolean; colors: ReturnType<typeof useTheme>['colors'];
}) {
  const bgColor = highlight
    ? (dark ? 'rgba(59,130,246,0.12)' : '#eef7ff')
    : (dark ? colors.inputBg : '#f8fafc');

  return (
    <View style={{
      flex: 1, minWidth: '45%', backgroundColor: bgColor,
      borderRadius: 10, padding: 10, alignItems: 'center',
    }}>
      <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 2 }}>{label}</Text>
      <Text style={{ fontSize: 16, fontWeight: '700', color: valueColor || (highlight ? '#3b82f6' : colors.text) }}>
        {value}
      </Text>
    </View>
  );
}
