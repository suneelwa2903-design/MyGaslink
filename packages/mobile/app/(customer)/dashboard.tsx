import { useState } from 'react';
import { View, Text, ScrollView, RefreshControl, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useApiQuery } from '../../src/hooks/useApi';
import { MetricCard, Card, Button, DateInput, MIN_DATE_FLOOR, todayLocalIso } from '../../src/components/ui';
import { useAuthStore } from '../../src/stores/authStore';
import { api, getErrorMessage } from '../../src/lib/api';
import { useTheme, formatINR } from '../../src/theme';

// Uniform height so all four Current Status cards line up regardless of content.
const CARD_MIN_HEIGHT = 116;

interface CustomerDashboard {
  // Always-current (state)
  outstandingAmount: number;
  overdueAmount: number;
  pendingOrders: number;
  emptyCylinders: number;
  emptiesByType: Array<{ cylinderTypeName: string; capacity: number; withCustomerQty: number }>;
  // Date-filtered (activity within range)
  totalOrders: number;
  ordersDelivered: number;
  amountDelivered: number;
  paymentsReceived: number;
  range: { from: string; to: string };
}

function firstOfMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0];
}

export default function CustomerDashboardScreen() {
  const { colors, accent } = useTheme();

  // Activity date range — defaults to the current month (1st → today).
  const [fromDate, setFromDate] = useState(firstOfMonth);
  const [toDate, setToDate] = useState(todayLocalIso);

  // 3-fix bundle Fix 2/3 (2026-06-12): Customer Ledger Statement download was
  // moved off the Payments screen onto this Dashboard. Endpoint mirrors web:
  // GET /customers/:id/ledger/pdf — customer role allowed, own-only. Driver
  // trip-sheet pattern: arraybuffer → expo-file-system cache → OS share sheet.
  // Defaults to the last 30 days (independent of the "This Period" range above
  // so the activity view and the statement window can move independently).
  const customerId = useAuthStore((s) => s.user?.customerId);
  const [stmtFrom, setStmtFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0];
  });
  const [stmtTo, setStmtTo] = useState(() => new Date().toISOString().split('T')[0]);
  const [downloading, setDownloading] = useState(false);

  const handleDownloadStatement = async () => {
    if (!customerId) {
      Alert.alert('Unavailable', 'No customer is linked to this account.');
      return;
    }
    setDownloading(true);
    try {
      const res = await api.get(`/customers/${customerId}/ledger/pdf`, {
        params: { from: stmtFrom, to: stmtTo },
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

  const { data, isLoading, refetch } = useApiQuery<CustomerDashboard>(
    ['customer-dashboard', fromDate, toDate],
    '/customer-portal/dashboard',
    { from: fromDate, to: toDate },
  );

  // FIX 3: show ALL non-zero balances (including negatives, where the customer
  // has returned more empties than cylinders received), and derive the headline
  // total from exactly these rows so the number always equals the breakdown sum.
  const emptiesWithYou = (data?.emptiesByType ?? []).filter((t) => t.withCustomerQty !== 0);
  const emptiesTotal = emptiesWithYou.reduce((sum, t) => sum + t.withCustomerQty, 0);

  // P1-3 sweep (2026-06-09): the inline TextInput + dateInputStyle pair was
  // replaced by the canonical `DateInput` component below. Native picker on
  // both iOS (modal) and Android (OS dialog); local-TZ math via the
  // component's parseIsoLocal/toIsoLocal helpers.

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
      >
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
          Welcome back
        </Text>

        {/* ── Current Status (always current, ignores date range) ── */}
        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 4 }}>
          Current Status
        </Text>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard title="Outstanding" value={formatINR(data?.outstandingAmount)} color={accent.orange} minHeight={CARD_MIN_HEIGHT} />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard title="Overdue" value={formatINR(data?.overdueAmount)} color={accent.red} minHeight={CARD_MIN_HEIGHT} />
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard title="Pending Orders" value={data?.pendingOrders ?? 0} color={accent.blue} minHeight={CARD_MIN_HEIGHT} />
          </View>
          <View style={{ flex: 1 }}>
            <Card style={{ minHeight: CARD_MIN_HEIGHT }}>
              <Text style={{ fontSize: 13, color: colors.textSecondary, fontWeight: '500' }}>
                Empty Cylinders With You
              </Text>
              {emptiesWithYou.length > 0 ? (
                <>
                  <Text style={{ fontSize: 24, fontWeight: '700', color: accent.green, marginTop: 4 }}>
                    {emptiesTotal}
                  </Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 }}>
                    {emptiesWithYou.map((t) => (
                      <Text
                        key={t.cylinderTypeName}
                        style={{ fontSize: 12, color: t.withCustomerQty < 0 ? accent.orange : colors.textSecondary, width: '50%', marginTop: 2 }}
                      >
                        {t.cylinderTypeName}: {t.withCustomerQty}
                        {t.withCustomerQty < 0 ? ' (excess returned)' : ''}
                      </Text>
                    ))}
                  </View>
                </>
              ) : (
                <Text style={{ fontSize: 13, color: colors.textMuted, marginTop: 8 }}>
                  0 — All cylinders returned
                </Text>
              )}
            </Card>
          </View>
        </View>

        {/* ── This Period (date-filtered activity) ── */}
        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 12 }}>
          This Period
        </Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <DateInput
              label="From"
              value={fromDate}
              onChange={setFromDate}
              minDate={MIN_DATE_FLOOR}
              maxDate={toDate || todayLocalIso()}
            />
          </View>
          <View style={{ flex: 1 }}>
            <DateInput
              label="To"
              value={toDate}
              onChange={setToDate}
              minDate={fromDate || MIN_DATE_FLOOR}
              maxDate={todayLocalIso()}
            />
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard title="Orders" value={data?.totalOrders ?? 0} color={accent.blue} minHeight={CARD_MIN_HEIGHT} />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard title="Delivered" value={data?.ordersDelivered ?? 0} color={accent.green} minHeight={CARD_MIN_HEIGHT} />
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard title="Amount Delivered" value={formatINR(data?.amountDelivered)} color={accent.purple} minHeight={CARD_MIN_HEIGHT} />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard title="Payments Made" value={formatINR(data?.paymentsReceived)} color={accent.green} minHeight={CARD_MIN_HEIGHT} />
          </View>
        </View>

        {/* ── Customer Statement (moved from Payments) ── */}
        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 16 }}>
          Customer Statement
        </Text>
        <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: -4 }}>
          Download your ledger (orders, invoices, payments) for a date range.
        </Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <DateInput
              label="From"
              value={stmtFrom}
              onChange={setStmtFrom}
              minDate={MIN_DATE_FLOOR}
              maxDate={stmtTo || todayLocalIso()}
            />
          </View>
          <View style={{ flex: 1 }}>
            <DateInput
              label="To"
              value={stmtTo}
              onChange={setStmtTo}
              minDate={stmtFrom || MIN_DATE_FLOOR}
              maxDate={todayLocalIso()}
            />
          </View>
        </View>
        <Button
          title={downloading ? 'Preparing statement…' : 'Download Statement (PDF)'}
          onPress={handleDownloadStatement}
          loading={downloading}
          variant="secondary"
        />
      </ScrollView>
    </SafeAreaView>
  );
}
