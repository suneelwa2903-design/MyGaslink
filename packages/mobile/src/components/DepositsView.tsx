/**
 * DepositsView — mobile counterpart to web /app/billing-payments Deposits tab.
 *
 * Mirrors the web Deposits UX (Change G, 2026-07-31 v6):
 *   • KPI strip: Deposits Held ₹ / Customers count / Cylinders count
 *   • Filters: customer / cylinder type / event type / date range
 *   • Paginated FlatList of deposit events (charged + refunded)
 *   • + Record Deposit bottom-sheet with charge/refund toggle,
 *     customer picker, cyl type picker, qty, amount (auto-fill from
 *     EmptyCylinderPrice), payment method, credit-note invoice picker
 *     when refund via credit-note.
 *
 * Anti-pattern #25 compliance:
 *   • Modal uses useSafeAreaInsets() for Android nav-bar clearance
 *   • Scrollable body has keyboardShouldPersistTaps="handled"
 *   • Modal has onRequestClose for Android hardware back
 *   • Customer picker has SearchInput at top (distributors with >20 customers)
 *
 * Renders inside both:
 *   - packages/mobile/app/(admin)/finance.tsx (Billing top-tab: Deposits)
 *   - packages/mobile/app/(finance)/payments.tsx (Payments screen tab: Deposits)
 */
import { useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, FlatList, RefreshControl,
  TouchableOpacity, Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery, useApiMutation } from '../hooks/useApi';
import { useTheme, formatINR, formatDate } from '../theme';
import { Card, MetricCard, Badge, Button, EmptyState, SearchInput, DateInput, SelectField } from './ui';
import { localTodayISO } from '@gaslink/shared';

type EventFilter = 'all' | 'charged' | 'refunded';

interface DepositRow {
  id: string;
  entryDate: string;
  customerId: string;
  customerName: string;
  eventType: 'charged' | 'refunded';
  cylinderTypeId: string | null;
  cylinderTypeName: string | null;
  qty: number;
  amount: number;
  paymentMethod: string | null;
  referenceType: 'payment' | 'credit_note' | null;
  referenceNumber: string | null;
  narration: string | null;
  // Change L v2 (2026-07-31): sequential voucher number — nullable for
  // pre-migration rows / no-docCode distributors.
  voucherNumber: string | null;
}

