/**
 * WI-PENDING-PAYMENTS — driver self-reports a payment collected at delivery.
 *
 * Entry point: tap "Submit Payment" on an order row in (driver)/orders.tsx.
 * Submits via POST /api/drivers/me/payment-submissions, landing as a
 * pending_verification PaymentSubmission. Office staff verify in the
 * web/mobile Pending Approval tab.
 *
 * Receipt-photo upload was removed 2026-06-19 (S3 infra not provisioned).
 * Submissions are now text-only: amount + method + date + reference + notes.
 */
import { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useLocalSearchParams, Stack } from 'expo-router';
import { useTheme, ACCENT } from '../../src/theme';
import { Button } from '../../src/components/ui';
import { apiPost, getErrorMessage } from '../../src/lib/api';
import { useApiQuery } from '../../src/hooks/useApi';
import { localTodayISO } from '@gaslink/shared';

type Method = 'cash' | 'upi' | 'bank_transfer' | 'cheque' | 'online';
const METHODS: { value: Method; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'online', label: 'Online' },
];

export default function DriverSubmitPaymentScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{
    customerId?: string;
    customerName?: string;
    orderId?: string;
    prefillAmount?: string;
  }>();

  const [amount, setAmount] = useState(params.prefillAmount ?? '');
  const [method, setMethod] = useState<Method>('cash');
  // Anti-pattern #21: use localTodayISO, NOT toISOString().slice(0,10).
  // Between 18:30 UTC and 23:59 UTC daily (00:00–05:30 IST) the UTC
  // calendar date is yesterday-in-IST, which silently submits a date
  // off-by-one for users entering payments during their night hours.
  const [transactionDate] = useState(() => localTodayISO());
  const [referenceNumber, setReferenceNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // WI-PENDING-PAYMENTS post-smoke FIX-C: two-mode operation.
  // Mode A — opened from an order (params.customerId set): customer is
  //   read-only at the top, prefillAmount populates the field.
  // Mode B — opened from analytics "+ Add Payment" (no params): the
  //   customer picker below is shown instead. Driver searches the
  //   distributor's customers and taps to select. selectedCustomer
  //   then drives the submit payload.
  const fromOrder = !!params.customerId;
  const [pickedCustomer, setPickedCustomer] = useState<{ id: string; customerName: string } | null>(null);
  const [customerSearch, setCustomerSearch] = useState('');

  const { data: customerData } = useApiQuery<{ customers: Array<{ customerId: string; customerName: string; phone?: string | null }> }>(
    ['driver-submit-payment-customers'],
    '/customers',
    { pageSize: 200 },
    { enabled: !fromOrder },
  );
  const allCustomers = customerData?.customers ?? [];
  const filteredCustomers = customerSearch.trim().length === 0
    ? allCustomers
    : allCustomers.filter((c) => {
        const q = customerSearch.trim().toLowerCase();
        return (
          c.customerName?.toLowerCase().includes(q)
          || (c.phone ?? '').toLowerCase().includes(q)
        );
      });

  const effectiveCustomerId = fromOrder ? (params.customerId ?? '') : (pickedCustomer?.id ?? '');
  const effectiveCustomerName = fromOrder ? (params.customerName ?? 'Customer') : (pickedCustomer?.customerName ?? '');

  const handleSubmit = async () => {
    const amt = Number(amount);
    if (!(amt > 0)) {
      Alert.alert('Invalid amount', 'Enter an amount greater than zero.');
      return;
    }
    if (!effectiveCustomerId) {
      Alert.alert('Pick a customer', 'Select a customer before submitting.');
      return;
    }
    try {
      setSubmitting(true);
      await apiPost('/drivers/me/payment-submissions', {
        customerId: effectiveCustomerId,
        amount: amt,
        paymentMethod: method,
        transactionDate,
        referenceNumber: referenceNumber || undefined,
        notes: notes || undefined,
      });
      Alert.alert('Submitted', 'Payment submitted for verification.', [
        {
          text: 'OK',
          onPress: () => {
            queryClient.invalidateQueries({ queryKey: ['driver-payment-submissions'] });
            router.back();
          },
        },
      ]);
    } catch (err) {
      Alert.alert('Submission failed', getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: 'Submit Payment', headerShown: true }} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 12 }}>
          {fromOrder ? (
            <View style={cardStyle(colors)}>
              <Text style={{ fontSize: 13, color: colors.textSecondary }}>Customer</Text>
              <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text, marginTop: 2 }}>
                {effectiveCustomerName}
              </Text>
            </View>
          ) : (
            <View style={cardStyle(colors)}>
              <Text style={labelStyle(colors)}>Customer</Text>
              {pickedCustomer ? (
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                  <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>
                    {pickedCustomer.customerName}
                  </Text>
                  <Button title="Change" variant="secondary" size="sm" onPress={() => setPickedCustomer(null)} />
                </View>
              ) : (
                <>
                  <TextInput
                    value={customerSearch}
                    onChangeText={setCustomerSearch}
                    placeholder="Search customer by name or phone"
                    placeholderTextColor={colors.textMuted}
                    style={inputStyle(colors)}
                  />
                  <View style={{ marginTop: 8, maxHeight: 240 }}>
                    <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                      {filteredCustomers.length === 0 ? (
                        <Text style={{ color: colors.textSecondary, fontSize: 13, padding: 8 }}>
                          {customerSearch ? 'No matches.' : 'No customers loaded yet.'}
                        </Text>
                      ) : (
                        filteredCustomers.slice(0, 50).map((c) => (
                          <TouchableOpacity
                            key={c.customerId}
                            onPress={() => {
                              setPickedCustomer({ id: c.customerId, customerName: c.customerName });
                              setCustomerSearch('');
                            }}
                            style={{
                              paddingVertical: 10,
                              paddingHorizontal: 8,
                              borderBottomWidth: 1,
                              borderBottomColor: colors.cardBorder,
                            }}
                          >
                            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>
                              {c.customerName}
                            </Text>
                            {c.phone && (
                              <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                                {c.phone}
                              </Text>
                            )}
                          </TouchableOpacity>
                        ))
                      )}
                    </ScrollView>
                  </View>
                </>
              )}
            </View>
          )}

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
              {METHODS.map((m) => {
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
              title={submitting ? 'Submitting…' : 'Submit for Verification'}
              variant="primary"
              onPress={handleSubmit}
              disabled={submitting || !(Number(amount) > 0) || !effectiveCustomerId}
            />
          </View>
          <Text style={{ fontSize: 12, color: colors.textMuted, textAlign: 'center' }}>
            {"Your submission goes to the office for verification before posting to the customer's account."}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
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
