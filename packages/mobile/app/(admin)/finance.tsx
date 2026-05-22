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
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { useTheme } from '../../src/theme';
import { api, getErrorMessage } from '../../src/lib/api';

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
}

interface Customer {
  customerId: string;
  customerName: string;
  phone?: string;
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
  return '\u20B9' + (amount ?? 0).toLocaleString('en-IN');
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
          invoiceStatus={invoiceStatus}
          setInvoiceStatus={setInvoiceStatus}
          invoicesData={invoicesData}
          invoicesLoading={invoicesLoading}
          invoicesRefetching={invoicesRefetching}
          refetchInvoices={refetchInvoices}
          expandedInvoiceId={expandedInvoiceId}
          setExpandedInvoiceId={setExpandedInvoiceId}
          setPayInvoice={setPayInvoice}
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
    </SafeAreaView>
  );
}

// ─── Invoices Tab ───────────────────────────────────────────────────────────

interface InvoicesTabProps {
  C: ReturnType<typeof getColors>;
  dark: boolean;
  invoiceStatus: string;
  setInvoiceStatus: (s: string) => void;
  invoicesData: { invoices: Invoice[]; total: number } | undefined;
  invoicesLoading: boolean;
  invoicesRefetching: boolean;
  refetchInvoices: () => void;
  expandedInvoiceId: string | null;
  setExpandedInvoiceId: (id: string | null) => void;
  setPayInvoice: (inv: Invoice) => void;
}

function InvoicesTab({
  C,
  dark,
  invoiceStatus,
  setInvoiceStatus,
  invoicesData,
  invoicesLoading,
  invoicesRefetching,
  refetchInvoices,
  expandedInvoiceId,
  setExpandedInvoiceId,
  setPayInvoice,
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
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
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

              {/* Action Buttons */}
              <View style={{ flexDirection: 'row', gap: 10 }}>
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
            </View>
          )}
        </TouchableOpacity>
      );
    },
    [expandedInvoiceId, C, dark, setExpandedInvoiceId, setPayInvoice, downloadingId, downloadInvoicePdf],
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

// ─── Payments Tab ───────────────────────────────────────────────────────────

interface PaymentsTabProps {
  C: ReturnType<typeof getColors>;
  dark: boolean;
  paymentsData: { payments: Payment[]; total: number } | undefined;
  paymentsLoading: boolean;
  paymentsRefetching: boolean;
  refetchPayments: () => void;
  setCreatePaymentVisible: (v: boolean) => void;
}

function PaymentsTab({
  C,
  dark,
  paymentsData,
  paymentsLoading,
  paymentsRefetching,
  refetchPayments,
  setCreatePaymentVisible,
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
        </View>
      );
    },
    [C],
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
