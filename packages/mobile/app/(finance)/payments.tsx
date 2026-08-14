import { useState } from 'react';
import {
  View, Text, ScrollView, RefreshControl, TouchableOpacity,
  Modal, TextInput, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { useTheme, formatINR } from '../../src/theme';
import { Card, Badge, MetricCard, Button, EmptyState, SearchInput } from '../../src/components/ui';
import type { Payment, Customer } from '@gaslink/shared';
import { localTodayISO } from '@gaslink/shared';
import { DepositsView } from '../../src/components/DepositsView';

const PAYMENT_METHODS = ['cash', 'cheque', 'online', 'upi', 'bank_transfer'] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// 2026-07-31 v6 (Change H): "deposits" added as a 3rd tab — same UX
// as web /app/billing-payments Deposits tab. Shared via DepositsView.
type ScreenTab = 'payments' | 'credit_notes' | 'deposits';

const METHOD_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  cash: 'cash-outline',
  cheque: 'receipt-outline',
  online: 'card-outline',
  bank_transfer: 'card-outline',
  upi: 'phone-portrait-outline',
};

// ─── Credit/Debit Note types ─────────────────────────────────────────────────

interface CreditNote {
  creditNoteId: string;
  noteNumber: string;
  type: 'credit' | 'debit';
  customerId: string;
  customerName: string;
  amount: number;
  reason: string;
  status: string;
  createdAt: string;
}

// Issued invoice for the CN/DN invoice picker (subset of GET /invoices).
interface NoteInvoice {
  invoiceId: string;
  invoiceNumber: string;
  totalAmount: number;
  outstandingAmount: number;
}

// ─── Main Screen ─────────────────────────────────────────────────────────────

