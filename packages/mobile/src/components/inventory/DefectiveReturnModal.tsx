/**
 * Defective Return modal (2026-08-13, Suneel) — mobile parity with the web
 * DefectiveReturnsPage / InventoryPage DefectiveReturnModal.
 *
 * Flow (one-shot "Record Defective Return & Raise CN"):
 *   1. Search + pick a customer.
 *   2. Load their eligible source invoices (last 90 days) via
 *      GET /defective-returns/eligible-invoices?customerId=… and pick ONE.
 *   3. Enter per-line defective qty (0..remainingQty). Live CN preview =
 *      Σ(qty × perCylRate).
 *   4. Submit → POST /defective-returns (capture) → immediately
 *      POST /defective-returns/{defectiveIds[0]}/raise-cn (auto credit-note).
 *
 * Modal hygiene: safe-area insets, KeyboardAvoidingView,
 * keyboardShouldPersistTaps, onRequestClose (anti-pattern #25).
 */
import { useMemo, useState } from 'react';
import {
  View, Text, TextInput, Modal, ScrollView, TouchableOpacity,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert, StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../hooks/useApi';
import { apiPost, getErrorMessage } from '../../lib/api';
import { useTheme, ACCENT } from '../../theme';
import { DateInput, SelectField, SearchInput, todayLocalIso, type SelectOption } from '../ui';

interface CustomerLite {
  customerId: string;
  customerName?: string;
  businessName?: string;
  phone?: string;
}
interface EligibleLine {
  invoiceItemId: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  perCylRate: number | string;
  qty: number;
  alreadyClaimedQty?: number;
  remainingQty: number;
}
interface EligibleInvoice {
  invoiceId: string;
  invoiceNumber: string;
  issueDate: string;
  totalAmount: number | string;
  paymentStatus: string;
  lines: EligibleLine[];
}

const REASON_OPTS: SelectOption[] = [
  { value: '', label: 'No reason' },
  { value: 'Leaky valve', label: 'Leaky valve' },
  { value: 'Bad seal', label: 'Bad seal' },
  { value: 'Low weight', label: 'Low weight' },
  { value: 'Damaged body', label: 'Damaged body' },
  { value: 'Other', label: 'Other' },
];

const toNum = (v: number | string | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

function useColors() {
  const { dark, colors } = useTheme();
  return {
    dark,
    card: colors.cardBg, cardBorder: colors.cardBorder, text: colors.text,
    textSecondary: colors.textSecondary, textMuted: colors.textMuted,
    inputBg: colors.inputBg, accent: ACCENT.red, red: '#ef4444',
    metricBg: dark ? '#0f172a' : '#f1f5f9',
  };
}

export function DefectiveReturnModal({ visible, onClose, onSaved }: {
  visible: boolean; onClose: () => void; onSaved?: () => void;
}) {
  const t = useColors();
  const insets = useSafeAreaInsets();

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [customer, setCustomer] = useState<CustomerLite | null>(null);
  const [invoiceId, setInvoiceId] = useState('');
  const [qtyByItem, setQtyByItem] = useState<Record<string, string>>({});
  const [collectedDate, setCollectedDate] = useState(todayLocalIso());
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { data: custResp } = useApiQuery<{ customers: CustomerLite[] }>(
    ['defective-customer-search', debounced], '/customers',
    { search: debounced, status: 'active', pageSize: 10 },
    { enabled: visible && debounced.trim().length >= 3 && !customer },
  );
  const customers = custResp?.customers ?? [];

  const { data: invoices, isLoading: invLoading } = useApiQuery<EligibleInvoice[]>(
    ['defective-eligible', customer?.customerId ?? ''],
    `/defective-returns/eligible-invoices`,
    { customerId: customer?.customerId },
    { enabled: visible && Boolean(customer?.customerId) },
  );

  const selectedInvoice = (invoices ?? []).find((i) => i.invoiceId === invoiceId) ?? null;

  const cnPreview = useMemo(() => {
    if (!selectedInvoice) return 0;
    return selectedInvoice.lines.reduce((s, l) => s + toNum(qtyByItem[l.invoiceItemId]) * toNum(l.perCylRate), 0);
  }, [selectedInvoice, qtyByItem]);

  const nameOf = (c: CustomerLite) => c.businessName || c.customerName || 'Customer';

  const resetAll = () => {
    setSearch(''); setDebounced(''); setCustomer(null); setInvoiceId('');
    setQtyByItem({}); setReason(''); setNotes(''); setCollectedDate(todayLocalIso());
  };
  const close = () => { resetAll(); onClose(); };

  const submit = async () => {
    if (!customer) { Alert.alert('Required', 'Pick a customer first.'); return; }
    if (!selectedInvoice) { Alert.alert('Required', 'Select a source invoice.'); return; }
    const items = selectedInvoice.lines
      .map((l) => ({ line: l, qty: Math.trunc(toNum(qtyByItem[l.invoiceItemId])) }))
      .filter((x) => x.qty > 0);
    if (items.length === 0) { Alert.alert('Required', 'Enter a defective quantity on at least one line.'); return; }
    for (const x of items) {
      if (x.qty > x.line.remainingQty) {
        Alert.alert('Too many', `${x.line.cylinderTypeName}: max ${x.line.remainingQty} claimable.`);
        return;
      }
    }
    setSubmitting(true);
    try {
      const capture = await apiPost<{ defectiveIds: string[]; cnAmountPreview: number }>('/defective-returns', {
        customerId: customer.customerId,
        sourceInvoiceId: selectedInvoice.invoiceId,
        collectedDate,
        items: items.map((x) => ({ cylinderTypeId: x.line.cylinderTypeId, quantity: x.qty })),
        ...(reason ? { reason } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      const ids = capture?.defectiveIds ?? [];
      let cnRaised = false;
      if (ids.length > 0) {
        try {
          await apiPost(`/defective-returns/${ids[0]}/raise-cn`, { defectiveIds: ids, reason: 'Defective cylinder return' });
          cnRaised = true;
        } catch {
          // Capture succeeded; CN can be raised later from web History.
        }
      }
      Alert.alert('Recorded', cnRaised ? 'Defective return captured + credit note raised.' : 'Defective return captured. Raise the CN later if needed.');
      onSaved?.();
      close();
    } catch (e) {
      Alert.alert('Error', getErrorMessage(e as Error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1, justifyContent: 'flex-end' }}>
        <View style={{ backgroundColor: t.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: Math.max(insets.bottom + 8, 20), maxHeight: '92%' }}>
          {/* Header */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
              <Ionicons name="alert-circle-outline" size={22} color={t.accent} />
              <Text style={{ fontSize: 17, fontWeight: '800', color: t.text }}>Defective Return</Text>
            </View>
            <TouchableOpacity onPress={close} style={{ padding: 4 }}>
              <Ionicons name="close" size={22} color={t.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {/* Step 1 — Customer */}
            <Text style={[styles.label, { color: t.textSecondary }]}>Customer <Text style={{ color: t.red }}>*</Text></Text>
            {customer ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: t.cardBorder, borderRadius: 10, padding: 12, marginBottom: 14, backgroundColor: t.inputBg }}>
                <Text style={{ fontSize: 15, fontWeight: '600', color: t.text }} numberOfLines={1}>{nameOf(customer)}</Text>
                <TouchableOpacity onPress={() => { setCustomer(null); setInvoiceId(''); setQtyByItem({}); }}>
                  <Text style={{ color: t.accent, fontWeight: '600', fontSize: 13 }}>Change</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={{ marginBottom: 14 }}>
                <SearchInput value={search} onChangeText={setSearch} onDebouncedChange={setDebounced} placeholder="Search customer (min 3 chars)…" />
                {debounced.trim().length >= 3 && customers.map((c) => (
                  <TouchableOpacity
                    key={c.customerId}
                    onPress={() => { setCustomer(c); setSearch(''); setDebounced(''); }}
                    style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.cardBorder }}
                  >
                    <Text style={{ fontSize: 14, color: t.text }}>{nameOf(c)}</Text>
                    {c.phone ? <Text style={{ fontSize: 12, color: t.textMuted }}>{c.phone}</Text> : null}
                  </TouchableOpacity>
                ))}
                {debounced.trim().length >= 3 && customers.length === 0 && (
                  <Text style={{ fontSize: 13, color: t.textMuted, paddingVertical: 10 }}>No active customers match.</Text>
                )}
              </View>
            )}

            {/* Step 2 — Eligible invoice + per-line qty */}
            {customer && (
              <>
                <Text style={[styles.label, { color: t.textSecondary }]}>Source Invoice <Text style={{ color: t.red }}>*</Text> <Text style={{ fontSize: 11, color: t.textMuted }}>(last 90 days)</Text></Text>
                {invLoading ? (
                  <Text style={{ color: t.textMuted, paddingVertical: 10 }}>Loading invoices…</Text>
                ) : (invoices ?? []).length === 0 ? (
                  <Text style={{ fontSize: 13, color: t.dark ? '#fcd34d' : '#92400e', backgroundColor: t.dark ? 'rgba(180,83,9,0.15)' : '#fffbeb', padding: 10, borderRadius: 8, marginBottom: 12 }}>
                    No eligible invoices in the last 90 days for this customer.
                  </Text>
                ) : (invoices ?? []).map((inv) => {
                  const sel = inv.invoiceId === invoiceId;
                  return (
                    <View key={inv.invoiceId} style={{ borderWidth: 1, borderColor: sel ? t.accent : t.cardBorder, borderRadius: 10, marginBottom: 10, overflow: 'hidden' }}>
                      <TouchableOpacity
                        onPress={() => { setInvoiceId(sel ? '' : inv.invoiceId); setQtyByItem({}); }}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, backgroundColor: sel ? (t.dark ? 'rgba(220,38,38,0.12)' : '#fef2f2') : t.inputBg }}
                      >
                        <Ionicons name={sel ? 'radio-button-on' : 'radio-button-off'} size={20} color={sel ? t.accent : t.textMuted} />
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 14, fontWeight: '600', color: t.text }}>{inv.invoiceNumber}</Text>
                          <Text style={{ fontSize: 12, color: t.textMuted }}>{inv.issueDate} · ₹{toNum(inv.totalAmount).toFixed(2)} · {inv.paymentStatus}</Text>
                        </View>
                      </TouchableOpacity>
                      {sel && inv.lines.map((l) => (
                        <View key={l.invoiceItemId} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: t.cardBorder }}>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 13, color: t.text }}>{l.cylinderTypeName}</Text>
                            <Text style={{ fontSize: 11, color: t.textMuted }}>₹{toNum(l.perCylRate).toFixed(2)}/cyl · up to {l.remainingQty}</Text>
                          </View>
                          <TextInput
                            value={qtyByItem[l.invoiceItemId] ?? ''}
                            onChangeText={(v) => setQtyByItem((m) => ({ ...m, [l.invoiceItemId]: v.replace(/[^0-9]/g, '') }))}
                            editable={l.remainingQty > 0}
                            keyboardType="number-pad"
                            placeholder="0"
                            placeholderTextColor={t.textMuted}
                            style={{ width: 64, borderWidth: 1, borderColor: t.cardBorder, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, textAlign: 'right', color: t.text, backgroundColor: t.card, opacity: l.remainingQty > 0 ? 1 : 0.5 }}
                          />
                        </View>
                      ))}
                    </View>
                  );
                })}

                {/* Collected date / reason / notes / preview */}
                {selectedInvoice && (
                  <>
                    <Text style={[styles.label, { color: t.textSecondary }]}>Collected Date <Text style={{ color: t.red }}>*</Text></Text>
                    <View style={{ marginBottom: 12 }}>
                      <DateInput value={collectedDate} onChange={setCollectedDate} />
                    </View>
                    <SelectField label="Reason (optional)" value={reason} onChange={setReason} options={REASON_OPTS} />
                    <View style={{ height: 12 }} />
                    <Text style={[styles.label, { color: t.textSecondary }]}>Notes (optional)</Text>
                    <TextInput
                      style={[styles.input, styles.textarea, { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder }]}
                      placeholder="Additional notes..." placeholderTextColor={t.textMuted} multiline numberOfLines={3}
                      value={notes} onChangeText={setNotes}
                    />
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: t.metricBg, padding: 12, borderRadius: 8, marginBottom: 8 }}>
                      <Text style={{ fontSize: 13, color: t.textMuted }}>Credit note (preview)</Text>
                      <Text style={{ fontSize: 16, fontWeight: '700', color: t.text }}>₹{cnPreview.toFixed(2)}</Text>
                    </View>
                  </>
                )}
              </>
            )}

            {/* Submit */}
            <TouchableOpacity
              onPress={submit} disabled={submitting || !selectedInvoice}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: t.accent, borderRadius: 12, paddingVertical: 14, marginTop: 8, marginBottom: 8, opacity: (submitting || !selectedInvoice) ? 0.6 : 1 }}
            >
              {submitting ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="alert-circle-outline" size={18} color="#fff" />}
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>{submitting ? 'Saving...' : 'Record Defective Return & Raise CN'}</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 12, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, marginBottom: 14 },
  textarea: { minHeight: 72, textAlignVertical: 'top' },
});
