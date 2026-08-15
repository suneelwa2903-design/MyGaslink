/**
 * Shared Incoming Fulls / Outgoing Empties modal (2026-08-13, Suneel).
 *
 * ONE modal used by BOTH the Godown screen ((admin)/inventory.tsx) and the
 * Corp. Loads screen ((admin)/corp-loads.tsx) — mirroring how the web reuses
 * InventoryPage's IncomingFullsModal / OutgoingEmptiesModal on the
 * CorporationLedgerPage. Keeping it in one place is what prevents the two
 * surfaces from drifting.
 *
 * It is "smart": owns the form state, the two mutations, and validation, so a
 * caller only supplies the picker data + context. Both entries are single-line
 * (one cylinder type + one quantity per submit), matching web + the original
 * Godown modal exactly.
 *
 * Corp. Loads passes `sourceDistributorId` (the OMC) → added to the incoming
 * payload so the load lands on that corporation's ledger. Outgoing empties has
 * no source field (it's a depot→plant ERV keyed by date), so the id is ignored
 * there — same as web.
 *
 * Modal hygiene (anti-pattern #25): honours useSafeAreaInsets().bottom,
 * KeyboardAvoidingView, keyboardShouldPersistTaps="handled", onRequestClose.
 */
import { useState } from 'react';
import {
  View, Text, TextInput, Modal, ScrollView, TouchableOpacity,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert, StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useApiMutation, useApiQuery } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { useTheme, ACCENT } from '../../theme';
import { DateInput } from '../ui';

export interface VehicleMapping {
  driverId: string;
  driverName: string;
  vehicleId: string | null;
  vehicleNumber: string | null;
  status: 'confirmed' | 'recommended' | 'unassigned';
}

export interface StockMovementModalProps {
  visible: boolean;
  mode: 'incoming' | 'outgoing';
  onClose: () => void;
  onSaved?: () => void;
  cylinderOptions: { id: string; name: string }[];
  /** 2026-08-15 — independent pickers (all vehicles / all drivers), matching
   *  web. Replaces the old preset vehicle+driver combo chips so the user can
   *  pair ANY vehicle with ANY driver. `availableMappings` kept optional only
   *  for backward-compat with un-migrated callers. */
  vehicles?: { vehicleId: string; vehicleNumber: string }[];
  drivers?: { driverName: string }[];
  availableMappings?: VehicleMapping[];
  /** Default document date (Godown: selectedDate; Corp: today). */
  defaultDate: string;
  /** TanStack keys to invalidate on success. */
  invalidateKeys?: string[][];
  /** Corp context — OMC id added to the INCOMING payload; name shown in header. */
  sourceDistributorId?: string;
  sourceName?: string;
}

interface MovementForm {
  cylinderTypeId: string;
  quantity: string;
  documentType: string;
  documentNumber: string;
  documentDate: string;
  vehicleId: string;
  vehicleNumber: string;
  driverName: string;
  // Incoming (invoice-value entry): GST-EXCLUSIVE taxable line total + GST%.
  taxableValue: string;
  gstRate: string;
  // Outgoing: value of empties returned.
  amount: string;
  authorizationRef: string;
  notes: string;
}

interface ChargeRow { chargeType: 'freight' | 'handling' | 'testing' | 'insurance' | 'other'; amount: string; gstRate: string }

function emptyForm(date: string): MovementForm {
  return {
    cylinderTypeId: '', quantity: '', documentType: '', documentNumber: '',
    documentDate: date, vehicleId: '', vehicleNumber: '', driverName: '',
    taxableValue: '', gstRate: '', amount: '', authorizationRef: '', notes: '',
  };
}

const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function useStockTheme() {
  const { dark, colors } = useTheme();
  return {
    dark,
    card: colors.cardBg,
    cardBorder: colors.cardBorder,
    text: colors.text,
    textSecondary: colors.textSecondary,
    textMuted: colors.textMuted,
    green: ACCENT.green,
    orange: ACCENT.orange,
    red: '#ef4444',
    inputBg: colors.inputBg,
    metricBg: dark ? '#0f172a' : '#f1f5f9',
  };
}