export default function FinancePaymentsScreen() {
  const { dark, colors, accent } = useTheme();
  const [showRecord, setShowRecord] = useState(false);
  const [showCreateNote, setShowCreateNote] = useState(false);
  const [screenTab, setScreenTab] = useState<ScreenTab>('payments');
  // 2026-07-28 — quick search across customer name / reference / amount
  // (backend paymentService.listPayments treats numeric tokens as amount).
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  const paymentParams: Record<string, unknown> = {};
  if (search) paymentParams.search = search;

  const { data: paymentsResponse, isLoading, refetch } = useApiQuery<{ payments: Payment[] }>(
    ['fin-payments', search],
    '/payments',
    paymentParams,
  );
  const payments: Payment[] = paymentsResponse?.payments ?? [];

  const { data: creditNotes, isLoading: notesLoading, refetch: refetchNotes } = useApiQuery<CreditNote[]>(
    ['credit-notes'],
    '/credit-notes',
    {},
    { enabled: screenTab === 'credit_notes' },
  );

  const totalCollected = (payments ?? []).reduce((s, p) => s + (p.amount ?? 0), 0);

  const screenTabs: { label: string; value: ScreenTab }[] = [
    { label: 'Payments', value: 'payments' },
    { label: 'Credit/Debit Notes', value: 'credit_notes' },
    { label: 'Deposits', value: 'deposits' },
  ];

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Screen Tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}
      >
        {screenTabs.map((t) => (
          <TouchableOpacity
            key={t.value}
            onPress={() => setScreenTab(t.value)}
            style={{
              paddingHorizontal: 16,
              height: 36,
              borderRadius: 18,
              justifyContent: 'center',
              backgroundColor: screenTab === t.value ? accent.red : (dark ? colors.inputBg : '#f1f5f9'),
            }}
          >
            <Text style={{
              fontSize: 13,
              fontWeight: '600',
              color: screenTab === t.value ? '#fff' : colors.textSecondary,
            }}>
              {t.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {screenTab === 'payments' && (
        <>
          <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
            <SearchInput
              value={searchInput}
              onChangeText={setSearchInput}
              onDebouncedChange={setSearch}
              placeholder="Search customer, reference, amount"
            />
          </View>
          <ScrollView
            contentContainerStyle={{ padding: 16, gap: 10, flexGrow: 1 }}
            refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text }}>Payments</Text>
              <Button title="+ Record" size="sm" onPress={() => setShowRecord(true)} />
            </View>

            {/* Summary */}
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <MetricCard title="Total Collected" value={formatINR(totalCollected)} color={accent.green} />
              </View>
              <View style={{ flex: 1 }}>
                <MetricCard title="Transactions" value={payments?.length ?? 0} color={accent.blue} />
              </View>
            </View>

            {/* Payments List */}
            {(!payments || payments.length === 0) ? (
              <View style={{ flex: 1, justifyContent: 'center' }}>
                <EmptyState title="No payments" description="Record your first payment" />
              </View>
            ) : (
              payments.map((payment) => (
                <Card key={payment.paymentId}>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                    {/* Method Icon */}
                    <View style={{
                      width: 44, height: 44, borderRadius: 12,
                      backgroundColor: dark ? colors.inputBg : '#f1f5f9',
                      alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Ionicons
                        name={METHOD_ICONS[payment.paymentMethod] ?? 'cash-outline'}
                        size={22}
                        color={colors.textSecondary}
                      />
                    </View>

                    {/* Details */}
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <View style={{ flex: 1, marginRight: 8 }}>
                          <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>{payment.customerName}</Text>
                          <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>{payment.transactionDate}</Text>
                        </View>
                        <Text style={{ fontWeight: '800', fontSize: 18, color: accent.green }}>{formatINR(payment.amount)}</Text>
                      </View>

                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
                        <Badge label={(payment.paymentMethod || '').replace(/_/g, ' ')} variant="info" />
                        {payment.referenceNumber && (
                          <Text style={{ fontSize: 11, color: colors.textSecondary }}>Ref: {payment.referenceNumber}</Text>
                        )}
                      </View>

                      {/* Allocations */}
                      {(payment.allocations?.length ?? 0) > 0 && (
                        <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.divider }}>
                          <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>Applied to:</Text>
                          {(payment.allocations ?? []).map((alloc, i) => (
                            <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                              <Text style={{ fontSize: 12, color: colors.textSecondary }}>{alloc.invoiceNumber}</Text>
                              <Text style={{ fontSize: 12, fontWeight: '600', color: colors.text }}>{formatINR(alloc.allocatedAmount)}</Text>
                            </View>
                          ))}
                        </View>
                      )}
                    </View>
                  </View>
                </Card>
              ))
            )}
          </ScrollView>

          <RecordPaymentModal
            visible={showRecord}
            dark={dark}
            colors={colors}
            accent={accent}
            onClose={() => setShowRecord(false)}
            onSuccess={() => { refetch(); setShowRecord(false); }}
          />
        </>
      )}

      {screenTab === 'credit_notes' && (
        <>
          <ScrollView
            contentContainerStyle={{ padding: 16, gap: 10, flexGrow: 1 }}
            refreshControl={<RefreshControl refreshing={notesLoading} onRefresh={refetchNotes} />}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text }}>Credit/Debit Notes</Text>
              <Button title="+ Create" size="sm" onPress={() => setShowCreateNote(true)} />
            </View>

            {(!creditNotes || creditNotes.length === 0) ? (
              <View style={{ flex: 1, justifyContent: 'center' }}>
                <EmptyState title="No notes" description="No credit or debit notes yet" />
              </View>
            ) : (
              creditNotes.map((note) => (
                <Card key={note.creditNoteId}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                    <View style={{ flex: 1, marginRight: 8 }}>
                      <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>{note.noteNumber}</Text>
                      <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>{note.customerName}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 4 }}>
                      <Badge
                        label={note.type === 'credit' ? 'Credit' : 'Debit'}
                        variant={note.type === 'credit' ? 'success' : 'danger'}
                      />
                      <Badge label={note.status} variant="neutral" />
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ fontSize: 13, color: colors.textSecondary }}>{note.reason}</Text>
                    <Text style={{
                      fontWeight: '800',
                      fontSize: 16,
                      color: note.type === 'credit' ? accent.green : '#ef4444',
                    }}>
                      {note.type === 'credit' ? '-' : '+'}{formatINR(note.amount)}
                    </Text>
                  </View>
                  <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>{note.createdAt}</Text>
                </Card>
              ))
            )}
          </ScrollView>

          <CreateCreditNoteModal
            visible={showCreateNote}
            dark={dark}
            colors={colors}
            accent={accent}
            onClose={() => setShowCreateNote(false)}
            onSuccess={() => { refetchNotes(); setShowCreateNote(false); }}
          />
        </>
      )}

      {screenTab === 'deposits' && <DepositsView />}
    </SafeAreaView>
  );
}

// ─── Record Payment Modal ────────────────────────────────────────────────────

