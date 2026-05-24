import { useState } from 'react';
import { View, Text, FlatList, RefreshControl, TextInput, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { Button, EmptyState, MetricCard } from '../../src/components/ui';
import { DateRangeFilter, last30Days } from '../../src/components/DateRangeFilter';
import { useAuthStore } from '../../src/stores/authStore';
import { api, getErrorMessage } from '../../src/lib/api';
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
  const { dark, colors, accent } = useTheme();

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

  // ── Statement PDF (WI-093) ──────────────────────────────────────────────
  // Downloads the customer's own ledger statement via the shared endpoint
  // GET /customers/:id/ledger/pdf (customer role allowed, own-only). Mirrors
  // the driver trip-sheet pattern: arraybuffer → expo-file-system cache → OS
  // share sheet. Date pickers default to the last 30 days. No DateTimePicker
  // native module is installed, so plain YYYY-MM-DD text inputs are used.
  const customerId = useAuthStore((s) => s.user?.customerId);
  const [downloading, setDownloading] = useState(false);
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0];
  });
  const [toDate, setToDate] = useState(() => new Date().toISOString().split('T')[0]);

  const handleDownloadStatement = async () => {
    if (!customerId) {
      Alert.alert('Unavailable', 'No customer is linked to this account.');
      return;
    }
    setDownloading(true);
    try {
      const res = await api.get(`/customers/${customerId}/ledger/pdf`, {
        params: { from: fromDate, to: toDate },
        responseType: 'arraybuffer',
      });
      const bytes = new Uint8Array(res.data);
      const file = new File(Paths.cache, `statement-${Date.now()}.pdf`);
      try { file.create(); } catch { /* already exists, fine */ }
      file.write(bytes);

      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'This device does not support sharing.');
        return;
      }
      await Sharing.shareAsync(file.uri, {
        mimeType: 'application/pdf',
        dialogTitle: 'Customer Ledger Statement',
        UTI: 'com.adobe.pdf',
      });
    } catch (err) {
      Alert.alert('Could not download statement', getErrorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  const dateInputStyle = {
    borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14,
    backgroundColor: colors.inputBg, color: colors.text,
  } as const;

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
        ListFooterComponent={
          <View style={{ marginTop: 20, gap: 10, paddingBottom: 16 }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>
              Customer Ledger Statement
            </Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>From</Text>
                <TextInput
                  value={fromDate}
                  onChangeText={setFromDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={dateInputStyle}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>To</Text>
                <TextInput
                  value={toDate}
                  onChangeText={setToDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={dateInputStyle}
                />
              </View>
            </View>
            <Button
              title={downloading ? 'Preparing statement…' : 'Download Statement (PDF)'}
              onPress={handleDownloadStatement}
              loading={downloading}
              variant="secondary"
            />
          </View>
        }
      />
    </SafeAreaView>
  );
}
