import { useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  Modal,
  ScrollView,
  Alert,
  RefreshControl,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useQueryClient } from '@tanstack/react-query';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { useTheme } from '../../src/theme';
import { api, apiGet, apiPost, apiPut, getErrorMessage } from '../../src/lib/api';

// ─── Types ──────────────────────────────────────────────────────────────────

interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

interface Invoice {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  issueDate: string;
  dueDate: string;
  totalAmount: number;
  amountPaid: number;
  outstandingAmount: number;
  status: string;
  lineItems?: InvoiceLineItem[];
  creditNotesCount?: number;
  debitNotesCount?: number;
}

interface Payment {
  paymentId: string;
  customerId: string;
  customerName: string;
  amount: number;
  paymentMethod: string;
  referenceNumber?: string;
  transactionDate: string;
  notes?: string;
  allocationStatus?: string;
  allocations?: { invoiceId: string; invoiceNumber?: string; allocatedAmount: number }[];
  unallocatedAmount?: number;
  allocatedAmount?: number;
}

interface Customer {
  customerId: string;
  customerName: string;
  phone?: string;
}

interface CreditNoteRow {
  creditNoteId: string;
  creditNoteNumber: string | null;
  totalAmount: number;
  reason: string;
  status: string;
  createdAt: string;
}

interface DebitNoteRow {
  debitNoteId: string;
  debitNoteNumber: string | null;
  totalAmount: number;
  reason: string;
  status: string;
  createdAt: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ACCENT = '#dc2626';

const INVOICE_STATUS_TABS = [
  { label: 'All', value: 'all' },
  { label: 'Issued', value: 'issued' },
  { label: 'Partially Paid', value: 'partially_paid' },
  { label: 'Paid', value: 'paid' },
  { label: 'Overdue', value: 'overdue' },
  { label: 'Cancelled', value: 'cancelled' },
] as const;

const INVOICE_STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  issued: { bg: '#3b82f6', text: '#ffffff' },
  partially_paid: { bg: '#f97316', text: '#ffffff' },
  paid: { bg: '#22c55e', text: '#ffffff' },
  overdue: { bg: '#ef4444', text: '#ffffff' },
  cancelled: { bg: '#6b7280', text: '#ffffff' },
};

const PAYMENT_METHOD_COLORS: Record<string, { bg: string; text: string }> = {
  cash: { bg: '#22c55e', text: '#ffffff' },
  upi: { bg: '#3b82f6', text: '#ffffff' },
  bank_transfer: { bg: '#8b5cf6', text: '#ffffff' },
  cheque: { bg: '#f97316', text: '#ffffff' },
};

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  upi: 'UPI',
  bank_transfer: 'Bank Transfer',
  cheque: 'Cheque',
};

const PAYMENT_METHODS = [
  { label: 'Cash', value: 'cash' },
  { label: 'UPI', value: 'upi' },
  { label: 'Bank Transfer', value: 'bank_transfer' },
  { label: 'Cheque', value: 'cheque' },
];

const NOTE_STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  pending: { bg: '#f97316', text: '#ffffff' },
  approved: { bg: '#22c55e', text: '#ffffff' },
  issued: { bg: '#22c55e', text: '#ffffff' },
  rejected: { bg: '#ef4444', text: '#ffffff' },
  cancelled: { bg: '#6b7280', text: '#ffffff' },
};

function getColors(dark: boolean) {
  return {
    bg: dark ? '#0f172a' : '#ffffff',
    card: dark ? '#1e293b' : '#f8fafc',
    cardBorder: dark ? '#334155' : '#e2e8f0',
    text: dark ? '#f1f5f9' : '#0f172a',
    textSecondary: dark ? '#94a3b8' : '#64748b',
    textMuted: dark ? '#64748b' : '#94a3b8',
    inputBg: dark ? '#0f172a' : '#ffffff',
    inputBorder: dark ? '#475569' : '#cbd5e1',
    tabBg: dark ? '#334155' : '#f1f5f9',
    tabText: dark ? '#94a3b8' : '#475569',
    modalBg: dark ? '#0f172a' : '#ffffff',
    overlay: 'rgba(0,0,0,0.6)',
    divider: dark ? '#334155' : '#e2e8f0',
  };
}

function formatCurrency(amount: number | undefined): string {
  return '₹' + (amount ?? 0).toLocaleString('en-IN');
}

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function getTodayISO(): string {
  return new Date().toISOString().split('T')[0];
}

