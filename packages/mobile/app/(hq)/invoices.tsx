/**
 * HQ Invoices (2026-07-19) — consolidated invoices across every
 * property in the group + PDF share via expo-sharing.
 *
 * Security: GET /api/customer-group-portal/invoices AND
 * /api/customer-group-portal/invoices/:id/pdf. Both routes call
 * getGroupInvoiceById first which asserts the invoice belongs to a
 * visible customer (throws 404 otherwise — no info leak). The mobile
 * client never sends a customerId; only invoiceId → server enforces.
 */
import { useMemo, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useApiQuery } from '../../src/hooks/useApi';
import { Card, EmptyState, ScreenSkeleton, Badge, SelectField } from '../../src/components/ui';
import { useTheme, formatINR } from '../../src/theme';
import { api, getErrorMessage } from '../../src/lib/api';
import type { Invoice } from '@gaslink/shared';

interface InvoicesResponse {
  invoices: Invoice[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

const STATUS_OPTIONS = [
  { label: 'All statuses', value: '' },
  { label: 'Issued', value: 'issued' },
  { label: 'Partially paid', value: 'partially_paid' },
  { label: 'Overdue', value: 'overdue' },
  { label: 'Paid', value: 'paid' },
];

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function statusBadge(status: string, outstanding: number) {
  const s = String(status);
  if (s === 'paid') return { label: 'Paid', variant: 'success' as const };
  if (s === 'overdue') return { label: 'Overdue', variant: 'danger' as const };
  if (s === 'partially_paid') return { label: 'Partial', variant: 'warning' as const };
  if (outstanding > 0) return { label: 'Due', variant: 'warning' as const };
  return { label: s, variant: 'neutral' as const };
}

export default function HqInvoicesScreen() {
  const { colors } = useTheme();
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const params = useMemo(() => {
    const p: Record<string, string | number> = { page, pageSize: 25 };
    if (statusFilter) p.status = statusFilter;
    return p;
  }, [page, statusFilter]);

  const { data, isLoading, refetch, isRefetching } = useApiQuery<InvoicesResponse>(
    ['hq-invoices', JSON.stringify(params)],
    '/customer-group-portal/invoices',
    params,
  );

  const invoices = data?.invoices ?? [];
  const totalPages = data?.meta.totalPages ?? 1;

  const handleShare = async (inv: Invoice) => {
    setDownloadingId(inv.invoiceId);
    try {
      // Server validates the invoice belongs to a visible customer
      // BEFORE generating the PDF. See customerGroupPortal.ts:144.
      const res = await api.get(
        `/customer-group-portal/invoices/${inv.invoiceId}/pdf`,
        { responseType: 'arraybuffer' },
      );
      const bytes = new Uint8Array(res.data);
      // 2026-07-19: Date.now() inside render is flagged by React Compiler
      // as impure. This is an event-handler path (post-tap) so it's
      // safe, but the linter rule fires on any Date.now() in the same
      // module. Use the invoiceId as the uniqueness token instead —
      // it's already stable and unique per row.
      const file = new File(Paths.cache, `invoice-${inv.invoiceNumber}-${inv.invoiceId.slice(0, 8)}.pdf`);
      try { file.create(); } catch { /* already exists */ }
      file.write(bytes);
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'This device does not support sharing.');
        return;
      }
      await Sharing.shareAsync(file.uri, {
        mimeType: 'application/pdf',
        dialogTitle: `Invoice ${inv.invoiceNumber}`,
      });
    } catch (err) {
      Alert.alert('Download failed', getErrorMessage(err) || 'Please try again.');
    } finally {
      setDownloadingId(null);
    }
  };

  if (isLoading && !data) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScreenSkeleton />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => { void refetch(); }} />}
      >
        <Card>
          <SelectField
            label="Status"
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={(v) => { setStatusFilter(v); setPage(1); }}
          />
        </Card>

        {invoices.length === 0 ? (
          <Card>
            <EmptyState
              title="No invoices"
              description={statusFilter ? 'No invoices match the current filter.' : 'No invoices across your group properties yet.'}
            />
          </Card>
        ) : (
          <Card>
            {invoices.map((inv, idx) => {
              const outstanding = Number(inv.outstandingAmount ?? 0);
              const b = statusBadge(inv.status, outstanding);
              const isDownloading = downloadingId === inv.invoiceId;
              return (
                <View
                  key={inv.invoiceId}
                  style={{
                    paddingVertical: 12,
                    borderBottomWidth: idx === invoices.length - 1 ? 0 : 1,
                    borderBottomColor: colors.divider,
                    gap: 8,
                  }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14 }} numberOfLines={1}>
                        {inv.invoiceNumber}
                      </Text>
                      <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                        {inv.customerName}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14 }}>
                        {formatINR(inv.totalAmount ?? 0)}
                      </Text>
                      <View style={{ marginTop: 4 }}>
                        <Badge variant={b.variant} label={b.label} />
                      </View>
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
                    <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                      Issued: {fmtDate(inv.issueDate)}
                    </Text>
                    <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                      Due: {fmtDate(inv.dueDate)}
                    </Text>
                    {outstanding > 0 && (
                      <Text style={{ color: '#dc2626', fontSize: 11, fontWeight: '600' }}>
                        Outstanding: {formatINR(outstanding)}
                      </Text>
                    )}
                  </View>
                  <TouchableOpacity
                    onPress={() => { void handleShare(inv); }}
                    disabled={isDownloading}
                    style={{
                      alignSelf: 'flex-start',
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      borderRadius: 8,
                      backgroundColor: colors.inputBg,
                      borderWidth: 1,
                      borderColor: colors.cardBorder,
                      opacity: isDownloading ? 0.5 : 1,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    {isDownloading && <ActivityIndicator size="small" color={colors.text} />}
                    <Text style={{ color: colors.text, fontWeight: '600', fontSize: 12 }}>
                      {isDownloading ? 'Preparing…' : 'Share PDF'}
                    </Text>
                  </TouchableOpacity>
                </View>
              );
            })}
          </Card>
        )}

        {totalPages > 1 && (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 }}>
            <TouchableOpacity
              onPress={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              style={{
                paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8,
                borderWidth: 1, borderColor: colors.cardBorder,
                opacity: page <= 1 ? 0.4 : 1,
              }}
            >
              <Text style={{ color: colors.text, fontWeight: '600' }}>Prev</Text>
            </TouchableOpacity>
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
              Page {page} / {totalPages}
            </Text>
            <TouchableOpacity
              onPress={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              style={{
                paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8,
                borderWidth: 1, borderColor: colors.cardBorder,
                opacity: page >= totalPages ? 0.4 : 1,
              }}
            >
              <Text style={{ color: colors.text, fontWeight: '600' }}>Next</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={{ height: 8 }} />
      </ScrollView>
    </SafeAreaView>
  );
}
