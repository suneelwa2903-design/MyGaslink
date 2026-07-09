/**
 * WI-PENDING-PAYMENTS — driver's history of self-reported payments.
 *
 * Read-only list reached from the More tab. Shows status badges
 * (amber Pending / green Verified / red Rejected). Tapping a rejected
 * row reveals the rejection reason in red so the driver knows why.
 *
 * Fetches via GET /api/drivers/me/payment-submissions.
 */
import { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { useTheme, ACCENT, formatINR } from '../../src/theme';
import { Badge, EmptyState } from '../../src/components/ui';

interface DriverSubmission {
  submissionId: string;
  customerName?: string;
  customer?: { customerName: string };
  amount: number;
  paymentMethod: string;
  transactionDate: string;
  referenceNumber: string | null;
  notes: string | null;
  attachmentUrl: string | null;
  status: 'pending_verification' | 'verified' | 'rejected';
  rejectionReason: string | null;
  resultingPaymentId: string | null;
  createdAt: string;
  // Item 10 (2026-07-09) — per-invoice allocation detail from the office's
  // verify step. Empty array on unverified rows.
  settledInvoices?: {
    invoiceId: string;
    invoiceNumber: string;
    allocatedAmount: number;
  }[];
}

interface ListResp {
  submissions: DriverSubmission[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

const STATUS_LABEL = {
  pending_verification: 'Pending',
  verified: 'Verified',
  rejected: 'Rejected',
} as const;

const STATUS_VARIANT: Record<string, 'warning' | 'success' | 'danger'> = {
  pending_verification: 'warning',
  verified: 'success',
  rejected: 'danger',
};

export default function DriverMySubmissionsScreen() {
  const { dark, colors } = useTheme();
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<DriverSubmission | null>(null);

  const { data, isLoading, refetch } = useApiQuery<ListResp>(
    ['driver-payment-submissions'],
    '/drivers/me/payment-submissions',
  );

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  };

  const submissions = data?.submissions ?? [];

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: 'My Payment Submissions', headerShown: true }} />
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 10 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {isLoading ? (
          <Text style={{ color: colors.textSecondary, textAlign: 'center', marginTop: 40 }}>
            Loading…
          </Text>
        ) : submissions.length === 0 ? (
          <EmptyState
            title="No payment submissions yet"
            description='Submit a payment from an order to see it here.'
          />
        ) : (
          submissions.map((s) => (
            <TouchableOpacity
              key={s.submissionId}
              onPress={() => setSelected(s)}
              activeOpacity={0.7}
              style={{
                backgroundColor: colors.cardBg,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.cardBorder,
                padding: 14,
                gap: 6,
              }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>
                  {s.customer?.customerName ?? s.customerName ?? 'Customer'}
                </Text>
                <Badge variant={STATUS_VARIANT[s.status]} label={STATUS_LABEL[s.status]} />
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
                  {formatINR(s.amount)} · {s.paymentMethod.replace(/_/g, ' ')}
                </Text>
                <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
                  {new Date(s.transactionDate).toLocaleDateString('en-IN')}
                </Text>
              </View>
              {s.status === 'rejected' && s.rejectionReason && (
                <Text style={{ color: ACCENT.red, fontSize: 12, marginTop: 4 }}>
                  Reason: {s.rejectionReason}
                </Text>
              )}
              {/* Item 10 (2026-07-09) — settled invoices summary on the row.
                  Shown only when verified + allocations exist. Truncate to
                  first 2 for the row; the detail modal shows all. */}
              {s.status === 'verified' && (s.settledInvoices?.length ?? 0) > 0 && (
                <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 4 }}>
                  Settled: {(s.settledInvoices ?? [])
                    .slice(0, 2)
                    .map((si) => `${si.invoiceNumber} ${formatINR(si.allocatedAmount)}`)
                    .join(' · ')}
                  {(s.settledInvoices?.length ?? 0) > 2
                    ? ` +${(s.settledInvoices?.length ?? 0) - 2} more`
                    : ''}
                </Text>
              )}
            </TouchableOpacity>
          ))
        )}
      </ScrollView>

      <Modal
        visible={!!selected}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSelected(null)}
      >
        {selected && (
          <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
            <View style={{ padding: 16, gap: 12 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontSize: 20, fontWeight: '700', color: colors.text }}>Submission details</Text>
                <TouchableOpacity onPress={() => setSelected(null)} hitSlop={12}>
                  <Ionicons name="close" size={24} color={colors.text} />
                </TouchableOpacity>
              </View>

              <DetailRow label="Status">
                <Badge variant={STATUS_VARIANT[selected.status]} label={STATUS_LABEL[selected.status]} />
              </DetailRow>

              {selected.status === 'rejected' && selected.rejectionReason && (
                <View style={{
                  backgroundColor: dark ? 'rgba(239,68,68,0.10)' : '#fef2f2',
                  borderRadius: 8,
                  padding: 12,
                }}>
                  <Text style={{ fontSize: 12, color: ACCENT.red, fontWeight: '700' }}>REASON</Text>
                  <Text style={{ color: ACCENT.red, marginTop: 4 }}>{selected.rejectionReason}</Text>
                </View>
              )}

              <DetailRow label="Customer">
                <Text style={{ color: colors.text }}>{selected.customer?.customerName ?? '—'}</Text>
              </DetailRow>
              <DetailRow label="Amount">
                <Text style={{ color: colors.text, fontWeight: '700' }}>{formatINR(selected.amount)}</Text>
              </DetailRow>
              <DetailRow label="Method">
                <Text style={{ color: colors.text }}>{selected.paymentMethod.replace(/_/g, ' ')}</Text>
              </DetailRow>
              <DetailRow label="Date">
                <Text style={{ color: colors.text }}>{new Date(selected.transactionDate).toLocaleDateString('en-IN')}</Text>
              </DetailRow>
              {selected.referenceNumber && (
                <DetailRow label="Reference">
                  <Text style={{ color: colors.text }}>{selected.referenceNumber}</Text>
                </DetailRow>
              )}
              {selected.notes && (
                <DetailRow label="Notes">
                  <Text style={{ color: colors.text }}>{selected.notes}</Text>
                </DetailRow>
              )}
              <DetailRow label="Submitted">
                <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                  {new Date(selected.createdAt).toLocaleString('en-IN')}
                </Text>
              </DetailRow>

              {/* Item 10 (2026-07-09) — full settlement list. Only rendered
                  when the submission is verified AND there are allocations.
                  The office may verify without allocating (payment left as
                  on-account credit) — settledInvoices is [] in that case. */}
              {selected.status === 'verified' && (selected.settledInvoices?.length ?? 0) > 0 && (
                <View style={{
                  marginTop: 12,
                  padding: 12,
                  backgroundColor: dark ? 'rgba(34,197,94,0.08)' : '#f0fdf4',
                  borderRadius: 8,
                  gap: 8,
                }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: colors.text, letterSpacing: 0.5 }}>
                    SETTLED AGAINST
                  </Text>
                  {(selected.settledInvoices ?? []).map((si) => (
                    <View
                      key={si.invoiceId}
                      style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
                    >
                      <Text style={{ color: colors.text, fontSize: 14 }}>{si.invoiceNumber}</Text>
                      <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>
                        {formatINR(si.allocatedAmount)}
                      </Text>
                    </View>
                  ))}
                  <View style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    borderTopWidth: 1,
                    borderTopColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
                    paddingTop: 8,
                  }}>
                    <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>Total</Text>
                    <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>
                      {formatINR(
                        (selected.settledInvoices ?? []).reduce((s, si) => s + si.allocatedAmount, 0),
                      )}
                    </Text>
                  </View>
                </View>
              )}
            </View>
          </SafeAreaView>
        )}
      </Modal>
    </SafeAreaView>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
      <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600' }}>{label}</Text>
      <View style={{ flex: 1, alignItems: 'flex-end' }}>{children}</View>
    </View>
  );
}