function capitalizeStatus(status: string): string {
  return status
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ─── Main Screen ────────────────────────────────────────────────────────────

type TopTab = 'invoices' | 'payments';

export default function AdminFinanceScreen() {
  const { dark } = useTheme();
  const C = getColors(dark);

  const [topTab, setTopTab] = useState<TopTab>('invoices');

  // Invoice state
  const [invoiceStatus, setInvoiceStatus] = useState('all');
  const [expandedInvoiceId, setExpandedInvoiceId] = useState<string | null>(null);
  const [payInvoice, setPayInvoice] = useState<Invoice | null>(null);

  // Payment state
  const [createPaymentVisible, setCreatePaymentVisible] = useState(false);

  // Feature 2: CN/DN modal state (lifted to screen level so gstEnabled is accessible)
  const [creditNoteInvoice, setCreditNoteInvoice] = useState<Invoice | null>(null);
  const [debitNoteInvoice, setDebitNoteInvoice] = useState<Invoice | null>(null);

  // Feature 3: Allocate payment modal state
  const [allocatePayment, setAllocatePayment] = useState<Payment | null>(null);

  // ─── Settings Query (for gstEnabled) ───────────────────────────────────

  const { data: settingsData } = useApiQuery<{ gstMode: string | null }>(
    ['settings'],
    '/settings',
    undefined,
    { staleTime: 5 * 60 * 1000 },
  );
  const gstEnabled =
    settingsData?.gstMode != null && settingsData.gstMode !== 'disabled';

  // ─── Invoice Queries ────────────────────────────────────────────────────

  const invoiceParams: Record<string, unknown> = { limit: 50 };
  if (invoiceStatus !== 'all') invoiceParams.status = invoiceStatus;

  const {
    data: invoicesData,
    isLoading: invoicesLoading,
    refetch: refetchInvoices,
    isRefetching: invoicesRefetching,
  } = useApiQuery<{ invoices: Invoice[]; total: number }>(
    ['admin-invoices', invoiceStatus],
    '/invoices',
    invoiceParams,
    { enabled: topTab === 'invoices' },
  );

  // ─── Payment Queries ───────────────────────────────────────────────────

  const {
    data: paymentsData,
    isLoading: paymentsLoading,
    refetch: refetchPayments,
    isRefetching: paymentsRefetching,
  } = useApiQuery<{ payments: Payment[]; total: number }>(
    ['admin-payments'],
    '/payments',
    { limit: 50 },
    { enabled: topTab === 'payments' },
  );

  // ─── Top Tab Bar ──────────────────────────────────────────────────────

  const renderTopTabs = () => (
    <View style={{ flexDirection: 'row', backgroundColor: C.bg, borderBottomWidth: 1, borderBottomColor: C.divider }}>
      {(['invoices', 'payments'] as TopTab[]).map((tab) => {
        const active = topTab === tab;
        return (
          <TouchableOpacity
            key={tab}
            onPress={() => setTopTab(tab)}
            style={{
              flex: 1,
              paddingVertical: 14,
              alignItems: 'center',
              borderBottomWidth: 3,
              borderBottomColor: active ? ACCENT : 'transparent',
            }}
          >
            <Text
              style={{
                fontSize: 15,
                fontWeight: active ? '700' : '500',
                color: active ? ACCENT : C.textSecondary,
              }}
            >
              {tab === 'invoices' ? 'Invoices' : 'Payments'}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: C.bg }}>
      {renderTopTabs()}

      {topTab === 'invoices' ? (
        <InvoicesTab
          C={C}
          dark={dark}
          gstEnabled={gstEnabled}
          invoiceStatus={invoiceStatus}
          setInvoiceStatus={setInvoiceStatus}
          invoicesData={invoicesData}
          invoicesLoading={invoicesLoading}
          invoicesRefetching={invoicesRefetching}
          refetchInvoices={refetchInvoices}
          expandedInvoiceId={expandedInvoiceId}
          setExpandedInvoiceId={setExpandedInvoiceId}
          setPayInvoice={setPayInvoice}
          setCreditNoteInvoice={setCreditNoteInvoice}
          setDebitNoteInvoice={setDebitNoteInvoice}
        />
      ) : (
        <PaymentsTab
          C={C}
          dark={dark}
          paymentsData={paymentsData}
          paymentsLoading={paymentsLoading}
          paymentsRefetching={paymentsRefetching}
          refetchPayments={refetchPayments}
          setCreatePaymentVisible={setCreatePaymentVisible}
          setAllocatePayment={setAllocatePayment}
        />
      )}

      {/* Pay Invoice Modal */}
      {payInvoice && (
        <PayInvoiceModal
          C={C}
          dark={dark}
          invoice={payInvoice}
          onClose={() => setPayInvoice(null)}
        />
      )}

      {/* Create Payment Modal */}
      {createPaymentVisible && (
        <CreatePaymentModal
          C={C}
          dark={dark}
          onClose={() => setCreatePaymentVisible(false)}
        />
      )}

      {/* Feature 2: Credit Note Modal */}
      {creditNoteInvoice && (
        <CreateNoteModal
          C={C}
          dark={dark}
          kind="cn"
          invoice={creditNoteInvoice}
          onClose={() => setCreditNoteInvoice(null)}
        />
      )}

      {/* Feature 2: Debit Note Modal */}
      {debitNoteInvoice && (
        <CreateNoteModal
          C={C}
          dark={dark}
          kind="dn"
          invoice={debitNoteInvoice}
          onClose={() => setDebitNoteInvoice(null)}
        />
      )}

      {/* Feature 3: Allocate Payment Modal */}
      {allocatePayment && (
        <AllocatePaymentModal
          C={C}
          dark={dark}
          payment={allocatePayment}
          onClose={() => setAllocatePayment(null)}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Invoices Tab ───────────────────────────────────────────────────────────

interface InvoicesTabProps {
  C: ReturnType<typeof getColors>;
  dark: boolean;
  gstEnabled: boolean;
  invoiceStatus: string;
  setInvoiceStatus: (s: string) => void;
  invoicesData: { invoices: Invoice[]; total: number } | undefined;
  invoicesLoading: boolean;
  invoicesRefetching: boolean;
  refetchInvoices: () => void;
  expandedInvoiceId: string | null;
  setExpandedInvoiceId: (id: string | null) => void;
  setPayInvoice: (inv: Invoice) => void;
  setCreditNoteInvoice: (inv: Invoice) => void;
  setDebitNoteInvoice: (inv: Invoice) => void;
}

function InvoicesTab({
  C,
  dark,
  gstEnabled,
  invoiceStatus,
  setInvoiceStatus,
  invoicesData,
  invoicesLoading,
  invoicesRefetching,
  refetchInvoices,
  expandedInvoiceId,
  setExpandedInvoiceId,
  setPayInvoice,
  setCreditNoteInvoice,
  setDebitNoteInvoice,
}: InvoicesTabProps) {
  const invoices = invoicesData?.invoices ?? [];
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const downloadInvoicePdf = async (invoiceId: string) => {
    try {
      setDownloadingId(invoiceId);
      const res = await api.get(`/invoices/${invoiceId}/pdf`, { responseType: 'arraybuffer' });
      const bytes = new Uint8Array(res.data);
      const file = new File(Paths.cache, `invoice-${invoiceId}.pdf`);
      try { file.create(); } catch {}
      file.write(bytes);
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'This device does not support sharing.');
        return;
      }
      await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', dialogTitle: 'Invoice', UTI: 'com.adobe.pdf' });
    } catch (err) {
      Alert.alert('Could not download invoice', getErrorMessage(err));
    } finally {
      setDownloadingId(null);
    }
  };

  const renderStatusFilter = () => (
    <View style={{ paddingVertical: 10 }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
      >
        {INVOICE_STATUS_TABS.map((tab) => {
          const active = invoiceStatus === tab.value;
          return (
            <TouchableOpacity
              key={tab.value}
              onPress={() => setInvoiceStatus(tab.value)}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 7,
                borderRadius: 99,
                backgroundColor: active ? ACCENT : C.tabBg,
              }}
            >
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: '600',
                  color: active ? '#ffffff' : C.tabText,
                }}
              >
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );

  const renderInvoiceCard = useCallback(
    ({ item: inv }: { item: Invoice }) => {
      const expanded = expandedInvoiceId === inv.invoiceId;
      const statusColor = INVOICE_STATUS_COLORS[inv.status] ?? { bg: '#6b7280', text: '#ffffff' };
      const hasCn = (inv.creditNotesCount ?? 0) > 0;
      const hasDn = (inv.debitNotesCount ?? 0) > 0;
      const showCnDnButtons = gstEnabled && inv.status === 'issued';

      return (
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => setExpandedInvoiceId(expanded ? null : inv.invoiceId)}
          style={{
            backgroundColor: C.card,
            borderRadius: 12,
            padding: 16,
            marginHorizontal: 16,
            marginBottom: 10,
            borderWidth: 1,
            borderColor: C.cardBorder,
          }}
        >
          {/* Header Row */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Text style={{ fontSize: 15, fontWeight: '700', color: C.text }}>
                  {inv.invoiceNumber}
                </Text>
                <View
                  style={{
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                    borderRadius: 6,
                    backgroundColor: statusColor.bg,
                  }}
                >
                  <Text style={{ fontSize: 11, fontWeight: '700', color: statusColor.text }}>
                    {capitalizeStatus(inv.status)}
                  </Text>
                </View>
                {/* Feature 2: CN/DN count chips */}
                {hasCn && (
                  <View
                    style={{
                      paddingHorizontal: 7,
                      paddingVertical: 2,
                      borderRadius: 6,
                      backgroundColor: '#fef3c7',
                    }}
                  >
                    <Text style={{ fontSize: 10, fontWeight: '700', color: '#92400e' }}>
                      {(inv.creditNotesCount ?? 0) === 1 ? 'CN' : `CN ×${inv.creditNotesCount}`}
                    </Text>
                  </View>
                )}
                {hasDn && (
                  <View
                    style={{
                      paddingHorizontal: 7,
                      paddingVertical: 2,
                      borderRadius: 6,
                      backgroundColor: '#e0f2fe',
                    }}
                  >
                    <Text style={{ fontSize: 10, fontWeight: '700', color: '#0369a1' }}>
                      {(inv.debitNotesCount ?? 0) === 1 ? 'DN' : `DN ×${inv.debitNotesCount}`}
                    </Text>
                  </View>
                )}
              </View>
              <Text style={{ fontSize: 13, color: C.textSecondary, marginTop: 3 }}>
                {inv.customerName}
              </Text>
              <Text style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                Issued: {formatDate(inv.issueDate)}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ fontSize: 16, fontWeight: '800', color: C.text }}>
                {formatCurrency(inv.totalAmount)}
              </Text>
              {inv.outstandingAmount > 0 && (
                <Text style={{ fontSize: 13, fontWeight: '600', color: '#ef4444', marginTop: 2 }}>
                  Due: {formatCurrency(inv.outstandingAmount)}
                </Text>
              )}
            </View>
          </View>

          {/* Due Date */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginTop: 8,
              gap: 4,
            }}
          >
            <Ionicons name="calendar-outline" size={13} color={C.textMuted} />
            <Text style={{ fontSize: 12, color: C.textMuted }}>
              Due: {formatDate(inv.dueDate)}
            </Text>
          </View>

          {/* Expand indicator */}
          <View style={{ alignItems: 'center', marginTop: 6 }}>
            <Ionicons
              name={expanded ? 'chevron-up' : 'chevron-down'}
              size={18}
              color={C.textMuted}
            />
          </View>

          {/* Expanded Content */}
          {expanded && (
            <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.divider }}>
              {/* Line Items */}
              {inv.lineItems && inv.lineItems.length > 0 && (
                <View style={{ marginBottom: 12 }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: C.text, marginBottom: 8 }}>
                    Line Items
                  </Text>
                  {inv.lineItems.map((item, idx) => (
                    <View
                      key={idx}
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        paddingVertical: 4,
                        borderBottomWidth: idx < (inv.lineItems?.length ?? 0) - 1 ? 1 : 0,
                        borderBottomColor: C.divider,
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 13, color: C.text }}>{item.description}</Text>
                        <Text style={{ fontSize: 11, color: C.textMuted }}>
                          {item.quantity} x {formatCurrency(item.unitPrice)}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: C.text }}>
                        {formatCurrency(item.totalPrice)}
                      </Text>
                    </View>
                  ))}
                </View>
              )}

              {/* Summary */}
              <View style={{ gap: 4, marginBottom: 14 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 13, color: C.textSecondary }}>Total</Text>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: C.text }}>
                    {formatCurrency(inv.totalAmount)}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 13, color: C.textSecondary }}>Paid</Text>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: '#22c55e' }}>
                    {formatCurrency(inv.amountPaid)}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 13, color: C.textSecondary }}>Outstanding</Text>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: '#ef4444' }}>
                    {formatCurrency(inv.outstandingAmount)}
                  </Text>
                </View>
              </View>

              {/* Action Buttons — row 1: PDF + Record Payment */}
              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10 }}>
                <TouchableOpacity
                  onPress={() => downloadInvoicePdf(inv.invoiceId)}
                  disabled={downloadingId === inv.invoiceId}
                  style={{
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    paddingVertical: 10,
                    borderRadius: 8,
                    backgroundColor: dark ? '#334155' : '#f1f5f9',
                    opacity: downloadingId === inv.invoiceId ? 0.6 : 1,
                  }}
                >
                  {downloadingId === inv.invoiceId ? (
                    <ActivityIndicator size="small" color={C.text} />
                  ) : (
                    <Ionicons name="download-outline" size={16} color={C.text} />
                  )}
                  <Text style={{ fontSize: 13, fontWeight: '600', color: C.text }}>
                    {downloadingId === inv.invoiceId ? 'Downloading...' : 'Download PDF'}
                  </Text>
                </TouchableOpacity>

                {inv.outstandingAmount > 0 && inv.status !== 'cancelled' && (
                  <TouchableOpacity
                    onPress={() => setPayInvoice(inv)}
                    style={{
                      flex: 1,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                      paddingVertical: 10,
                      borderRadius: 8,
                      backgroundColor: ACCENT,
                    }}
                  >
                    <Ionicons name="card-outline" size={16} color="#ffffff" />
                    <Text style={{ fontSize: 13, fontWeight: '600', color: '#ffffff' }}>Record Payment</Text>
                  </TouchableOpacity>
                )}
              </View>

              {/* Feature 2: Credit Note + Debit Note buttons (only for issued invoices with GST) */}
              {showCnDnButtons && (
                <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
                  <TouchableOpacity
                    onPress={() => setCreditNoteInvoice(inv)}
                    style={{
                      flex: 1,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                      paddingVertical: 10,
                      borderRadius: 8,
                      backgroundColor: '#fef3c7',
                      borderWidth: 1,
                      borderColor: '#fbbf24',
                    }}
                  >
                    <Ionicons name="remove-circle-outline" size={16} color="#92400e" />
                    <Text style={{ fontSize: 13, fontWeight: '600', color: '#92400e' }}>Credit Note</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={() => setDebitNoteInvoice(inv)}
                    style={{
                      flex: 1,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                      paddingVertical: 10,
                      borderRadius: 8,
                      backgroundColor: '#e0f2fe',
                      borderWidth: 1,
                      borderColor: '#7dd3fc',
                    }}
                  >
                    <Ionicons name="add-circle-outline" size={16} color="#0369a1" />
                    <Text style={{ fontSize: 13, fontWeight: '600', color: '#0369a1' }}>Debit Note</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Feature 2: Inline CN/DN list (lazy-loaded when expanded) */}
              <InvoiceNotesSection
                C={C}
                dark={dark}
                invoiceId={inv.invoiceId}
                enabled={expanded}
              />
            </View>
          )}
        </TouchableOpacity>
      );
    },
    [
      expandedInvoiceId, C, dark, gstEnabled, setExpandedInvoiceId, setPayInvoice,
      setCreditNoteInvoice, setDebitNoteInvoice, downloadingId, downloadInvoicePdf,
    ],
  );

  const renderEmpty = () => {
    if (invoicesLoading) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 80 }}>
          <ActivityIndicator size="large" color={ACCENT} />
          <Text style={{ marginTop: 12, color: C.textSecondary, fontSize: 14 }}>Loading invoices...</Text>
        </View>
      );
    }
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 80 }}>
        <Ionicons name="receipt-outline" size={48} color={C.textMuted} />
        <Text style={{ fontSize: 16, fontWeight: '600', color: C.text, marginTop: 12 }}>
          No invoices found
        </Text>
        <Text style={{ fontSize: 13, color: C.textSecondary, marginTop: 4 }}>
          {invoiceStatus !== 'all'
            ? `No ${capitalizeStatus(invoiceStatus).toLowerCase()} invoices`
            : 'Invoices will appear here'}
        </Text>
      </View>
    );
  };

  return (
    <View style={{ flex: 1 }}>
      {renderStatusFilter()}
      <FlatList
        data={invoices}
        keyExtractor={(item) => item.invoiceId}
        renderItem={renderInvoiceCard}
        contentContainerStyle={{ paddingTop: 4, paddingBottom: 24 }}
        ListEmptyComponent={renderEmpty}
        refreshControl={
          <RefreshControl
            refreshing={invoicesRefetching}
            onRefresh={refetchInvoices}
            tintColor={ACCENT}
            colors={[ACCENT]}
          />
        }
      />
    </View>
  );
}

