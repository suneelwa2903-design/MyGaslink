import { useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, Modal, FlatList, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { useTheme, formatINR } from '../../src/theme';
import { Card, Badge, MetricCard, EmptyState, SelectField } from '../../src/components/ui';
import type { Invoice } from '@gaslink/shared';
import { invoiceStatusLabel, invoiceStatusVariant } from '@gaslink/shared';

type InvoiceFilter = 'all' | 'issued' | 'partially_paid' | 'paid' | 'overdue';

const TABS: { label: string; value: InvoiceFilter }[] = [
  { label: 'All', value: 'all' },
  { label: invoiceStatusLabel('issued'), value: 'issued' },
  { label: invoiceStatusLabel('partially_paid'), value: 'partially_paid' },
  { label: invoiceStatusLabel('paid'), value: 'paid' },
  { label: invoiceStatusLabel('overdue'), value: 'overdue' },
];

export default function FinanceInvoicesScreen() {
  const { dark, colors, accent } = useTheme();
  const [tab, setTab] = useState<InvoiceFilter>('all');
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);

  const { data: invoicesResponse, isLoading, refetch } = useApiQuery<{ invoices: Invoice[] }>(
    ['fin-invoices', tab],
    '/invoices',
    tab === 'all' ? {} : { status: tab },
  );
  const invoices: Invoice[] = invoicesResponse?.invoices ?? [];

  const totalOutstanding = (invoices ?? []).reduce((s, inv) => s + (inv.outstandingAmount ?? 0), 0);
  const overdueCount = (invoices ?? []).filter((inv) => (inv.status || '') === 'overdue').length;

  // Capture "now" once via a lazy initializer so render stays pure (no impure
  // Date.now() call during render). Good enough for a day-granularity display.
  const [now] = useState(() => Date.now());

  const renderInvoice = ({ item: inv }: { item: Invoice }) => {
    const daysOverdue = inv.status === 'overdue'
      ? Math.floor((now - new Date(inv.dueDate).getTime()) / 86400000)
      : 0;

    return (
      <TouchableOpacity onPress={() => setSelectedInvoiceId(inv.invoiceId)} activeOpacity={0.7}>
        <Card>
          {/* Header */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
            <View style={{ flex: 1, marginRight: 8 }}>
              <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>{inv.invoiceNumber}</Text>
              <Text style={{ fontSize: 14, color: accent.red, fontWeight: '500', marginTop: 2 }}>{inv.customerName}</Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <Badge label={invoiceStatusLabel(inv.status || '')} variant={invoiceStatusVariant(inv.status || '')} />
              {daysOverdue > 0 && (
                <Text style={{ fontSize: 11, color: '#ef4444', fontWeight: '600' }}>{daysOverdue}d overdue</Text>
              )}
            </View>
          </View>

          {/* Dates */}
          <View style={{ flexDirection: 'row', gap: 16, marginBottom: 8 }}>
            <View>
              <Text style={{ fontSize: 11, color: colors.textSecondary }}>Issue Date</Text>
              <Text style={{ fontSize: 13, fontWeight: '500', color: colors.text }}>{inv.issueDate}</Text>
            </View>
            <View>
              <Text style={{ fontSize: 11, color: colors.textSecondary }}>Due Date</Text>
              <Text style={{ fontSize: 13, fontWeight: '500', color: daysOverdue > 0 ? '#ef4444' : colors.text }}>{inv.dueDate}</Text>
            </View>
          </View>

          {/* Financial breakdown */}
          <View style={{ backgroundColor: dark ? colors.inputBg : '#f8fafc', borderRadius: 10, padding: 12, gap: 4 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 13, color: colors.textSecondary }}>Total</Text>
              <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>{formatINR(inv.totalAmount)}</Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 13, color: colors.textSecondary }}>Paid</Text>
              <Text style={{ fontSize: 13, fontWeight: '600', color: accent.green }}>{formatINR(inv.amountPaid)}</Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 4, marginTop: 2 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>Outstanding</Text>
              <Text style={{ fontSize: 14, fontWeight: '800', color: (inv.outstandingAmount ?? 0) > 0 ? '#f97316' : accent.green }}>
                {formatINR(inv.outstandingAmount)}
              </Text>
            </View>
          </View>

          {/* GST Badge */}
          {inv.irn && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
              <Badge label="GST e-Invoice" variant="success" />
              <Text style={{ fontSize: 11, color: colors.textSecondary }} numberOfLines={1}>IRN: {inv.irn.substring(0, 20)}...</Text>
            </View>
          )}
        </Card>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* STAGE-D: horizontal pill-row replaced with a chip-shaped SelectField
          dropdown for parity with the admin Billing screen UX. */}
      <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
        <SelectField
          label="Status"
          value={tab}
          options={TABS}
          onChange={(v) => setTab(v as InvoiceFilter)}
          accent={accent.red}
        />
      </View>

      {/* Summary */}
      <View style={{ paddingHorizontal: 16, paddingBottom: 8, gap: 12 }}>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard title="Outstanding" value={formatINR(totalOutstanding)} color="#f97316" />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard title="Overdue" value={overdueCount} color={overdueCount > 0 ? '#ef4444' : accent.green} subtitle={`of ${invoices?.length ?? 0} invoices`} />
          </View>
        </View>
      </View>

      {/* Invoice List */}
      <FlatList
        data={invoices ?? []}
        keyExtractor={(inv) => inv.invoiceId}
        renderItem={renderInvoice}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 10 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
        ListEmptyComponent={<EmptyState title="No invoices" description="No invoices match the selected filter" />}
      />

      {/* Invoice Detail Modal */}
      {selectedInvoiceId && (
        <InvoiceDetailModal
          invoiceId={selectedInvoiceId}
          dark={dark}
          colors={colors}
          accent={accent}
          onClose={() => setSelectedInvoiceId(null)}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Invoice Detail Modal ────────────────────────────────────────────────────

interface InvoiceDetailData {
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  issueDate: string;
  dueDate: string;
  status: string;
  lineItems?: {
    cylinderTypeName: string;
    quantity: number;
    unitPrice: number;
    gstRate: number;
    amount: number;
  }[];
  subtotal: number;
  cgstAmount: number;
  sgstAmount: number;
  totalAmount: number;
  amountPaid: number;
  outstandingAmount: number;
  irn?: string;
  notes?: string;
}

function InvoiceDetailModal({
  invoiceId,
  dark,
  colors,
  accent,
  onClose,
}: {
  invoiceId: string;
  dark: boolean;
  colors: ReturnType<typeof useTheme>['colors'];
  accent: ReturnType<typeof useTheme>['accent'];
  onClose: () => void;
}) {
  const { data: invoice, isLoading } = useApiQuery<InvoiceDetailData>(
    ['invoice-detail', invoiceId],
    `/invoices/${invoiceId}`,
  );

  const badgeVariant = invoiceStatusVariant(invoice?.status || '');
  const sectionBg = dark ? colors.inputBg : '#f8fafc';

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen">
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        {/* Header */}
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: colors.divider,
          backgroundColor: dark ? colors.cardBg : colors.bg,
        }}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="close" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>Invoice Detail</Text>
          <View style={{ width: 26 }} />
        </View>

        {isLoading || !invoice ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="large" color={accent.red} />
          </View>
        ) : (
          <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
            {/* Invoice Header */}
            <View style={{ gap: 4 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text }}>{invoice.invoiceNumber}</Text>
                  <Text style={{ fontSize: 15, color: accent.red, fontWeight: '500', marginTop: 2 }}>{invoice.customerName}</Text>
                </View>
                <Badge label={invoiceStatusLabel(invoice.status || '')} variant={badgeVariant} />
              </View>
            </View>

            {/* Dates */}
            <View style={{ flexDirection: 'row', gap: 24 }}>
              <View>
                <Text style={{ fontSize: 12, color: colors.textMuted, marginBottom: 2 }}>Issue Date</Text>
                <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>{invoice.issueDate}</Text>
              </View>
              <View>
                <Text style={{ fontSize: 12, color: colors.textMuted, marginBottom: 2 }}>Due Date</Text>
                <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>{invoice.dueDate}</Text>
              </View>
            </View>

            {/* Line Items */}
            {(invoice.lineItems?.length ?? 0) > 0 && (
              <View style={{ backgroundColor: sectionBg, borderRadius: 12, padding: 14, gap: 10 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Line Items
                </Text>
                {invoice.lineItems!.map((item, idx) => (
                  <View key={idx} style={{
                    paddingBottom: idx < invoice.lineItems!.length - 1 ? 10 : 0,
                    borderBottomWidth: idx < invoice.lineItems!.length - 1 ? 1 : 0,
                    borderBottomColor: colors.divider,
                    gap: 4,
                  }}>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>{item.cylinderTypeName}</Text>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 12, color: colors.textSecondary }}>
                        {item.quantity} x {formatINR(item.unitPrice)} @ {item.gstRate}% GST
                      </Text>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>{formatINR(item.amount)}</Text>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {/* Totals */}
            <View style={{ backgroundColor: sectionBg, borderRadius: 12, padding: 14, gap: 8 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Summary
              </Text>
              <DetailRow label="Subtotal" value={formatINR(invoice.subtotal)} colors={colors} />
              <DetailRow label="CGST" value={formatINR(invoice.cgstAmount)} colors={colors} />
              <DetailRow label="SGST" value={formatINR(invoice.sgstAmount)} colors={colors} />
              <View style={{ borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 8, marginTop: 4 }}>
                <DetailRow label="Total" value={formatINR(invoice.totalAmount)} colors={colors} bold />
              </View>
              <DetailRow label="Paid" value={formatINR(invoice.amountPaid)} colors={colors} valueColor={accent.green} />
              <View style={{ borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 8, marginTop: 4 }}>
                <DetailRow
                  label="Outstanding"
                  value={formatINR(invoice.outstandingAmount)}
                  colors={colors}
                  valueColor={(invoice.outstandingAmount ?? 0) > 0 ? '#f97316' : accent.green}
                  bold
                />
              </View>
            </View>

            {/* IRN */}
            {invoice.irn && (
              <View style={{ backgroundColor: sectionBg, borderRadius: 12, padding: 14, gap: 4 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  GST e-Invoice
                </Text>
                <Text style={{ fontSize: 12, color: colors.textMuted }} numberOfLines={2}>IRN: {invoice.irn}</Text>
              </View>
            )}

            {/* Notes */}
            {invoice.notes && (
              <View style={{ backgroundColor: sectionBg, borderRadius: 12, padding: 14, gap: 4 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Notes
                </Text>
                <Text style={{ fontSize: 14, color: colors.text }}>{invoice.notes}</Text>
              </View>
            )}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

function DetailRow({
  label,
  value,
  colors,
  valueColor,
  bold,
}: {
  label: string;
  value: string;
  colors: ReturnType<typeof useTheme>['colors'];
  valueColor?: string;
  bold?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={{ fontSize: 13, color: colors.textSecondary, fontWeight: bold ? '700' : '400' }}>{label}</Text>
      <Text style={{ fontSize: bold ? 15 : 13, fontWeight: bold ? '800' : '600', color: valueColor || colors.text }}>{value}</Text>
    </View>
  );
}
