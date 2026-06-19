/**
 * WI-PENDING-PAYMENTS — admin/finance mobile screen for the pending
 * approval queue. Reached as a sub-tab in finance/payments and
 * admin/finance, or as a standalone route via /(admin)/pending-payments
 * and /(finance)/pending-payments (the latter is a one-line re-export
 * of this file, per the codebase's shared-screen convention — see
 * docs in (finance)/collections.tsx).
 *
 * Office user actions: tap row → review → Approve (calls
 * POST /payments/:id/verify) or Reject (POST /payments/:id/reject with
 * a required reason).
 *
 * Allocation modal: when the submitter hinted pendingInvoiceIds, those
 * are pre-suggested but office can edit. Auto-allocate FIFO is
 * available when no allocations are entered.
 */
import { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  Modal,
  TextInput,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { useTheme, formatINR } from '../../src/theme';
import { Badge, Button, EmptyState } from '../../src/components/ui';

interface PendingSubmission {
  submissionId: string;
  customerId: string;
  customerName?: string;
  customer: { customerName: string; currentOutstanding: number };
  amount: number;
  paymentMethod: string;
  transactionDate: string;
  referenceNumber: string | null;
  notes: string | null;
  attachmentUrl: string | null;
  pendingInvoiceIds: string[] | null;
  status: string;
  submittedBy: 'staff' | 'driver' | 'customer';
  submittedByDriver?: { driverName: string } | null;
  submittedByDriverName?: string | null;
  otherPendingCount: number;
  createdAt: string;
}

interface ListResp {
  submissions: PendingSubmission[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export default function PendingPaymentsScreen() {
  const { dark, colors } = useTheme();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [approveTarget, setApproveTarget] = useState<PendingSubmission | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PendingSubmission | null>(null);

  const { data, isLoading, refetch } = useApiQuery<ListResp>(
    ['payment-submissions-pending'],
    '/payments/pending',
  );
  const submissions = data?.submissions ?? [];

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['payment-submissions-pending'] });
    queryClient.invalidateQueries({ queryKey: ['payment-submissions-pending-count'] });
    queryClient.invalidateQueries({ queryKey: ['fin-payments'] });
  };

  const onRefresh = async () => {
    setRefreshing(true);
    try { await refetch(); } finally { setRefreshing(false); }
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: 'Pending Approvals', headerShown: true }} />
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {isLoading ? (
          <Text style={{ color: colors.textSecondary, textAlign: 'center', marginTop: 40 }}>Loading…</Text>
        ) : submissions.length === 0 ? (
          <EmptyState
            title="No pending payments"
            description="Self-reported payments from drivers and customers appear here for verification."
          />
        ) : (
          submissions.map((s) => (
            <View
              key={s.submissionId}
              style={{
                backgroundColor: colors.cardBg,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.cardBorder,
                padding: 14,
                gap: 8,
              }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1, paddingRight: 8 }}>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>
                    {s.customer?.customerName ?? s.customerName ?? 'Customer'}
                  </Text>
                  <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                    Outstanding: {formatINR(s.customer?.currentOutstanding ?? 0)}
                  </Text>
                </View>
                <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text }}>
                  {formatINR(s.amount)}
                </Text>
              </View>

              {s.otherPendingCount > 0 && (
                <View style={{
                  backgroundColor: dark ? 'rgba(245,158,11,0.10)' : '#fffbeb',
                  padding: 8,
                  borderRadius: 8,
                }}>
                  <Text style={{ fontSize: 12, color: dark ? '#fbbf24' : '#92400e' }}>
                    ⚠ {s.otherPendingCount} other pending for this customer
                  </Text>
                </View>
              )}

              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <Badge
                  variant="neutral"
                  label={
                    s.submittedBy === 'driver'
                      ? `Driver: ${s.submittedByDriverName ?? s.submittedByDriver?.driverName ?? 'unknown'}`
                      : s.submittedBy === 'customer'
                        ? 'Customer'
                        : 'Staff'
                  }
                />
                <Badge variant="neutral" label={s.paymentMethod.replace(/_/g, ' ')} />
                <Badge
                  variant="neutral"
                  label={new Date(s.transactionDate).toLocaleDateString('en-IN')}
                />
              </View>

              {s.referenceNumber && (
                <Text style={{ fontSize: 12, color: colors.textSecondary }}>
                  Ref: {s.referenceNumber}
                </Text>
              )}
              {s.notes && (
                <Text style={{ fontSize: 12, color: colors.textSecondary }}>{s.notes}</Text>
              )}

              <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                <View style={{ flex: 1 }}>
                  <Button
                    title="Approve"
                    variant="primary"
                    size="sm"
                    onPress={() => setApproveTarget(s)}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    title="Reject"
                    variant="secondary"
                    size="sm"
                    onPress={() => setRejectTarget(s)}
                  />
                </View>
              </View>
            </View>
          ))
        )}
      </ScrollView>

      {approveTarget && (
        <ApproveModal
          submission={approveTarget}
          onClose={() => setApproveTarget(null)}
          onSuccess={() => {
            invalidateAll();
            setApproveTarget(null);
          }}
        />
      )}
      {rejectTarget && (
        <RejectModal
          submission={rejectTarget}
          onClose={() => setRejectTarget(null)}
          onSuccess={() => {
            invalidateAll();
            setRejectTarget(null);
          }}
        />
      )}

    </SafeAreaView>
  );
}