// ─── Feature 2: Invoice Notes Section ──────────────────────────────────────
// Lazy-loaded when a card is expanded. Lists CN + DN rows with
// Approve / Reject (pending) and Download PDF (approved/issued).

interface InvoiceNotesSectionProps {
  C: ReturnType<typeof getColors>;
  dark: boolean;
  invoiceId: string;
  enabled: boolean;
}

function InvoiceNotesSection({ C, dark, invoiceId, enabled }: InvoiceNotesSectionProps) {
  const queryClient = useQueryClient();

  const [rejectTarget, setRejectTarget] = useState<{ kind: 'cn' | 'dn'; id: string; number: string | null } | null>(null);
  const [downloadingNoteId, setDownloadingNoteId] = useState<string | null>(null);

  const { data: cnData, isLoading: cnLoading } = useApiQuery<{ creditNotes: CreditNoteRow[] }>(
    ['invoice-credit-notes', invoiceId],
    `/invoices/${invoiceId}/credit-notes`,
    undefined,
    { enabled },
  );

  const { data: dnData, isLoading: dnLoading } = useApiQuery<{ debitNotes: DebitNoteRow[] }>(
    ['invoice-debit-notes', invoiceId],
    `/invoices/${invoiceId}/debit-notes`,
    undefined,
    { enabled },
  );

  const cns = cnData?.creditNotes ?? [];
  const dns = dnData?.debitNotes ?? [];
  const total = cns.length + dns.length;

  const invalidateNotes = () => {
    queryClient.invalidateQueries({ queryKey: ['invoice-credit-notes', invoiceId] });
    queryClient.invalidateQueries({ queryKey: ['invoice-debit-notes', invoiceId] });
    queryClient.invalidateQueries({ queryKey: ['admin-invoices'] });
  };

  const handleApprove = async (kind: 'cn' | 'dn', id: string) => {
    try {
      const path = kind === 'cn'
        ? `/invoices/credit-notes/${id}/approve`
        : `/invoices/debit-notes/${id}/approve`;
      await apiPut(path);
      Alert.alert('Approved', `${kind === 'cn' ? 'Credit' : 'Debit'} note approved.`);
      invalidateNotes();
    } catch (err) {
      Alert.alert('Error', getErrorMessage(err));
    }
  };

  const handleReject = async (kind: 'cn' | 'dn', id: string, reason: string) => {
    try {
      const path = kind === 'cn'
        ? `/invoices/credit-notes/${id}/reject`
        : `/invoices/debit-notes/${id}/reject`;
      await apiPut(path, { reason });
      Alert.alert('Rejected', `${kind === 'cn' ? 'Credit' : 'Debit'} note rejected.`);
      setRejectTarget(null);
      invalidateNotes();
    } catch (err) {
      Alert.alert('Error', getErrorMessage(err));
    }
  };

  const downloadNotePdf = async (kind: 'cn' | 'dn', id: string, number: string | null) => {
    try {
      setDownloadingNoteId(id);
      const path = kind === 'cn'
        ? `/invoices/credit-notes/${id}/pdf`
        : `/invoices/debit-notes/${id}/pdf`;
      const res = await api.get(path, { responseType: 'arraybuffer' });
      const bytes = new Uint8Array(res.data);
      const filename = `${kind === 'cn' ? 'credit-note' : 'debit-note'}-${number ?? id.slice(0, 8)}.pdf`;
      const file = new File(Paths.cache, filename);
      try { file.create(); } catch {}
      file.write(bytes);
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'This device does not support sharing.');
        return;
      }
      await Sharing.shareAsync(file.uri, {
        mimeType: 'application/pdf',
        dialogTitle: kind === 'cn' ? 'Credit Note' : 'Debit Note',
        UTI: 'com.adobe.pdf',
      });
    } catch (err) {
      Alert.alert('Could not download PDF', getErrorMessage(err));
    } finally {
      setDownloadingNoteId(null);
    }
  };

  if (!enabled) return null;

  const loading = cnLoading || dnLoading;

  if (loading) {
    return (
      <View style={{ paddingVertical: 12, alignItems: 'center' }}>
        <ActivityIndicator size="small" color={ACCENT} />
      </View>
    );
  }

  if (total === 0) return null;

  const renderNoteRow = (kind: 'cn' | 'dn', id: string, number: string | null, amount: number, reason: string, status: string) => {
    const sc = NOTE_STATUS_COLORS[status] ?? { bg: '#6b7280', text: '#ffffff' };
    const isPending = status === 'pending';
    const isDownloadable = status === 'approved' || status === 'issued';
    const isDownloading = downloadingNoteId === id;

    return (
      <View
        key={id}
        style={{
          backgroundColor: dark ? '#0f172a' : '#f8fafc',
          borderRadius: 8,
          padding: 10,
          marginBottom: 6,
          borderWidth: 1,
          borderColor: C.cardBorder,
        }}
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: C.text, fontVariant: ['tabular-nums'] }}>
              {number ?? id.slice(0, 8)}
            </Text>
            <Text style={{ fontSize: 12, fontWeight: '600', color: C.textSecondary }}>
              {formatCurrency(amount)}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: sc.bg }}>
              <Text style={{ fontSize: 10, fontWeight: '700', color: sc.text }}>
                {capitalizeStatus(status)}
              </Text>
            </View>
          </View>
        </View>
        {reason ? (
          <Text style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }} numberOfLines={2}>
            {reason}
          </Text>
        ) : null}
        {/* Action row */}
        {(isPending || isDownloadable) && (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            {isDownloadable && (
              <TouchableOpacity
                onPress={() => downloadNotePdf(kind, id, number)}
                disabled={isDownloading}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: 6,
                  backgroundColor: dark ? '#334155' : '#e2e8f0',
                  opacity: isDownloading ? 0.6 : 1,
                }}
              >
                {isDownloading
                  ? <ActivityIndicator size="small" color={C.text} />
                  : <Ionicons name="download-outline" size={13} color={C.text} />}
                <Text style={{ fontSize: 12, fontWeight: '600', color: C.text }}>
                  {isDownloading ? 'Downloading...' : 'PDF'}
                </Text>
              </TouchableOpacity>
            )}
            {isPending && (
              <>
                <TouchableOpacity
                  onPress={() => handleApprove(kind, id)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4,
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 6,
                    backgroundColor: '#22c55e',
                  }}
                >
                  <Ionicons name="checkmark-outline" size={13} color="#ffffff" />
                  <Text style={{ fontSize: 12, fontWeight: '600', color: '#ffffff' }}>Approve</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setRejectTarget({ kind, id, number })}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4,
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 6,
                    backgroundColor: '#ef4444',
                  }}
                >
                  <Ionicons name="close-outline" size={13} color="#ffffff" />
                  <Text style={{ fontSize: 12, fontWeight: '600', color: '#ffffff' }}>Reject</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={{ marginTop: 4 }}>
      <View style={{ height: 1, backgroundColor: C.divider, marginBottom: 10 }} />
      <Text style={{ fontSize: 12, fontWeight: '700', color: C.textSecondary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        Credit / Debit Notes
      </Text>

      {cns.length > 0 && (
        <View style={{ marginBottom: 8 }}>
          <Text style={{ fontSize: 11, fontWeight: '600', color: C.textMuted, marginBottom: 4 }}>Credit Notes</Text>
          {cns.map((cn) => renderNoteRow('cn', cn.creditNoteId, cn.creditNoteNumber, cn.totalAmount, cn.reason, cn.status))}
        </View>
      )}

      {dns.length > 0 && (
        <View>
          <Text style={{ fontSize: 11, fontWeight: '600', color: C.textMuted, marginBottom: 4 }}>Debit Notes</Text>
          {dns.map((dn) => renderNoteRow('dn', dn.debitNoteId, dn.debitNoteNumber, dn.totalAmount, dn.reason, dn.status))}
        </View>
      )}

      {/* Reject modal */}
      {rejectTarget && (
        <RejectNoteModal
          C={C}
          dark={dark}
          target={rejectTarget}
          onClose={() => setRejectTarget(null)}
          onSubmit={(reason) => handleReject(rejectTarget.kind, rejectTarget.id, reason)}
        />
      )}
    </View>
  );
}

