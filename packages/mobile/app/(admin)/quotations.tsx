/**
 * Mini-op #7 (2026-07-28) — Mobile Quotations screen.
 *
 * Hidden route under (admin), reached from More → Quotations for mini-op
 * admins only (parity with Expenses gating).
 *
 * Read-only + shareable + send-via-SMTP. The editor stays on web — a
 * quotation editor is a wide-table + rich-text surface that doesn't
 * translate cleanly to mobile in v1. Mobile use case: on-the-road resend,
 * download PDF to share on WhatsApp, mark as sent after a manual client
 * conversation.
 *
 * Anti-pattern #25 compliance:
 *   - useSafeAreaInsets read + insets.bottom padding on the FlatList and
 *     the view modal's ScrollView.
 *   - keyboardShouldPersistTaps='handled' on scroll surfaces.
 *   - onRequestClose on every <Modal> for Android hardware back.
 *   - KeyboardAvoidingView wraps the ScrollView in the view modal so the
 *     iOS keyboard doesn't cover the Send / Duplicate buttons.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Modal, Alert, ActivityIndicator,
  RefreshControl, FlatList, KeyboardAvoidingView, Platform, TextInput,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { api, getErrorMessage } from '../../src/lib/api';
import { useTheme, formatINR } from '../../src/theme';
import { Badge, EmptyState, DateInput } from '../../src/components/ui';
import { localTodayISO, localDateISO } from '@gaslink/shared';

// Defaults used by the compact mobile create form. Web has a longer
// template — mobile keeps the essentials so a salesperson can generate
// a rate-quote from the road; the operator can enrich it on web later
// (Edit → Duplicate for a monthly re-send). Terms mirror the web
// New Quotation defaults so the PDF reads consistently across surfaces.
const MOBILE_DEFAULT_COVER = 'Dear Sir / Madam,\n\nThank you for the opportunity. Please find our rates below.\n\nRegards.';
const MOBILE_DEFAULT_TERMS: string[] = [
  'Prices are valid until the date shown above; beyond that a fresh quote will be issued.',
  'Statutory taxes as applicable are included where shown.',
  'Delivery within 24 working hours of confirmed order, subject to cylinder availability at the depot.',
  'A refundable security deposit is payable at first delivery for every new cylinder taken on rotation.',
  'Late payments beyond the agreed credit period attract 2% interest per month.',
];
const MOBILE_DEFAULT_CREDIT_TERMS = '15 days from date of invoice';
const MOBILE_QUOTATION_GST_RATES = [0.05, 0.18] as const;
import type { QuotationStatusValue } from '@gaslink/shared';

// Shape returned by GET /api/quotations (see quotationService.listQuotations).
interface QuotationRow {
  quotationId: string;
  quotationNumber: string;
  quotationDate: string;
  validUntil: string;
  recipientName: string;
  recipientEmail: string;
  customerId: string | null;
  subject: string;
  mode: 'per_cylinder' | 'per_kg' | 'mixed';
  status: QuotationStatusValue;
  gstRate: number;
  itemCount: number;
  createdAt: string;
  sentAt: string | null;
}

// Shape returned by GET /api/quotations/:id (see quotationService.getQuotation
// / mapQuotation). Only fields we render are typed.
interface QuotationItem {
  quotationItemId: string;
  kind: 'per_cylinder' | 'per_kg';
  itemName: string;
  hsnCode: string;
  priceInclGst?: number | null;
  discountInclGst?: number | null;
  pricePerKgInclGst?: number | null;
  discountPerKgInclGst?: number | null;
  cylinderCapacityKg?: number | null;
  notes?: string | null;
}

interface QuotationDetail extends QuotationRow {
  recipientContactPerson?: string | null;
  recipientAddress?: string | null;
  recipientCity?: string | null;
  recipientState?: string | null;
  recipientPincode?: string | null;
  recipientPhone?: string | null;
  recipientGstin?: string | null;
  ccEmails?: string[] | null;
  coverText: string;
  footerNotes?: string | null;
  terms: string[];
  creditTerms: string;
  items: QuotationItem[];
}

const STATUS_TABS: { label: string; value: QuotationStatusValue | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Draft', value: 'draft' },
  { label: 'Sent', value: 'sent' },
  { label: 'Accepted', value: 'accepted' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'Expired', value: 'expired' },
];

function statusVariant(s: QuotationStatusValue): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  if (s === 'sent') return 'info';
  if (s === 'accepted') return 'success';
  if (s === 'expired') return 'warning';
  if (s === 'rejected') return 'danger';
  return 'neutral';
}

// 2026-07-29 — status colour for the card left border (minimal category-
// level colour polish: keep the row white, just a 3-px band on the left
// keyed to status). Matches statusVariant order.
function statusBorderColor(s: QuotationStatusValue): string {
  if (s === 'sent') return '#2563eb'; // blue
  if (s === 'accepted') return '#059669'; // emerald
  if (s === 'expired') return '#d97706'; // amber
  if (s === 'rejected') return '#dc2626'; // red
  return '#9ca3af'; // slate — draft
}

// Compact labelled input reused by the freeform recipient block. Keeps
// the create-modal JSX below scannable.
type ThemeColors = ReturnType<typeof useTheme>['colors'];
function FieldInput({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoCapitalize,
  theme,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'email-address' | 'phone-pad' | 'number-pad' | 'decimal-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  theme: ThemeColors;
}) {
  return (
    <View>
      <Text style={{ fontSize: 11, color: theme.textMuted, marginBottom: 4, textTransform: 'uppercase' }}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.textMuted}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize={autoCapitalize ?? 'sentences'}
        style={{
          backgroundColor: theme.inputBg,
          borderColor: theme.inputBorder,
          borderWidth: 1,
          borderRadius: 10,
          padding: 10,
          fontSize: 14,
          color: theme.text,
        }}
      />
    </View>
  );
}

// ─── Screen ─────────────────────────────────────────────────────────────────

export default function QuotationsScreen() {
  const { colors, accent } = useTheme();
  const insets = useSafeAreaInsets();
  const [statusFilter, setStatusFilter] = useState<QuotationStatusValue | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createVisible, setCreateVisible] = useState(false);

  const params: Record<string, unknown> = {};
  if (statusFilter !== 'all') params.status = statusFilter;

  const { data, isLoading, refetch, isRefetching } = useApiQuery<{
    quotations: QuotationRow[];
    meta: { total: number };
  }>(['quotations', statusFilter], '/quotations', params);

  const rows: QuotationRow[] = data?.quotations ?? [];

  const renderRow = ({ item }: { item: QuotationRow }) => (
    <TouchableOpacity
      onPress={() => setSelectedId(item.quotationId)}
      activeOpacity={0.7}
      style={{
        backgroundColor: colors.cardBg,
        borderRadius: 12,
        padding: 14,
        marginHorizontal: 16,
        marginBottom: 10,
        borderWidth: 1,
        borderColor: colors.cardBorder,
        // 2026-07-29 — category-level colour: 3-px left border keyed to
        // quotation status, so the reader can scan Draft vs Sent vs
        // Accepted at a glance without introducing full row backgrounds.
        borderLeftWidth: 3,
        borderLeftColor: statusBorderColor(item.status),
      }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 12, color: colors.textMuted }}>{item.quotationDate}</Text>
          <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text, marginTop: 2 }}>
            {item.quotationNumber}
          </Text>
          <Text style={{ fontSize: 13, color: accent.red, marginTop: 2 }}>{item.recipientName}</Text>
        </View>
        <Badge label={item.status.toUpperCase()} variant={statusVariant(item.status)} />
      </View>
      <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
        <View>
          <Text style={{ fontSize: 11, color: colors.textMuted }}>Valid until</Text>
          <Text style={{ fontSize: 12, fontWeight: '600', color: colors.text }}>{item.validUntil}</Text>
        </View>
        <View>
          <Text style={{ fontSize: 11, color: colors.textMuted }}>Items</Text>
          <Text style={{ fontSize: 12, fontWeight: '600', color: colors.text }}>{item.itemCount}</Text>
        </View>
        <View>
          <Text style={{ fontSize: 11, color: colors.textMuted }}>GST</Text>
          <Text style={{ fontSize: 12, fontWeight: '600', color: colors.text }}>{Math.round(item.gstRate * 100)}%</Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Status filter chip row. 2026-07-29 — flexGrow: 0 pins the
          ScrollView height to its content; without it the row inherits
          flex: 1 from the SafeAreaView parent and each chip stretches to
          fill the vertical space (was rendering as tall bars). */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, flexShrink: 0 }}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10, gap: 6, alignItems: 'center' }}
      >
        {STATUS_TABS.map((t) => {
          const active = statusFilter === t.value;
          return (
            <TouchableOpacity
              key={t.value}
              onPress={() => setStatusFilter(t.value)}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 16,
                backgroundColor: active ? accent.red : colors.inputBg,
                borderWidth: 1,
                borderColor: active ? accent.red : colors.inputBorder,
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: '600', color: active ? '#ffffff' : colors.text }}>
                {t.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <FlatList
        data={rows}
        keyExtractor={(r) => r.quotationId}
        renderItem={renderRow}
        contentContainerStyle={{ paddingTop: 4, paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={accent.red} colors={[accent.red]} />}
        ListEmptyComponent={
          isLoading ? (
            <View style={{ padding: 40, alignItems: 'center' }}>
              <ActivityIndicator color={accent.red} />
            </View>
          ) : (
            <EmptyState
              title="No quotations yet"
              description="Create quotations from the web. On mobile you can view, share and email them."
            />
          )
        }
      />

      {selectedId && (
        <QuotationDetailModal
          quotationId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => { refetch(); }}
        />
      )}

      {/* 2026-07-29 — Floating "+ New Quotation" FAB. Opens a compact
          create modal (customer picker + one line item). Full multi-item
          editing stays on web where the wide-table editor is. */}
      <TouchableOpacity
        onPress={() => setCreateVisible(true)}
        activeOpacity={0.85}
        style={{
          position: 'absolute',
          right: 20,
          bottom: Math.max(insets.bottom + 16, 24),
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: accent.red,
          alignItems: 'center',
          justifyContent: 'center',
          elevation: 6,
          shadowColor: '#000',
          shadowOpacity: 0.2,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 3 },
        }}
      >
        <Ionicons name="add" size={30} color="#ffffff" />
      </TouchableOpacity>

      {createVisible && (
        <QuotationCreateModal
          onClose={() => setCreateVisible(false)}
          onCreated={() => {
            setCreateVisible(false);
            refetch();
          }}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Detail modal ───────────────────────────────────────────────────────────

function QuotationDetailModal({
  quotationId,
  onClose,
  onChanged,
}: {
  quotationId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { dark, colors, accent } = useTheme();
  const insets = useSafeAreaInsets();
  const [downloading, setDownloading] = useState(false);

  const { data: q, isLoading, refetch } = useApiQuery<QuotationDetail>(
    ['quotation-detail', quotationId],
    `/quotations/${quotationId}`,
  );

  const sendMut = useApiMutation<{ sent: boolean; reason?: string }, void>(
    'post',
    `/quotations/${quotationId}/send-email`,
    {
      onSuccess: (res) => {
        if (res.sent) {
          Alert.alert('Email sent', `Quotation emailed to ${q?.recipientEmail}.`);
        } else if (res.reason === 'skipped') {
          Alert.alert(
            'SMTP not configured',
            'The server has no SMTP credentials set. Download the PDF and email it manually from your mail app.',
          );
        } else {
          Alert.alert('Email failed', 'The server tried to send but failed. Check with the admin.');
        }
        onChanged();
        refetch();
      },
      onError: (err) => Alert.alert('Send failed', getErrorMessage(err)),
    },
  );

  const dupMut = useApiMutation<{ quotation: { quotationId: string } }, void>(
    'post',
    `/quotations/${quotationId}/duplicate`,
    {
      onSuccess: () => {
        Alert.alert('Duplicated', 'A new draft was created. Edit it on the web.');
        onChanged();
        onClose();
      },
      onError: (err) => Alert.alert('Duplicate failed', getErrorMessage(err)),
    },
  );

  const handleDownloadPdf = async () => {
    if (!q) return;
    setDownloading(true);
    try {
      const res = await api.get(`/quotations/${q.quotationId}/pdf`, { responseType: 'arraybuffer' });
      const bytes = new Uint8Array(res.data);
      const file = new File(Paths.cache, `${q.quotationNumber}.pdf`);
      try { file.create(); } catch { /* already exists */ }
      file.write(bytes);
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'This device does not support sharing.');
        return;
      }
      await Sharing.shareAsync(file.uri, {
        mimeType: 'application/pdf',
        dialogTitle: q.quotationNumber,
        UTI: 'com.adobe.pdf',
      });
    } catch (err) {
      Alert.alert('Could not download PDF', getErrorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  const total = useMemo(() => {
    if (!q) return 0;
    return q.items.reduce((s, it) => {
      if (it.kind === 'per_cylinder') {
        const p = Number(it.priceInclGst ?? 0);
        const d = Number(it.discountInclGst ?? 0);
        return s + Math.max(0, p - d);
      }
      const p = Number(it.pricePerKgInclGst ?? 0);
      const d = Number(it.discountPerKgInclGst ?? 0);
      const cap = Number(it.cylinderCapacityKg ?? 0);
      return s + Math.max(0, p - d) * cap;
    }, 0);
  }, [q]);

  const sectionBg = dark ? colors.inputBg : '#f8fafc';
  const canSend = q && (q.status === 'draft' || q.status === 'sent');

  return (
    <Modal visible transparent={false} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: colors.divider,
          }}
        >
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text }}>
            {q?.quotationNumber ?? 'Quotation'}
          </Text>
          <TouchableOpacity
            onPress={handleDownloadPdf}
            disabled={downloading || !q}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Download quotation PDF"
          >
            {downloading ? (
              <ActivityIndicator size="small" color={accent.red} />
            ) : (
              <Ionicons name="download-outline" size={22} color={q ? colors.text : colors.textMuted} />
            )}
          </TouchableOpacity>
        </View>

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
          {isLoading || !q ? (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
              <ActivityIndicator color={accent.red} />
            </View>
          ) : (
            <ScrollView
              contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 96, gap: 14 }}
              keyboardShouldPersistTaps="handled"
            >
              {/* Recipient block */}
              <View style={{ backgroundColor: sectionBg, borderRadius: 12, padding: 14, gap: 6 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase' }}>
                  To
                </Text>
                <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>{q.recipientName}</Text>
                {q.recipientContactPerson ? (
                  <Text style={{ fontSize: 13, color: colors.text }}>{q.recipientContactPerson}</Text>
                ) : null}
                {q.recipientEmail ? (
                  <Text style={{ fontSize: 13, color: colors.textSecondary }}>{q.recipientEmail}</Text>
                ) : null}
                {q.recipientPhone ? (
                  <Text style={{ fontSize: 13, color: colors.textSecondary }}>{q.recipientPhone}</Text>
                ) : null}
                {q.recipientAddress ? (
                  <Text style={{ fontSize: 12, color: colors.textSecondary }}>
                    {[q.recipientAddress, q.recipientCity, q.recipientState, q.recipientPincode]
                      .filter(Boolean)
                      .join(', ')}
                  </Text>
                ) : null}
                {q.ccEmails && q.ccEmails.length > 0 ? (
                  <Text style={{ fontSize: 12, color: colors.textMuted }}>CC: {q.ccEmails.join(', ')}</Text>
                ) : null}
              </View>

              {/* Meta */}
              <View style={{ backgroundColor: sectionBg, borderRadius: 12, padding: 14, gap: 8 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 12, color: colors.textMuted }}>Date</Text>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>{q.quotationDate}</Text>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 12, color: colors.textMuted }}>Valid until</Text>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>{q.validUntil}</Text>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 12, color: colors.textMuted }}>Status</Text>
                  <Badge label={q.status.toUpperCase()} variant={statusVariant(q.status)} />
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 12, color: colors.textMuted }}>GST</Text>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>
                    {Math.round(q.gstRate * 100)}%
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 12, color: colors.textMuted }}>Credit terms</Text>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>{q.creditTerms}</Text>
                </View>
              </View>

              {/* Subject + Cover */}
              <View style={{ backgroundColor: sectionBg, borderRadius: 12, padding: 14, gap: 8 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase' }}>
                  Subject
                </Text>
                <Text style={{ fontSize: 14, color: colors.text }}>{q.subject}</Text>
                {q.coverText ? (
                  <>
                    <Text
                      style={{
                        fontSize: 11,
                        fontWeight: '700',
                        color: colors.textMuted,
                        textTransform: 'uppercase',
                        marginTop: 6,
                      }}
                    >
                      Cover
                    </Text>
                    <Text style={{ fontSize: 13, color: colors.text, lineHeight: 18 }}>{q.coverText}</Text>
                  </>
                ) : null}
              </View>

              {/* Items */}
              <View style={{ backgroundColor: sectionBg, borderRadius: 12, padding: 14, gap: 10 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase' }}>
                  Line items ({q.items.length})
                </Text>
                {q.items.map((it, idx) => {
                  const isPerKg = it.kind === 'per_kg';
                  const price = isPerKg ? Number(it.pricePerKgInclGst ?? 0) : Number(it.priceInclGst ?? 0);
                  const disc = isPerKg ? Number(it.discountPerKgInclGst ?? 0) : Number(it.discountInclGst ?? 0);
                  const net = Math.max(0, price - disc);
                  return (
                    <View
                      key={it.quotationItemId}
                      style={{
                        paddingBottom: idx < q.items.length - 1 ? 10 : 0,
                        borderBottomWidth: idx < q.items.length - 1 ? 1 : 0,
                        borderBottomColor: colors.divider,
                        gap: 4,
                      }}
                    >
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text, flex: 1 }}>
                          {it.itemName}
                        </Text>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>
                          {formatINR(net)} {isPerKg ? '/kg' : ''}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 11, color: colors.textSecondary }}>
                        HSN {it.hsnCode} • {isPerKg ? `per KG (${it.cylinderCapacityKg ?? '?'} kg cyl)` : 'per cylinder'}
                        {disc > 0 ? `  •  ${formatINR(disc)} discount` : ''}
                      </Text>
                      {it.notes ? (
                        <Text style={{ fontSize: 11, color: colors.textMuted, fontStyle: 'italic' }}>{it.notes}</Text>
                      ) : null}
                    </View>
                  );
                })}
                <View
                  style={{
                    borderTopWidth: 1,
                    borderTopColor: colors.divider,
                    paddingTop: 10,
                    marginTop: 4,
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>Indicative total</Text>
                  <Text style={{ fontSize: 15, fontWeight: '800', color: colors.text }}>{formatINR(total)}</Text>
                </View>
              </View>

              {/* Terms */}
              {q.terms.length > 0 && (
                <View style={{ backgroundColor: sectionBg, borderRadius: 12, padding: 14, gap: 6 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase' }}>
                    Terms
                  </Text>
                  {q.terms.map((t, i) => (
                    <Text key={i} style={{ fontSize: 12, color: colors.text, lineHeight: 18 }}>
                      • {t}
                    </Text>
                  ))}
                </View>
              )}
            </ScrollView>
          )}
        </KeyboardAvoidingView>

        {/* Sticky action row — Send + Duplicate. Sits above the safe-area
            inset so it never overlaps the Samsung 3-button nav bar. */}
        {q && (
          <View
            style={{
              paddingHorizontal: 16,
              paddingTop: 10,
              paddingBottom: Math.max(insets.bottom + 6, 12),
              borderTopWidth: 1,
              borderTopColor: colors.divider,
              flexDirection: 'row',
              gap: 8,
              backgroundColor: colors.bg,
            }}
          >
            <TouchableOpacity
              onPress={() => dupMut.mutate()}
              disabled={dupMut.isPending}
              style={{
                flex: 1,
                paddingVertical: 12,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: colors.inputBorder,
                alignItems: 'center',
                backgroundColor: colors.cardBg,
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>
                {dupMut.isPending ? '…' : 'Duplicate'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                if (!q.recipientEmail) {
                  Alert.alert('No email on file', 'This quotation has no recipient email. Add one on the web first.');
                  return;
                }
                sendMut.mutate();
              }}
              disabled={sendMut.isPending || !canSend}
              style={{
                flex: 1.4,
                paddingVertical: 12,
                borderRadius: 10,
                alignItems: 'center',
                backgroundColor: canSend ? accent.red : colors.inputBg,
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: '700', color: canSend ? '#ffffff' : colors.textMuted }}>
                {sendMut.isPending ? 'Sending…' : q.status === 'sent' ? 'Resend email' : 'Send email'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

// ─── Create modal ───────────────────────────────────────────────────────────
// Compact "New Quotation" form that captures the essentials for a
// per-cylinder rate quote:
//   customer → subject → validUntil → GST → one line item (type + rate + discount)
// Cover text, terms, and creditTerms use the mobile defaults (matches web
// New Quotation defaults for consistent PDF appearance). Multi-item edits,
// per_kg rows, and terms edits live on web.
//
// Anti-pattern #25 (Samsung nav-bar overlap) compliance:
//   - useSafeAreaInsets → insets.bottom padding on the ScrollView.
//   - keyboardShouldPersistTaps='handled' on scroll surfaces.
//   - onRequestClose on every <Modal> for Android hardware back.

interface CustomerRow {
  customerId: string;
  customerName: string;
  customerType?: 'B2B' | 'B2C';
  contactPerson?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  phone?: string | null;
  email?: string | null;
  gstin?: string | null;
}

interface CylinderTypeRow {
  cylinderTypeId: string;
  typeName: string;
  capacity: number;
  unit: 'kg' | 'lb';
  hsnCode?: string | null;
}

function QuotationCreateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { colors, accent, dark } = useTheme();
  const insets = useSafeAreaInsets();

  // 2026-07-29 — recipient mode. Web supports either linking to an existing
  // customer OR entering freeform recipient details for a prospect who
  // isn't in the customer table yet. Mobile matches: mode toggle at the
  // top of the modal switches the block.
  const [recipientMode, setRecipientMode] = useState<'existing' | 'freeform'>('existing');
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [showCustomerPicker, setShowCustomerPicker] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Freeform recipient fields (used when recipientMode === 'freeform', or
  // as overrides on top of an existing customer's data — e.g. the operator
  // wants to send this specific quote to a different email address).
  const [ffName, setFfName] = useState('');
  const [ffContact, setFfContact] = useState('');
  const [ffEmail, setFfEmail] = useState('');
  const [ffPhone, setFfPhone] = useState('');
  const [ffAddress, setFfAddress] = useState('');
  const [ffCity, setFfCity] = useState('');
  const [ffState, setFfState] = useState('');
  const [ffPincode, setFfPincode] = useState('');
  const [ffGstin, setFfGstin] = useState('');

  // CC emails (up to 10 per shared schema; comma-separated on input).
  const [ccEmailsRaw, setCcEmailsRaw] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(customerSearch.length >= 3 ? customerSearch : ''), 300);
    return () => clearTimeout(t);
  }, [customerSearch]);

  const { data: searchData, isFetching: isSearching } = useApiQuery<{ customers: CustomerRow[] }>(
    ['quotation-customer-search', debouncedSearch],
    '/customers',
    { search: debouncedSearch, status: 'active', pageSize: 10 },
    { enabled: debouncedSearch.length >= 3, staleTime: 30_000 },
  );

  // Quotation basics
  const [subject, setSubject] = useState('Rate quote');
  const [validUntil, setValidUntil] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return localDateISO(d);
  });
  const [gstRate, setGstRate] = useState<number>(0.05);

  // Line item — 2026-07-29 supports both per_cylinder and per_kg modes,
  // matching the web New Quotation shape. per_cylinder = flat rate per
  // cylinder; per_kg = rate × capacityKg, useful for wholesale rate
  // quotes on non-standard sizes.
  const [itemKind, setItemKind] = useState<'per_cylinder' | 'per_kg'>('per_cylinder');
  const [cylinderTypeId, setCylinderTypeId] = useState<string>('');
  const [rate, setRate] = useState<string>(''); // per-cylinder rate ₹ incl GST OR per-kg rate ₹ incl GST
  const [discount, setDiscount] = useState<string>('0');
  const [capacityKg, setCapacityKg] = useState<string>(''); // per_kg override; auto-filled from cylinder type

  const { data: cylinderTypesData } = useApiQuery<{ cylinderTypes: CylinderTypeRow[] }>(
    ['cylinder-types-quotation'],
    '/cylinder-types',
  );
  const cylinderTypes = cylinderTypesData?.cylinderTypes ?? [];
  const selectedCylType = cylinderTypes.find((c) => c.cylinderTypeId === cylinderTypeId);

  const createMut = useApiMutation<{ quotation: { quotationId: string } }, Record<string, unknown>>(
    'post',
    '/quotations',
    {
      invalidateKeys: [['quotations']],
      onSuccess: () => {
        Alert.alert('Draft created', 'Quotation saved as Draft. Open it to send or duplicate.');
        onCreated();
      },
      onError: (err) => Alert.alert('Save failed', getErrorMessage(err)),
    },
  );

  // Auto-fill capacityKg on mode-toggle and type-select callbacks below —
  // no useEffect needed. Deriving at those two event sites avoids the
  // cascading-render lint rule (setState inside effect body).

  // Effective recipient block — either the linked customer's snapshot or
  // the freeform values below. In existing mode, freeform email overrides
  // the customer's email if the operator typed one.
  const effectiveRecipient = useMemo(() => {
    if (recipientMode === 'freeform') {
      return {
        name: ffName.trim(),
        contact: ffContact.trim() || undefined,
        email: ffEmail.trim(),
        phone: ffPhone.trim() || undefined,
        address: ffAddress.trim() || undefined,
        city: ffCity.trim() || undefined,
        state: ffState.trim() || undefined,
        pincode: ffPincode.trim() || undefined,
        gstin: ffGstin.trim() || undefined,
      };
    }
    return {
      name: customer?.customerName ?? '',
      contact: customer?.contactPerson ?? undefined,
      email: ffEmail.trim() || customer?.email || '',
      phone: customer?.phone ?? undefined,
      address: customer?.address ?? undefined,
      city: customer?.city ?? undefined,
      state: customer?.state ?? undefined,
      pincode: customer?.pincode ?? undefined,
      gstin: customer?.gstin ?? undefined,
    };
  }, [recipientMode, customer, ffName, ffContact, ffEmail, ffPhone, ffAddress, ffCity, ffState, ffPincode, ffGstin]);

  const parsedCcEmails = useMemo(() => {
    return ccEmailsRaw
      .split(/[,;\s]+/)
      .map((e) => e.trim())
      .filter((e) => e.length > 0);
  }, [ccEmailsRaw]);

  const canSubmit =
    !!effectiveRecipient.name
    && !!cylinderTypeId
    && !!rate
    && Number.isFinite(parseFloat(rate))
    && parseFloat(rate) > 0
    && !!subject.trim()
    && !!validUntil
    && (itemKind === 'per_cylinder' || (itemKind === 'per_kg' && parseFloat(capacityKg) > 0));

  const handleSubmit = () => {
    if (!effectiveRecipient.name) return Alert.alert('Validation', 'Recipient name is required.');
    if (recipientMode === 'existing' && !customer) return Alert.alert('Validation', 'Please pick a customer or switch to freeform.');
    if (!selectedCylType) return Alert.alert('Validation', 'Please pick a cylinder type.');
    const rateNum = parseFloat(rate);
    if (!Number.isFinite(rateNum) || rateNum <= 0) return Alert.alert('Validation', 'Rate must be a positive number.');
    const discountNum = parseFloat(discount || '0');
    if (!Number.isFinite(discountNum) || discountNum < 0) return Alert.alert('Validation', 'Discount must be 0 or a positive number.');
    if (itemKind === 'per_kg') {
      const capNum = parseFloat(capacityKg);
      if (!Number.isFinite(capNum) || capNum <= 0) return Alert.alert('Validation', 'Capacity (kg) must be a positive number for per-kg quotes.');
    }
    if (parsedCcEmails.length > 10) return Alert.alert('Validation', 'At most 10 CC emails allowed.');

    // Build item based on kind — matches shared discriminated union.
    // 2026-07-29 — de-duplicate the capacity label. typeName often already
    // contains the capacity (e.g. "19 KG"), so appending "(19KG)" produced
    // "19 KG (19KG)" on the PDF. Only append the parenthetical when the
    // capacity isn't already in the name.
    const capLabel = `${selectedCylType.capacity}${selectedCylType.unit}`;
    const hasCapInName = selectedCylType.typeName.toLowerCase().includes(String(selectedCylType.capacity).toLowerCase());
    const displayName = hasCapInName
      ? selectedCylType.typeName
      : `${selectedCylType.typeName} (${capLabel})`;
    const items = [
      itemKind === 'per_cylinder'
        ? {
            kind: 'per_cylinder' as const,
            cylinderTypeId: selectedCylType.cylinderTypeId,
            itemName: displayName,
            hsnCode: selectedCylType.hsnCode || '27111900',
            priceInclGst: rateNum,
            discountInclGst: discountNum,
          }
        : {
            kind: 'per_kg' as const,
            cylinderTypeId: selectedCylType.cylinderTypeId,
            itemName: `${displayName} — per kg`,
            hsnCode: selectedCylType.hsnCode || '27111900',
            cylinderCapacityKg: parseFloat(capacityKg),
            pricePerKgInclGst: rateNum,
            discountPerKgInclGst: discountNum,
          },
    ];

    const payload: Record<string, unknown> = {
      quotationDate: localTodayISO(),
      validUntil,
      customerId: recipientMode === 'existing' ? customer?.customerId : null,
      recipientName: effectiveRecipient.name,
      recipientContactPerson: effectiveRecipient.contact,
      recipientAddress: effectiveRecipient.address,
      recipientCity: effectiveRecipient.city,
      recipientState: effectiveRecipient.state,
      recipientPincode: effectiveRecipient.pincode,
      recipientEmail: effectiveRecipient.email,
      ccEmails: parsedCcEmails.length > 0 ? parsedCcEmails : undefined,
      recipientPhone: effectiveRecipient.phone,
      recipientGstin: effectiveRecipient.gstin,
      subject: subject.trim(),
      coverText: MOBILE_DEFAULT_COVER,
      terms: MOBILE_DEFAULT_TERMS,
      creditTerms: MOBILE_DEFAULT_CREDIT_TERMS,
      gstRate,
      items,
    };
    createMut.mutate(payload);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      {/* 2026-07-29 — Android needs 'height' (not undefined) or the modal
          content stays fixed while the keyboard rises up and covers the
          Save button + line-item block. iOS 'padding' lifts the whole KAV
          smoothly. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }}
      >
        <View
          style={{
            backgroundColor: colors.bg,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            maxHeight: '92%',
            paddingBottom: Math.max(insets.bottom, 12),
          }}
        >
          {/* Header */}
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            padding: 14,
            borderBottomWidth: 1,
            borderBottomColor: colors.cardBorder,
          }}>
            <TouchableOpacity onPress={onClose} style={{ padding: 4 }}>
              <Ionicons name="close" size={22} color={colors.text} />
            </TouchableOpacity>
            <Text style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: colors.text }}>
              New Quotation
            </Text>
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={!canSubmit || createMut.isPending}
              style={{ padding: 4 }}
            >
              {createMut.isPending ? (
                <ActivityIndicator size="small" color={accent.red} />
              ) : (
                <Text style={{ fontSize: 15, fontWeight: '700', color: canSubmit ? accent.red : colors.textMuted }}>
                  Save
                </Text>
              )}
            </TouchableOpacity>
          </View>

          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 16, gap: 14 }}
          >
            {/* Recipient mode toggle (existing customer OR freeform) */}
            <View>
              <Text style={{ fontSize: 12, fontWeight: '600', color: colors.textMuted, marginBottom: 6, textTransform: 'uppercase' }}>
                Recipient *
              </Text>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
                {(['existing', 'freeform'] as const).map((mode) => {
                  const active = recipientMode === mode;
                  return (
                    <TouchableOpacity
                      key={mode}
                      onPress={() => setRecipientMode(mode)}
                      style={{
                        flex: 1,
                        paddingVertical: 8,
                        borderRadius: 10,
                        alignItems: 'center',
                        backgroundColor: active ? accent.red : colors.inputBg,
                        borderWidth: 1,
                        borderColor: active ? accent.red : colors.inputBorder,
                      }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: '600', color: active ? '#ffffff' : colors.text }}>
                        {mode === 'existing' ? 'Existing customer' : 'Enter new'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {recipientMode === 'existing' ? (
                <>
                  <TouchableOpacity
                    onPress={() => setShowCustomerPicker(true)}
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      backgroundColor: colors.inputBg,
                      borderColor: colors.inputBorder,
                      borderWidth: 1,
                      borderRadius: 10,
                      padding: 12,
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, color: customer ? colors.text : colors.textMuted }}>
                        {customer?.customerName || 'Select customer'}
                      </Text>
                      {customer?.email ? (
                        <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 2 }}>
                          {customer.email}
                        </Text>
                      ) : null}
                    </View>
                    <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
                  </TouchableOpacity>
                  {customer && !customer.email && !ffEmail && (
                    <Text style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>
                      This customer has no email on file — enter one below to send via email.
                    </Text>
                  )}
                </>
              ) : (
                <View style={{ gap: 8 }}>
                  <FieldInput label="Name" value={ffName} onChangeText={setFfName} placeholder="Business or person name" theme={colors} />
                  <FieldInput label="Contact person" value={ffContact} onChangeText={setFfContact} placeholder="Optional" theme={colors} />
                  <FieldInput label="Phone" value={ffPhone} onChangeText={setFfPhone} placeholder="Optional" keyboardType="phone-pad" theme={colors} />
                  <FieldInput label="GSTIN" value={ffGstin} onChangeText={setFfGstin} placeholder="Optional" theme={colors} autoCapitalize="characters" />
                  <FieldInput label="Address" value={ffAddress} onChangeText={setFfAddress} placeholder="Optional" theme={colors} />
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <FieldInput label="City" value={ffCity} onChangeText={setFfCity} placeholder="Optional" theme={colors} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <FieldInput label="State" value={ffState} onChangeText={setFfState} placeholder="Optional" theme={colors} />
                    </View>
                    <View style={{ width: 90 }}>
                      <FieldInput label="Pincode" value={ffPincode} onChangeText={setFfPincode} placeholder="—" keyboardType="number-pad" theme={colors} />
                    </View>
                  </View>
                </View>
              )}
            </View>

            {/* Email + CC — email is required for send-via-email; CC list
                is comma/semicolon/space separated, up to 10 per schema. */}
            <View>
              <FieldInput
                label={recipientMode === 'existing' ? 'Email (override)' : 'Email *'}
                value={ffEmail}
                onChangeText={setFfEmail}
                placeholder={recipientMode === 'existing' && customer?.email ? customer.email : 'customer@example.com'}
                keyboardType="email-address"
                theme={colors}
                autoCapitalize="none"
              />
            </View>
            <View>
              <FieldInput
                label="CC emails (comma separated)"
                value={ccEmailsRaw}
                onChangeText={setCcEmailsRaw}
                placeholder="ops@x.com, finance@x.com"
                keyboardType="email-address"
                theme={colors}
                autoCapitalize="none"
              />
              {parsedCcEmails.length > 0 && (
                <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>
                  {parsedCcEmails.length} CC recipient{parsedCcEmails.length > 1 ? 's' : ''}
                </Text>
              )}
            </View>

            {/* Subject */}
            <View>
              <Text style={{ fontSize: 12, fontWeight: '600', color: colors.textMuted, marginBottom: 4, textTransform: 'uppercase' }}>
                Subject *
              </Text>
              <TextInput
                value={subject}
                onChangeText={setSubject}
                placeholder="Rate quote"
                placeholderTextColor={colors.textMuted}
                style={{
                  backgroundColor: colors.inputBg,
                  borderColor: colors.inputBorder,
                  borderWidth: 1,
                  borderRadius: 10,
                  padding: 12,
                  fontSize: 14,
                  color: colors.text,
                }}
                maxLength={500}
              />
            </View>

            {/* Valid Until */}
            <View>
              <Text style={{ fontSize: 12, fontWeight: '600', color: colors.textMuted, marginBottom: 4, textTransform: 'uppercase' }}>
                Valid Until *
              </Text>
              <DateInput
                value={validUntil}
                onChange={(v) => setValidUntil(v || localTodayISO())}
                minDate={localTodayISO()}
              />
            </View>

            {/* GST rate */}
            <View>
              <Text style={{ fontSize: 12, fontWeight: '600', color: colors.textMuted, marginBottom: 4, textTransform: 'uppercase' }}>
                GST Rate *
              </Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {MOBILE_QUOTATION_GST_RATES.map((r) => {
                  const active = gstRate === r;
                  return (
                    <TouchableOpacity
                      key={r}
                      onPress={() => setGstRate(r)}
                      style={{
                        flex: 1,
                        paddingVertical: 10,
                        borderRadius: 10,
                        alignItems: 'center',
                        backgroundColor: active ? accent.red : colors.inputBg,
                        borderWidth: 1,
                        borderColor: active ? accent.red : colors.inputBorder,
                      }}
                    >
                      <Text style={{ fontSize: 14, fontWeight: '700', color: active ? '#ffffff' : colors.text }}>
                        {Math.round(r * 100)}%
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Line item */}
            <View style={{
              backgroundColor: colors.cardBg,
              borderColor: colors.cardBorder,
              borderWidth: 1,
              borderRadius: 12,
              padding: 12,
              gap: 10,
            }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>Line item</Text>

              {/* Mode picker: per_cylinder | per_kg */}
              <View>
                <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 6, textTransform: 'uppercase' }}>
                  Mode *
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {(['per_cylinder', 'per_kg'] as const).map((k) => {
                    const active = itemKind === k;
                    return (
                      <TouchableOpacity
                        key={k}
                        onPress={() => {
                          setItemKind(k);
                          // Auto-fill capacityKg when switching TO per_kg
                          // if a type is already picked and capacity is
                          // still blank. See the effect-removed comment above.
                          if (k === 'per_kg' && selectedCylType && !capacityKg) {
                            setCapacityKg(String(selectedCylType.capacity));
                          }
                        }}
                        style={{
                          flex: 1,
                          paddingVertical: 8,
                          borderRadius: 10,
                          alignItems: 'center',
                          backgroundColor: active ? accent.red : colors.inputBg,
                          borderWidth: 1,
                          borderColor: active ? accent.red : colors.inputBorder,
                        }}
                      >
                        <Text style={{ fontSize: 13, fontWeight: '600', color: active ? '#ffffff' : colors.text }}>
                          {k === 'per_cylinder' ? 'Per cylinder' : 'Per kg'}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* Cylinder type chip picker */}
              <View>
                <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 6, textTransform: 'uppercase' }}>
                  Cylinder Type *
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {cylinderTypes.map((c) => {
                    const active = cylinderTypeId === c.cylinderTypeId;
                    return (
                      <TouchableOpacity
                        key={c.cylinderTypeId}
                        onPress={() => {
                          setCylinderTypeId(c.cylinderTypeId);
                          if (itemKind === 'per_kg') setCapacityKg(String(c.capacity));
                        }}
                        style={{
                          paddingHorizontal: 10,
                          paddingVertical: 6,
                          borderRadius: 999,
                          backgroundColor: active ? accent.red : dark ? '#475569' : '#e2e8f0',
                        }}
                      >
                        <Text style={{ fontSize: 12, fontWeight: '600', color: active ? '#ffffff' : colors.text }}>
                          {c.typeName} ({c.capacity}{c.unit})
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                  {cylinderTypes.length === 0 && (
                    <Text style={{ fontSize: 12, color: colors.textMuted }}>Loading types…</Text>
                  )}
                </View>
              </View>

              {/* Per_kg gets a capacity field so the operator can override
                  (e.g. quoting a bulk rate for a 47.5kg cylinder as a 45kg
                  contract). Per_cylinder skips it — the type's own capacity
                  applies. */}
              {itemKind === 'per_kg' && (
                <View>
                  <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 4, textTransform: 'uppercase' }}>
                    Capacity (kg) *
                  </Text>
                  <TextInput
                    value={capacityKg}
                    onChangeText={(v) => setCapacityKg(v.replace(/[^0-9.]/g, ''))}
                    placeholder="e.g. 19"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="decimal-pad"
                    style={{
                      backgroundColor: colors.inputBg,
                      borderColor: colors.inputBorder,
                      borderWidth: 1,
                      borderRadius: 10,
                      padding: 10,
                      fontSize: 14,
                      color: colors.text,
                    }}
                  />
                </View>
              )}

              {/* Rate ₹ + Discount ₹ side by side. Label swaps for per_kg. */}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 4, textTransform: 'uppercase' }}>
                    {itemKind === 'per_cylinder' ? 'Rate ₹ (incl GST) *' : 'Rate ₹/kg (incl GST) *'}
                  </Text>
                  <TextInput
                    value={rate}
                    onChangeText={(v) => setRate(v.replace(/[^0-9.]/g, ''))}
                    placeholder={itemKind === 'per_cylinder' ? 'e.g. 2000' : 'e.g. 105'}
                    placeholderTextColor={colors.textMuted}
                    keyboardType="decimal-pad"
                    style={{
                      backgroundColor: colors.inputBg,
                      borderColor: colors.inputBorder,
                      borderWidth: 1,
                      borderRadius: 10,
                      padding: 10,
                      fontSize: 14,
                      color: colors.text,
                    }}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 4, textTransform: 'uppercase' }}>
                    {itemKind === 'per_cylinder' ? 'Discount ₹' : 'Discount ₹/kg'}
                  </Text>
                  <TextInput
                    value={discount}
                    onChangeText={(v) => setDiscount(v.replace(/[^0-9.]/g, ''))}
                    placeholder="0"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="decimal-pad"
                    style={{
                      backgroundColor: colors.inputBg,
                      borderColor: colors.inputBorder,
                      borderWidth: 1,
                      borderRadius: 10,
                      padding: 10,
                      fontSize: 14,
                      color: colors.text,
                    }}
                  />
                </View>
              </View>
            </View>

            <Text style={{ fontSize: 11, color: colors.textMuted, textAlign: 'center' }}>
              Cover text, terms and credit terms use the standard template. Edit on web for full customisation.
            </Text>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>

      {/* Nested customer picker modal — 2026-07-29 Android needs
          behavior='height' or the modal stays fixed and the keyboard
          covers the search input + results list. */}
      <Modal
        visible={showCustomerPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowCustomerPicker(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }}
        >
          <View style={{
            backgroundColor: colors.bg,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            padding: 14,
            paddingBottom: Math.max(insets.bottom + 8, 20),
            maxHeight: '80%',
          }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>Select Customer</Text>
              <TouchableOpacity onPress={() => setShowCustomerPicker(false)} style={{ padding: 4 }}>
                <Ionicons name="close" size={22} color={colors.text} />
              </TouchableOpacity>
            </View>
            <TextInput
              value={customerSearch}
              onChangeText={setCustomerSearch}
              placeholder="Search by name (min 3 chars)…"
              placeholderTextColor={colors.textMuted}
              autoFocus
              style={{
                backgroundColor: colors.inputBg,
                borderColor: colors.inputBorder,
                borderWidth: 1,
                borderRadius: 10,
                padding: 10,
                fontSize: 14,
                color: colors.text,
                marginBottom: 10,
              }}
            />
            {isSearching && <ActivityIndicator color={accent.red} />}
            <FlatList
              data={searchData?.customers ?? []}
              keyExtractor={(c) => c.customerId}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
              ListEmptyComponent={
                <Text style={{ fontSize: 12, color: colors.textMuted, textAlign: 'center', paddingVertical: 20 }}>
                  {debouncedSearch.length < 3 ? 'Start typing to search.' : 'No matches.'}
                </Text>
              }
              renderItem={({ item }) => (
                <TouchableOpacity
                  onPress={() => {
                    setCustomer(item);
                    setShowCustomerPicker(false);
                    setCustomerSearch('');
                    setDebouncedSearch('');
                  }}
                  style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.cardBorder }}
                >
                  <Text style={{ fontSize: 14, color: colors.text, fontWeight: '600' }}>{item.customerName}</Text>
                  <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                    {item.email || 'No email on file'}{item.phone ? ` · ${item.phone}` : ''}
                  </Text>
                </TouchableOpacity>
              )}
            />
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </Modal>
  );
}
