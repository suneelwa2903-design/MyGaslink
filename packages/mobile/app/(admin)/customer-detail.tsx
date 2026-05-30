/**
 * STEP-3E — Admin mobile Customer Detail full screen.
 *
 * Mirrors packages/web/src/pages/CustomersPage.tsx CustomerDetailModal with
 * React Native idioms. Reached from:
 *  - More -> Customers -> tap a row
 *  - Collections -> Call list -> "Account" button
 *
 * Four sub-tabs:
 *  - Overview  -> customer detail card (no API call beyond GET /customers/:id)
 *  - Invoices  -> GET /invoices?customerId=&page=&pageSize= (paginated)
 *  - Payments  -> GET /payments?customerId=&page=&pageSize= (paginated)
 *  - Ledger    -> GET /payments/ledger/:customerId (NO pagination at API)
 *
 * Role gating:
 *  - The Edit button is hidden for FINANCE because the API's
 *    `PUT /customers/:id` (customers.ts:175) restricts mutations to
 *    super_admin / distributor_admin / inventory.
 *  - Inside EditCustomerModal the Transport block is further gated to
 *    DISTRIBUTOR_ADMIN | SUPER_ADMIN (mirrors web CustomerFormModal's
 *    canEditTransport — CustomersPage.tsx:286).
 *
 * Endpoint shapes confirmed:
 *  - GET /customers/:id           returns Customer (envelope-data is the object)
 *  - GET /invoices?customerId=    returns { invoices: Invoice[] }, meta in envelope
 *  - GET /payments?customerId=    returns { payments: Payment[] }, meta in envelope
 *  - GET /payments/ledger/:id     returns LedgerEntry[] (raw array, no envelope)
 *
 * Note on duplication: the EditCustomerModal is duplicated between this file
 * and (admin)/more.tsx. Extracting to a shared component is out of scope per
 * the STEP-3E brief — the inline duplication is intentional and flagged for
 * a future cleanup pass.
 */

import { useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  FlatList,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  Modal,
  KeyboardAvoidingView,
  Platform,
  Alert,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  UserRole,
  CustomerStatus,
  invoiceStatusLabel,
  invoiceStatusVariant,
  type Customer,
  type Invoice,
  type Payment,
  type LedgerEntry,
  type StatusVariant,
} from '@gaslink/shared';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { useTheme, formatINR } from '../../src/theme';
import { useAuthStore } from '../../src/stores/authStore';
import { Badge, EmptyState } from '../../src/components/ui';

const ACCENT = '#dc2626';
const PAGE_SIZE = 25;

// ─── Colour helper ──────────────────────────────────────────────────────────

function getColors(dark: boolean) {
  return {
    bg: dark ? '#0f172a' : '#ffffff',
    card: dark ? '#1e293b' : '#f8fafc',
    cardBorder: dark ? '#334155' : '#e2e8f0',
    text: dark ? '#f8fafc' : '#0f172a',
    textSecondary: dark ? '#cbd5e1' : '#64748b',
    textMuted: dark ? '#94a3b8' : '#94a3b8',
    tabBg: dark ? '#334155' : '#f1f5f9',
    tabText: dark ? '#cbd5e1' : '#475569',
    divider: dark ? '#334155' : '#e2e8f0',
    inputBg: dark ? '#0f172a' : '#ffffff',
    inputBorder: dark ? '#475569' : '#cbd5e1',
    modalBg: dark ? '#0f172a' : '#ffffff',
    overlay: 'rgba(0,0,0,0.6)',
  };
}

// ─── Tab pill row ───────────────────────────────────────────────────────────

type TabValue = 'overview' | 'invoices' | 'payments' | 'ledger';

interface PillOption {
  label: string;
  value: TabValue;
}