export function StockMovementModal({
  visible, mode, onClose, onSaved, cylinderOptions,
  vehicles = [], drivers = [],
  defaultDate, invalidateKeys, sourceDistributorId, sourceName,
}: StockMovementModalProps) {
  const t = useStockTheme();
  const insets = useSafeAreaInsets();
  // Fresh form per open: callers remount via a `key` that changes each time
  // the modal opens (see the `key` on <StockMovementModal> at both call
  // sites), so the form self-resets on mount without a setState-in-effect.
  const [form, setForm] = useState<MovementForm>(() => emptyForm(defaultDate));
  const [charges, setCharges] = useState<ChargeRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const qc = useQueryClient();
  const isIncoming = mode === 'incoming';
  // Include-defective-fulls (F1, outgoing only) — pending defectives at depot +
  // the CN-issued rows ready to ship alongside this empties challan.
  const [includeDefectives, setIncludeDefectives] = useState(false);
  const { data: defectiveBucket } = useApiQuery<Array<{ cylinderTypeId: string; cylinderTypeName: string; qty: number }>>(
    ['defective-depot-bucket'], '/defective-returns/depot-bucket', undefined, { enabled: visible && mode === 'outgoing' },
  );
  const { data: readyDefectives } = useApiQuery<Array<{ id: string }>>(
    ['defective-returns-ready'], '/defective-returns', { status: 'cn_issued' }, { enabled: visible && mode === 'outgoing' },
  );
  const defectivePendingQty = (defectiveBucket ?? []).reduce((s, b) => s + b.qty, 0);
  const readyDefectiveIds = (readyDefectives ?? []).map((d) => d.id);
  const accent = isIncoming ? t.green : t.orange;
  // 2026-08-15 — label parity with web: incoming supplies use "Supply *",
  // outgoing empties challans use "Challan *".
  const docLabel = isIncoming ? 'Supply' : 'Challan';

  // Live per-cylinder cost readout (invoice-value entry). Base is GST-EXCLUSIVE;
  // GST is reclaimable ITC; landed = incl GST + expenses. See web parity.
  const qtyNum = Math.max(0, parseInt(form.quantity, 10) || 0);
  const taxNum = Math.max(0, Number(form.taxableValue) || 0);
  const gstNum = Math.max(0, Number(form.gstRate) || 0);
  const cylGst = (taxNum * gstNum) / 100;
  const chargeBase = charges.reduce((s, c) => s + Math.max(0, Number(c.amount) || 0), 0);
  const chargeGst = charges.reduce((s, c) => s + Math.max(0, Number(c.amount) || 0) * (Math.max(0, Number(c.gstRate) || 0) / 100), 0);
  const landedTotal = taxNum + cylGst + chargeBase + chargeGst;
  const perBase = qtyNum ? taxNum / qtyNum : 0;
  const perExpense = qtyNum ? chargeBase / qtyNum : 0;
  const perGst = qtyNum ? (cylGst + chargeGst) / qtyNum : 0;
  const perLanded = qtyNum ? landedTotal / qtyNum : 0;

  const onDone = () => { onSaved?.(); onClose(); };
  const incoming = useApiMutation<unknown, Record<string, unknown>>('post', '/inventory/incoming-fulls', {
    invalidateKeys, successMessage: 'Incoming fulls recorded', onSuccess: onDone,
  });
  // Outgoing is a manual chain (empties, then optionally the defective batch),
  // so it uses the raw api client + a local `submitting` flag rather than a
  // useApiMutation — mirrors the web OutgoingEmptiesModal.onSubmit.
  const isPending = incoming.isPending || submitting;

  const submit = () => {
    const qty = parseInt(form.quantity, 10);
    if (!form.cylinderTypeId) { Alert.alert('Required', 'Please select a cylinder type.'); return; }
    if (isNaN(qty) || qty <= 0) { Alert.alert('Required', 'Quantity must be a whole number greater than 0.'); return; }
    if (!form.documentType.trim()) { Alert.alert('Required', `${docLabel} Type is required.`); return; }
    if (!form.documentNumber.trim()) { Alert.alert('Required', `${isIncoming ? 'Supply Reference No.' : 'Challan No.'} is required.`); return; }
    const base: Record<string, unknown> = {
      cylinderTypeId: form.cylinderTypeId,
      quantity: qty,
      documentType: form.documentType.trim(),
      documentNumber: form.documentNumber.trim(),
      documentDate: form.documentDate,
      ...(form.vehicleId ? { vehicleId: form.vehicleId } : {}),
      ...(form.vehicleNumber.trim() ? { vehicleNumber: form.vehicleNumber.trim() } : {}),
      ...(form.driverName.trim() ? { driverName: form.driverName.trim() } : {}),
      ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    };

    if (isIncoming) {
      // Invoice-value entry: GST-EXCLUSIVE taxable + GST% + charges (each with
      // its own GST%). Service derives the GST-inclusive per-cyl cost.
      const tax = form.taxableValue.trim() ? Number(form.taxableValue) : undefined;
      if (tax !== undefined && (Number.isNaN(tax) || tax < 0)) { Alert.alert('Required', 'Taxable Value must be 0 or greater.'); return; }
      const gst = form.gstRate.trim() ? Number(form.gstRate) : undefined;
      const chargePayload = charges
        .filter((c) => (Number(c.amount) || 0) > 0)
        .map((c) => ({ chargeType: c.chargeType, amount: Number(c.amount), gstRate: Number(c.gstRate) || 0 }));
      incoming.mutate({
        ...base,
        ...(tax !== undefined ? { taxableValue: tax } : {}),
        ...(gst !== undefined ? { gstRate: gst } : {}),
        ...(chargePayload.length > 0 ? { charges: chargePayload } : {}),
        ...(sourceDistributorId ? { sourceDistributorId } : {}),
      });
    } else {
      const amt = form.amount.trim() ? Number(form.amount) : undefined;
      if (amt !== undefined && (Number.isNaN(amt) || amt < 0)) { Alert.alert('Required', 'Amount must be 0 or greater.'); return; }
      const outPayload = {
        ...base,
        ...(amt !== undefined ? { amount: amt } : {}),
        ...(form.authorizationRef.trim() ? { authorizationRef: form.authorizationRef.trim() } : {}),
      };
      void (async () => {
        setSubmitting(true);
        try {
          await api.post('/inventory/outgoing-empties', outPayload);
          for (const k of invalidateKeys ?? []) qc.invalidateQueries({ queryKey: k });
        } catch (e) {
          setSubmitting(false);
          const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
          Alert.alert('Error', msg || 'Failed to record outgoing empties.');
          return;
        }
        // Empties saved. Optionally ship the pending defective fulls on this
        // same challan (F1) — a failure here is a WARNING, empties still landed.
        if (includeDefectives && readyDefectiveIds.length > 0) {
          try {
            await api.post('/defective-returns/batches', {
              corporationName: (form.documentType.trim() || 'IOCL').slice(0, 60),
              challanNumber: form.documentNumber.trim() || undefined,
              challanDate: form.documentDate || undefined,
              defectiveIds: readyDefectiveIds,
              notes: `Piggybacked on outgoing empties challan ${form.documentNumber.trim()}`.trim(),
            });
            qc.invalidateQueries({ queryKey: ['defective-depot-bucket'] });
            qc.invalidateQueries({ queryKey: ['defective-returns-ready'] });
            qc.invalidateQueries({ queryKey: ['defective-returns-pending-count'] });
          } catch {
            Alert.alert('Partial', 'Empties recorded, but the defective batch failed. Defectives still at depot — retry from Outgoing Empties.');
          }
        }
        setSubmitting(false);
        onDone();
      })();
    }
  };

  const title = `${isIncoming ? '+ Incoming Fulls' : '+ Outgoing Empties'}${sourceName ? ` — ${sourceName}` : ''}`;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1, justifyContent: 'flex-end' }}
      >
        <View style={{
          backgroundColor: t.card, borderTopLeftRadius: 20, borderTopRightRadius: 20,
          padding: 20, paddingBottom: Math.max(insets.bottom + 8, 20), maxHeight: '90%',
        }}>
          {/* Header */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
              <Ionicons name={isIncoming ? 'arrow-down-circle-outline' : 'arrow-up-circle-outline'} size={22} color={accent} />
              <Text style={{ fontSize: 17, fontWeight: '800', color: t.text, flex: 1 }} numberOfLines={1}>{title}</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={{ padding: 4 }}>
              <Ionicons name="close" size={22} color={t.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {/* Cylinder Type */}
            <Text style={[styles.label, { color: t.textSecondary }]}>Cylinder Type <Text style={{ color: t.red }}>*</Text></Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
              {cylinderOptions.map((opt) => {
                const selected = form.cylinderTypeId === opt.id;
                return (
                  <TouchableOpacity
                    key={opt.id}
                    onPress={() => setForm((f) => ({ ...f, cylinderTypeId: opt.id }))}
                    style={{
                      paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
                      backgroundColor: selected ? accent : t.metricBg,
                      borderWidth: 1, borderColor: selected ? accent : t.cardBorder,
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: '600', color: selected ? '#fff' : t.text }}>{opt.name}</Text>
                  </TouchableOpacity>
                );
              })}
              {cylinderOptions.length === 0 && (
                <Text style={{ fontSize: 13, color: t.textMuted, paddingVertical: 8 }}>No cylinder types</Text>
              )}
            </ScrollView>

            {/* Quantity */}
            <Text style={[styles.label, { color: t.textSecondary }]}>Quantity <Text style={{ color: t.red }}>*</Text></Text>
            <TextInput
              style={[styles.input, { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder }]}
              placeholder="e.g. 50" placeholderTextColor={t.textMuted} keyboardType="number-pad"
              value={form.quantity} onChangeText={(v) => setForm((f) => ({ ...f, quantity: v }))}
            />

            {/* Supply / Challan Date */}
            <Text style={[styles.label, { color: t.textSecondary }]}>{docLabel} Date</Text>
            <View style={{ marginBottom: 12 }}>
              <DateInput value={form.documentDate || null} onChange={(v) => setForm((f) => ({ ...f, documentDate: v }))} placeholder="Select date" />
            </View>

            {/* Supply / Challan Type */}
            <Text style={[styles.label, { color: t.textSecondary }]}>{docLabel} Type <Text style={{ color: t.red }}>*</Text></Text>
            <TextInput
              style={[styles.input, { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder }]}
              placeholder={isIncoming ? 'e.g. Invoice, DC' : 'e.g. Return Challan'} placeholderTextColor={t.textMuted}
              value={form.documentType} onChangeText={(v) => setForm((f) => ({ ...f, documentType: v }))}
            />

            {/* Supply Reference No. / Challan No. */}
            <Text style={[styles.label, { color: t.textSecondary }]}>{isIncoming ? 'Supply Reference No.' : 'Challan No.'} <Text style={{ color: t.red }}>*</Text></Text>
            <TextInput
              style={[styles.input, { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder }]}
              placeholder="e.g. INV-2026-001" placeholderTextColor={t.textMuted}
              value={form.documentNumber} onChangeText={(v) => setForm((f) => ({ ...f, documentNumber: v }))}
            />

            {/* Vehicle (independent picker — any vehicle) */}
            <Text style={[styles.label, { color: t.textSecondary }]}>Vehicle <Text style={{ fontSize: 11, color: t.textMuted }}>(optional)</Text></Text>
            {vehicles.length === 0 ? (
              <View style={{ padding: 12, borderRadius: 10, borderWidth: 1, borderColor: t.cardBorder, backgroundColor: t.inputBg, marginBottom: 12 }}>
                <Text style={{ fontSize: 13, color: t.textMuted }}>No vehicles in Transport yet, or leave blank.</Text>
              </View>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
                {vehicles.map((v) => {
                  const selected = form.vehicleId === v.vehicleId;
                  return (
                    <TouchableOpacity
                      key={v.vehicleId}
                      onPress={() => setForm((f) => selected
                        ? { ...f, vehicleId: '', vehicleNumber: '' }
                        : { ...f, vehicleId: v.vehicleId, vehicleNumber: v.vehicleNumber })}
                      style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: selected ? accent : t.metricBg, borderWidth: 1, borderColor: selected ? accent : t.cardBorder }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: '700', color: selected ? '#fff' : t.text }}>{v.vehicleNumber}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            {/* Driver (independent picker — any driver) */}
            <Text style={[styles.label, { color: t.textSecondary }]}>Driver <Text style={{ fontSize: 11, color: t.textMuted }}>(optional)</Text></Text>
            {drivers.length === 0 ? (
              <View style={{ padding: 12, borderRadius: 10, borderWidth: 1, borderColor: t.cardBorder, backgroundColor: t.inputBg, marginBottom: 14 }}>
                <Text style={{ fontSize: 13, color: t.textMuted }}>No drivers in Transport yet, or leave blank.</Text>
              </View>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
                {drivers.map((d) => {
                  const selected = form.driverName === d.driverName;
                  return (
                    <TouchableOpacity
                      key={d.driverName}
                      onPress={() => setForm((f) => ({ ...f, driverName: selected ? '' : d.driverName }))}
                      style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: selected ? accent : t.metricBg, borderWidth: 1, borderColor: selected ? accent : t.cardBorder }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: '700', color: selected ? '#fff' : t.text }}>{d.driverName}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            {isIncoming ? (
              <>
                {/* Taxable Value (GST-EXCLUSIVE line total off the invoice) */}
                <Text style={[styles.label, { color: t.textSecondary }]}>Taxable Value (₹, excl GST) <Text style={{ fontSize: 11, color: t.textMuted }}>(optional)</Text></Text>
                <TextInput
                  style={[styles.input, { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder }]}
                  placeholder="Line total before GST — from invoice" placeholderTextColor={t.textMuted} keyboardType="decimal-pad"
                  value={form.taxableValue} onChangeText={(v) => setForm((f) => ({ ...f, taxableValue: v.replace(/[^0-9.]/g, '') }))}
                />

                {/* GST % — 5 / 18 / custom */}
                <Text style={[styles.label, { color: t.textSecondary }]}>GST %</Text>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 4, alignItems: 'center' }}>
                  {[5, 18].map((r) => {
                    const selected = Number(form.gstRate) === r;
                    return (
                      <TouchableOpacity key={r} onPress={() => setForm((f) => ({ ...f, gstRate: String(r) }))}
                        style={{ paddingHorizontal: 16, paddingVertical: 9, borderRadius: 10, backgroundColor: selected ? accent : t.metricBg, borderWidth: 1, borderColor: selected ? accent : t.cardBorder }}>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: selected ? '#fff' : t.text }}>{r}%</Text>
                      </TouchableOpacity>
                    );
                  })}
                  <TextInput
                    style={[styles.input, { flex: 1, marginBottom: 0, backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder }]}
                    placeholder="Custom %" placeholderTextColor={t.textMuted} keyboardType="decimal-pad"
                    value={form.gstRate} onChangeText={(v) => setForm((f) => ({ ...f, gstRate: v.replace(/[^0-9.]/g, '') }))}
                  />
                </View>
                <Text style={{ fontSize: 11, color: t.textMuted, marginBottom: 12 }}>5% domestic · 18% commercial — pick per invoice.</Text>

                {/* Charges (each with its own GST%) */}
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <Text style={[styles.label, { color: t.textSecondary, marginBottom: 0 }]}>Charges (freight, etc.)</Text>
                  <TouchableOpacity onPress={() => setCharges((cs) => [...cs, { chargeType: 'freight', amount: '', gstRate: form.gstRate }])}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: accent }}>+ Add</Text>
                  </TouchableOpacity>
                </View>
                {charges.map((c, i) => (
                  <View key={i} style={{ flexDirection: 'row', gap: 6, marginBottom: 8, alignItems: 'center' }}>
                    <TextInput
                      style={[styles.input, { flex: 1.4, marginBottom: 0, backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder }]}
                      placeholder="freight" placeholderTextColor={t.textMuted}
                      value={c.chargeType} onChangeText={(v) => setCharges((cs) => cs.map((x, j) => j === i ? { ...x, chargeType: (['freight','handling','testing','insurance','other'].includes(v) ? v : 'other') as ChargeRow['chargeType'] } : x))}
                    />
                    <TextInput
                      style={[styles.input, { flex: 1.2, marginBottom: 0, backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder }]}
                      placeholder="₹ excl GST" placeholderTextColor={t.textMuted} keyboardType="decimal-pad"
                      value={c.amount} onChangeText={(v) => setCharges((cs) => cs.map((x, j) => j === i ? { ...x, amount: v.replace(/[^0-9.]/g, '') } : x))}
                    />
                    <TextInput
                      style={[styles.input, { width: 56, marginBottom: 0, backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder }]}
                      placeholder="GST%" placeholderTextColor={t.textMuted} keyboardType="decimal-pad"
                      value={c.gstRate} onChangeText={(v) => setCharges((cs) => cs.map((x, j) => j === i ? { ...x, gstRate: v.replace(/[^0-9.]/g, '') } : x))}
                    />
                    <TouchableOpacity onPress={() => setCharges((cs) => cs.filter((_, j) => j !== i))} style={{ padding: 6 }}>
                      <Ionicons name="close-circle" size={20} color={t.textMuted} />
                    </TouchableOpacity>
                  </View>
                ))}

                {/* Live per-cylinder readout */}
                {qtyNum > 0 && taxNum > 0 && (
                  <View style={{ borderRadius: 10, borderWidth: 1, borderColor: t.cardBorder, backgroundColor: t.metricBg, padding: 12, marginTop: 4, marginBottom: 10, gap: 4 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={{ fontSize: 12, color: t.textSecondary }}>Base / cyl (excl GST)</Text><Text style={{ fontSize: 12, fontWeight: '700', color: t.text }}>{inr(perBase)}</Text></View>
                    {perExpense > 0 && <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={{ fontSize: 12, color: t.textSecondary }}>+ Expense / cyl</Text><Text style={{ fontSize: 12, fontWeight: '700', color: t.text }}>{inr(perExpense)}</Text></View>}
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={{ fontSize: 12, color: t.textSecondary }}>GST / cyl (ITC)</Text><Text style={{ fontSize: 12, fontWeight: '700', color: t.textMuted }}>{inr(perGst)}</Text></View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: t.cardBorder, paddingTop: 4 }}><Text style={{ fontSize: 12, fontWeight: '700', color: t.text }}>Landed / cyl (incl GST + exp)</Text><Text style={{ fontSize: 13, fontWeight: '800', color: t.text }}>{inr(perLanded)}</Text></View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={{ fontSize: 12, color: t.textSecondary }}>Payable to supplier</Text><Text style={{ fontSize: 12, fontWeight: '700', color: t.text }}>{inr(landedTotal)}</Text></View>
                  </View>
                )}
                <Text style={{ fontSize: 11, color: t.textMuted, marginBottom: 12 }}>Cost &amp; margin use the excl-GST base; GST is reclaimable ITC; payables use the incl-GST total.</Text>
              </>
            ) : (
              <>
                {/* Amount (value of empties returned) */}
                <Text style={[styles.label, { color: t.textSecondary }]}>Amount <Text style={{ fontSize: 11, color: t.textMuted }}>(optional)</Text></Text>
                <TextInput
                  style={[styles.input, { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder }]}
                  placeholder="e.g. 12000" placeholderTextColor={t.textMuted} keyboardType="decimal-pad"
                  value={form.amount} onChangeText={(v) => setForm((f) => ({ ...f, amount: v.replace(/[^0-9.]/g, '') }))}
                />
              </>
            )}

            {/* Outgoing-only: Authorization Ref + include-defective-fulls */}
            {!isIncoming && (
              <>
                <Text style={[styles.label, { color: t.textSecondary }]}>Authorization Ref <Text style={{ fontSize: 11, color: t.textMuted }}>(optional)</Text></Text>
                <TextInput
                  style={[styles.input, { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder }]}
                  placeholder="e.g. AUTH-2026-001" placeholderTextColor={t.textMuted}
                  value={form.authorizationRef} onChangeText={(v) => setForm((f) => ({ ...f, authorizationRef: v }))}
                />
                {/* Include defective fulls — ship pending CN-issued defectives on
                    this same challan (F1). Only shown when the depot has some. */}
                {defectivePendingQty > 0 && readyDefectiveIds.length > 0 && (
                  <TouchableOpacity
                    onPress={() => setIncludeDefectives((v) => !v)}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, marginBottom: 14, borderRadius: 10, borderWidth: 1, borderColor: includeDefectives ? t.orange : t.cardBorder, backgroundColor: includeDefectives ? (t.dark ? '#2a1d10' : '#fff7ed') : t.inputBg }}
                  >
                    <Ionicons name={includeDefectives ? 'checkbox' : 'square-outline'} size={22} color={includeDefectives ? t.orange : t.textMuted} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: t.text }}>Also send defective fulls</Text>
                      <Text style={{ fontSize: 11, color: t.textSecondary, marginTop: 1 }}>{defectivePendingQty} pending at depot — ship on this challan</Text>
                    </View>
                  </TouchableOpacity>
                )}
              </>
            )}

            {/* Notes */}
            <Text style={[styles.label, { color: t.textSecondary }]}>Notes <Text style={{ fontSize: 11, color: t.textMuted }}>(optional)</Text></Text>
            <TextInput
              style={[styles.input, styles.textarea, { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder }]}
              placeholder="Additional notes..." placeholderTextColor={t.textMuted} multiline numberOfLines={3}
              value={form.notes} onChangeText={(v) => setForm((f) => ({ ...f, notes: v }))}
            />

            {/* Submit */}
            <TouchableOpacity
              onPress={submit} disabled={isPending}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: accent, borderRadius: 12, paddingVertical: 14, marginTop: 8, marginBottom: 8, opacity: isPending ? 0.6 : 1 }}
            >
              {isPending ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name={isIncoming ? 'arrow-down-circle-outline' : 'arrow-up-circle-outline'} size={18} color="#fff" />}
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>
                {isPending ? 'Saving...' : isIncoming ? 'Record Incoming Fulls' : 'Record Outgoing Empties'}
              </Text>
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
