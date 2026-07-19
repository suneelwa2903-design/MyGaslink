/**
 * HQ Payments (2026-07-19) — consolidated payments across every
 * property in the group. Web parity:
 * packages/web/src/pages/hq/PaymentsPage.tsx.
 *
 * Security: GET /api/customer-group-portal/payments — server calls
 * getGroupPayments(distributorId, visibleCustomerIds, filters) which
 * double-scopes every query. customerId in the property filter is
 * validated against visibleCustomerIds before Prisma runs.
 */
import { useMemo, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApiQuery } from '../../src/hooks/useApi';
import { Card, EmptyState, ScreenSkeleton, Badge, SelectField } from '../../src/components/ui';
import { useTheme, formatINR } from '../../src/theme';

interface Payment {
  paymentId: string;
  customerId: string;
  customerName: string;
  businessName: string | null;
  amount: number;
  paymentMethod: string;
  transactionDate: string;
  referenceNumber: string | null;
  notes: string | null;
  invoicesApplied: Array<{ invoiceNumber: string | null; amount: number }>;
}
interface PaymentsResponse {
  payments: Payment[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}
interface ProfileMember { customerId: string; customerName: string }
interface ProfileResponse { members: ProfileMember[] }

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function methodLabel(m: string): string {
  return m
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

export default function HqPaymentsScreen() {
  const { colors } = useTheme();
  const [customerFilter, setCustomerFilter] = useState('');
  const [page, setPage] = useState(1);

  const { data: profile } = useApiQuery<ProfileResponse>(
    ['hq-profile'],
    '/customer-group-portal/profile',
  );
  const propertyOptions = useMemo(() => {
    const opts = [{ label: 'All properties', value: '' }];
    for (const m of profile?.members ?? []) {
      opts.push({ label: m.customerName, value: m.customerId });
    }
    return opts;
  }, [profile?.members]);

  const params = useMemo(() => {
    const p: Record<string, string | number> = { page, pageSize: 25 };
    if (customerFilter) p.customerId = customerFilter;
    return p;
  }, [page, customerFilter]);

  const { data, isLoading, refetch, isRefetching } = useApiQuery<PaymentsResponse>(
    ['hq-payments', JSON.stringify(params)],
    '/customer-group-portal/payments',
    params,
  );
  const payments = data?.payments ?? [];
  const totalPages = data?.meta.totalPages ?? 1;

  const groupTotal = useMemo(
    () => payments.reduce((s, p) => s + (p.amount ?? 0), 0),
    [payments],
  );

  if (isLoading && !data) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScreenSkeleton />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => { void refetch(); }} />}
      >
        <Card>
          <SelectField
            label="Property"
            options={propertyOptions}
            value={customerFilter}
            onChange={(v) => { setCustomerFilter(v); setPage(1); }}
          />
        </Card>

        {payments.length > 0 && (
          <Card>
            <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>
              Sum of {payments.length} payment{payments.length === 1 ? '' : 's'} on this page
            </Text>
            <Text style={{ fontSize: 22, fontWeight: '700', color: colors.text }}>
              {formatINR(groupTotal)}
            </Text>
          </Card>
        )}

        {payments.length === 0 ? (
          <Card>
            <EmptyState
              title="No payments"
              description={customerFilter ? 'No payments for the selected property.' : 'No payments received across your group properties yet.'}
            />
          </Card>
        ) : (
          <Card>
            {payments.map((p, idx) => (
              <View
                key={p.paymentId}
                style={{
                  paddingVertical: 12,
                  borderBottomWidth: idx === payments.length - 1 ? 0 : 1,
                  borderBottomColor: colors.divider,
                  gap: 6,
                }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>
                      {p.customerName}
                    </Text>
                    <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 2 }}>
                      {fmtDate(p.transactionDate)}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: '#059669', fontWeight: '700', fontSize: 14 }}>
                      {formatINR(p.amount ?? 0)}
                    </Text>
                    <View style={{ marginTop: 4 }}>
                      <Badge variant="neutral" label={methodLabel(p.paymentMethod)} />
                    </View>
                  </View>
                </View>
                {p.referenceNumber && (
                  <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                    Ref: {p.referenceNumber}
                  </Text>
                )}
                {p.invoicesApplied.length > 0 && (
                  <Text style={{ color: colors.textSecondary, fontSize: 11 }} numberOfLines={2}>
                    Applied to: {p.invoicesApplied.map((a) => a.invoiceNumber ?? '—').join(', ')}
                  </Text>
                )}
                {p.notes && (
                  <Text style={{ color: colors.textSecondary, fontSize: 11, fontStyle: 'italic' }} numberOfLines={2}>
                    {p.notes}
                  </Text>
                )}
              </View>
            ))}
          </Card>
        )}

        {totalPages > 1 && (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 }}>
            <TouchableOpacity
              onPress={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              style={{
                paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8,
                borderWidth: 1, borderColor: colors.cardBorder,
                opacity: page <= 1 ? 0.4 : 1,
              }}
            >
              <Text style={{ color: colors.text, fontWeight: '600' }}>Prev</Text>
            </TouchableOpacity>
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
              Page {page} / {totalPages}
            </Text>
            <TouchableOpacity
              onPress={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              style={{
                paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8,
                borderWidth: 1, borderColor: colors.cardBorder,
                opacity: page >= totalPages ? 0.4 : 1,
              }}
            >
              <Text style={{ color: colors.text, fontWeight: '600' }}>Next</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={{ height: 8 }} />
      </ScrollView>
    </SafeAreaView>
  );
}