function PillRow({
  options,
  value,
  onChange,
  dark,
}: {
  options: PillOption[];
  value: TabValue;
  onChange: (v: TabValue) => void;
  dark: boolean;
}) {
  const C = getColors(dark);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.pillRow}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <TouchableOpacity
            key={opt.value}
            onPress={() => onChange(opt.value)}
            style={[styles.pill, { backgroundColor: active ? ACCENT : C.tabBg }]}
          >
            <Text
              style={[styles.pillText, { color: active ? '#ffffff' : C.tabText }]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

// ─── Status variant for customer ────────────────────────────────────────────

function customerStatusVariant(status: string): StatusVariant {
  switch (status) {
    case CustomerStatus.ACTIVE:
      return 'success';
    case CustomerStatus.SUSPENDED:
      return 'warning';
    case CustomerStatus.INACTIVE:
      return 'neutral';
    default:
      return 'neutral';
  }
}

// ─── Edit Customer Modal (duplicated from more.tsx — see file header) ──────

interface EditCustomerFormState {
  customerName: string;
  businessName: string;
  phone: string;
  email: string;
  gstin: string;
  creditPeriodDays: string;
  transportChargePerCylinder: string;
}

function EditCustomerModal({
  visible,
  customer,
  canEditTransport,
  onClose,
  onSaved,
}: {
  visible: boolean;
  customer: Customer | null;
  canEditTransport: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { dark } = useTheme();
  const C = getColors(dark);

  const [form, setForm] = useState<EditCustomerFormState>({
    customerName: '',
    businessName: '',
    phone: '',
    email: '',
    gstin: '',
    creditPeriodDays: '30',
    transportChargePerCylinder: '0',
  });
  const [initializedFor, setInitializedFor] = useState<string | null>(null);

  // Sync form fields with the customer when the modal opens for a (new)
  // customer, and reset the guard when it closes. Done in render to avoid an
  // extra effect render pass — same pattern as more.tsx GstConfigModal.
  if (visible && customer && initializedFor !== customer.customerId) {
    setInitializedFor(customer.customerId);
    setForm({
      customerName: customer.customerName,
      businessName: customer.businessName ?? '',
      phone: customer.phone,
      email: customer.email ?? '',
      gstin: customer.gstin ?? '',
      creditPeriodDays: String(customer.creditPeriodDays ?? 30),
      transportChargePerCylinder: String(customer.transportChargePerCylinder ?? 0),
    });
  }
  if (!visible && initializedFor !== null) {
    setInitializedFor(null);
  }

  const updateMutation = useApiMutation<
    Customer,
    {
      customerName: string;
      businessName?: string;
      phone: string;
      email?: string;
      gstin?: string;
      creditPeriodDays: number;
      transportChargePerCylinder?: number;
    }
  >('put', () => `/customers/${customer?.customerId}`, {
    invalidateKeys: [
      ['customers'],
      ['customer-detail', customer?.customerId ?? ''],
    ],
    successMessage: 'Customer updated',
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  const handleSubmit = () => {
    if (!customer) return;
    if (!form.customerName.trim() || !form.phone.trim()) {
      Alert.alert('Validation', 'Name and phone are required.');
      return;
    }
    const credit = parseInt(form.creditPeriodDays, 10);
    if (Number.isNaN(credit) || credit < 0) {
      Alert.alert('Validation', 'Credit period must be a non-negative number.');
      return;
    }
    const transport = parseFloat(form.transportChargePerCylinder);
    if (canEditTransport && Number.isNaN(transport)) {
      Alert.alert('Validation', 'Transport charge must be a number.');
      return;
    }
    updateMutation.mutate({
      customerName: form.customerName.trim(),
      businessName: form.businessName.trim() || undefined,
      phone: form.phone.trim(),
      email: form.email.trim() || undefined,
      gstin: form.gstin.trim() || undefined,
      creditPeriodDays: credit,
      transportChargePerCylinder: canEditTransport ? transport : undefined,
    });
  };

  const setField = (key: keyof EditCustomerFormState) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <View style={[styles.editHeader, { borderBottomColor: C.divider }]}>
          <Text style={[styles.headerTitle, { color: C.text }]}>Edit Customer</Text>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close" size={24} color={C.textSecondary} />
          </TouchableOpacity>
        </View>

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
          <ScrollView contentContainerStyle={{ padding: 20 }}>
            <EditField
              label="Customer Name *"
              value={form.customerName}
              onChangeText={setField('customerName')}
              C={C}
              placeholder="Full name"
            />
            <EditField
              label="Business Name"
              value={form.businessName}
              onChangeText={setField('businessName')}
              C={C}
              placeholder="Business name (optional)"
            />
            <EditField
              label="Phone *"
              value={form.phone}
              onChangeText={setField('phone')}
              C={C}
              placeholder="10-digit mobile"
              keyboardType="phone-pad"
            />
            <EditField
              label="Email"
              value={form.email}
              onChangeText={setField('email')}
              C={C}
              placeholder="Email (optional)"
              keyboardType="email-address"
              autoCapitalize="none"
            />
            <EditField
              label="GSTIN"
              value={form.gstin}
              onChangeText={setField('gstin')}
              C={C}
              placeholder="22AAAAA0000A1Z5"
              autoCapitalize="characters"
            />
            <EditField
              label="Credit Period (days)"
              value={form.creditPeriodDays}
              onChangeText={setField('creditPeriodDays')}
              C={C}
              placeholder="e.g. 30"
              keyboardType="numeric"
            />
            {canEditTransport && (
              <EditField
                label="Transport Charge (per cylinder, GST incl.)"
                value={form.transportChargePerCylinder}
                onChangeText={setField('transportChargePerCylinder')}
                C={C}
                placeholder="0"
                keyboardType="numeric"
              />
            )}

            <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
              <TouchableOpacity
                onPress={onClose}
                disabled={updateMutation.isPending}
                style={[
                  styles.modalBtn,
                  {
                    backgroundColor: C.card,
                    borderWidth: 1,
                    borderColor: C.cardBorder,
                  },
                ]}
              >
                <Text style={{ fontSize: 15, fontWeight: '600', color: C.textSecondary }}>
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSubmit}
                disabled={updateMutation.isPending}
                style={[
                  styles.modalBtn,
                  {
                    backgroundColor: ACCENT,
                    opacity: updateMutation.isPending ? 0.6 : 1,
                  },
                ]}
              >
                {updateMutation.isPending ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>
                    Save Changes
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function EditField({
  label,
  value,
  onChangeText,
  C,
  placeholder,
  keyboardType,
  autoCapitalize,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  C: ReturnType<typeof getColors>;
  placeholder?: string;
  keyboardType?: 'default' | 'phone-pad' | 'email-address' | 'numeric';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={{ fontSize: 13, fontWeight: '600', color: C.textSecondary, marginBottom: 6 }}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={C.textMuted}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize ?? 'sentences'}
        style={{
          backgroundColor: C.inputBg,
          borderWidth: 1,
          borderColor: C.inputBorder,
          borderRadius: 10,
          paddingHorizontal: 14,
          paddingVertical: 12,
          fontSize: 15,
          color: C.text,
        }}
      />
    </View>
  );
}

// ─── Overview helpers ───────────────────────────────────────────────────────

function DetailRow({
  label,
  value,
  C,
}: {
  label: string;
  value: string;
  C: ReturnType<typeof getColors>;
}) {
  return (
    <View style={styles.detailRow}>
      <Text style={[styles.detailLabel, { color: C.textMuted }]}>{label}</Text>
      <Text style={[styles.detailValue, { color: C.text }]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

// ─── Main screen ────────────────────────────────────────────────────────────

export default function AdminCustomerDetailScreen() {
  const router = useRouter();
  const { dark } = useTheme();
  const C = getColors(dark);

  const params = useLocalSearchParams<{ customerId?: string | string[] }>();
  const customerId = Array.isArray(params.customerId)
    ? params.customerId[0]
    : params.customerId ?? '';

  const user = useAuthStore((s) => s.user);
  const role = user?.role;
  const canEdit =
    role === UserRole.SUPER_ADMIN ||
    role === UserRole.DISTRIBUTOR_ADMIN ||
    role === UserRole.INVENTORY;
  const canEditTransport =
    role === UserRole.SUPER_ADMIN || role === UserRole.DISTRIBUTOR_ADMIN;

  const [tab, setTab] = useState<TabValue>('overview');
  const [invoicesPage, setInvoicesPage] = useState(0);
  const [paymentsPage, setPaymentsPage] = useState(0);
  const [editOpen, setEditOpen] = useState(false);

  // Customer detail
  const {
    data: customer,
    isLoading: customerLoading,
    isRefetching: customerRefetching,
    refetch: refetchCustomer,
  } = useApiQuery<Customer>(
    ['customer-detail', customerId],
    `/customers/${customerId}`,
    undefined,
    { enabled: !!customerId },
  );

  // Invoices
  const {
    data: invoicesResp,
    isLoading: invoicesLoading,
    isRefetching: invoicesRefetching,
    refetch: refetchInvoices,
  } = useApiQuery<{ invoices: Invoice[] }>(
    ['customer-detail-invoices', customerId, String(invoicesPage)],
    '/invoices',
    { customerId, page: invoicesPage + 1, pageSize: PAGE_SIZE },
    { enabled: !!customerId && tab === 'invoices' },
  );
  const invoices = invoicesResp?.invoices ?? [];

  // Payments
  const {
    data: paymentsResp,
    isLoading: paymentsLoading,
    isRefetching: paymentsRefetching,
    refetch: refetchPayments,
  } = useApiQuery<{ payments: Payment[] }>(
    ['customer-detail-payments', customerId, String(paymentsPage)],
    '/payments',
    { customerId, page: paymentsPage + 1, pageSize: PAGE_SIZE },
    { enabled: !!customerId && tab === 'payments' },
  );
  const payments = paymentsResp?.payments ?? [];

  // Ledger (no pagination at the API — returns the whole array)
  const {
    data: ledgerEntries,
    isLoading: ledgerLoading,
    isRefetching: ledgerRefetching,
    refetch: refetchLedger,
  } = useApiQuery<LedgerEntry[]>(
    ['customer-detail-ledger', customerId],
    `/payments/ledger/${customerId}`,
    undefined,
    { enabled: !!customerId && tab === 'ledger' },
  );

  const tabOptions: PillOption[] = useMemo(
    () => [
      { label: 'Overview', value: 'overview' },
      { label: 'Invoices', value: 'invoices' },
      { label: 'Payments', value: 'payments' },
      { label: 'Ledger', value: 'ledger' },
    ],
    [],
  );

  // ─── Renderers ────────────────────────────────────────────────────────────

  const renderOverview = () => {
    if (customerLoading) {
      return (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      );
    }
    if (!customer) {
      return (
        <View style={styles.centered}>
          <EmptyState
            title="Customer not found"
            description="The customer may have been deleted or you may not have access."
          />
        </View>
      );
    }
    const billingAddress = [
      customer.billingAddressLine1,
      customer.billingAddressLine2,
      customer.billingCity,
      customer.billingState,
      customer.billingPincode,
    ]
      .filter(Boolean)
      .join(', ');
    const shippingAddress = [
      customer.shippingAddressLine1,
      customer.shippingAddressLine2,
      customer.shippingCity,
      customer.shippingState,
      customer.shippingPincode,
    ]
      .filter(Boolean)
      .join(', ');
    return (
      <ScrollView
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={customerRefetching}
            onRefresh={refetchCustomer}
            tintColor={ACCENT}
          />
        }
      >
        <View style={[styles.card, { backgroundColor: C.card, borderColor: C.cardBorder }]}>
          <View style={styles.rowBetween}>
            <View style={{ flex: 1, paddingRight: 8 }}>
              <Text style={[styles.cardTitle, { color: C.text }]}>
                {customer.customerName}
              </Text>
              {customer.businessName ? (
                <Text style={[styles.metaLine, { color: C.textMuted }]}>
                  {customer.businessName}
                </Text>
              ) : null}
            </View>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Badge variant="info" label={customer.customerType} />
              <Badge
                variant={customerStatusVariant(customer.status)}
                label={customer.status}
              />
            </View>
          </View>

          <View style={{ marginTop: 12, gap: 8 }}>
            <DetailRow label="Phone" value={customer.phone} C={C} />
            {customer.email ? (
              <DetailRow label="Email" value={customer.email} C={C} />
            ) : null}
            {customer.gstin ? (
              <DetailRow label="GSTIN" value={customer.gstin} C={C} />
            ) : null}
            <DetailRow
              label="Credit Period"
              value={`${customer.creditPeriodDays} days`}
              C={C}
            />
            <DetailRow
              label="Transport Charge"
              value={`${formatINR(customer.transportChargePerCylinder)} / cylinder`}
              C={C}
            />
            <DetailRow
              label="Supply"
              value={customer.stopSupply ? 'Stopped' : 'Active'}
              C={C}
            />
          </View>
        </View>

        {billingAddress ? (
          <View style={[styles.card, { backgroundColor: C.card, borderColor: C.cardBorder }]}>
            <Text style={[styles.cardTitle, { color: C.text, marginBottom: 8 }]}>
              Billing Address
            </Text>
            <Text style={{ fontSize: 13, color: C.textSecondary, lineHeight: 18 }}>
              {billingAddress}
            </Text>
          </View>
        ) : null}

        {shippingAddress ? (
          <View style={[styles.card, { backgroundColor: C.card, borderColor: C.cardBorder }]}>
            <Text style={[styles.cardTitle, { color: C.text, marginBottom: 8 }]}>
              Shipping Address
            </Text>
            <Text style={{ fontSize: 13, color: C.textSecondary, lineHeight: 18 }}>
              {shippingAddress}
            </Text>
          </View>
        ) : null}

        {customer.contacts.length > 0 && (
          <View style={[styles.card, { backgroundColor: C.card, borderColor: C.cardBorder }]}>
            <Text style={[styles.cardTitle, { color: C.text, marginBottom: 8 }]}>
              Contacts
            </Text>
            {customer.contacts.map((contact) => (
              <View
                key={contact.contactId}
                style={{
                  paddingVertical: 8,
                  borderTopWidth: 1,
                  borderTopColor: C.divider,
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: C.text }}>
                    {contact.name}
                  </Text>
                  <Text style={{ fontSize: 12, color: C.textMuted }}>{contact.phone}</Text>
                </View>
                {contact.isPrimary && <Badge variant="info" label="Primary" />}
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    );
  };

  const renderInvoiceRow = ({ item }: { item: Invoice }) => (
    <View style={[styles.card, { backgroundColor: C.card, borderColor: C.cardBorder }]}>
      <View style={styles.rowBetween}>
        <View style={{ flex: 1, paddingRight: 8 }}>
          <Text style={[styles.cardTitle, { color: C.text }]}>{item.invoiceNumber}</Text>
          <Text style={[styles.metaLine, { color: C.textMuted }]}>
            Issued {new Date(item.issueDate).toLocaleDateString('en-IN')}
          </Text>
        </View>
        <Badge
          variant={invoiceStatusVariant(item.status)}
          label={invoiceStatusLabel(item.status)}
        />
      </View>
      <View style={styles.statGrid}>
        <View style={styles.statCell}>
          <Text style={[styles.statLabel, { color: C.textMuted }]}>Total</Text>
          <Text style={[styles.statValue, { color: C.text }]}>
            {formatINR(item.totalAmount)}
          </Text>
        </View>
        <View style={styles.statCell}>
          <Text style={[styles.statLabel, { color: C.textMuted }]}>Outstanding</Text>
          <Text
            style={[
              styles.statValue,
              { color: item.outstandingAmount > 0 ? '#dc2626' : C.text },
            ]}
          >
            {formatINR(item.outstandingAmount)}
          </Text>
        </View>
      </View>
    </View>
  );

  const renderPaymentRow = ({ item }: { item: Payment }) => (
    <View style={[styles.card, { backgroundColor: C.card, borderColor: C.cardBorder }]}>
      <View style={styles.rowBetween}>
        <View style={{ flex: 1, paddingRight: 8 }}>
          <Text style={[styles.cardTitle, { color: C.text }]}>
            {formatINR(item.amount)}
          </Text>
          <Text style={[styles.metaLine, { color: C.textMuted }]}>
            {new Date(item.transactionDate).toLocaleDateString('en-IN')}
          </Text>
        </View>
        <Badge variant="neutral" label={item.paymentMethod} />
      </View>
      {item.referenceNumber ? (
        <Text
          style={{ fontSize: 12, color: C.textMuted, marginTop: 6 }}
          numberOfLines={1}
        >
          Ref: {item.referenceNumber}
        </Text>
      ) : null}
      <View style={{ marginTop: 6, flexDirection: 'row', gap: 6 }}>
        <Badge
          variant={
            item.allocationStatus === 'fully_allocated' ? 'success' : 'warning'
          }
          label={item.allocationStatus.replace(/_/g, ' ')}
        />
      </View>
    </View>
  );

  const renderLedgerRow = ({ item }: { item: LedgerEntry }) => {
    const positive = item.amountDelta >= 0;
    return (
      <View style={[styles.card, { backgroundColor: C.card, borderColor: C.cardBorder }]}>
        <View style={styles.rowBetween}>
          <View style={{ flex: 1, paddingRight: 8 }}>
            <Text style={[styles.cardTitle, { color: C.text }]}>
              {item.entryType.replace(/_/g, ' ')}
            </Text>
            <Text style={[styles.metaLine, { color: C.textMuted }]}>
              {new Date(item.entryDate).toLocaleDateString('en-IN')}
            </Text>
          </View>
          <Text
            style={{
              fontSize: 15,
              fontWeight: '700',
              color: positive ? '#dc2626' : '#10b981',
            }}
          >
            {positive ? '+' : ''}
            {formatINR(item.amountDelta)}
          </Text>
        </View>
        {item.narration ? (
          <Text
            style={{ fontSize: 12, color: C.textSecondary, marginTop: 6 }}
            numberOfLines={3}
          >
            {item.narration}
          </Text>
        ) : null}
      </View>
    );
  };

  // ─── Pagination footer ───────────────────────────────────────────────────

  const renderPaginationFooter = useCallback(
    (page: number, setPage: (next: number) => void, currentCount: number) => {
      const showPagination = page > 0 || currentCount === PAGE_SIZE;
      if (!showPagination) return null;
      return (
        <View style={styles.pagination}>
          <TouchableOpacity
            style={[
              styles.pageBtn,
              { backgroundColor: C.tabBg, opacity: page === 0 ? 0.5 : 1 },
            ]}
            onPress={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
          >
            <Text style={[styles.pageBtnText, { color: C.text }]}>Previous</Text>
          </TouchableOpacity>
          <Text style={{ color: C.textMuted, fontSize: 12 }}>
            Showing {page * PAGE_SIZE + 1}–{page * PAGE_SIZE + currentCount}
          </Text>
          <TouchableOpacity
            style={[
              styles.pageBtn,
              {
                backgroundColor: C.tabBg,
                opacity: currentCount < PAGE_SIZE ? 0.5 : 1,
              },
            ]}
            onPress={() => setPage(page + 1)}
            disabled={currentCount < PAGE_SIZE}
          >
            <Text style={[styles.pageBtnText, { color: C.text }]}>Next</Text>
          </TouchableOpacity>
        </View>
      );
    },
    [C.tabBg, C.text, C.textMuted],
  );

  // ─── Body switcher ───────────────────────────────────────────────────────

  const renderBody = () => {
    if (tab === 'overview') return renderOverview();

    if (tab === 'invoices') {
      if (invoicesLoading) {
        return (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        );
      }
      if (invoices.length === 0) {
        return (
          <View style={styles.centered}>
            <EmptyState
              title="No invoices"
              description="No invoices have been issued for this customer."
            />
          </View>
        );
      }
      return (
        <FlatList
          data={invoices}
          keyExtractor={(i) => i.invoiceId}
          renderItem={renderInvoiceRow}
          refreshing={invoicesRefetching}
          onRefresh={refetchInvoices}
          contentContainerStyle={styles.listContent}
          ListFooterComponent={renderPaginationFooter(
            invoicesPage,
            setInvoicesPage,
            invoices.length,
          )}
        />
      );
    }

    if (tab === 'payments') {
      if (paymentsLoading) {
        return (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        );
      }
      if (payments.length === 0) {
        return (
          <View style={styles.centered}>
            <EmptyState
              title="No payments"
              description="No payments have been recorded for this customer."
            />
          </View>
        );
      }
      return (
        <FlatList
          data={payments}
          keyExtractor={(p) => p.paymentId}
          renderItem={renderPaymentRow}
          refreshing={paymentsRefetching}
          onRefresh={refetchPayments}
          contentContainerStyle={styles.listContent}
          ListFooterComponent={renderPaginationFooter(
            paymentsPage,
            setPaymentsPage,
            payments.length,
          )}
        />
      );
    }

    // ledger
    if (ledgerLoading) {
      return (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      );
    }
    const ledger = ledgerEntries ?? [];
    if (ledger.length === 0) {
      return (
        <View style={styles.centered}>
          <EmptyState
            title="No ledger entries"
            description="No ledger movements for this customer yet."
          />
        </View>
      );
    }
    return (
      <FlatList
        data={ledger}
        keyExtractor={(l) => l.id}
        renderItem={renderLedgerRow}
        refreshing={ledgerRefetching}
        onRefresh={refetchLedger}
        contentContainerStyle={styles.listContent}
      />
    );
  };

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <SafeAreaView
      edges={['left', 'right']}
      style={[styles.container, { backgroundColor: C.bg }]}
    >
      {/* Back header */}
      <View style={[styles.header, { borderBottomColor: C.divider }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="chevron-back" size={26} color={C.text} />
        </TouchableOpacity>
        <Text
          style={[styles.headerTitle, { color: C.text, flex: 1, textAlign: 'center' }]}
          numberOfLines={1}
        >
          {customer?.customerName ?? 'Customer'}
        </Text>
        {canEdit && customer ? (
          <TouchableOpacity
            onPress={() => setEditOpen(true)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="create-outline" size={22} color={ACCENT} />
          </TouchableOpacity>
        ) : (
          <View style={{ width: 22 }} />
        )}
      </View>

      {/* Tabs */}
      <View style={[styles.filterSection, { borderBottomColor: C.divider }]}>
        <PillRow options={tabOptions} value={tab} onChange={setTab} dark={dark} />
      </View>

      {renderBody()}

      {/* Edit modal */}
      <EditCustomerModal
        visible={editOpen}
        customer={customer ?? null}
        canEditTransport={canEditTransport}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          refetchCustomer();
        }}
      />
    </SafeAreaView>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    gap: 8,
  },
  editHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 17, fontWeight: '700' },

  filterSection: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  pillRow: { gap: 6, paddingVertical: 2 },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
  pillText: { fontSize: 12, fontWeight: '600' },

  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  listContent: { padding: 12, paddingBottom: 24 },

  card: { borderRadius: 12, borderWidth: 1, padding: 12, marginBottom: 8 },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  cardTitle: { fontSize: 15, fontWeight: '700', marginBottom: 2 },
  metaLine: { fontSize: 11 },

  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  detailLabel: { fontSize: 12, fontWeight: '600' },
  detailValue: {
    fontSize: 13,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right',
  },

  statGrid: { flexDirection: 'row', marginTop: 8, gap: 8 },
  statCell: { flex: 1 },
  statLabel: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase' },
  statValue: { fontSize: 14, fontWeight: '700', marginTop: 2 },

  pagination: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 16,
    paddingHorizontal: 4,
  },
  pageBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  pageBtnText: { fontSize: 12, fontWeight: '700' },

  modalBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
