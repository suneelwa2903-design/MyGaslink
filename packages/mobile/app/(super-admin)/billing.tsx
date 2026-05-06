import { useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { Card, Badge, MetricCard, Button, EmptyState } from '../../src/components/ui';
import { useTheme, formatINR } from '../../src/theme';
import type { BillingCycle } from '@gaslink/shared';

type Tab = 'active' | 'history';

export default function BillingScreen() {
  const { dark, colors, accent } = useTheme();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('active');

  const { data: cyclesData, isLoading, refetch } = useApiQuery<{ cycles: BillingCycle[] } | BillingCycle[]>(
    ['billing-cycles', tab],
    '/billing/cycles',
    tab === 'active' ? { status: 'pending_payment,invoice_generated,overdue' } : {},
  );

  // API may return { cycles: [...] } or [...] directly — handle both
  const cycles: BillingCycle[] = Array.isArray(cyclesData)
    ? cyclesData
    : (cyclesData as any)?.cycles ?? [];

  const markPaid = useApiMutation<BillingCycle, { id: string }>(
    'put',
    (vars) => `/billing/cycles/${vars.id}/mark-paid`,
    { invalidateKeys: [['billing-cycles']], successMessage: 'Marked as paid' },
  );

  const sorted = [...cycles].sort((a, b) =>
    new Date(b.periodStartDate).getTime() - new Date(a.periodStartDate).getTime(),
  );

  const totalPending = sorted
    .filter((c) => c.billingStatus === 'pending_payment' || c.billingStatus === 'invoice_generated')
    .reduce((s, c) => s + (c.totalAmountInclGst ?? 0), 0);

  const totalOverdue = sorted
    .filter((c) => c.billingStatus === 'overdue_billing')
    .reduce((s, c) => s + (c.totalAmountInclGst ?? 0), 0);

  const statusVariant = (s: string) => {
    switch (s) {
      case 'paid_billing': return 'success' as const;
      case 'overdue_billing': case 'suspended_billing': return 'danger' as const;
      case 'pending_payment': case 'invoice_generated': return 'warning' as const;
      default: return 'neutral' as const;
    }
  };

  const handleMarkPaid = (id: string, distributor: string) => {
    Alert.alert('Confirm Payment', `Mark billing for "${distributor}" as paid?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Mark Paid', onPress: () => markPaid.mutate({ id }) },
    ]);
  };

  const tabs: { label: string; value: Tab }[] = [
    { label: 'Active', value: 'active' },
    { label: 'All History', value: 'history' },
  ];

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Header with back button */}
      <View style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.cardBorder,
        backgroundColor: colors.bg,
      }}>
        <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>Billing &amp; Payments</Text>
      </View>

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
              height: 36,
              paddingHorizontal: 16,
              paddingVertical: 0,
              borderRadius: 18,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: tab === t.value ? accent.red : (dark ? colors.cardBg : colors.inputBg),
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: '600', color: tab === t.value ? '#fff' : colors.textSecondary }}>
              {t.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
      >
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>Billing</Text>

        {/* Summary */}
        {tab === 'active' && (
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <MetricCard title="Pending" value={formatINR(totalPending)} color={accent.orange} />
            </View>
            <View style={{ flex: 1 }}>
              <MetricCard title="Overdue" value={formatINR(totalOverdue)} color={accent.red} />
            </View>
          </View>
        )}

        {/* Cycles */}
        {sorted.length === 0 ? (
          <EmptyState title="No billing cycles" description={tab === 'active' ? 'No active billing cycles' : 'No billing history'} />
        ) : (
          sorted.map((cycle) => (
            <Card key={cycle.cycleId} style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                <View style={{ flex: 1, marginRight: 8 }}>
                  <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>
                    {cycle.distributorName || 'Distributor'}
                  </Text>
                  <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                    {cycle.periodStartDate} → {cycle.periodEndDate}
                  </Text>
                </View>
                <Badge label={cycle.billingStatus.replace(/_/g, ' ')} variant={statusVariant(cycle.billingStatus)} />
              </View>

              {/* Billing Details */}
              <View style={{
                backgroundColor: dark ? colors.inputBg : colors.cardBg,
                borderRadius: 10,
                padding: 12,
                gap: 6,
              }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 13, color: colors.textSecondary }}>Base Amount</Text>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>{formatINR(cycle.totalAmountExclGst ?? 0)}</Text>
                </View>
                {(cycle.totalGstAmount ?? 0) > 0 && (
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 13, color: colors.textSecondary }}>GST</Text>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>{formatINR(cycle.totalGstAmount ?? 0)}</Text>
                  </View>
                )}
                <View style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  borderTopWidth: 1,
                  borderTopColor: colors.divider,
                  paddingTop: 6,
                  marginTop: 2,
                }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>Total</Text>
                  <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text }}>{formatINR(cycle.totalAmountInclGst ?? 0)}</Text>
                </View>
              </View>

              {/* Due Date */}
              {cycle.dueDate && (
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                  <Text style={{ fontSize: 12, color: colors.textSecondary }}>Due Date</Text>
                  <Text style={{ fontSize: 12, fontWeight: '600', color: cycle.billingStatus === 'overdue_billing' ? accent.red : colors.text }}>
                    {cycle.dueDate}
                  </Text>
                </View>
              )}

              {/* Mark Paid Action */}
              {(cycle.billingStatus === 'pending_payment' || cycle.billingStatus === 'invoice_generated' || cycle.billingStatus === 'overdue_billing') && (
                <Button
                  title="Mark as Paid"
                  variant="accent"
                  size="sm"
                  onPress={() => handleMarkPaid(cycle.cycleId, cycle.distributorName || 'this distributor')}
                  loading={markPaid.isPending}
                  style={{ marginTop: 10 }}
                />
              )}
            </Card>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