function RecordPaymentModal({ visible, dark, colors, accent, onClose, onSuccess }: {
  visible: boolean;
  dark: boolean;
  colors: ReturnType<typeof useTheme>['colors'];
  accent: ReturnType<typeof useTheme>['accent'];
  onClose: () => void;
  onSuccess: () => void;
}) {
  // 2026-07-28 (anti-pattern #25) — bottom-sheet Record Payment button
  // clips under Samsung 3-button nav without insets padding.
  const insets = useSafeAreaInsets();
  const [customerId, setCustomerId] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');

  const { data: customersResponse } = useApiQuery<{ customers: Customer[] }>(
    ['customers-for-payment'],
    '/customers',
    { pageSize: 100 },
    { enabled: visible },
  );
  const customers: Customer[] = customersResponse?.customers ?? [];

  const mutation = useApiMutation<Payment, {
    customerId: string;
    amount: number;
    paymentMethod: PaymentMethod;
    referenceNumber?: string;
    notes?: string;
    transactionDate: string;
  }>(
    'post', '/payments',
    {
      invalidateKeys: [['fin-payments'], ['fin-metrics'], ['fin-invoices']],
      successMessage: 'Payment recorded',
      onSuccess: () => {
        onSuccess();
        setCustomerId(''); setAmount(''); setMethod('cash'); setReference(''); setNotes(''); setCustomerSearch('');
      },
    },
  );

  const filteredCustomers = (customers ?? []).filter((c) =>
    !customerSearch || c.businessName?.toLowerCase().includes(customerSearch.toLowerCase()) ||
    c.customerName.toLowerCase().includes(customerSearch.toLowerCase()),
  );

  const selectedCustomer = customers?.find((c) => c.customerId === customerId);

  // 2026-08-13 (Suneel) — show the selected customer's pending due so the
  // office knows how much is outstanding before recording a payment. Sum of
  // that customer's open invoices' outstandingAmount (paid ones contribute 0).
  const { data: custInvoicesResp } = useApiQuery<{ invoices: Array<{ outstandingAmount: number }> }>(
    ['cust-outstanding', customerId],
    '/invoices',
    { customerId, pageSize: 300 },
    { enabled: visible && !!customerId },
  );
  const customerDue = (custInvoicesResp?.invoices ?? []).reduce((s, i) => s + (i.outstandingAmount || 0), 0);

  const handleSubmit = () => {
    if (!customerId) { Alert.alert('Required', 'Select a customer'); return; }
    if (!amount || parseFloat(amount) <= 0) { Alert.alert('Required', 'Enter a valid amount'); return; }

    mutation.mutate({
      customerId,
      amount: parseFloat(amount),
      paymentMethod: method,
      referenceNumber: reference.trim() || undefined,
      notes: notes.trim() || undefined,
      // Phase D (2026-06-12): local TZ — see localTodayISO docs.
      transactionDate: localTodayISO(),
    });
  };

  const inputStyle = {
    borderWidth: 1,
    borderColor: colors.inputBorder,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 15,
    backgroundColor: colors.inputBg,
    color: colors.text,
  };

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
          <View style={{
            backgroundColor: dark ? colors.cardBg : '#fff',
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            paddingTop: 24, paddingHorizontal: 24,
            paddingBottom: Math.max(insets.bottom + 8, 24),
            maxHeight: '90%',
          }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text }}>Record Payment</Text>
              <TouchableOpacity onPress={onClose}>
                <Ionicons name="close" size={26} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps="handled">
              {/* Customer Search */}
              <View>
                <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>Customer *</Text>
                {selectedCustomer ? (
                  <TouchableOpacity
                    onPress={() => setCustomerId('')}
                    style={{
                      backgroundColor: dark ? 'rgba(220, 38, 38, 0.1)' : '#fef2f2',
                      borderRadius: 12,
                      padding: 14,
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <Text style={{ fontWeight: '600', color: accent.red }}>
                      {selectedCustomer.businessName || selectedCustomer.customerName}
                    </Text>
                    <Text style={{ color: colors.textSecondary }}>Change</Text>
                  </TouchableOpacity>
                ) : (
                  <>
                    <TextInput
                      placeholder="Search customer..."
                      value={customerSearch}
                      onChangeText={setCustomerSearch}
                      style={inputStyle}
                      placeholderTextColor={colors.textMuted}
                    />
                    {customerSearch.length > 0 && (
                      <View style={{
                        maxHeight: 150,
                        borderWidth: 1,
                        borderColor: colors.inputBorder,
                        borderRadius: 12,
                        marginTop: 4,
                        backgroundColor: dark ? colors.cardBg : '#fff',
                      }}>
                        <ScrollView>
                          {filteredCustomers.slice(0, 8).map((c) => (
                            <TouchableOpacity
                              key={c.customerId}
                              onPress={() => { setCustomerId(c.customerId); setCustomerSearch(''); }}
                              style={{ padding: 12, borderBottomWidth: 1, borderBottomColor: colors.divider }}
                            >
                              <Text style={{ fontWeight: '600', color: colors.text }}>
                                {c.businessName || c.customerName}
                              </Text>
                            </TouchableOpacity>
                          ))}
                        </ScrollView>
                      </View>
                    )}
                  </>
                )}
              </View>

              {/* Amount */}
              <View>
                <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>Amount *</Text>
                <TextInput
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="numeric"
                  placeholder="0.00"
                  style={{
                    ...inputStyle,
                    fontSize: 24,
                    fontWeight: '700',
                    paddingVertical: 14,
                    textAlign: 'center',
                  }}
                  placeholderTextColor={colors.textMuted}
                />
              </View>

              {/* 2026-08-13 (Suneel) — pending due for the selected customer. */}
              {selectedCustomer && (
                <View style={{
                  borderRadius: 12, padding: 12,
                  flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                  backgroundColor: dark ? 'rgba(245, 158, 11, 0.12)' : '#fffbeb',
                }}>
                  <Text style={{ color: colors.textSecondary, fontSize: 13 }}>Pending due</Text>
                  <Text style={{ fontWeight: '800', fontSize: 16, color: customerDue > 0 ? '#f59e0b' : '#10b981' }}>
                    {formatINR(customerDue)}
                  </Text>
                </View>
              )}

              {/* Payment Method */}
              <View>
                <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 8 }}>Method</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {PAYMENT_METHODS.map((m) => (
                    <TouchableOpacity
                      key={m}
                      onPress={() => setMethod(m)}
                      style={{
                        paddingHorizontal: 14,
                        height: 36,
                        borderRadius: 18,
                        justifyContent: 'center',
                        backgroundColor: method === m ? accent.red : (dark ? colors.inputBg : '#f1f5f9'),
                        borderWidth: 1,
                        borderColor: method === m ? accent.red : colors.inputBorder,
                      }}
                    >
                      <Text style={{
                        fontSize: 13,
                        fontWeight: '600',
                        color: method === m ? '#fff' : colors.textSecondary,
                      }}>
                        {m.replace(/_/g, ' ').toUpperCase()}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* Reference */}
              <View>
                <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>Reference No.</Text>
                <TextInput
                  value={reference}
                  onChangeText={setReference}
                  placeholder="Cheque/UTR/Transaction ID"
                  style={{ ...inputStyle, paddingVertical: 14, fontSize: 16 }}
                  placeholderTextColor={colors.textMuted}
                />
              </View>

              {/* Notes */}
              <View>
                <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>Notes</Text>
                <TextInput
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Optional notes..."
                  multiline
                  style={{
                    ...inputStyle,
                    paddingVertical: 14,
                    fontSize: 16,
                    minHeight: 60,
                    textAlignVertical: 'top',
                  }}
                  placeholderTextColor={colors.textMuted}
                />
              </View>

              <Button title="Record Payment" onPress={handleSubmit} loading={mutation.isPending} style={{ marginTop: 4 }} />
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── Create Credit/Debit Note Modal ─────────────────────────────────────────

function CreateCreditNoteModal({ visible, dark, colors, accent, onClose, onSuccess }: {
  visible: boolean;
  dark: boolean;
  colors: ReturnType<typeof useTheme>['colors'];
  accent: ReturnType<typeof useTheme>['accent'];
  onClose: () => void;
  onSuccess: () => void;
}) {
  // 2026-07-28 (anti-pattern #25) — bottom-sheet Create Note button
  // clips under Samsung 3-button nav without insets padding.
  const insets = useSafeAreaInsets();
  const [noteType, setNoteType] = useState<'credit' | 'debit'>('credit');
  const [customerId, setCustomerId] = useState('');
  // A CN/DN is always raised AGAINST a specific invoice (API requires
  // invoiceId). Pick the customer, then the customer's issued invoice.
  const [invoiceId, setInvoiceId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');

  const { data: customersResponse } = useApiQuery<{ customers: Customer[] }>(
    ['customers-for-note'],
    '/customers',
    { pageSize: 100 },
    { enabled: visible },
  );
  const customers: Customer[] = customersResponse?.customers ?? [];

  // Issued invoices for the chosen customer — same source the admin CN/DN flow
  // and DepositsView use. Only 'issued' invoices can take a CN/DN.
  const { data: invoicesResp } = useApiQuery<{ invoices: NoteInvoice[] }>(
    ['note-customer-invoices', customerId],
    '/invoices',
    { customerId, status: 'issued', pageSize: 50 },
    { enabled: visible && !!customerId },
  );
  const invoices: NoteInvoice[] = invoicesResp?.invoices ?? [];
  const selectedInvoice = invoices.find((i) => i.invoiceId === invoiceId);

  const resetForm = () => {
    setNoteType('credit'); setCustomerId(''); setInvoiceId('');
    setAmount(''); setReason(''); setCustomerSearch('');
  };
  const onDone = () => { onSuccess(); resetForm(); };

  // Route by type — the real endpoints are /invoices/credit-notes and
  // /invoices/debit-notes (the old flat '/credit-notes' 404'd). Body is
  // { invoiceId, amount, reason } per createCreditNoteSchema.
  const creditMutation = useApiMutation<unknown, { invoiceId: string; amount: number; reason: string }>(
    'post', '/invoices/credit-notes',
    { invalidateKeys: [['credit-notes'], ['fin-invoices'], ['fin-metrics']], successMessage: 'Credit note created — pending approval', onSuccess: onDone },
  );
  const debitMutation = useApiMutation<unknown, { invoiceId: string; amount: number; reason: string }>(
    'post', '/invoices/debit-notes',
    { invalidateKeys: [['credit-notes'], ['fin-invoices'], ['fin-metrics']], successMessage: 'Debit note created — pending approval', onSuccess: onDone },
  );
  const activeMutation = noteType === 'credit' ? creditMutation : debitMutation;

  const filteredCustomers = (customers ?? []).filter((c) =>
    !customerSearch || c.businessName?.toLowerCase().includes(customerSearch.toLowerCase()) ||
    c.customerName.toLowerCase().includes(customerSearch.toLowerCase()),
  );

  const selectedCustomer = customers?.find((c) => c.customerId === customerId);

  const handleSubmit = () => {
    if (!customerId) { Alert.alert('Required', 'Select a customer'); return; }
    // selectedInvoice is only defined when invoiceId is in THIS customer's
    // issued-invoice list — so a stale pick from a previous customer can't slip
    // through (the picker re-shows and this guard blocks submit).
    if (!selectedInvoice) { Alert.alert('Required', 'Select the invoice this note is against'); return; }
    if (!amount || parseFloat(amount) <= 0) { Alert.alert('Required', 'Enter a valid amount'); return; }
    if (reason.trim().length === 0) { Alert.alert('Required', 'Enter a reason'); return; }

    activeMutation.mutate({
      invoiceId: selectedInvoice.invoiceId,
      amount: parseFloat(amount),
      reason: reason.trim(),
    });
  };

  const inputStyle = {
    borderWidth: 1,
    borderColor: colors.inputBorder,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 15,
    backgroundColor: colors.inputBg,
    color: colors.text,
  };

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
          <View style={{
            backgroundColor: dark ? colors.cardBg : '#fff',
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            paddingTop: 24, paddingHorizontal: 24,
            paddingBottom: Math.max(insets.bottom + 8, 24),
            maxHeight: '90%',
          }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text }}>Create Note</Text>
              <TouchableOpacity onPress={onClose}>
                <Ionicons name="close" size={26} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps="handled">
              {/* Note Type */}
              <View>
                <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 8 }}>Type *</Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {(['credit', 'debit'] as const).map((t) => (
                    <TouchableOpacity
                      key={t}
                      onPress={() => setNoteType(t)}
                      style={{
                        flex: 1,
                        paddingVertical: 12,
                        borderRadius: 12,
                        alignItems: 'center',
                        backgroundColor: noteType === t
                          ? (t === 'credit' ? accent.green : '#ef4444')
                          : (dark ? colors.inputBg : '#f1f5f9'),
                        borderWidth: 1,
                        borderColor: noteType === t
                          ? (t === 'credit' ? accent.green : '#ef4444')
                          : colors.inputBorder,
                      }}
                    >
                      <Text style={{
                        fontSize: 14,
                        fontWeight: '700',
                        color: noteType === t ? '#fff' : colors.textSecondary,
                      }}>
                        {t === 'credit' ? 'Credit Note' : 'Debit Note'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* Customer Search */}
              <View>
                <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>Customer *</Text>
                {selectedCustomer ? (
                  <TouchableOpacity
                    onPress={() => setCustomerId('')}
                    style={{
                      backgroundColor: dark ? 'rgba(220, 38, 38, 0.1)' : '#fef2f2',
                      borderRadius: 12,
                      padding: 14,
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <Text style={{ fontWeight: '600', color: accent.red }}>
                      {selectedCustomer.businessName || selectedCustomer.customerName}
                    </Text>
                    <Text style={{ color: colors.textSecondary }}>Change</Text>
                  </TouchableOpacity>
                ) : (
                  <>
                    <TextInput
                      placeholder="Search customer..."
                      value={customerSearch}
                      onChangeText={setCustomerSearch}
                      style={inputStyle}
                      placeholderTextColor={colors.textMuted}
                    />
                    {customerSearch.length > 0 && (
                      <View style={{
                        maxHeight: 150,
                        borderWidth: 1,
                        borderColor: colors.inputBorder,
                        borderRadius: 12,
                        marginTop: 4,
                        backgroundColor: dark ? colors.cardBg : '#fff',
                      }}>
                        <ScrollView>
                          {filteredCustomers.slice(0, 8).map((c) => (
                            <TouchableOpacity
                              key={c.customerId}
                              onPress={() => { setCustomerId(c.customerId); setCustomerSearch(''); }}
                              style={{ padding: 12, borderBottomWidth: 1, borderBottomColor: colors.divider }}
                            >
                              <Text style={{ fontWeight: '600', color: colors.text }}>
                                {c.businessName || c.customerName}
                              </Text>
                            </TouchableOpacity>
                          ))}
                        </ScrollView>
                      </View>
                    )}
                  </>
                )}
              </View>

              {/* Invoice — a CN/DN is always raised against a specific invoice */}
              {customerId ? (
                <View>
                  <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>Invoice *</Text>
                  {selectedInvoice ? (
                    <TouchableOpacity
                      onPress={() => setInvoiceId('')}
                      style={{ backgroundColor: dark ? 'rgba(220, 38, 38, 0.1)' : '#fef2f2', borderRadius: 12, padding: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
                    >
                      <Text style={{ fontWeight: '600', color: accent.red }}>{selectedInvoice.invoiceNumber}</Text>
                      <Text style={{ color: colors.textSecondary }}>₹{Number(selectedInvoice.outstandingAmount).toFixed(2)} due · Change</Text>
                    </TouchableOpacity>
                  ) : invoices.length === 0 ? (
                    <Text style={{ fontSize: 13, color: colors.textMuted, padding: 12, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 12 }}>
                      No issued invoices for this customer.
                    </Text>
                  ) : (
                    <View style={{ maxHeight: 160, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 12, backgroundColor: dark ? colors.cardBg : '#fff' }}>
                      <ScrollView keyboardShouldPersistTaps="handled">
                        {invoices.map((inv) => (
                          <TouchableOpacity
                            key={inv.invoiceId}
                            onPress={() => setInvoiceId(inv.invoiceId)}
                            style={{ padding: 12, borderBottomWidth: 1, borderBottomColor: colors.divider, flexDirection: 'row', justifyContent: 'space-between' }}
                          >
                            <Text style={{ fontWeight: '600', color: colors.text }}>{inv.invoiceNumber}</Text>
                            <Text style={{ color: colors.textSecondary }}>₹{Number(inv.outstandingAmount).toFixed(2)} due</Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    </View>
                  )}
                </View>
              ) : null}

              {/* Amount */}
              <View>
                <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>Amount *</Text>
                <TextInput
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="numeric"
                  placeholder="0.00"
                  style={{
                    ...inputStyle,
                    fontSize: 24,
                    fontWeight: '700',
                    paddingVertical: 14,
                    textAlign: 'center',
                  }}
                  placeholderTextColor={colors.textMuted}
                />
              </View>

              {/* Reason */}
              <View>
                <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>Reason *</Text>
                <TextInput
                  value={reason}
                  onChangeText={setReason}
                  placeholder="Reason for note..."
                  multiline
                  style={{
                    ...inputStyle,
                    paddingVertical: 14,
                    fontSize: 16,
                    minHeight: 80,
                    textAlignVertical: 'top',
                  }}
                  placeholderTextColor={colors.textMuted}
                />
              </View>

              <Button title="Create Note" onPress={handleSubmit} loading={activeMutation.isPending} style={{ marginTop: 4 }} />
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
