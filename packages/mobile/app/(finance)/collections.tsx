import { View, Text, FlatList, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApiQuery } from '../../src/hooks/useApi';
import { useTheme, formatINR } from '../../src/theme';
import { Card, Badge, MetricCard, EmptyState } from '../../src/components/ui';
import type { CollectionsDashboard } from '@gaslink/shared';

export default function FinanceCollectionsScreen() {
  const { colors, accent } = useTheme();

  const { data: collections, isLoading, refetch } = useApiQuery<CollectionsDashboard[]>(
    ['fin-collections'],
    '/analytics/collections',
  );

  const sorted = [...(collections ?? [])].sort((a, b) => (b.totalDue ?? 0) - (a.totalDue ?? 0));
  const totalDue = sorted.reduce((s, c) => s + (c.totalDue ?? 0), 0);
  const totalOverdue = sorted.reduce((s, c) => s + (c.overdueDue ?? 0), 0);
  const totalMissing = sorted.reduce((s, c) => s + (c.missingCylinderValue ?? 0), 0);
  const customersWithDues = sorted.filter((c) => (c.totalDue ?? 0) > 0).length;

  const renderHeader = () => (
    <View style={{ gap: 12, marginBottom: 12 }}>
      <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>Collections</Text>

      {/* Summary Metrics */}
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <MetricCard title="Total Receivable" value={formatINR(totalDue)} color="#f97316" />
        </View>
        <View style={{ flex: 1 }}>
          <MetricCard title="Overdue" value={formatINR(totalOverdue)} color="#ef4444" />
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <MetricCard title="Missing Cylinder Value" value={formatINR(totalMissing)} color={accent.red} />
        </View>
        <View style={{ flex: 1 }}>
          <MetricCard title="Customers" value={customersWithDues} color={accent.blue} subtitle="with outstanding dues" />
        </View>
      </View>

      {/* Section Header */}
      <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 }}>
        All Customers ({sorted.length})
      </Text>
    </View>
  );

  const renderItem = ({ item: c }: { item: CollectionsDashboard }) => {
    const badgeVariant = c.overdueDue > 0 ? 'danger' : c.totalDue > 0 ? 'warning' : 'success';
    const badgeLabel = c.overdueDue > 0 ? `${c.overdueDays}d overdue` : c.totalDue > 0 ? 'Due' : 'Clear';

    return (
      <Card>
        {/* Header */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
          <View style={{ flex: 1, marginRight: 8 }}>
            <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>{c.customerName}</Text>
            {c.lastPaymentDate && (
              <Text style={{ fontSize: 11, color: colors.textSecondary, marginTop: 2 }}>
                Last paid: {c.lastPaymentDate} ({formatINR(c.lastPaymentAmount ?? 0)})
              </Text>
            )}
          </View>
          <Badge label={badgeLabel} variant={badgeVariant} />
        </View>

        {/* Financial Details */}
        <View style={{ gap: 6 }}>
          <DetailRow label="Total Due" value={formatINR(c.totalDue)} valueColor="#f97316" colors={colors} />
          {c.overdueDue > 0 && (
            <DetailRow label="Overdue" value={formatINR(c.overdueDue)} valueColor="#ef4444" colors={colors} />
          )}
          {c.missingCylinders > 0 && (
            <DetailRow
              label="Missing Cylinders"
              value={`${c.missingCylinders} (${formatINR(c.missingCylinderValue)})`}
              valueColor={accent.red}
              colors={colors}
            />
          )}
          {c.excessEmptyCylinders > 0 && (
            <DetailRow label="Excess Empties" value={`${c.excessEmptyCylinders}`} valueColor={accent.orange} colors={colors} />
          )}
        </View>

        {/* Total Collectible */}
        <View style={{
          marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.divider,
          flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>Total Collectible</Text>
          <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text }}>
            {formatINR(c.totalDue + (c.missingCylinderValue ?? 0))}
          </Text>
        </View>

        {/* Credit info */}
        <View style={{ flexDirection: 'row', gap: 12, marginTop: 6 }}>
          <Text style={{ fontSize: 11, color: colors.textMuted }}>Credit: {c.creditPeriodDays}d</Text>
        </View>
      </Card>
    );
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <FlatList
        data={sorted}
        keyExtractor={(c) => c.customerId}
        renderItem={renderItem}
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={<EmptyState title="No collections data" description="No outstanding customer balances" />}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
      />
    </SafeAreaView>
  );
}

function DetailRow({
  label,
  value,
  valueColor,
  colors,
}: {
  label: string;
  value: string;
  valueColor?: string;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={{ fontSize: 13, color: colors.textSecondary }}>{label}</Text>
      <Text style={{ fontSize: 13, fontWeight: '600', color: valueColor || colors.text }}>{value}</Text>
    </View>
  );
}
