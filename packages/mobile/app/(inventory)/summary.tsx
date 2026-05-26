import { useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { Card, MetricCard, Badge, Button, EmptyState } from '../../src/components/ui';
import { useTheme } from '../../src/theme';
import type { InventorySummary } from '@gaslink/shared';

export default function InventorySummaryScreen() {
  const { dark, colors, accent } = useTheme();
  const today = new Date().toISOString().split('T')[0];
  const [date, setDate] = useState(today);

  const { data: summaries, isLoading, refetch } = useApiQuery<InventorySummary[]>(
    ['inv-summary', date],
    '/inventory/summary',
    { date },
  );

  const lockMutation = useApiMutation<void, { date: string }>(
    'put', '/inventory/lock-summary',
    { invalidateKeys: [['inv-summary', date]], successMessage: 'Inventory locked for the day' },
  );

  const unlockMutation = useApiMutation<void, { date: string }>(
    'post', '/inventory/unlock',
    { invalidateKeys: [['inv-summary', date]], successMessage: 'Inventory unlocked' },
  );

  const totalFulls = summaries?.reduce((s, item) => s + (item.closingFulls ?? 0), 0) ?? 0;
  const totalEmpties = summaries?.reduce((s, item) => s + (item.closingEmpties ?? 0), 0) ?? 0;
  const isLocked = summaries?.some((s) => s.isLocked) ?? false;

  const navigateDate = (dir: -1 | 1) => {
    const d = new Date(date);
    d.setDate(d.getDate() + dir);
    setDate(d.toISOString().split('T')[0]);
  };

  const handleLock = () => {
    Alert.alert(
      'Lock Inventory',
      `Lock inventory for ${date}? This prevents further changes.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Lock', onPress: () => lockMutation.mutate({ date }) },
      ],
    );
  };

  const handleUnlock = () => {
    Alert.alert(
      'Unlock Inventory',
      `Unlock inventory for ${date}? This allows further changes.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Unlock', style: 'destructive', onPress: () => unlockMutation.mutate({ date }) },
      ],
    );
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Date Navigation */}
      <View style={{
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        paddingVertical: 12, gap: 16,
        backgroundColor: dark ? colors.cardBg : '#fff',
        borderBottomWidth: 1, borderBottomColor: colors.divider,
      }}>
        <TouchableOpacity onPress={() => navigateDate(-1)} style={{ padding: 8 }}>
          <Ionicons name="chevron-back" size={22} color={accent.red} />
        </TouchableOpacity>
        <View style={{ alignItems: 'center' }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>{date}</Text>
          {date === today && <Text style={{ fontSize: 11, color: accent.green, fontWeight: '600' }}>Today</Text>}
        </View>
        <TouchableOpacity onPress={() => navigateDate(1)} style={{ padding: 8 }} disabled={date >= today}>
          <Ionicons name="chevron-forward" size={22} color={date >= today ? colors.textMuted : accent.red} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingTop: 12, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
      >
        {/* Top Metrics */}
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard title="Closing Full" value={totalFulls} color={accent.green} />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard title="Closing Empty" value={totalEmpties} color={accent.blue} />
          </View>
        </View>

        {/* Lock/Unlock Button */}
        {summaries && summaries.length > 0 && (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {isLocked ? (
              <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{
                  flex: 1, borderRadius: 12, padding: 12,
                  backgroundColor: dark ? 'rgba(16,185,129,0.15)' : '#ecfdf5',
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}>
                  <Ionicons name="lock-closed" size={16} color={accent.green} />
                  <Text style={{ fontSize: 13, fontWeight: '700', color: dark ? '#34d399' : '#059669' }}>Day Locked</Text>
                </View>
                <Button title="Unlock" variant="secondary" size="sm" onPress={handleUnlock} loading={unlockMutation.isPending} />
              </View>
            ) : (
              <View style={{ flex: 1 }}>
                <Button title="Lock Day" variant="accent" onPress={handleLock} loading={lockMutation.isPending} />
              </View>
            )}
          </View>
        )}

        {/* Per Cylinder Type */}
        <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 }}>
          By Cylinder Type
        </Text>

        {(!summaries || summaries.length === 0) ? (
          <EmptyState title="No inventory data" description="No inventory records for this date" />
        ) : (
          summaries.map((item) => {
            const isWarning = (item.thresholdWarning ?? 0) > 0 && (item.closingFulls ?? 0) <= (item.thresholdWarning ?? 0);
            const isCritical = (item.thresholdCritical ?? 0) > 0 && (item.closingFulls ?? 0) <= (item.thresholdCritical ?? 0);

            return (
              <Card key={item.cylinderTypeId}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <Text style={{ fontWeight: '700', fontSize: 16, color: colors.text }}>{item.cylinderTypeName}</Text>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    {item.isLocked && <Badge label="LOCKED" variant="success" />}
                    {isCritical ? (
                      <Badge label="CRITICAL" variant="danger" />
                    ) : isWarning ? (
                      <Badge label="LOW" variant="warning" />
                    ) : (
                      <Badge label="OK" variant="success" />
                    )}
                  </View>
                </View>

                {/* Full Cylinder Flow */}
                <View style={{ backgroundColor: dark ? colors.inputBg : '#f8fafc', borderRadius: 10, padding: 12, gap: 6 }}>
                  <FlowRow label="Opening Full" value={item.openingFulls} color={colors.textSecondary} dark={dark} />
                  <FlowRow label="+ Incoming" value={item.incomingFulls} color={accent.green} plus dark={dark} />
                  <FlowRow label="- Delivered" value={item.deliveredQty} color="#ef4444" minus dark={dark} />
                  <FlowRow label="+ Cancelled Return" value={item.cancelledStockQty} color={accent.orange} plus dark={dark} />
                  <FlowRow label="± Manual Adj." value={item.manualAdjustment} color={accent.purple} dark={dark} />
                  <View style={{ borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 6, marginTop: 2 }}>
                    <FlowRow label="= Closing Full" value={item.closingFulls} color={colors.text} bold dark={dark} />
                  </View>
                </View>

                {/* Empty Cylinder Flow */}
                <View style={{ flexDirection: 'row', gap: 12, marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: dark ? colors.divider : '#f1f5f9' }}>
                  <MiniStat label="Open Empty" value={item.openingEmpties} dark={dark} />
                  <MiniStat label="Collected" value={item.collectedEmpties} color={accent.green} prefix="+" dark={dark} />
                  <MiniStat label="Sent Out" value={item.outgoingEmpties} color="#ef4444" prefix="-" dark={dark} />
                  <MiniStat label="Close Empty" value={item.closingEmpties} bold dark={dark} />
                </View>
              </Card>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function FlowRow({ label, value, color, bold, plus, minus, dark }: {
  label: string; value: number; color: string; bold?: boolean; plus?: boolean; minus?: boolean; dark: boolean;
}) {
  const prefix = plus ? '+' : minus ? '-' : '';
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={{ fontSize: 13, color: dark ? '#94a3b8' : '#64748b' }}>{label}</Text>
      <Text style={{ fontSize: 13, fontWeight: bold ? '700' : '500', color }}>
        {prefix}{Math.abs(value)}
      </Text>
    </View>
  );
}

function MiniStat({ label, value, color, prefix, bold, dark }: {
  label: string; value: number; color?: string; prefix?: string; bold?: boolean; dark: boolean;
}) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ fontSize: 11, color: dark ? '#94a3b8' : '#64748b' }}>{label}</Text>
      <Text style={{ fontWeight: bold ? '700' : '600', color: color || (dark ? '#f1f5f9' : '#0f172a') }}>
        {prefix || ''}{Math.abs(value)}
      </Text>
    </View>
  );
}