// ─── Feature 2: Reject Note Modal ───────────────────────────────────────────

interface RejectNoteModalProps {
  C: ReturnType<typeof getColors>;
  dark: boolean;
  target: { kind: 'cn' | 'dn'; id: string; number: string | null };
  onClose: () => void;
  onSubmit: (reason: string) => void;
}

function RejectNoteModal({ C, dark, target, onClose, onSubmit }: RejectNoteModalProps) {
  const [reason, setReason] = useState('');
  const noun = target.kind === 'cn' ? 'Credit Note' : 'Debit Note';

  const inputStyle = {
    backgroundColor: C.inputBg,
    borderWidth: 1,
    borderColor: C.inputBorder,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: C.text,
    minHeight: 80,
    textAlignVertical: 'top' as const,
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: C.overlay }}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View
            style={{
              backgroundColor: C.modalBg,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              paddingHorizontal: 20,
              paddingTop: 16,
              paddingBottom: Platform.OS === 'ios' ? 36 : 24,
            }}
          >
            <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: C.divider, marginBottom: 16 }} />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <Text style={{ fontSize: 16, fontWeight: '800', color: C.text }}>
                Reject {noun}
              </Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={C.textSecondary} />
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 13, color: C.textSecondary, marginBottom: 12 }}>
              The rejection reason will be recorded in the audit log. The {noun.toLowerCase()} will be marked as rejected.
            </Text>
            <TextInput
              style={inputStyle}
              placeholder="Reason for rejection (required)"
              placeholderTextColor={C.textMuted}
              value={reason}
              onChangeText={setReason}
              multiline
              numberOfLines={3}
              maxLength={500}
            />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity
                onPress={onClose}
                style={{
                  flex: 1,
                  paddingVertical: 12,
                  borderRadius: 10,
                  backgroundColor: dark ? '#334155' : '#f1f5f9',
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: '600', color: C.text }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  if (!reason.trim()) {
                    Alert.alert('Validation', 'Please enter a reason for rejection.');
                    return;
                  }
                  onSubmit(reason.trim());
                }}
                style={{
                  flex: 1,
                  paddingVertical: 12,
                  borderRadius: 10,
                  backgroundColor: '#ef4444',
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#ffffff' }}>Reject</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

// ─── Feature 2: Create Note Modal (Credit / Debit) ───────────────────────────

interface CreateNoteModalProps {
  C: ReturnType<typeof getColors>;
  dark: boolean;
  kind: 'cn' | 'dn';
  invoice: Invoice;
  onClose: () => void;
}

function CreateNoteModal({ C, dark, kind, invoice, onClose }: CreateNoteModalProps) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  const isCn = kind === 'cn';
  const title = isCn ? 'Credit Note' : 'Debit Note';
  const endpoint = isCn ? '/invoices/credit-notes' : '/invoices/debit-notes';

  const noteMutation = useApiMutation<unknown, {
    invoiceId: string;
    amount: number;
    reason: string;
    note?: string;
  }>('post', endpoint, {
    invalidateKeys: [
      ['admin-invoices'],
      ['invoice-credit-notes', invoice.invoiceId],
      ['invoice-debit-notes', invoice.invoiceId],
    ],
    onSuccess: () => {
      Alert.alert(
        `${title} created`,
        'Pending approval.',
      );
      onClose();
    },
  });

  const handleSubmit = () => {
    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      Alert.alert('Validation', 'Please enter a valid amount.');
      return;
    }
    if (isCn && parsedAmount > invoice.totalAmount) {
      Alert.alert('Validation', `Credit note amount cannot exceed invoice total of ${formatCurrency(invoice.totalAmount)}.`);
      return;
    }
    if (!reason.trim()) {
      Alert.alert('Validation', 'Please enter a reason.');
      return;
    }
    noteMutation.mutate({
      invoiceId: invoice.invoiceId,
      amount: parsedAmount,
      reason: reason.trim(),
      note: note.trim() || undefined,
    });
  };

  const inputStyle = {
    backgroundColor: C.inputBg,
    borderWidth: 1,
    borderColor: C.inputBorder,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: C.text,
  } as const;

  const labelStyle = {
    fontSize: 13,
    fontWeight: '600' as const,
    color: C.textSecondary,
    marginBottom: 6,
  };

  const readonlyStyle = {
    ...inputStyle,
    backgroundColor: dark ? '#334155' : '#f1f5f9',
    color: C.textMuted,
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: C.overlay }}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View
            style={{
              backgroundColor: C.modalBg,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              paddingHorizontal: 20,
              paddingTop: 16,
              paddingBottom: Platform.OS === 'ios' ? 36 : 24,
              maxHeight: '90%',
            }}
          >
            <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: C.divider, marginBottom: 16 }} />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: C.text }}>{title}</Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={24} color={C.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {/* Invoice (readonly) */}
              <View style={{ marginBottom: 16 }}>
                <Text style={labelStyle}>Invoice #</Text>
                <View style={readonlyStyle}>
                  <Text style={{ fontSize: 15, color: C.textMuted }}>{invoice.invoiceNumber}</Text>
                </View>
              </View>

              {/* Amount */}
              <View style={{ marginBottom: 16 }}>
                <Text style={labelStyle}>
                  {isCn ? `Credit Amount (max ${formatCurrency(invoice.totalAmount)})` : 'Debit Amount'}
                </Text>
                <TextInput
                  style={inputStyle}
                  placeholder={isCn ? `Enter amount (max ${formatCurrency(invoice.totalAmount)})` : 'Enter amount'}
                  placeholderTextColor={C.textMuted}
                  keyboardType="numeric"
                  value={amount}
                  onChangeText={setAmount}
                />
              </View>

              {/* Reason */}
              <View style={{ marginBottom: 16 }}>
                <Text style={labelStyle}>Reason *</Text>
                <TextInput
                  style={{
                    ...inputStyle,
                    minHeight: 70,
                    textAlignVertical: 'top',
                  }}
                  placeholder="e.g. Price correction, billing error"
                  placeholderTextColor={C.textMuted}
                  value={reason}
                  onChangeText={setReason}
                  multiline
                  numberOfLines={2}
                  maxLength={500}
                />
              </View>

              {/* Note (optional) */}
              <View style={{ marginBottom: 24 }}>
                <Text style={labelStyle}>Note (optional)</Text>
                <TextInput
                  style={{
                    ...inputStyle,
                    minHeight: 60,
                    textAlignVertical: 'top',
                  }}
                  placeholder="Internal notes"
                  placeholderTextColor={C.textMuted}
                  value={note}
                  onChangeText={setNote}
                  multiline
                  numberOfLines={2}
                />
              </View>

              {/* Submit */}
              <TouchableOpacity
                onPress={handleSubmit}
                disabled={noteMutation.isPending}
                style={{
                  backgroundColor: noteMutation.isPending ? '#9ca3af' : (isCn ? '#d97706' : '#0369a1'),
                  borderRadius: 12,
                  paddingVertical: 14,
                  alignItems: 'center',
                  marginBottom: 8,
                }}
              >
                {noteMutation.isPending ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={{ fontSize: 16, fontWeight: '700', color: '#ffffff' }}>
                    Create {title}
                  </Text>
                )}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

