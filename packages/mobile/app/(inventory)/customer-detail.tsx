/**
 * Phase B2 (2026-06-12) — inventory customer detail (balance-only).
 *
 * Pared-down customer-detail focused on what inventory staff actually
 * need: customer header (name + phone + GSTIN for B2B context) + the
 * cylinder balances table. Financial tabs (ledger, invoices, payments)
 * are deliberately omitted per the Phase B spec — they're finance's
 * domain.
 *
 * Reached from (inventory)/customers.tsx with a `customerId` route
 * param. Read-only end to end: no edit, no balance-setup form (admin
 * has that under Customers → Balance Setup).
 *
 * Server endpoints hit:
 *   GET /api/customers/:id         (customer header)
 *   GET /api/customers/:id/balance (per-cylinder balances)
 * Both allow `inventory` per routes/customers.ts.
 */
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useApiQuery } from '../../src/hooks/useApi';
import { useTheme, ACCENT as ACCENT_COLORS } from '../../src/theme';
import { Card, EmptyState } from '../../src/components/ui';

const ACCENT = ACCENT_COLORS.red;

interface CustomerHeader {
  customerId: string;
  customerName: string;
  businessName?: string;
  phone: string;
  email?: string;
  gstin?: string;
  customerType?: 'B2B' | 'B2C';
}

interface BalanceRow {
  cylinderTypeId: string;
  cylinderTypeName: string;
  withCustomerQty: number;
  pendingReturns: number;
  missingQty: number;
  updatedAt: string;
}

interface BalanceResponse {
  balances: BalanceRow[];
}

export default function InventoryCustomerDetailScreen() {
  const { dark, colors } = useTheme();
  const router = useRouter();
  const { customerId } = useLocalSearchParams<{ customerId: string }>();

  const { data: customer, isLoading: loadingCustomer } = useApiQuery<CustomerHeader>(
    ['inv-customer-header', String(customerId)],
    `/customers/${customerId}`,
    undefined,
    { enabled: !!customerId },
  );
  const { data: balances, isLoading: loadingBalances, refetch } = useApiQuery<BalanceResponse>(
    ['inv-customer-balances', String(customerId)],
    `/customers/${customerId}/balance`,
    undefined,
    { enabled: !!customerId },
  );

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: 16, paddingVertical: 12,
        borderBottomWidth: 1, borderBottomColor: colors.divider,
      }}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={{ flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700', color: colors.text }} numberOfLines={1}>
          {customer?.customerName ?? 'Customer'}
        </Text>
        <TouchableOpacity onPress={() => refetch()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="refresh" size={22} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        {loadingCustomer ? (
          <View style={{ alignItems: 'center', paddingVertical: 24 }}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        ) : customer ? (
          <Card>
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>{customer.customerName}</Text>
            {customer.businessName ? (
              <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>{customer.businessName}</Text>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
              <View>
                <Text style={{ fontSize: 11, color: colors.textMuted }}>Phone</Text>
                <Text style={{ fontSize: 13, color: colors.text }}>{customer.phone}</Text>
              </View>
              {customer.gstin ? (
                <View>
                  <Text style={{ fontSize: 11, color: colors.textMuted }}>GSTIN</Text>
                  <Text style={{ fontSize: 13, color: colors.text }}>{customer.gstin}</Text>
                </View>
              ) : null}
              {customer.customerType ? (
                <View>
                  <Text style={{ fontSize: 11, color: colors.textMuted }}>Type</Text>
                  <Text style={{ fontSize: 13, color: colors.text }}>{customer.customerType}</Text>
                </View>
              ) : null}
            </View>
          </Card>
        ) : null}

        <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Cylinder Balances
        </Text>

        {loadingBalances ? (
          <View style={{ alignItems: 'center', paddingVertical: 24 }}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        ) : (balances?.balances ?? []).length === 0 ? (
          <EmptyState title="No balances recorded" description="Inventory staff can record cylinder balances from the Customers screen on web." />
        ) : (
          (balances?.balances ?? []).map((b) => (
            <Card key={b.cylinderTypeId}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: 8 }}>
                {b.cylinderTypeName}
              </Text>
              <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }}>
                <View>
                  <Text style={{ fontSize: 11, color: colors.textMuted }}>With customer</Text>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>{b.withCustomerQty}</Text>
                </View>
                <View>
                  <Text style={{ fontSize: 11, color: colors.textMuted }}>Pending returns</Text>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: '#f59e0b' }}>{b.pendingReturns}</Text>
                </View>
                <View>
                  <Text style={{ fontSize: 11, color: colors.textMuted }}>Missing</Text>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: b.missingQty > 0 ? '#ef4444' : colors.text }}>{b.missingQty}</Text>
                </View>
              </View>
              <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 8 }}>
                Updated {new Date(b.updatedAt).toLocaleDateString('en-IN')}
              </Text>
            </Card>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
