import { useState } from 'react';
import {
  View, Text, ScrollView, RefreshControl, TouchableOpacity, Modal,
  FlatList, Alert, ActivityIndicator,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { api, getErrorMessage } from '../../src/lib/api';
import { Badge, EmptyState } from '../../src/components/ui';
import { DateRangeFilter, last30Days } from '../../src/components/DateRangeFilter';
import { useTheme, formatINR, formatDate } from '../../src/theme';
import type { Invoice } from '@gaslink/shared';

// WI-126: PDF is offered only for billed invoices whose order was delivered.
function canDownloadPdf(status?: string | null, orderStatus?: string | null): boolean {
  return ['issued', 'partially_paid', 'paid'].includes(status ?? '')
    && ['delivered', 'modified_delivered'].includes(orderStatus ?? '');
}

interface InvoiceDetail {
  invoiceId: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  status: string;
  orderStatus: string | null;
  customerName: string;
  customerGstin: string | null;
  billingAddress: string | null;
  items: Array<{
    cylinderTypeName: string;
    quantity: number;
    unitPrice: number;
    gstRate: number;
    lineTotal: number;
  }>;
  subtotal: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalAmount: number;
  amountPaid: number;
  outstandingAmount: number;
  irn: string | null;
  payments: Array<{
    paymentId: string;
    amount: number;
    transactionDate: string;
    paymentMethod: string;
    referenceNumber: string | null;
  }>;
}

export default function CustomerInvoicesScreen() {
  const { colors, accent } = useTheme();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // WI-124: collapsible date-range filter (issueDate), default last 30 days.
  const [dateFrom, setDateFrom] = useState(() => last30Days().from);
  const [dateTo, setDateTo] = useState(() => last30Days().to);

  const { data: invoicesResponse, isLoading, refetch } = useApiQuery<{ invoices: Invoice[] }>(
    ['customer-invoices', dateFrom, dateTo],
    '/customer-portal/invoices',
    { from: dateFrom, to: dateTo },
  );
  const invoices: Invoice[] = invoicesResponse?.invoices ?? [];

  const { data: invoiceDetail } = useApiQuery<InvoiceDetail>(
    ['invoice-detail', selectedId!],
    `/customer-portal/invoices/${selectedId}`,
    undefined,
    { enabled: !!selectedId },
  );

  // WI-126: per-invoice PDF download (customer-scoped endpoint). Mirrors the
  // payments ledger-download pattern: arraybuffer → cache file → OS share sheet.
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const handleDownloadPdf = async (invoiceId: string, invoiceNumber: string) => {
    setDownloadingId(invoiceId);
    try {
      const res = await api.get(`/customer-portal/invoices/${invoiceId}/pdf`, {
        responseType: 'arraybuffer',
      });
      const bytes = new Uint8Array(res.data);
      const file = new File(Paths.cache, `invoice-${invoiceNumber}.pdf`);
      try { file.create(); } catch { /* already exists, fine */ }
      file.write(bytes);
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'This device does not support sharing.');
        return;
      }
      await Sharing.shareAsync(file.uri, {
        mimeType: 'application/pdf',
        dialogTitle: `Invoice ${invoiceNumber}`,
        UTI: 'com.adobe.pdf',
      });
    } catch (err) {
      Alert.alert('Could not download invoice', getErrorMessage(err));
    } finally {
      setDownloadingId(null);
    }
  };

  const statusVariant = (status: string) => {
    switch (status) {
      case 'paid': return 'success' as const;
      case 'overdue': return 'danger' as const;
      case 'partially_paid': return 'warning' as const;
      case 'issued': return 'info' as const;
      default: return 'neutral' as const;
    }
  };

  const renderInvoiceItem = ({ item: inv }: { item: Invoice }) => (
    <TouchableOpacity
      onPress={() => setSelectedId(inv.invoiceId)}
      style={{
        backgroundColor: colors.cardBg, borderRadius: 14, padding: 16,
        borderWidth: 1, borderColor: colors.cardBorder, marginBottom: 10,
      }}
      activeOpacity={0.7}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>{inv.invoiceNumber}</Text>
          <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 4 }}>
            Issued: {formatDate(inv.issueDate)} | Due: {formatDate(inv.dueDate)}
          </Text>
        </View>
        <Badge label={(inv.status || '').replace(/_/g, ' ')} variant={statusVariant(inv.status || '')} />
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 }}>
        <View>
          <Text style={{ fontSize: 12, color: colors.textSecondary }}>Total</Text>
          <Text style={{ fontWeight: '700', color: colors.text }}>{formatINR(inv.totalAmount)}</Text>
        </View>
        <View style={{ alignItems: 'center' }}>
          <Text style={{ fontSize: 12, color: colors.textSecondary }}>Paid</Text>
          <Text style={{ fontWeight: '700', color: accent.green }}>{formatINR(inv.amountPaid)}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={{ fontSize: 12, color: colors.textSecondary }}>Outstanding</Text>
          <Text style={{ fontWeight: '700', color: (inv.outstandingAmount ?? 0) > 0 ? accent.orange : accent.green }}>
            {formatINR(inv.outstandingAmount)}
          </Text>
        </View>
      </View>

      {inv.irn && (
        <View style={{ marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Ionicons name="shield-checkmark" size={12} color={accent.green} />
          <Text style={{ fontSize: 11, color: accent.green, fontWeight: '600' }}>GST e-Invoice</Text>
        </View>
      )}

      {canDownloadPdf(inv.status, inv.orderStatus) && (
        <TouchableOpacity
          onPress={() => handleDownloadPdf(inv.invoiceId, inv.invoiceNumber)}
          disabled={downloadingId === inv.invoiceId}
          style={{
            marginTop: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
            paddingVertical: 9, borderRadius: 10, borderWidth: 1, borderColor: colors.inputBorder,
            backgroundColor: colors.inputBg,
          }}
        >
          {downloadingId === inv.invoiceId ? (
            <ActivityIndicator size="small" color={accent.blue} />
          ) : (
            <Ionicons name="download-outline" size={16} color={accent.blue} />
          )}
          <Text style={{ fontSize: 13, fontWeight: '600', color: accent.blue }}>
            {downloadingId === inv.invoiceId ? 'Preparing…' : 'Download PDF'}
          </Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <DateRangeFilter from={dateFrom} to={dateTo} setFrom={setDateFrom} setTo={setDateTo} />
      <FlatList
        data={invoices ?? []}
        keyExtractor={(inv) => inv.invoiceId}
        renderItem={renderInvoiceItem}
        contentContainerStyle={{ padding: 16 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
        ListEmptyComponent={
          <EmptyState title="No invoices" description="Invoices will appear here after orders are delivered" />
        }
      />

      {/* Invoice Detail Modal */}
      <Modal visible={!!selectedId} animationType="slide">
        <SafeAreaProvider>
        <SafeAreaView edges={['top','bottom','left','right']} style={{ flex: 1, backgroundColor: colors.bg }}>
          {/* Header */}
          <View style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            paddingHorizontal: 16, paddingVertical: 12,
            borderBottomWidth: 1, borderBottomColor: colors.divider,
          }}>
            <TouchableOpacity onPress={() => setSelectedId(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
            <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>
              {invoiceDetail?.invoiceNumber ?? 'Invoice'}
            </Text>
            {invoiceDetail && canDownloadPdf(invoiceDetail.status, invoiceDetail.orderStatus) ? (
              <TouchableOpacity
                onPress={() => handleDownloadPdf(invoiceDetail.invoiceId, invoiceDetail.invoiceNumber)}
                disabled={downloadingId === invoiceDetail.invoiceId}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                {downloadingId === invoiceDetail.invoiceId ? (
                  <ActivityIndicator size="small" color={accent.blue} />
                ) : (
                  <Ionicons name="download-outline" size={24} color={accent.blue} />
                )}
              </TouchableOpacity>
            ) : (
              <View style={{ width: 24 }} />
            )}
          </View>

          <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
            {invoiceDetail ? (
              <>
                {/* Status & Dates */}
                <View style={{
                  backgroundColor: colors.cardBg, borderRadius: 14, padding: 16,
                  borderWidth: 1, borderColor: colors.cardBorder,
                }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>
                      {invoiceDetail.invoiceNumber}
                    </Text>
                    <Badge
                      label={(invoiceDetail.status || '').replace(/_/g, ' ')}
                      variant={statusVariant(invoiceDetail.status || '')}
                    />
                  </View>
                  <View style={{ gap: 6 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, color: colors.textSecondary }}>Issue Date</Text>
                      <Text style={{ fontSize: 13, fontWeight: '500', color: colors.text }}>{formatDate(invoiceDetail.issueDate)}</Text>
                    </View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, color: colors.textSecondary }}>Due Date</Text>
                      <Text style={{ fontSize: 13, fontWeight: '500', color: colors.text }}>{formatDate(invoiceDetail.dueDate)}</Text>
                    </View>
                  </View>
                </View>

                {/* Customer Info */}
                <View style={{
                  backgroundColor: colors.cardBg, borderRadius: 14, padding: 16,
                  borderWidth: 1, borderColor: colors.cardBorder,
                }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: 8 }}>Customer</Text>
                  <Text style={{ fontSize: 14, color: colors.text }}>{invoiceDetail.customerName}</Text>
                  {invoiceDetail.customerGstin && (
                    <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                      GSTIN: {invoiceDetail.customerGstin}
                    </Text>
                  )}
                  {invoiceDetail.billingAddress && (
                    <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                      {invoiceDetail.billingAddress}
                    </Text>
                  )}
                </View>

                {/* Line Items */}
                <View style={{
                  backgroundColor: colors.cardBg, borderRadius: 14, padding: 16,
                  borderWidth: 1, borderColor: colors.cardBorder,
                }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: 12 }}>Items</Text>
                  {/* Table Header */}
                  <View style={{ flexDirection: 'row', paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.divider }}>
                    <Text style={{ flex: 2, fontSize: 11, fontWeight: '600', color: colors.textMuted }}>ITEM</Text>
                    <Text style={{ flex: 0.5, fontSize: 11, fontWeight: '600', color: colors.textMuted, textAlign: 'center' }}>QTY</Text>
                    <Text style={{ flex: 1, fontSize: 11, fontWeight: '600', color: colors.textMuted, textAlign: 'right' }}>PRICE</Text>
                    <Text style={{ flex: 0.5, fontSize: 11, fontWeight: '600', color: colors.textMuted, textAlign: 'right' }}>GST</Text>
                    <Text style={{ flex: 1, fontSize: 11, fontWeight: '600', color: colors.textMuted, textAlign: 'right' }}>TOTAL</Text>
                  </View>
                  {invoiceDetail.items?.map((item, i) => (
                    <View
                      key={i}
                      style={{
                        flexDirection: 'row', paddingVertical: 10, alignItems: 'center',
                        borderBottomWidth: i < invoiceDetail.items.length - 1 ? 1 : 0,
                        borderBottomColor: colors.divider,
                      }}
                    >
                      <Text style={{ flex: 2, fontSize: 13, color: colors.text }} numberOfLines={1}>
                        {item.cylinderTypeName}
                      </Text>
                      <Text style={{ flex: 0.5, fontSize: 13, color: colors.text, textAlign: 'center' }}>
                        {item.quantity}
                      </Text>
                      <Text style={{ flex: 1, fontSize: 13, color: colors.text, textAlign: 'right' }}>
                        {formatINR(item.unitPrice)}
                      </Text>
                      <Text style={{ flex: 0.5, fontSize: 12, color: colors.textSecondary, textAlign: 'right' }}>
                        {item.gstRate}%
                      </Text>
                      <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: colors.text, textAlign: 'right' }}>
                        {formatINR(item.lineTotal)}
                      </Text>
                    </View>
                  ))}
                </View>

                {/* Totals */}
                <View style={{
                  backgroundColor: colors.cardBg, borderRadius: 14, padding: 16,
                  borderWidth: 1, borderColor: colors.cardBorder,
                }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: 8 }}>Summary</Text>
                  <View style={{ gap: 6 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, color: colors.textSecondary }}>Subtotal</Text>
                      <Text style={{ fontSize: 13, color: colors.text }}>{formatINR(invoiceDetail.subtotal)}</Text>
                    </View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, color: colors.textSecondary }}>CGST</Text>
                      <Text style={{ fontSize: 13, color: colors.text }}>{formatINR(invoiceDetail.cgstAmount)}</Text>
                    </View>
                    {(invoiceDetail.igstAmount ?? 0) > 0 ? (
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: 13, color: colors.textSecondary }}>IGST</Text>
                        <Text style={{ fontSize: 13, color: colors.text }}>{formatINR(invoiceDetail.igstAmount)}</Text>
                      </View>
                    ) : (
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: 13, color: colors.textSecondary }}>SGST</Text>
                        <Text style={{ fontSize: 13, color: colors.text }}>{formatINR(invoiceDetail.sgstAmount)}</Text>
                      </View>
                    )}
                    <View style={{
                      flexDirection: 'row', justifyContent: 'space-between',
                      borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 8, marginTop: 4,
                    }}>
                      <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>Total</Text>
                      <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>{formatINR(invoiceDetail.totalAmount)}</Text>
                    </View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, color: accent.green }}>Paid</Text>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: accent.green }}>{formatINR(invoiceDetail.amountPaid)}</Text>
                    </View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, color: (invoiceDetail.outstandingAmount ?? 0) > 0 ? accent.orange : accent.green }}>
                        Outstanding
                      </Text>
                      <Text style={{
                        fontSize: 13, fontWeight: '600',
                        color: (invoiceDetail.outstandingAmount ?? 0) > 0 ? accent.orange : accent.green,
                      }}>
                        {formatINR(invoiceDetail.outstandingAmount)}
                      </Text>
                    </View>
                  </View>
                </View>

                {/* Payment History */}
                {(invoiceDetail.payments?.length ?? 0) > 0 && (
                  <View style={{
                    backgroundColor: colors.cardBg, borderRadius: 14, padding: 16,
                    borderWidth: 1, borderColor: colors.cardBorder,
                  }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: 8 }}>
                      Payment History
                    </Text>
                    {invoiceDetail.payments.map((p) => (
                      <View
                        key={p.paymentId}
                        style={{
                          flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                          paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.divider,
                        }}
                      >
                        <View>
                          <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>
                            {formatINR(p.amount)}
                          </Text>
                          <Text style={{ fontSize: 11, color: colors.textSecondary, marginTop: 2 }}>
                            {formatDate(p.transactionDate)}
                          </Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <View style={{
                            flexDirection: 'row', alignItems: 'center', gap: 4,
                            backgroundColor: colors.inputBg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
                          }}>
                            <Ionicons
                              name={p.paymentMethod === 'cash' ? 'cash-outline' : p.paymentMethod === 'upi' ? 'phone-portrait-outline' : 'card-outline'}
                              size={12}
                              color={colors.textSecondary}
                            />
                            <Text style={{ fontSize: 11, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase' }}>
                              {p.paymentMethod}
                            </Text>
                          </View>
                          {p.referenceNumber && (
                            <Text style={{ fontSize: 10, color: colors.textMuted, marginTop: 2 }}>
                              Ref: {p.referenceNumber}
                            </Text>
                          )}
                        </View>
                      </View>
                    ))}
                  </View>
                )}

                {invoiceDetail.irn && (
                  <View style={{
                    flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center',
                    paddingVertical: 8,
                  }}>
                    <Ionicons name="shield-checkmark" size={14} color={accent.green} />
                    <Text style={{ fontSize: 12, color: accent.green, fontWeight: '600' }}>
                      GST e-Invoice verified (IRN available)
                    </Text>
                  </View>
                )}
              </>
            ) : (
              <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                <Text style={{ color: colors.textMuted }}>Loading invoice details...</Text>
              </View>
            )}
          </ScrollView>
        </SafeAreaView>
        </SafeAreaProvider>
      </Modal>
    </SafeAreaView>
  );
}
