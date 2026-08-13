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
import { useApiMutation } from '../../hooks/useApi';
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
  availableMappings: VehicleMapping[];
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
  amount: string;
  authorizationRef: string;
  condition: 'good' | 'defective' | '';
  notes: string;
}

function emptyForm(date: string): MovementForm {
  return {
    cylinderTypeId: '', quantity: '', documentType: '', documentNumber: '',
    documentDate: date, vehicleId: '', vehicleNumber: '', driverName: '',
    amount: '', authorizationRef: '', condition: '', notes: '',
  };
}

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
  visible, mode, onClose, onSaved, cylinderOptions, availableMappings,
  defaultDate, invalidateKeys, sourceDistributorId, sourceName,
}: StockMovementModalProps) {
  const t = useStockTheme();
  const insets = useSafeAreaInsets();
  // Fresh form per open: callers remount via a `key` that changes each time
  // the modal opens (see the `key` on <StockMovementModal> at both call
  // sites), so the form self-resets on mount without a setState-in-effect.
  const [form, setForm] = useState<MovementForm>(() => emptyForm(defaultDate));
  const isIncoming = mode === 'incoming';
  const accent = isIncoming ? t.green : t.orange;

  const onDone = () => { onSaved?.(); onClose(); };
  const incoming = useApiMutation<unknown, Record<string, unknown>>('post', '/inventory/incoming-fulls', {
    invalidateKeys, successMessage: 'Incoming fulls recorded', onSuccess: onDone,
  });
  const outgoing = useApiMutation<unknown, Record<string, unknown>>('post', '/inventory/outgoing-empties', {
    invalidateKeys, successMessage: 'Outgoing empties recorded', onSuccess: onDone,
  });
  const isPending = incoming.isPending || outgoing.isPending;

  const submit = () => {
    const qty = parseInt(form.quantity, 10);
    if (!form.cylinderTypeId) { Alert.alert('Required', 'Please select a cylinder type.'); return; }
    if (isNaN(qty) || qty <= 0) { Alert.alert('Required', 'Quantity must be a whole number greater than 0.'); return; }
    if (!form.documentType.trim()) { Alert.alert('Required', 'Document Type is required.'); return; }
    if (!form.documentNumber.trim()) { Alert.alert('Required', 'Document Number is required.'); return; }
    const amt = form.amount.trim() ? Number(form.amount) : undefined;
    if (amt !== undefined && (Number.isNaN(amt) || amt < 0)) { Alert.alert('Required', 'Amount must be 0 or greater.'); return; }

    const base: Record<string, unknown> = {
      cylinderTypeId: form.cylinderTypeId,
      quantity: qty,
      documentType: form.documentType.trim(),
      documentNumber: form.documentNumber.trim(),
      documentDate: form.documentDate,
      ...(form.vehicleId ? { vehicleId: form.vehicleId } : {}),
      ...(form.vehicleNumber.trim() ? { vehicleNumber: form.vehicleNumber.trim() } : {}),
      ...(form.driverName.trim() ? { driverName: form.driverName.trim() } : {}),
      ...(amt !== undefined ? { amount: amt } : {}),
      ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    };

    if (isIncoming) {
      incoming.mutate({ ...base, ...(sourceDistributorId ? { sourceDistributorId } : {}) });
    } else {
      outgoing.mutate({
        ...base,
        ...(form.authorizationRef.trim() ? { authorizationRef: form.authorizationRef.trim() } : {}),
        ...(form.condition ? { condition: form.condition } : {}),
      });
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

            {/* Date */}
            <Text style={[styles.label, { color: t.textSecondary }]}>Date</Text>
            <View style={{ marginBottom: 12 }}>
              <DateInput value={form.documentDate || null} onChange={(v) => setForm((f) => ({ ...f, documentDate: v }))} placeholder="Select date" />
            </View>

            {/* Document Type */}
            <Text style={[styles.label, { color: t.textSecondary }]}>Document Type <Text style={{ color: t.red }}>*</Text></Text>
            <TextInput
              style={[styles.input, { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder }]}
              placeholder="e.g. Invoice, DC" placeholderTextColor={t.textMuted}
              value={form.documentType} onChangeText={(v) => setForm((f) => ({ ...f, documentType: v }))}
            />

            {/* Document Number */}
            <Text style={[styles.label, { color: t.textSecondary }]}>Document Number <Text style={{ color: t.red }}>*</Text></Text>
            <TextInput
              style={[styles.input, { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder }]}
              placeholder="e.g. INV-2026-001" placeholderTextColor={t.textMuted}
              value={form.documentNumber} onChangeText={(v) => setForm((f) => ({ ...f, documentNumber: v }))}
            />

            {/* Vehicle & Driver */}
            <Text style={[styles.label, { color: t.textSecondary }]}>Vehicle &amp; Driver <Text style={{ fontSize: 11, color: t.textMuted }}>(optional)</Text></Text>
            {availableMappings.length === 0 ? (
              <View style={{ padding: 12, borderRadius: 10, borderWidth: 1, borderColor: t.cardBorder, backgroundColor: t.inputBg, marginBottom: 14 }}>
                <Text style={{ fontSize: 13, color: t.textMuted }}>No vehicle mappings for today. Set one up in Transport → Vehicle Mappings, or leave blank.</Text>
              </View>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
                {availableMappings.map((m) => {
                  const selected = form.vehicleId === m.vehicleId;
                  return (
                    <TouchableOpacity
                      key={m.driverId}
                      onPress={() => setForm((f) => ({ ...f, vehicleId: m.vehicleId ?? '', vehicleNumber: m.vehicleNumber ?? '', driverName: m.driverName }))}
                      style={{
                        paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12,
                        backgroundColor: selected ? accent : t.metricBg,
                        borderWidth: 1, borderColor: selected ? accent : t.cardBorder,
                      }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: '700', color: selected ? '#fff' : t.text }}>{m.vehicleNumber}</Text>
                      <Text style={{ fontSize: 11, color: selected ? '#fff' : t.textSecondary, marginTop: 2 }}>{m.driverName}</Text>
                    </TouchableOpacity>
                  );
                })}
                {form.vehicleId !== '' && (
                  <TouchableOpacity
                    onPress={() => setForm((f) => ({ ...f, vehicleId: '', vehicleNumber: '', driverName: '' }))}
                    style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, borderWidth: 1, borderColor: t.cardBorder, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Ionicons name="close" size={14} color={t.textSecondary} />
                    <Text style={{ fontSize: 11, color: t.textSecondary, marginTop: 2 }}>Clear</Text>
                  </TouchableOpacity>
                )}
              </ScrollView>
            )}

            {/* Amount */}
            <Text style={[styles.label, { color: t.textSecondary }]}>Amount <Text style={{ fontSize: 11, color: t.textMuted }}>(optional)</Text></Text>
            <TextInput
              style={[styles.input, { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder }]}
              placeholder="e.g. 12000" placeholderTextColor={t.textMuted} keyboardType="decimal-pad"
              value={form.amount} onChangeText={(v) => setForm((f) => ({ ...f, amount: v.replace(/[^0-9.]/g, '') }))}
            />

            {/* Outgoing-only: Authorization Ref + Condition */}
            {!isIncoming && (
              <>
                <Text style={[styles.label, { color: t.textSecondary }]}>Authorization Ref <Text style={{ fontSize: 11, color: t.textMuted }}>(optional)</Text></Text>
                <TextInput
                  style={[styles.input, { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder }]}
                  placeholder="e.g. AUTH-2026-001" placeholderTextColor={t.textMuted}
                  value={form.authorizationRef} onChangeText={(v) => setForm((f) => ({ ...f, authorizationRef: v }))}
                />
                <Text style={[styles.label, { color: t.textSecondary }]}>Condition <Text style={{ fontSize: 11, color: t.textMuted }}>(optional)</Text></Text>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                  {(['good', 'defective'] as const).map((c) => {
                    const selected = form.condition === c;
                    return (
                      <TouchableOpacity
                        key={c}
                        onPress={() => setForm((f) => ({ ...f, condition: f.condition === c ? '' : c }))}
                        style={{ flex: 1, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: selected ? t.orange : t.cardBorder, backgroundColor: selected ? t.orange : t.metricBg, alignItems: 'center' }}
                      >
                        <Text style={{ fontSize: 13, fontWeight: '700', color: selected ? '#fff' : t.text }}>{c === 'good' ? 'Good' : 'Defective'}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
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
