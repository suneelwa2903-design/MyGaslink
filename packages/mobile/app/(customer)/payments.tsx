import { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  Modal,
  TextInput,
  ScrollView,
  Alert,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useApiQuery } from '../../src/hooks/useApi';
import { Badge, Button, EmptyState, MetricCard } from '../../src/components/ui';
import { DateRangeFilter, last30Days } from '../../src/components/DateRangeFilter';
import { useTheme, ACCENT, formatINR, formatDate } from '../../src/theme';
import { apiPost, getErrorMessage } from '../../src/lib/api';
import { localTodayISO } from '@gaslink/shared';
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

// Phase 12: wire shape for the customer's own self-reported submissions,
// returned by GET /api/customer-portal/payments/my-submissions.
interface CustomerSubmission {
  submissionId: string;
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
}

const SUBMISSION_STATUS_LABEL = {
  pending_verification: 'Pending',
  verified: 'Verified',
  rejected: 'Rejected',
} as const;

const SUBMISSION_STATUS_VARIANT: Record<string, 'warning' | 'success' | 'danger'> = {
  pending_verification: 'warning',
  verified: 'success',
  rejected: 'danger',
};

type SubmitMethod = 'cash' | 'upi' | 'bank_transfer' | 'cheque' | 'online';
const METHOD_OPTIONS: { value: SubmitMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'online', label: 'Online' },
];

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
  const [reportModalOpen, setReportModalOpen] = useState(false);

  const { data, isLoading, refetch } = useApiQuery<{ payments: Payment[]; meta?: unknown }>(
    ['customer-payments', listFrom, listTo],
    '/customer-portal/payments',
    { from: listFrom, to: listTo },
  );
  const payments = data?.payments ?? [];

  // Phase 12: customer's own self-reported submissions (pending +
  // verified + rejected) — separate query so submission totals are
  // NEVER mixed into the cleared payments total above.
  const { data: submissionsData, refetch: refetchSubmissions } = useApiQuery<{
    submissions: CustomerSubmission[];
  }>(
    ['customer-payment-submissions'],
    '/customer-portal/payments/my-submissions',
  );
  const submissions: CustomerSubmission[] = submissionsData?.submissions ?? [];

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

  // Phase 12: header block contains the Total tile, the Report-a-Payment
  // CTA, and (when there are any) the Pending Verifications list above the
  // cleared history. Lives inside ListHeaderComponent so it scrolls with
  // the FlatList — no separate ScrollView wrapping.
  const header = (
    <View style={{ marginBottom: 12, gap: 12 }}>
      <MetricCard title="Total Payments Made" value={formatINR(totalPaid)} color={accent.green} />
      <Button
        title="Report a Payment"
        variant="primary"
        onPress={() => setReportModalOpen(true)}
      />
      {submissions.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 4 }}>
            Pending Verifications
          </Text>
          <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: -4 }}>
            Payments you reported here are reviewed by the distributor&apos;s team
            before they appear in your cleared payment history.
          </Text>
          {submissions.map((s) => (
            <View
              key={s.submissionId}
              style={{
                backgroundColor: colors.cardBg,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.cardBorder,
                padding: 12,
                gap: 6,
              }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>
                  {formatINR(s.amount)}
                </Text>
                <Badge
                  label={SUBMISSION_STATUS_LABEL[s.status]}
                  variant={SUBMISSION_STATUS_VARIANT[s.status]}
                />
              </View>
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>
                {s.paymentMethod.replace(/_/g, ' ')} · {new Date(s.transactionDate).toLocaleDateString('en-IN')}
                {s.referenceNumber ? ` · Ref: ${s.referenceNumber}` : ''}
              </Text>
              {s.status === 'rejected' && s.rejectionReason && (
                <Text style={{ fontSize: 12, color: ACCENT.red }}>
                  Reason: {s.rejectionReason}
                </Text>
              )}
            </View>
          ))}
        </View>
      )}
      <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 4 }}>
        Payment History
      </Text>
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
        refreshControl={
          <RefreshControl
            refreshing={isLoading}
            onRefresh={() => {
              refetch();
              refetchSubmissions();
            }}
          />
        }
        ListHeaderComponent={header}
        ListEmptyComponent={
          <EmptyState title="No payments" description="Your payment history will appear here" />
        }
      />
      {reportModalOpen && (
        <ReportPaymentModal
          onClose={() => setReportModalOpen(false)}
          onSubmitted={() => {
            refetchSubmissions();
            setReportModalOpen(false);
          }}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Report a Payment modal ────────────────────────────────────────────
// Phase 12: customer self-reports a payment made via off-portal channels
// (cash to driver, bank transfer outside Razorpay, UPI, cheque). Lands
// as PaymentSubmission status='pending_verification' until distributor
// staff verify. Mirrors the web ReportPaymentModal in PaymentsPage.tsx.

function ReportPaymentModal({
  onClose,
  onSubmitted,
}: {
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const todayStr = localTodayISO();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<SubmitMethod>('upi');
  const [transactionDate, setTransactionDate] = useState(todayStr);
  const [referenceNumber, setReferenceNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const amt = Number(amount);
    if (!(amt > 0)) {
      Alert.alert('Invalid amount', 'Enter an amount greater than zero.');
      return;
    }
    try {
      setSubmitting(true);
      await apiPost('/customer-portal/payments/submit', {
        amount: amt,
        paymentMethod: method,
        transactionDate,
        referenceNumber: referenceNumber || undefined,
        notes: notes || undefined,
      });
      queryClient.invalidateQueries({ queryKey: ['customer-payment-submissions'] });
      Alert.alert(
        'Submitted',
        'Your payment has been reported. Our team will verify and update your account shortly.',
        [{ text: 'OK', onPress: onSubmitted }],
      );
    } catch (err) {
      Alert.alert('Submission failed', getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 }}>
            <Text style={{ fontSize: 20, fontWeight: '700', color: colors.text }}>
              Report a Payment
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
          </View>
          <ScrollView
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24, gap: 12 }}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={{ fontSize: 13, color: colors.textSecondary }}>
              {"Use this to report a payment you made through channels outside this app — cash to the delivery driver, bank transfer, UPI outside the Pay Now flow, or cheque. Your distributor's team will verify and update your account."}
            </Text>

            <View style={cardStyle(colors)}>
              <Text style={labelStyle(colors)}>Amount (₹)</Text>
              <TextInput
                keyboardType="decimal-pad"
                value={amount}
                onChangeText={setAmount}
                placeholder="0.00"
                placeholderTextColor={colors.textMuted}
                style={inputStyle(colors)}
              />
            </View>

            <View style={cardStyle(colors)}>
              <Text style={labelStyle(colors)}>Payment Method</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {METHOD_OPTIONS.map((m) => {
                  const active = m.value === method;
                  return (
                    <TouchableOpacity
                      key={m.value}
                      onPress={() => setMethod(m.value)}
                      style={{
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderRadius: 8,
                        borderWidth: 1,
                        backgroundColor: active ? ACCENT.blue : 'transparent',
                        borderColor: active ? ACCENT.blue : colors.cardBorder,
                      }}
                    >
                      <Text style={{ color: active ? '#fff' : colors.text, fontWeight: '600' }}>
                        {m.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <View style={cardStyle(colors)}>
              <Text style={labelStyle(colors)}>Payment Date (YYYY-MM-DD)</Text>
              <TextInput
                value={transactionDate}
                onChangeText={setTransactionDate}
                placeholder={todayStr}
                placeholderTextColor={colors.textMuted}
                style={inputStyle(colors)}
              />
            </View>

            <View style={cardStyle(colors)}>
              <Text style={labelStyle(colors)}>Reference / UTR (optional)</Text>
              <TextInput
                value={referenceNumber}
                onChangeText={setReferenceNumber}
                placeholder="UPI ref / cheque no."
                placeholderTextColor={colors.textMuted}
                style={inputStyle(colors)}
              />
            </View>

            <View style={cardStyle(colors)}>
              <Text style={labelStyle(colors)}>Notes (optional)</Text>
              <TextInput
                value={notes}
                onChangeText={setNotes}
                multiline
                numberOfLines={3}
                placeholder="Any additional context"
                placeholderTextColor={colors.textMuted}
                style={[inputStyle(colors), { height: 80, textAlignVertical: 'top' }]}
              />
            </View>

            <View style={{ marginTop: 8 }}>
              <Button
                title={submitting ? 'Submitting…' : 'Submit'}
                variant="primary"
                onPress={handleSubmit}
                disabled={submitting || !(Number(amount) > 0)}
              />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const cardStyle = (colors: { cardBg: string; cardBorder: string }) => ({
  backgroundColor: colors.cardBg,
  borderRadius: 12,
  borderWidth: 1,
  borderColor: colors.cardBorder,
  padding: 14,
});

const labelStyle = (colors: { textSecondary: string }) => ({
  fontSize: 12,
  color: colors.textSecondary,
  fontWeight: '600' as const,
  letterSpacing: 0.3,
  textTransform: 'uppercase' as const,
});

const inputStyle = (colors: { text: string; cardBorder: string }) => ({
  marginTop: 6,
  borderWidth: 1,
  borderColor: colors.cardBorder,
  borderRadius: 8,
  padding: 10,
  fontSize: 16,
  color: colors.text,
});