// ─── Payments Tab ───────────────────────────────────────────────────────────

interface PaymentsTabProps {
  C: ReturnType<typeof getColors>;
  dark: boolean;
  paymentsData: { payments: Payment[]; total: number } | undefined;
  paymentsLoading: boolean;
  paymentsRefetching: boolean;
  refetchPayments: () => void;
  setCreatePaymentVisible: (v: boolean) => void;
  setAllocatePayment: (p: Payment) => void;
}

function PaymentsTab({
  C,
  dark,
  paymentsData,
  paymentsLoading,
  paymentsRefetching,
  refetchPayments,
  setCreatePaymentVisible,
  setAllocatePayment,
}: PaymentsTabProps) {
  const payments = paymentsData?.payments ?? [];

  const renderPaymentCard = useCallback(
    ({ item: pmt }: { item: Payment }) => {
      const methodKey = pmt.paymentMethod?.toLowerCase().replace(/\s+/g, '_') ?? 'cash';
      const methodColor = PAYMENT_METHOD_COLORS[methodKey] ?? { bg: '#6b7280', text: '#ffffff' };
      const methodLabel = PAYMENT_METHOD_LABELS[methodKey] ?? pmt.paymentMethod ?? 'Unknown';

      const allocationLabel = pmt.allocationStatus
        ? capitalizeStatus(pmt.allocationStatus)
        : (pmt.allocations && pmt.allocations.length > 0)
        ? 'Fully Allocated'
        : 'Unallocated';

      const allocationColor =
        allocationLabel === 'Fully Allocated'
          ? '#22c55e'
          : allocationLabel === 'Unallocated'
          ? '#ef4444'
          : '#f97316';

      const unallocated = pmt.unallocatedAmount ?? 0;

      return (
        <View
          style={{
            backgroundColor: C.card,
            borderRadius: 12,
            padding: 16,
            marginHorizontal: 16,
            marginBottom: 10,
            borderWidth: 1,
            borderColor: C.cardBorder,
          }}
        >
          {/* Top Row: Date + Customer + Amount */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 12, color: C.textMuted }}>{formatDate(pmt.transactionDate)}</Text>
              <Text style={{ fontSize: 15, fontWeight: '700', color: C.text, marginTop: 2 }}>
                {pmt.customerName}
              </Text>
            </View>
            <Text style={{ fontSize: 18, fontWeight: '800', color: '#22c55e' }}>
              {formatCurrency(pmt.amount)}
            </Text>
          </View>

          {/* Bottom Row: Method badge + Reference + Allocation */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginTop: 10,
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <View
              style={{
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 6,
                backgroundColor: methodColor.bg,
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: '700', color: methodColor.text }}>
                {methodLabel}
              </Text>
            </View>

            {pmt.referenceNumber ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Ionicons name="document-text-outline" size={13} color={C.textMuted} />
                <Text style={{ fontSize: 12, color: C.textSecondary }}>{pmt.referenceNumber}</Text>
              </View>
            ) : null}

            <View
              style={{
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 6,
                backgroundColor: allocationColor + '20',
                marginLeft: 'auto',
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: '600', color: allocationColor }}>
                {allocationLabel}
              </Text>
            </View>
          </View>

          {/* Invoice link */}
          {(pmt.allocations?.[0]?.invoiceNumber ?? pmt.allocations?.[0]?.invoiceId) && (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 4 }}>
              <Ionicons name="link-outline" size={13} color={C.textMuted} />
              <Text style={{ fontSize: 12, color: C.textSecondary }}>
                Invoice: {pmt.allocations?.[0]?.invoiceNumber ?? pmt.allocations?.[0]?.invoiceId}
              </Text>
            </View>
          )}

          {/* Feature 3: Unallocated amount + Allocate button */}
          {unallocated > 0 && (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginTop: 10,
                paddingTop: 10,
                borderTopWidth: 1,
                borderTopColor: C.divider,
              }}
            >
              <View>
                <Text style={{ fontSize: 11, color: C.textMuted }}>Unallocated</Text>
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#f59e0b' }}>
                  {formatCurrency(unallocated)}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setAllocatePayment(pmt)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 8,
                  backgroundColor: '#f59e0b',
                }}
              >
                <Ionicons name="arrow-forward-outline" size={15} color="#ffffff" />
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#ffffff' }}>Allocate</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      );
    },
    [C, dark, setAllocatePayment],
  );

  const renderEmpty = () => {
    if (paymentsLoading) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 80 }}>
          <ActivityIndicator size="large" color={ACCENT} />
          <Text style={{ marginTop: 12, color: C.textSecondary, fontSize: 14 }}>Loading payments...</Text>
        </View>
      );
    }
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 80 }}>
        <Ionicons name="wallet-outline" size={48} color={C.textMuted} />
        <Text style={{ fontSize: 16, fontWeight: '600', color: C.text, marginTop: 12 }}>
          No payments recorded
        </Text>
        <Text style={{ fontSize: 13, color: C.textSecondary, marginTop: 4 }}>
          Tap the + button to record a payment
        </Text>
      </View>
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={payments}
        keyExtractor={(item) => item.paymentId}
        renderItem={renderPaymentCard}
        contentContainerStyle={{ paddingTop: 12, paddingBottom: 80 }}
        ListEmptyComponent={renderEmpty}
        refreshControl={
          <RefreshControl
            refreshing={paymentsRefetching}
            onRefresh={refetchPayments}
            tintColor={ACCENT}
            colors={[ACCENT]}
          />
        }
      />

      {/* FAB */}
      <TouchableOpacity
        onPress={() => setCreatePaymentVisible(true)}
        style={{
          position: 'absolute',
          bottom: 24,
          right: 20,
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: ACCENT,
          justifyContent: 'center',
          alignItems: 'center',
          elevation: 6,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 3 },
          shadowOpacity: 0.3,
          shadowRadius: 4,
        }}
      >
        <Ionicons name="add" size={28} color="#ffffff" />
      </TouchableOpacity>
    </View>
  );
}