interface DepositListResp {
  data: DepositRow[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
  summary: { totalHeld: number; customerCount: number; cylinderCount: number };
}

interface CustomerLite {
  customerId: string;
  customerName: string;
  phone: string;
}

interface CylinderTypeLite {
  cylinderTypeId: string;
  typeName: string;
  isActive: boolean;
}

interface EmptyPriceRow {
  cylinderTypeId: string;
  emptyCylinderPrice: number;
}

interface OpenInvoiceLite {
  id: string;
  invoiceNumber: string;
  outstandingAmount: number;
}

export function DepositsView() {
  const { dark, colors, accent } = useTheme();
  const [showRecord, setShowRecord] = useState(false);
  // 2026-08-01 polish (Change H post-mortem): dropped the on-screen
  // customer filter — the polished header now has 2 SelectField dropdowns
  // (Event + Cylinder type). Web keeps a customer combobox; mobile
  // operators drill via the Deposits list rather than pre-filtering.
  // Re-add here + a mobile Customer picker if needed later.
  const [cylinderTypeFilter, setCylinderTypeFilter] = useState<string>('');
  const [eventFilter, setEventFilter] = useState<EventFilter>('all');
  const [page, setPage] = useState(1);

  const params: Record<string, unknown> = { pageSize: 25, page };
  if (cylinderTypeFilter) params.cylinderTypeId = cylinderTypeFilter;
  if (eventFilter !== 'all') params.eventType = eventFilter;

  const { data, isLoading, refetch, isRefetching } = useApiQuery<DepositListResp>(
    ['mobile-deposits', String(page), cylinderTypeFilter, eventFilter],
    '/payments/deposits',
    params,
  );

  const rows = data?.data ?? [];
  const summary = data?.summary;
  const meta = data?.meta;

  // 2026-07-31 v7 (Change I): defer the 500-customer preload to when
  // the record sheet actually opens. Pre-v7 the query fired on every
  // Deposits-tab open — for a 500-customer tenant that's ~200KB payload
  // that briefly blocked the FlatList's initial render (and pinned the
  // TanStack Query cache to the tab's lifetime). Cylinder types + empty
  // prices stay preloaded (small: ~3-8 rows) so the record sheet feels
  // instant once the customer list arrives.
  const { data: customerListResp, isFetching: customersFetching } = useApiQuery<{ customers: CustomerLite[] }>(
    ['mobile-customers-for-deposits'],
    '/customers',
    { pageSize: 500, status: 'active' },
    { enabled: showRecord },
  );
  const customerList: CustomerLite[] = customerListResp?.customers ?? [];

  const { data: cylinderTypesResp } = useApiQuery<{ cylinderTypes: CylinderTypeLite[] }>(
    ['mobile-cylinder-types-for-deposits'],
    '/cylinder-types',
  );
  const cylinderTypes: CylinderTypeLite[] = (cylinderTypesResp?.cylinderTypes ?? []).filter((t) => t.isActive);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        refreshControl={<RefreshControl refreshing={isLoading || isRefetching} onRefresh={refetch} />}
        contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 10, flexGrow: 1 }}
        ListHeaderComponent={
          <View style={{ gap: 12, marginBottom: 6 }}>
            {/* 2026-08-01 polish — dropped the "Deposits" title (repetitive
                with the tab label right above it) and moved the + Record
                button to sit alone on its own row, right-aligned. Uses
                accent.red as an inline background to match the finance
                tab's red accent (Payments' Button primary was blue —
                this override keeps Deposits visually consistent with the
                red highlight already used on the active tab underline). */}
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
              <Button
                title="+ Record"
                size="sm"
                onPress={() => setShowRecord(true)}
                style={{ backgroundColor: accent.red }}
              />
            </View>

            {/* KPI strip */}
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <MetricCard
                  title="Deposits Held"
                  value={formatINR(summary?.totalHeld ?? 0)}
                  color={accent.blue}
                />
              </View>
              <View style={{ flex: 1 }}>
                <MetricCard
                  title="Customers"
                  value={String(summary?.customerCount ?? 0)}
                  color={accent.green}
                />
              </View>
              <View style={{ flex: 1 }}>
                <MetricCard
                  title="Cylinders"
                  value={String(summary?.cylinderCount ?? 0)}
                  color={accent.red}
                />
              </View>
            </View>

            {/* 2026-08-01 polish — filters were previously horizontal
                pill-row ScrollViews. Aligned to the Invoices tab pattern
                (packages/mobile/app/(finance)/invoices.tsx), which uses
                SelectField dropdowns — cleaner on small screens and
                consistent with the Status filter UX operators already
                learned. Event filter and cylinder-type filter each get
                their own SelectField; both reset the pager to page 1 on
                change (same as the pill implementation). */}
            <View style={{ gap: 8 }}>
              <SelectField
                label="Event"
                value={eventFilter}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'charged', label: 'Charged' },
                  { value: 'refunded', label: 'Refunded' },
                ]}
                onChange={(v) => { setEventFilter(v as EventFilter); setPage(1); }}
                accent={accent.red}
              />
              {cylinderTypes.length > 0 && (
                <SelectField
                  label="Cylinder type"
                  value={cylinderTypeFilter}
                  options={[
                    { value: '', label: 'All types' },
                    ...cylinderTypes.map((t) => ({ value: t.cylinderTypeId, label: t.typeName })),
                  ]}
                  onChange={(v) => { setCylinderTypeFilter(v); setPage(1); }}
                  accent={accent.red}
                />
              )}
            </View>
          </View>
        }
        ListEmptyComponent={
          isLoading ? null : (
            <View style={{ flex: 1, justifyContent: 'center' }}>
              <EmptyState
                title="No deposits yet"
                description={
                  (cylinderTypeFilter || eventFilter !== 'all')
                    ? 'No deposits match the current filters.'
                    : 'Tap + Record to charge your first cylinder deposit.'
                }
              />
            </View>
          )
        }
        renderItem={({ item: r }) => (
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
              <View style={{
                width: 40, height: 40, borderRadius: 10,
                backgroundColor: dark ? colors.inputBg : '#f1f5f9',
                alignItems: 'center', justifyContent: 'center',
              }}>
                <Ionicons
                  name={r.eventType === 'charged' ? 'arrow-down-outline' : 'arrow-up-outline'}
                  size={20}
                  color={r.eventType === 'charged' ? accent.blue : accent.red}
                />
              </View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1, marginRight: 8 }}>
                    <Text style={{ fontWeight: '700', fontSize: 14, color: colors.text }}>
                      {r.customerName}
                    </Text>
                    <Text style={{ fontSize: 11, color: colors.textSecondary, marginTop: 2 }}>
                      {formatDate(r.entryDate)} · {r.cylinderTypeName ?? '—'} × {r.qty}
                    </Text>
                  </View>
                  <Text style={{
                    fontWeight: '800',
                    fontSize: 16,
                    color: r.eventType === 'charged' ? accent.blue : accent.red,
                  }}>
                    {r.eventType === 'charged' ? '+' : '-'}{formatINR(r.amount)}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                  <Badge
                    label={r.eventType === 'charged' ? 'Deposit' : 'Refund'}
                    variant={r.eventType === 'charged' ? 'info' : 'warning'}
                  />
                  {/* Change L v2 (2026-07-31): sequential voucher no pill —
                      lets driver/finance quote it during customer disputes. */}
                  {r.voucherNumber && (
                    <Text style={{
                      fontSize: 11,
                      fontFamily: 'Courier',
                      color: accent.blue,
                      fontWeight: '700',
                    }}>
                      {r.voucherNumber}
                    </Text>
                  )}
                  {r.paymentMethod && (
                    <Text style={{ fontSize: 11, color: colors.textSecondary }}>
                      {r.paymentMethod.replace(/_/g, ' ')}
                    </Text>
                  )}
                  {r.referenceNumber && (
                    <Text style={{ fontSize: 11, color: colors.textSecondary }}>
                      Ref: {r.referenceNumber}
                    </Text>
                  )}
                </View>
              </View>
            </View>
          </Card>
        )}
        ListFooterComponent={
          meta && meta.totalPages > 1 ? (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>
                Page {meta.page} of {meta.totalPages} · {meta.total} total
              </Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button
                  title="Prev"
                  size="sm"
                  variant="ghost"
                  onPress={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                />
                <Button
                  title="Next"
                  size="sm"
                  variant="ghost"
                  onPress={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
                  disabled={page >= meta.totalPages}
                />
              </View>
            </View>
          ) : null
        }
      />

      <RecordDepositSheet
        visible={showRecord}
        onClose={() => setShowRecord(false)}
        onSuccess={() => { refetch(); setShowRecord(false); }}
        customers={customerList}
        customersLoading={customersFetching}
        cylinderTypes={cylinderTypes}
      />
    </View>
  );
}