function ApproveModal({
  submission,
  onClose,
  onSuccess,
}: {
  submission: PendingSubmission;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { dark, colors } = useTheme();
  // Mobile approval is always auto-allocate (FIFO across the customer's
  // open invoices). Manual per-invoice allocation lives in the web app —
  // the small mobile sheet doesn't have room for an invoice picker, and a
  // half-implemented manual toggle that silently fell back to auto was
  // misleading. Office staff who need to split a payment across specific
  // invoices use BillingPaymentsPage > Pending Approval > Approve in the
  // browser.

  const verifyMutation = useApiMutation<unknown, { allocations?: { invoiceId: string; amount: number }[] }>(
    'post',
    `/payments/${submission.submissionId}/verify`,
  );

  const handleApprove = async () => {
    try {
      await verifyMutation.mutateAsync({});
      Alert.alert('Approved', 'Payment recorded.');
      onSuccess();
    } catch (err) {
      Alert.alert('Approve failed', (err as Error).message);
    }
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <View style={{ padding: 16, gap: 12 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ fontSize: 20, fontWeight: '700', color: colors.text }}>Approve payment</Text>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
          </View>

          <View style={{ backgroundColor: colors.cardBg, padding: 14, borderRadius: 10, gap: 6 }}>
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>Customer</Text>
            <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>
              {submission.customer?.customerName ?? 'Customer'}
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 6 }}>Amount</Text>
            <Text style={{ color: colors.text, fontSize: 20, fontWeight: '800' }}>
              {formatINR(submission.amount)}
            </Text>
          </View>

          <View style={{
            backgroundColor: dark ? 'rgba(59,130,246,0.10)' : '#eff6ff',
            padding: 12,
            borderRadius: 10,
            flexDirection: 'row',
            gap: 10,
            alignItems: 'flex-start',
          }}>
            <Ionicons name="information-circle-outline" size={20} color={dark ? '#60a5fa' : '#1e40af'} />
            <Text style={{ flex: 1, fontSize: 13, color: dark ? '#60a5fa' : '#1e40af', lineHeight: 18 }}>
              {submission.pendingInvoiceIds && submission.pendingInvoiceIds.length > 0
                ? `Auto-allocating to the customer's oldest unpaid invoices (FIFO). Submitter hinted ${submission.pendingInvoiceIds.length} invoice(s); use the web app if you need to allocate to specific ones.`
                : "Auto-allocating to the customer's oldest unpaid invoices (FIFO). Use the web app if you need per-invoice allocations."}
            </Text>
          </View>

          <View style={{ marginTop: 8 }}>
            <Button
              title={verifyMutation.isPending ? 'Approving…' : 'Confirm Approve (FIFO)'}
              variant="primary"
              onPress={handleApprove}
              disabled={verifyMutation.isPending}
            />
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function RejectModal({
  submission,
  onClose,
  onSuccess,
}: {
  submission: PendingSubmission;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { colors } = useTheme();
  const [reason, setReason] = useState('');

  const rejectMutation = useApiMutation<unknown, { rejectionReason: string }>(
    'post',
    `/payments/${submission.submissionId}/reject`,
  );

  const handleReject = async () => {
    if (reason.trim().length < 5) {
      Alert.alert('Reason too short', 'Please provide at least 5 characters explaining the rejection.');
      return;
    }
    try {
      await rejectMutation.mutateAsync({ rejectionReason: reason.trim() });
      Alert.alert('Rejected', 'The submitter will see your reason on next app open.');
      onSuccess();
    } catch (err) {
      Alert.alert('Reject failed', (err as Error).message);
    }
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
          <View style={{ padding: 16, gap: 12 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ fontSize: 20, fontWeight: '700', color: colors.text }}>Reject payment</Text>
              <TouchableOpacity onPress={onClose} hitSlop={12}>
                <Ionicons name="close" size={24} color={colors.text} />
              </TouchableOpacity>
            </View>

            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
              The submitter (driver or customer) will see this reason in their app. Be
              specific so they can correct the issue.
            </Text>

            <TextInput
              value={reason}
              onChangeText={setReason}
              multiline
              numberOfLines={4}
              placeholder='e.g. "Receipt photo unclear, please retake" or "Amount does not match invoice"'
              placeholderTextColor={colors.textMuted}
              style={{
                marginTop: 6,
                borderWidth: 1,
                borderColor: colors.cardBorder,
                borderRadius: 8,
                padding: 12,
                fontSize: 16,
                color: colors.text,
                minHeight: 120,
                textAlignVertical: 'top',
              }}
            />

            <View style={{ marginTop: 8 }}>
              <Button
                title={rejectMutation.isPending ? 'Rejecting…' : 'Confirm Reject'}
                variant="danger"
                onPress={handleReject}
                disabled={rejectMutation.isPending || reason.trim().length < 5}
              />
            </View>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
