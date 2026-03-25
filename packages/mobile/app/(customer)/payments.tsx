import { View, Text, FlatList, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { EmptyState, MetricCard } from '../../src/components/ui';
import { useTheme, formatINR } from '../../src/theme';
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
  const { dark, colors, accent } = useTheme();

  const { data: payments, isLoading, refetch } = useApiQuery<Payment[]>(
    ['customer-payments'],
    '/customer-portal/payments',
  );

  const totalPaid = payments?.reduce((sum, p) => sum + (p.amount ?? 0), 0) ?? 0;

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
            {payment.transactionDate}
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
      <FlatList
        data={payments ?? []}
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