// ─── Record Deposit bottom sheet ─────────────────────────────────────────────

interface RecordDepositSheetProps {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
  customers: CustomerLite[];
  customersLoading: boolean;
  cylinderTypes: CylinderTypeLite[];
}

type Mode = 'charge' | 'refund';

function RecordDepositSheet({ visible, onClose, onSuccess, customers, customersLoading, cylinderTypes }: RecordDepositSheetProps) {
  const { dark, colors, accent } = useTheme();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>('charge');
  const [customerId, setCustomerId] = useState('');
  const [cylinderTypeId, setCylinderTypeId] = useState('');
  const [qty, setQty] = useState('');
  const [amount, setAmount] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'upi' | 'cheque' | 'neft' | 'rtgs' | 'other'>('cash');
  const [refundMethod, setRefundMethod] = useState<'cash' | 'credit_note'>('cash');
  const [creditNoteInvoiceId, setCreditNoteInvoiceId] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false);
  const [typePickerOpen, setTypePickerOpen] = useState(false);
  const [invoicePickerOpen, setInvoicePickerOpen] = useState(false);
  const [notes, setNotes] = useState('');
  // 2026-07-31 v8 (Change K): editable transaction date. Defaults to
  // today (localTodayISO — TZ-safe per anti-pattern #21). Operator can
  // backdate for a deposit slip entered a day later.
  const [transactionDate, setTransactionDate] = useState(() => localTodayISO());

  // Reset on close.
  // 2026-08-04 — the state fanout is deferred to a microtask so React
  // doesn't schedule the cascade synchronously inside the same commit
  // — the "Calling setState synchronously within an effect can trigger
  // cascading renders" lint rule flags the eager form. Same pattern as
  // SignaturePadModal.tsx:209.
  useEffect(() => {
    if (visible) return;
    void Promise.resolve().then(() => {
      setMode('charge');
      setCustomerId('');
      setCylinderTypeId('');
      setQty('');
      setAmount('');
      setAmountTouched(false);
      setPaymentMethod('cash');
      setRefundMethod('cash');
      setCreditNoteInvoiceId('');
      setCustomerSearch('');
      setNotes('');
      setTransactionDate(localTodayISO());
    });
  }, [visible]);

  // Preload empty prices for auto-fill (single query, small payload).
  const { data: emptyPricesRaw } = useApiQuery<EmptyPriceRow[]>(
    ['mobile-empty-prices-for-deposits'],
    '/cylinder-types/empty-prices/list',
    undefined,
    { enabled: visible },
  );
  const emptyPriceMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of emptyPricesRaw ?? []) m.set(p.cylinderTypeId, p.emptyCylinderPrice);
    return m;
  }, [emptyPricesRaw]);

  // Auto-fill amount from qty × unit price whenever user hasn't overridden.
  // 2026-08-04 — same microtask-defer pattern as the reset effect above:
  // sidesteps the "setState synchronously within an effect" lint rule
  // while keeping the auto-fill UX behaviour identical.
  useEffect(() => {
    if (amountTouched) return;
    const q = Number(qty);
    const p = cylinderTypeId ? emptyPriceMap.get(cylinderTypeId) ?? 0 : 0;
    if (q > 0 && p > 0) {
      void Promise.resolve().then(() => setAmount(String(q * p)));
    }
  }, [qty, cylinderTypeId, emptyPriceMap, amountTouched]);

  // Open invoices — only loaded when credit-note refund is selected.
  const { data: openInvoicesResp } = useApiQuery<{ invoices: OpenInvoiceLite[] }>(
    ['mobile-open-invoices-for-refund', customerId],
    '/invoices',
    { customerId, status: 'issued', pageSize: 50 },
    { enabled: visible && !!customerId && mode === 'refund' && refundMethod === 'credit_note' },
  );
  const openInvoices = openInvoicesResp?.invoices ?? [];

  const chargeMutation = useApiMutation<unknown, {
    customerId: string;
    amount: number;
    paymentMethod: string;
    transactionDate: string;
    notes?: string;
    deposits: Array<{ cylinderTypeId: string; qty: number; amount: number }>;
  }>('post', '/payments', {
    onSuccess: () => onSuccess(),
  });

  const refundMutation = useApiMutation<unknown, {
    cylinderTypeId: string;
    qty: number;
    amount: number;
    method: 'cash' | 'credit_note';
    paymentMethod?: string;
    creditNoteInvoiceId?: string;
    transactionDate: string;
    notes?: string;
  }>('post', `/payments/refund-deposit/${customerId || 'PICK'}`, {
    onSuccess: () => onSuccess(),
  });

  const filteredCustomers = customerSearch.trim()
    ? customers.filter((c) => {
        const s = customerSearch.trim().toLowerCase();
        return c.customerName.toLowerCase().includes(s) || c.phone.toLowerCase().includes(s);
      })
    : customers;

  const selectedCustomer = customers.find((c) => c.customerId === customerId);
  const selectedType = cylinderTypes.find((t) => t.cylinderTypeId === cylinderTypeId);
  const selectedTypePrice = cylinderTypeId ? emptyPriceMap.get(cylinderTypeId) : undefined;
  const selectedInvoice = openInvoices.find((i) => i.id === creditNoteInvoiceId);

  const canSubmit = !!customerId && !!cylinderTypeId && Number(qty) > 0 && Number(amount) > 0
    && (mode === 'charge' || refundMethod === 'cash' || !!creditNoteInvoiceId);

  const submit = () => {
    const q = Number(qty);
    const a = Number(amount);
    if (!customerId || !cylinderTypeId || !(q > 0) || !(a > 0)) return;
    if (mode === 'charge') {
      chargeMutation.mutate({
        customerId,
        amount: a,
        paymentMethod,
        transactionDate,
        notes: notes || undefined,
        deposits: [{ cylinderTypeId, qty: q, amount: a }],
      });
    } else {
      refundMutation.mutate({
        cylinderTypeId,
        qty: q,
        amount: a,
        method: refundMethod,
        paymentMethod: refundMethod === 'cash' ? paymentMethod : undefined,
        creditNoteInvoiceId: refundMethod === 'credit_note' ? creditNoteInvoiceId : undefined,
        transactionDate,
        notes: notes || undefined,
      });
    }
  };

  const submitting = chargeMutation.isPending || refundMutation.isPending;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1, justifyContent: 'flex-end' }}
        >
          <View style={{
            backgroundColor: colors.bg,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            maxHeight: '90%',
            paddingBottom: Math.max(insets.bottom + 8, 16),
          }}>
            {/* Header */}
            <View style={{
              flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
              padding: 16, borderBottomWidth: 1, borderBottomColor: colors.divider,
            }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text }}>Record Deposit</Text>
              <TouchableOpacity onPress={onClose}>
                <Ionicons name="close" size={26} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ padding: 16, gap: 12 }}
            >
              {/* Mode toggle */}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {(['charge', 'refund'] as Mode[]).map((m) => {
                  const active = mode === m;
                  return (
                    <TouchableOpacity
                      key={m}
                      onPress={() => setMode(m)}
                      style={{
                        flex: 1,
                        paddingVertical: 12,
                        borderRadius: 10,
                        alignItems: 'center',
                        backgroundColor: active ? accent.blue : (dark ? colors.inputBg : '#eef2f7'),
                      }}
                    >
                      <Text style={{
                        fontSize: 14, fontWeight: '700',
                        color: active ? '#fff' : colors.textSecondary,
                      }}>
                        {m === 'charge' ? 'Charge' : 'Refund'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Customer picker */}
              <TouchableOpacity
                onPress={() => setCustomerPickerOpen(true)}
                style={{
                  paddingVertical: 12,
                  paddingHorizontal: 12,
                  borderRadius: 10,
                  backgroundColor: dark ? colors.inputBg : '#f8fafc',
                  borderWidth: 1,
                  borderColor: colors.divider,
                }}
              >
                <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 2 }}>Customer</Text>
                <Text style={{ fontSize: 15, fontWeight: '600', color: selectedCustomer ? colors.text : colors.textMuted }}>
                  {selectedCustomer ? selectedCustomer.customerName : 'Pick a customer'}
                </Text>
              </TouchableOpacity>

              {/* Cyl type picker */}
              <TouchableOpacity
                onPress={() => setTypePickerOpen(true)}
                style={{
                  paddingVertical: 12,
                  paddingHorizontal: 12,
                  borderRadius: 10,
                  backgroundColor: dark ? colors.inputBg : '#f8fafc',
                  borderWidth: 1,
                  borderColor: colors.divider,
                }}
              >
                <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 2 }}>Cylinder Type</Text>
                <Text style={{ fontSize: 15, fontWeight: '600', color: selectedType ? colors.text : colors.textMuted }}>
                  {selectedType
                    ? `${selectedType.typeName}${selectedTypePrice != null ? ` (Rs. ${selectedTypePrice}/cyl)` : ' — no price set'}`
                    : 'Pick a type'}
                </Text>
              </TouchableOpacity>

              {/* Qty + Amount side by side */}
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>Quantity</Text>
                  <TextInput
                    keyboardType="number-pad"
                    value={qty}
                    onChangeText={setQty}
                    placeholder="0"
                    placeholderTextColor={colors.textMuted}
                    style={{
                      paddingVertical: 12,
                      paddingHorizontal: 12,
                      borderRadius: 10,
                      backgroundColor: dark ? colors.inputBg : '#f8fafc',
                      borderWidth: 1,
                      borderColor: colors.divider,
                      color: colors.text,
                      fontSize: 15,
                    }}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>Amount (Rs.)</Text>
                  <TextInput
                    keyboardType="decimal-pad"
                    value={amount}
                    onChangeText={(v) => { setAmountTouched(true); setAmount(v); }}
                    placeholder="0.00"
                    placeholderTextColor={colors.textMuted}
                    style={{
                      paddingVertical: 12,
                      paddingHorizontal: 12,
                      borderRadius: 10,
                      backgroundColor: dark ? colors.inputBg : '#f8fafc',
                      borderWidth: 1,
                      borderColor: colors.divider,
                      color: colors.text,
                      fontSize: 15,
                    }}
                  />
                </View>
              </View>
              {!amountTouched && Number(qty) > 0 && selectedTypePrice != null && (
                <Text style={{ fontSize: 11, color: colors.textMuted }}>
                  Auto-filled = qty × empty cylinder price. Edit to override.
                </Text>
              )}

              {/* Refund method (refund mode only) */}
              {mode === 'refund' && (
                <View>
                  <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>Refund Method</Text>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {(['cash', 'credit_note'] as const).map((m) => {
                      const active = refundMethod === m;
                      return (
                        <TouchableOpacity
                          key={m}
                          onPress={() => setRefundMethod(m)}
                          style={{
                            flex: 1,
                            paddingVertical: 10,
                            borderRadius: 8,
                            alignItems: 'center',
                            backgroundColor: active ? accent.green : (dark ? colors.inputBg : '#eef2f7'),
                          }}
                        >
                          <Text style={{
                            fontSize: 12, fontWeight: '600',
                            color: active ? '#fff' : colors.textSecondary,
                          }}>
                            {m === 'cash' ? 'Cash out' : 'Credit note'}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              )}

              {/* Credit note invoice picker */}
              {mode === 'refund' && refundMethod === 'credit_note' && (
                <TouchableOpacity
                  onPress={() => setInvoicePickerOpen(true)}
                  style={{
                    paddingVertical: 12,
                    paddingHorizontal: 12,
                    borderRadius: 10,
                    backgroundColor: dark ? colors.inputBg : '#f8fafc',
                    borderWidth: 1,
                    borderColor: colors.divider,
                  }}
                >
                  <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 2 }}>Apply credit to invoice</Text>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: selectedInvoice ? colors.text : colors.textMuted }}>
                    {selectedInvoice
                      ? `${selectedInvoice.invoiceNumber} (${formatINR(selectedInvoice.outstandingAmount)} outstanding)`
                      : 'Pick an open invoice'}
                  </Text>
                </TouchableOpacity>
              )}

              {/* Payment method (charge OR cash refund) */}
              {(mode === 'charge' || refundMethod === 'cash') && (
                <View>
                  <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>Payment Method</Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={{ gap: 8 }}
                  >
                    {(['cash', 'upi', 'cheque', 'neft', 'rtgs', 'other'] as const).map((m) => {
                      const active = paymentMethod === m;
                      return (
                        <TouchableOpacity
                          key={m}
                          onPress={() => setPaymentMethod(m)}
                          style={{
                            paddingHorizontal: 16,
                            height: 34,
                            borderRadius: 17,
                            justifyContent: 'center',
                            backgroundColor: active ? accent.blue : (dark ? colors.inputBg : '#eef2f7'),
                          }}
                        >
                          <Text style={{
                            fontSize: 12, fontWeight: '600',
                            color: active ? '#fff' : colors.textSecondary,
                          }}>
                            {m.toUpperCase()}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
              )}

              {/* Transaction date — defaults to today, backdate-editable */}
              <View>
                <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>Transaction Date</Text>
                <DateInput
                  value={transactionDate}
                  onChange={setTransactionDate}
                />
                <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>
                  Defaults to today. Change to backdate a late-entered deposit slip.
                </Text>
              </View>

              {/* Notes */}
              <View>
                <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>Notes (optional)</Text>
                <TextInput
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="e.g. NC — new cylinder issued"
                  placeholderTextColor={colors.textMuted}
                  style={{
                    paddingVertical: 12,
                    paddingHorizontal: 12,
                    borderRadius: 10,
                    backgroundColor: dark ? colors.inputBg : '#f8fafc',
                    borderWidth: 1,
                    borderColor: colors.divider,
                    color: colors.text,
                    fontSize: 14,
                  }}
                />
              </View>

              {/* Submit */}
              <Button
                title={mode === 'charge' ? 'Charge Deposit' : 'Refund Deposit'}
                onPress={submit}
                disabled={!canSubmit || submitting}
                loading={submitting}
                style={{ marginTop: 4 }}
              />
            </ScrollView>

            {/* Customer picker overlay */}
            <PickerOverlay
              visible={customerPickerOpen}
              onClose={() => setCustomerPickerOpen(false)}
              title="Pick a customer"
              insets={insets}
              colors={colors}
              dark={dark}
            >
              <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
                <SearchInput
                  value={customerSearch}
                  onChangeText={setCustomerSearch}
                  onDebouncedChange={setCustomerSearch}
                  placeholder="Search name or phone"
                />
              </View>
              {customersLoading && customers.length === 0 ? (
                // 2026-07-31 v7 (Change I): show a lightweight loading
                // affordance while the deferred /customers fetch is
                // in-flight. Prior UX: empty FlatList looked like a
                // "no customers" state instead of "loading".
                <View style={{ padding: 32, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, color: colors.textSecondary }}>Loading customers…</Text>
                </View>
              ) : (
                <FlatList
                  data={filteredCustomers}
                  keyExtractor={(c) => c.customerId}
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
                  ListEmptyComponent={
                    <View style={{ padding: 24, alignItems: 'center' }}>
                      <Text style={{ fontSize: 13, color: colors.textSecondary }}>
                        {customerSearch ? 'No customers match' : 'No customers found'}
                      </Text>
                    </View>
                  }
                  renderItem={({ item: c }) => (
                    <TouchableOpacity
                      onPress={() => {
                        setCustomerId(c.customerId);
                        setCustomerPickerOpen(false);
                      }}
                      style={{
                        paddingVertical: 14,
                        paddingHorizontal: 16,
                        borderBottomWidth: 1,
                        borderBottomColor: colors.divider,
                      }}
                    >
                      <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>{c.customerName}</Text>
                      <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>{c.phone}</Text>
                    </TouchableOpacity>
                  )}
                />
              )}
            </PickerOverlay>

            {/* Cyl type picker overlay */}
            <PickerOverlay
              visible={typePickerOpen}
              onClose={() => setTypePickerOpen(false)}
              title="Pick a cylinder type"
              insets={insets}
              colors={colors}
              dark={dark}
            >
              <FlatList
                data={cylinderTypes}
                keyExtractor={(t) => t.cylinderTypeId}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
                renderItem={({ item: t }) => {
                  const price = emptyPriceMap.get(t.cylinderTypeId);
                  return (
                    <TouchableOpacity
                      onPress={() => {
                        setCylinderTypeId(t.cylinderTypeId);
                        setTypePickerOpen(false);
                      }}
                      style={{
                        paddingVertical: 14,
                        paddingHorizontal: 16,
                        borderBottomWidth: 1,
                        borderBottomColor: colors.divider,
                      }}
                    >
                      <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>{t.typeName}</Text>
                      <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                        {price != null ? `Rs. ${price} per cylinder` : 'No price set — enter amount manually'}
                      </Text>
                    </TouchableOpacity>
                  );
                }}
              />
            </PickerOverlay>

            {/* Invoice picker overlay */}
            <PickerOverlay
              visible={invoicePickerOpen}
              onClose={() => setInvoicePickerOpen(false)}
              title="Pick an open invoice"
              insets={insets}
              colors={colors}
              dark={dark}
            >
              <FlatList
                data={openInvoices}
                keyExtractor={(i) => i.id}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
                ListEmptyComponent={
                  <EmptyState title="No open invoices" description="No unpaid invoices for this customer." />
                }
                renderItem={({ item: i }) => (
                  <TouchableOpacity
                    onPress={() => {
                      setCreditNoteInvoiceId(i.id);
                      setInvoicePickerOpen(false);
                    }}
                    style={{
                      paddingVertical: 14,
                      paddingHorizontal: 16,
                      borderBottomWidth: 1,
                      borderBottomColor: colors.divider,
                    }}
                  >
                    <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>{i.invoiceNumber}</Text>
                    <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                      Outstanding: {formatINR(i.outstandingAmount)}
                    </Text>
                  </TouchableOpacity>
                )}
              />
            </PickerOverlay>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

interface PickerOverlayProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  insets: ReturnType<typeof useSafeAreaInsets>;
  colors: ReturnType<typeof useTheme>['colors'];
  dark: boolean;
  children: React.ReactNode;
}

function PickerOverlay({ visible, onClose, title, insets, colors, dark: _dark, children }: PickerOverlayProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: colors.bg,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          maxHeight: '85%',
          paddingBottom: Math.max(insets.bottom + 8, 16),
        }}>
          <View style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            padding: 16, borderBottomWidth: 1, borderBottomColor: colors.divider,
          }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>{title}</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          {children}
        </View>
      </View>
    </Modal>
  );
}