// ─── Feature 3: Allocate Payment Modal ──────────────────────────────────────

interface AllocatePaymentModalProps {
  C: ReturnType<typeof getColors>;
  dark: boolean;
  payment: Payment;
  onClose: () => void;
}

function AllocatePaymentModal({ C, dark, payment, onClose }: AllocatePaymentModalProps) {
  const [selectedInvoiceId, setSelectedInvoiceId] = useState('');
  const [amount, setAmount] = useState('');
  const [invoicePickerVisible, setInvoicePickerVisible] = useState(false);

  // Fetch open invoices for this customer
  const { data: invoicesData, isLoading: invoicesLoading } = useApiQuery<{ invoices: Invoice[] }>(
    ['customer-open-invoices', payment.customerId],
    '/invoices',
    { customerId: payment.customerId, pageSize: 100 },
    { staleTime: 60 * 1000 },
  );

  // Filter client-side to status issued/partially_paid with outstanding > 0
  const openInvoices = useMemo(() => {
    const all = invoicesData?.invoices ?? [];
    return all.filter(
      (inv) =>
        (inv.status === 'issued' || inv.status === 'partially_paid') &&
        (inv.outstandingAmount ?? 0) > 0,
    );
  }, [invoicesData]);

  const selectedInvoice = openInvoices.find((inv) => inv.invoiceId === selectedInvoiceId) ?? null;

  const unallocated = payment.unallocatedAmount ?? 0;
  const maxAmount = selectedInvoice
    ? Math.min(unallocated, selectedInvoice.outstandingAmount)
    : unallocated;

  // Pre-fill amount when invoice selected
  const handleSelectInvoice = (inv: Invoice) => {
    setSelectedInvoiceId(inv.invoiceId);
    setInvoicePickerVisible(false);
    setAmount(Math.min(unallocated, inv.outstandingAmount).toFixed(2));
  };

  const allocateMutation = useApiMutation<unknown, { invoiceId: string; amount: number }>(
    'post',
    `/payments/${payment.paymentId}/allocate`,
    {
      invalidateKeys: [['admin-payments'], ['admin-invoices']],
      successMessage: 'Payment allocated successfully',
      onSuccess: () => onClose(),
    },
  );

  const handleSubmit = () => {
    if (!selectedInvoiceId) {
      Alert.alert('Validation', 'Please select an invoice.');
      return;
    }
    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      Alert.alert('Validation', 'Please enter a valid amount.');
      return;
    }
    if (parsedAmount > maxAmount) {
      Alert.alert(
        'Validation',
        `Amount cannot exceed ${formatCurrency(maxAmount)} (min of unallocated and outstanding).`,
      );
      return;
    }
    allocateMutation.mutate({ invoiceId: selectedInvoiceId, amount: parsedAmount });
  };

  const inputStyle = {
    backgroundColor: C.inputBg,
    borderWidth: 1,
    borderColor: C.inputBorder,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: C.text,
  } as const;

  const labelStyle = {
    fontSize: 13,
    fontWeight: '600' as const,
    color: C.textSecondary,
    marginBottom: 6,
  };

  const readonlyStyle = {
    ...inputStyle,
    backgroundColor: dark ? '#334155' : '#f1f5f9',
    color: C.textMuted,
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: C.overlay }}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View
            style={{
              backgroundColor: C.modalBg,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              paddingHorizontal: 20,
              paddingTop: 16,
              paddingBottom: Platform.OS === 'ios' ? 36 : 24,
              maxHeight: '90%',
            }}
          >
            <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: C.divider, marginBottom: 16 }} />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: C.text }}>Allocate Payment</Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={24} color={C.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {/* Customer (readonly) */}
              <View style={{ marginBottom: 16 }}>
                <Text style={labelStyle}>Customer</Text>
                <View style={readonlyStyle}>
                  <Text style={{ fontSize: 15, color: C.textMuted }}>{payment.customerName}</Text>
                </View>
              </View>

              {/* Unallocated (readonly) */}
              <View style={{ marginBottom: 16 }}>
                <Text style={labelStyle}>Unallocated Amount</Text>
                <View style={readonlyStyle}>
                  <Text style={{ fontSize: 15, color: '#f59e0b', fontWeight: '700' }}>
                    {formatCurrency(unallocated)}
                  </Text>
                </View>
              </View>

              {/* Invoice picker */}
              <View style={{ marginBottom: 16 }}>
                <Text style={labelStyle}>Invoice</Text>
                {invoicesLoading ? (
                  <View style={{ ...readonlyStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <ActivityIndicator size="small" color={ACCENT} />
                    <Text style={{ fontSize: 14, color: C.textMuted }}>Loading invoices...</Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    onPress={() => setInvoicePickerVisible(!invoicePickerVisible)}
                    style={{
                      ...inputStyle,
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <Text style={{ fontSize: 15, color: selectedInvoice ? C.text : C.textMuted, flex: 1 }} numberOfLines={1}>
                      {selectedInvoice
                        ? `${selectedInvoice.invoiceNumber} (${formatCurrency(selectedInvoice.outstandingAmount)} due)`
                        : openInvoices.length === 0
                        ? 'No open invoices'
                        : 'Select invoice'}
                    </Text>
                    <Ionicons name="chevron-down" size={18} color={C.textSecondary} />
                  </TouchableOpacity>
                )}
                {invoicePickerVisible && openInvoices.length > 0 && (
                  <View
                    style={{
                      backgroundColor: C.card,
                      borderWidth: 1,
                      borderColor: C.cardBorder,
                      borderRadius: 10,
                      marginTop: 4,
                      maxHeight: 220,
                      overflow: 'hidden',
                    }}
                  >
                    <FlatList
                      data={openInvoices}
                      keyExtractor={(inv) => inv.invoiceId}
                      keyboardShouldPersistTaps="handled"
                      renderItem={({ item: inv }) => (
                        <TouchableOpacity
                          onPress={() => handleSelectInvoice(inv)}
                          style={{
                            paddingHorizontal: 14,
                            paddingVertical: 12,
                            borderBottomWidth: 1,
                            borderBottomColor: C.divider,
                            backgroundColor:
                              selectedInvoiceId === inv.invoiceId
                                ? (dark ? '#334155' : '#f1f5f9')
                                : 'transparent',
                          }}
                        >
                          <Text style={{ fontSize: 13, fontWeight: '600', color: C.text }}>
                            {inv.invoiceNumber}
                          </Text>
                          <Text style={{ fontSize: 12, color: C.textSecondary, marginTop: 2 }}>
                            Due: {formatCurrency(inv.outstandingAmount)} · {inv.customerName}
                          </Text>
                        </TouchableOpacity>
                      )}
                    />
                  </View>
                )}
              </View>

              {/* Amount */}
              <View style={{ marginBottom: 24 }}>
                <Text style={labelStyle}>
                  Amount{selectedInvoice ? ` (max ${formatCurrency(maxAmount)})` : ''}
                </Text>
                <TextInput
                  style={inputStyle}
                  placeholder={`Enter amount${selectedInvoice ? ` (max ${formatCurrency(maxAmount)})` : ''}`}
                  placeholderTextColor={C.textMuted}
                  keyboardType="numeric"
                  value={amount}
                  onChangeText={setAmount}
                />
              </View>

              {/* Submit */}
              <TouchableOpacity
                onPress={handleSubmit}
                disabled={allocateMutation.isPending || openInvoices.length === 0}
                style={{
                  backgroundColor:
                    allocateMutation.isPending || openInvoices.length === 0
                      ? '#9ca3af'
                      : '#f59e0b',
                  borderRadius: 12,
                  paddingVertical: 14,
                  alignItems: 'center',
                  marginBottom: 8,
                }}
              >
                {allocateMutation.isPending ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={{ fontSize: 16, fontWeight: '700', color: '#ffffff' }}>
                    Allocate Payment
                  </Text>
                )}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

// ─── Pay Invoice Modal (Bottom Sheet) ───────────────────────────────────────

interface PayInvoiceModalProps {
  C: ReturnType<typeof getColors>;
  dark: boolean;
  invoice: Invoice;
  onClose: () => void;
}

function PayInvoiceModal({ C, dark, invoice, onClose }: PayInvoiceModalProps) {
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [paymentDate, setPaymentDate] = useState(getTodayISO());
  const [methodPickerVisible, setMethodPickerVisible] = useState(false);

  const payMutation = useApiMutation<unknown, {
    customerId: string;
    amount: number;
    paymentMethod: string;
    referenceNumber?: string;
    transactionDate: string;
    allocations: { invoiceId: string; amount: number }[];
  }>('post', '/payments', {
    invalidateKeys: [['admin-invoices'], ['admin-payments']],
    successMessage: 'Payment recorded successfully',
    onSuccess: () => onClose(),
  });

  const handleSubmit = () => {
    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      Alert.alert('Validation', 'Please enter a valid amount.');
      return;
    }
    if (parsedAmount > invoice.outstandingAmount) {
      Alert.alert('Validation', `Amount cannot exceed outstanding amount of ${formatCurrency(invoice.outstandingAmount)}.`);
      return;
    }
    if (!paymentDate) {
      Alert.alert('Validation', 'Please enter a payment date.');
      return;
    }

    payMutation.mutate({
      customerId: invoice.customerId,
      amount: parsedAmount,
      paymentMethod,
      referenceNumber: referenceNumber.trim() || undefined,
      transactionDate: paymentDate,
      allocations: [{ invoiceId: invoice.invoiceId, amount: parsedAmount }],
    });
  };

  const inputStyle = {
    backgroundColor: C.inputBg,
    borderWidth: 1,
    borderColor: C.inputBorder,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: C.text,
  } as const;

  const labelStyle = {
    fontSize: 13,
    fontWeight: '600' as const,
    color: C.textSecondary,
    marginBottom: 6,
  };

  const readonlyStyle = {
    ...inputStyle,
    backgroundColor: dark ? '#334155' : '#f1f5f9',
    color: C.textMuted,
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: C.overlay }}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View
            style={{
              backgroundColor: C.modalBg,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              paddingHorizontal: 20,
              paddingTop: 16,
              paddingBottom: Platform.OS === 'ios' ? 36 : 24,
              maxHeight: '85%',
            }}
          >
            {/* Handle */}
            <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: C.divider, marginBottom: 16 }} />

            {/* Header */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: C.text }}>Record Payment</Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={24} color={C.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              {/* Invoice Number (readonly) */}
              <View style={{ marginBottom: 16 }}>
                <Text style={labelStyle}>Invoice #</Text>
                <View style={readonlyStyle}>
                  <Text style={{ fontSize: 15, color: C.textMuted }}>{invoice.invoiceNumber}</Text>
                </View>
              </View>

              {/* Outstanding (readonly) */}
              <View style={{ marginBottom: 16 }}>
                <Text style={labelStyle}>Outstanding Amount</Text>
                <View style={readonlyStyle}>
                  <Text style={{ fontSize: 15, color: '#ef4444', fontWeight: '700' }}>
                    {formatCurrency(invoice.outstandingAmount)}
                  </Text>
                </View>
              </View>

              {/* Amount */}
              <View style={{ marginBottom: 16 }}>
                <Text style={labelStyle}>Amount</Text>
                <TextInput
                  style={inputStyle}
                  placeholder="Enter amount"
                  placeholderTextColor={C.textMuted}
                  keyboardType="numeric"
                  value={amount}
                  onChangeText={setAmount}
                />
              </View>

              {/* Payment Method */}
              <View style={{ marginBottom: 16 }}>
                <Text style={labelStyle}>Payment Method</Text>
                <TouchableOpacity
                  onPress={() => setMethodPickerVisible(!methodPickerVisible)}
                  style={{
                    ...inputStyle,
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ fontSize: 15, color: C.text }}>
                    {PAYMENT_METHODS.find((m) => m.value === paymentMethod)?.label ?? 'Select'}
                  </Text>
                  <Ionicons name="chevron-down" size={18} color={C.textSecondary} />
                </TouchableOpacity>
                {methodPickerVisible && (
                  <View
                    style={{
                      backgroundColor: C.card,
                      borderWidth: 1,
                      borderColor: C.cardBorder,
                      borderRadius: 10,
                      marginTop: 4,
                      overflow: 'hidden',
                    }}
                  >
                    {PAYMENT_METHODS.map((m) => (
                      <TouchableOpacity
                        key={m.value}
                        onPress={() => {
                          setPaymentMethod(m.value);
                          setMethodPickerVisible(false);
                        }}
                        style={{
                          paddingHorizontal: 14,
                          paddingVertical: 12,
                          backgroundColor: paymentMethod === m.value ? (dark ? '#334155' : '#f1f5f9') : 'transparent',
                          borderBottomWidth: 1,
                          borderBottomColor: C.divider,
                        }}
                      >
                        <Text style={{ fontSize: 14, color: C.text, fontWeight: paymentMethod === m.value ? '700' : '400' }}>
                          {m.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>

              {/* Reference Number */}
              <View style={{ marginBottom: 16 }}>
                <Text style={labelStyle}>Reference #</Text>
                <TextInput
                  style={inputStyle}
                  placeholder="Transaction/Cheque reference"
                  placeholderTextColor={C.textMuted}
                  value={referenceNumber}
                  onChangeText={setReferenceNumber}
                />
              </View>

              {/* Payment Date */}
              <View style={{ marginBottom: 24 }}>
                <Text style={labelStyle}>Payment Date</Text>
                <TextInput
                  style={inputStyle}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={C.textMuted}
                  value={paymentDate}
                  onChangeText={setPaymentDate}
                />
              </View>

              {/* Submit */}
              <TouchableOpacity
                onPress={handleSubmit}
                disabled={payMutation.isPending}
                style={{
                  backgroundColor: payMutation.isPending ? '#9ca3af' : ACCENT,
                  borderRadius: 12,
                  paddingVertical: 14,
                  alignItems: 'center',
                  marginBottom: 8,
                }}
              >
                {payMutation.isPending ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={{ fontSize: 16, fontWeight: '700', color: '#ffffff' }}>
                    Record Payment
                  </Text>
                )}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

// ─── Create Payment Modal (Full Screen) ─────────────────────────────────────

interface CreatePaymentModalProps {
  C: ReturnType<typeof getColors>;
  dark: boolean;
  onClose: () => void;
}

function CreatePaymentModal({ C, dark, onClose }: CreatePaymentModalProps) {
  const [customerSearch, setCustomerSearch] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [showCustomerPicker, setShowCustomerPicker] = useState(false);
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [paymentDate, setPaymentDate] = useState(getTodayISO());
  const [notes, setNotes] = useState('');
  const [methodPickerVisible, setMethodPickerVisible] = useState(false);

  const { data: customersData } = useApiQuery<{ customers: Customer[] }>(
    ['customers-list'],
    '/customers',
    { limit: 200 },
    { staleTime: 5 * 60 * 1000 },
  );

  const filteredCustomers = useMemo(() => {
    const customers = customersData?.customers ?? [];
    if (!customerSearch.trim()) return customers;
    const q = customerSearch.toLowerCase();
    return customers.filter(
      (c) =>
        c.customerName.toLowerCase().includes(q) ||
        (c.phone && c.phone.includes(q)),
    );
  }, [customersData, customerSearch]);

  const createMutation = useApiMutation<unknown, {
    customerId: string;
    amount: number;
    paymentMethod: string;
    referenceNumber: string;
    transactionDate: string;
    notes: string;
  }>('post', '/payments', {
    invalidateKeys: [['admin-payments'], ['admin-invoices']],
    successMessage: 'Payment recorded successfully',
    onSuccess: () => onClose(),
  });

  const handleSubmit = () => {
    if (!selectedCustomer) {
      Alert.alert('Validation', 'Please select a customer.');
      return;
    }
    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      Alert.alert('Validation', 'Please enter a valid amount.');
      return;
    }
    if (!paymentDate) {
      Alert.alert('Validation', 'Please enter a payment date.');
      return;
    }

    createMutation.mutate({
      customerId: selectedCustomer.customerId,
      amount: parsedAmount,
      paymentMethod,
      referenceNumber: referenceNumber.trim(),
      transactionDate: paymentDate,
      notes: notes.trim(),
    });
  };

  const inputStyle = {
    backgroundColor: C.inputBg,
    borderWidth: 1,
    borderColor: C.inputBorder,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: C.text,
  } as const;

  const labelStyle = {
    fontSize: 13,
    fontWeight: '600' as const,
    color: C.textSecondary,
    marginBottom: 6,
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        {/* Header */}
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingHorizontal: 20,
            paddingVertical: 16,
            borderBottomWidth: 1,
            borderBottomColor: C.divider,
          }}
        >
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close" size={24} color={C.textSecondary} />
          </TouchableOpacity>
          <Text style={{ fontSize: 18, fontWeight: '800', color: C.text }}>Record Payment</Text>
          <View style={{ width: 24 }} />
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Customer Picker */}
            <View style={{ marginBottom: 16 }}>
              <Text style={labelStyle}>Customer</Text>
              <TouchableOpacity
                onPress={() => setShowCustomerPicker(!showCustomerPicker)}
                style={{
                  ...inputStyle,
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <Text
                  style={{
                    fontSize: 15,
                    color: selectedCustomer ? C.text : C.textMuted,
                  }}
                >
                  {selectedCustomer?.customerName ?? 'Select customer'}
                </Text>
                <Ionicons name="chevron-down" size={18} color={C.textSecondary} />
              </TouchableOpacity>

              {showCustomerPicker && (
                <View
                  style={{
                    backgroundColor: C.card,
                    borderWidth: 1,
                    borderColor: C.cardBorder,
                    borderRadius: 10,
                    marginTop: 4,
                    maxHeight: 250,
                  }}
                >
                  {/* Search input */}
                  <View
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      borderBottomWidth: 1,
                      borderBottomColor: C.divider,
                    }}
                  >
                    <TextInput
                      style={{
                        backgroundColor: C.inputBg,
                        borderWidth: 1,
                        borderColor: C.inputBorder,
                        borderRadius: 8,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        fontSize: 14,
                        color: C.text,
                      }}
                      placeholder="Search customer..."
                      placeholderTextColor={C.textMuted}
                      value={customerSearch}
                      onChangeText={setCustomerSearch}
                      autoFocus
                    />
                  </View>

                  <FlatList
                    data={filteredCustomers}
                    keyExtractor={(item) => item.customerId}
                    keyboardShouldPersistTaps="handled"
                    style={{ maxHeight: 190 }}
                    renderItem={({ item: cust }) => (
                      <TouchableOpacity
                        onPress={() => {
                          setSelectedCustomer(cust);
                          setShowCustomerPicker(false);
                          setCustomerSearch('');
                        }}
                        style={{
                          paddingHorizontal: 14,
                          paddingVertical: 12,
                          borderBottomWidth: 1,
                          borderBottomColor: C.divider,
                          backgroundColor:
                            selectedCustomer?.customerId === cust.customerId
                              ? (dark ? '#334155' : '#f1f5f9')
                              : 'transparent',
                        }}
                      >
                        <Text style={{ fontSize: 14, fontWeight: '600', color: C.text }}>
                          {cust.customerName}
                        </Text>
                        {cust.phone && (
                          <Text style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                            {cust.phone}
                          </Text>
                        )}
                      </TouchableOpacity>
                    )}
                    ListEmptyComponent={
                      <View style={{ padding: 20, alignItems: 'center' }}>
                        <Text style={{ color: C.textMuted, fontSize: 13 }}>No customers found</Text>
                      </View>
                    }
                  />
                </View>
              )}
            </View>

            {/* Amount */}
            <View style={{ marginBottom: 16 }}>
              <Text style={labelStyle}>Amount</Text>
              <TextInput
                style={inputStyle}
                placeholder="Enter amount"
                placeholderTextColor={C.textMuted}
                keyboardType="numeric"
                value={amount}
                onChangeText={setAmount}
              />
            </View>

            {/* Payment Method */}
            <View style={{ marginBottom: 16 }}>
              <Text style={labelStyle}>Payment Method</Text>
              <TouchableOpacity
                onPress={() => setMethodPickerVisible(!methodPickerVisible)}
                style={{
                  ...inputStyle,
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 15, color: C.text }}>
                  {PAYMENT_METHODS.find((m) => m.value === paymentMethod)?.label ?? 'Select'}
                </Text>
                <Ionicons name="chevron-down" size={18} color={C.textSecondary} />
              </TouchableOpacity>
              {methodPickerVisible && (
                <View
                  style={{
                    backgroundColor: C.card,
                    borderWidth: 1,
                    borderColor: C.cardBorder,
                    borderRadius: 10,
                    marginTop: 4,
                    overflow: 'hidden',
                  }}
                >
                  {PAYMENT_METHODS.map((m) => (
                    <TouchableOpacity
                      key={m.value}
                      onPress={() => {
                        setPaymentMethod(m.value);
                        setMethodPickerVisible(false);
                      }}
                      style={{
                        paddingHorizontal: 14,
                        paddingVertical: 12,
                        backgroundColor: paymentMethod === m.value ? (dark ? '#334155' : '#f1f5f9') : 'transparent',
                        borderBottomWidth: 1,
                        borderBottomColor: C.divider,
                      }}
                    >
                      <Text style={{ fontSize: 14, color: C.text, fontWeight: paymentMethod === m.value ? '700' : '400' }}>
                        {m.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            {/* Reference Number */}
            <View style={{ marginBottom: 16 }}>
              <Text style={labelStyle}>Reference #</Text>
              <TextInput
                style={inputStyle}
                placeholder="Transaction/Cheque reference"
                placeholderTextColor={C.textMuted}
                value={referenceNumber}
                onChangeText={setReferenceNumber}
              />
            </View>

            {/* Payment Date */}
            <View style={{ marginBottom: 16 }}>
              <Text style={labelStyle}>Payment Date</Text>
              <TextInput
                style={inputStyle}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={C.textMuted}
                value={paymentDate}
                onChangeText={setPaymentDate}
              />
            </View>

            {/* Notes */}
            <View style={{ marginBottom: 24 }}>
              <Text style={labelStyle}>Notes</Text>
              <TextInput
                style={{
                  ...inputStyle,
                  minHeight: 80,
                  textAlignVertical: 'top',
                }}
                placeholder="Optional notes"
                placeholderTextColor={C.textMuted}
                value={notes}
                onChangeText={setNotes}
                multiline
                numberOfLines={3}
              />
            </View>

            {/* Submit */}
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={createMutation.isPending}
              style={{
                backgroundColor: createMutation.isPending ? '#9ca3af' : ACCENT,
                borderRadius: 12,
                paddingVertical: 14,
                alignItems: 'center',
              }}
            >
              {createMutation.isPending ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={{ fontSize: 16, fontWeight: '700', color: '#ffffff' }}>
                  Record Payment
                </Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
