import { useState } from 'react';
import { View, Text, FlatList, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { EmptyState, MetricCard } from '../../src/components/ui';
import { DateRangeFilter, last30Days } from '../../src/components/DateRangeFilter';
import { useTheme, formatINR, formatDate } from '../../src/theme';
import type { Payment } from '@gaslink/shared';

const PAYMENT_METHOD_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  cash: 'cash-outline',
  upi: 'phone-portrait-outline',
  bank_transfer: 'swap-horizontal-outline',
  neft: 'swap-horizontal-outline',
  rtgs: 'swap-horizontal-outline',
  cheque: 'document-outline',
  card: 'card-outline',
  online: 'globe-outline',
};

export default function CustomerPaymentsScreen() {
  const { colors, accent } = useTheme();

  // GET /customer-portal/payments returns the standard envelope
  // { payments, meta } — NOT a bare array. Read .payments to match the
  // pattern in invoices.tsx (was previously typed as Payment[] and crashed
  // .reduce on the wrong shape).
  // WI-124: collapsible date-range filter (transactionDate) for the payment
  // LIST, default last 30 days. Distinct from the statement-PDF range below.
  const [listFrom, setListFrom] = useState(() => last30Days().from);
  const [listTo, setListTo] = useState(() => last30Days().to);

  const { data, isLoading, refetch } = useApiQuery<{ payments: Payment[]; meta?: unknown }>(
    ['customer-payments', listFrom, listTo],
    '/customer-portal/payments',
    { from: listFrom, to: listTo },
  );
  const payments = data?.payments ?? [];

  const totalPaid = payments.reduce((sum, p) => sum + (p.amount ?? 0), 0);

  // 3-fix bundle Fix 2 (2026-06-12): Customer Ledger Statement download was
  // moved off this screen onto the customer Dashboard so Payments is purely
  // the payment history list. See app/(customer)/dashboard.tsx for the new
  // home of the date pickers + Download Statement button.

  const getMethodIcon = (method: string | null | undefined): keyof typeof Ionicons.glyphMap => {
    if (!method) return 'wallet-outline';
    return PAYMENT_METHOD_ICON[method.toLowerCase()] ?? 'wallet-outline';
  };

  const renderPayment = ({ item: payment }: { item: Payment }) => (
    <View
      style={{
        backgroundColor: colors.cardBg, borderRadius: 14, padding: 16,
        borderWidth: 1, borderColor: colors.cardBorder, marginBottom: 10,
      }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View>
          <Text style={{ fontWeight: '700', fontSize: 16, color: accent.green }}>
            {formatINR(payment.amount)}
          </Text>
          <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 4 }}>
            {formatDate(payment.transactionDate)}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: 6,
            backgroundColor: colors.inputBg, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8,
          }}>
            <Ionicons
              name={getMethodIcon(payment.paymentMethod)}
              size={14}
              color={colors.textSecondary}
            />
            <Text style={{ fontSize: 12, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase' }}>
              {(payment.paymentMethod || '').replace(/_/g, ' ')}
            </Text>
          </View>
          {payment.referenceNumber && (
            <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>
              Ref: {payment.referenceNumber}
            </Text>
          )}
        </View>
      </View>

      {(payment.allocations?.length ?? 0) > 0 && (
        <View style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 8 }}>
          <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 4 }}>Applied to:</Text>
          {(payment.allocations ?? []).map((alloc, i) => (
            <Text key={i} style={{ fontSize: 12, color: colors.textSecondary }}>
              {alloc.invoiceNumber || ''}: {formatINR(alloc.allocatedAmount)}
            </Text>
          ))}
        </View>
      )}
    </View>
  );

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <DateRangeFilter from={listFrom} to={listTo} setFrom={setListFrom} setTo={setListTo} />
      <FlatList
        data={payments}
        keyExtractor={(p) => p.paymentId}
        renderItem={renderPayment}
        contentContainerStyle={{ padding: 16, gap: 2 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
        ListHeaderComponent={
          <View style={{ marginBottom: 12, gap: 12 }}>
            <MetricCard title="Total Payments Made" value={formatINR(totalPaid)} color={accent.green} />
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 4 }}>
              Payment History
            </Text>
          </View>
        }
        ListEmptyComponent={
          <EmptyState title="No payments" description="Your payment history will appear here" />
        }
      />
    </SafeAreaView>
  );
}
