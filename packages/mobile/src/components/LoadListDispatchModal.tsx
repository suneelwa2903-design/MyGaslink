import { useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useApiQuery, useApiMutation } from '../hooks/useApi';
import { useTheme, ACCENT } from '../theme';

// ─────────────────────────────────────────────────────────────────────────────
// LoadListDispatchModal (mobile)
//
// Two-state full-screen modal opened from the Dispatch button on the admin
// (and inventory) Orders screen. Replaces the prior direct-to-preflight tap.
//
//   STATE 1 (EDITOR)
//     - Per-cylinder-type rows: Booked (read-only) + Spare (editable) + Total
//     - [Cancel] [Save Load List]
//     - On Save: POST /api/manifests → transition to STATE 2.
//
//   STATE 2 (CONFIRMATION)
//     - Summary of saved load list per cylinder type.
//     - [Edit Load List] [Dispatch Now]
//     - On Dispatch Now: invokes parent's onDispatchNow, which is responsible
//       for closing this modal AND firing the existing preflight flow. We do
//       NOT call /preflight-dispatch from here — keeps the dispatch result
//       UX exactly as it is today.
//
// If a manifest already exists on open → start in STATE 2 (skip editor).
// ─────────────────────────────────────────────────────────────────────────────

type CylinderTypeRow = { cylinderTypeId: string; typeName: string };

type ManifestRow = {
  cylinderTypeId: string;
  cylinderTypeName?: string;
  totalLoaded: number;
  orderedQty: number;
  floatQty: number;
};

export interface LoadListDispatchModalProps {
  visible: boolean;
  driverName: string;
  vehicleNumber: string | null;
  /** DVA id; required for manifest read + write. */
  assignmentId: string;
  /** Current DVA trip number (cache-key scoping). */
  tripNumber: number;
  /**
   * Pre-booked order line items for this driver-vehicle group. Used to fill
   * the Booked column before any manifest exists.
   */
  orderItems: Array<{ cylinderTypeId: string; quantity: number }>;
  onClose: () => void;
  /**
   * Called when the user taps Dispatch Now from STATE 2. Parent must close
   * the modal and trigger the existing preflight + dispatch-result flow.
   */
  onDispatchNow: () => void;
}

export function LoadListDispatchModal(props: LoadListDispatchModalProps) {
  const { visible, driverName, vehicleNumber, assignmentId, tripNumber, orderItems, onClose, onDispatchNow } = props;
  const { colors } = useTheme();
  const queryClient = useQueryClient();

  const [spareByType, setSpareByType] = useState<Record<string, string>>({});
  const [view, setView] = useState<'editor' | 'confirmation'>('editor');
  const [initialized, setInitialized] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const { data: typesResp } = useApiQuery<{ cylinderTypes: CylinderTypeRow[] }>(
    ['cylinder-types-list'],
    '/cylinder-types',
    undefined,
    { enabled: visible, staleTime: 5 * 60_000 },
  );
  const types = typesResp?.cylinderTypes ?? [];

  const {
    data: existing,
    isLoading: manifestLoading,
    isSuccess: manifestLoaded,
  } = useApiQuery<{ manifest: ManifestRow[] }>(
    ['manifest', assignmentId, String(tripNumber)],
    `/manifests/dva/${assignmentId}`,
    undefined,
    { enabled: visible && !!assignmentId, staleTime: 30_000 },
  );
  const existingRows = existing?.manifest ?? [];
  const existingByType = useMemo(
    () => new Map(existingRows.map((m) => [m.cylinderTypeId, m])),
    [existingRows],
  );

  const liveOrderedByType = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of orderItems) {
      m.set(it.cylinderTypeId, (m.get(it.cylinderTypeId) ?? 0) + it.quantity);
    }
    return m;
  }, [orderItems]);

  // Decide initial view on first manifest load per open cycle.
  if (visible && manifestLoaded && !initialized) {
    setView(existingRows.length > 0 ? 'confirmation' : 'editor');
    setInitialized(true);
  }
  if (!visible && initialized) {
    setInitialized(false);
    setSpareByType({});
    setView('editor');
    setSaveError(null);
  }

  const saveMutation = useApiMutation<
    { manifest: ManifestRow[] },
    { dvaId: string; items: Array<{ cylinderTypeId: string; totalLoaded: number }> }
  >('post', '/manifests', {
    onSuccess: (saved) => {
      if (saved && Array.isArray(saved.manifest)) {
        queryClient.setQueryData<{ manifest: ManifestRow[] }>(
          ['manifest', assignmentId, String(tripNumber)],
          (prev) => {
            const merged = new Map<string, ManifestRow>();
            for (const m of prev?.manifest ?? []) merged.set(m.cylinderTypeId, m);
            for (const m of saved.manifest) merged.set(m.cylinderTypeId, m);
            return { manifest: Array.from(merged.values()) };
          },
        );
      }
      queryClient.invalidateQueries({ queryKey: ['manifest', assignmentId, String(tripNumber)] });
      setSpareByType({});
      setSaveError(null);
      setView('confirmation');
    },
    onError: (err) => {
      // Inline error — suppresses the default Alert.
      setSaveError(err?.message || 'Failed to save load list');
    },
  });

  const handleSave = () => {
    setSaveError(null);
    const items: Array<{ cylinderTypeId: string; totalLoaded: number }> = [];
    for (const t of types) {
      const raw = spareByType[t.cylinderTypeId];
      const saved = existingByType.get(t.cylinderTypeId);
      const savedSpare = saved?.floatQty ?? 0;
      const explicit = raw !== undefined && raw.trim() !== '';
      const spareVal = explicit ? Math.max(0, Math.floor(Number(raw) || 0)) : savedSpare;
      const ordered = saved?.orderedQty ?? liveOrderedByType.get(t.cylinderTypeId) ?? 0;
      const totalLoaded = ordered + spareVal;
      if (!explicit && savedSpare === 0 && ordered === 0) continue;
      if (totalLoaded <= 0) continue;
      items.push({ cylinderTypeId: t.cylinderTypeId, totalLoaded });
    }
    if (items.length === 0) {
      setSaveError('Enter spare qty for at least one cylinder type');
      return;
    }
    saveMutation.mutate({ dvaId: assignmentId, items });
  };

  const totalToLoadInEditor = useMemo(() => {
    let sum = 0;
    for (const t of types) {
      const saved = existingByType.get(t.cylinderTypeId);
      const ordered = saved?.orderedQty ?? liveOrderedByType.get(t.cylinderTypeId) ?? 0;
      const raw = spareByType[t.cylinderTypeId];
      const savedSpare = saved?.floatQty ?? 0;
      const spareVal = raw !== undefined && raw.trim() !== ''
        ? Math.max(0, Math.floor(Number(raw) || 0))
        : savedSpare;
      sum += ordered + spareVal;
    }
    return sum;
  }, [types, existingByType, liveOrderedByType, spareByType]);

  const confirmedTotal = existingRows.reduce((s, m) => s + m.totalLoaded, 0);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      presentationStyle="overFullScreen"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ maxHeight: '92%' }}>
          <View style={{
            backgroundColor: colors.bg,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            maxHeight: '100%',
          }}>
            {/* Header */}
            <View style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: 16,
              borderBottomWidth: 1,
              borderBottomColor: colors.divider,
            }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>
                  {view === 'confirmation' ? 'Load List Confirmed' : 'Load List'}
                </Text>
                <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                  {driverName}{vehicleNumber ? `  •  ${vehicleNumber}` : ''}
                </Text>
              </View>
              <TouchableOpacity onPress={onClose}>
                <Text style={{ fontSize: 26, color: colors.textSecondary, paddingHorizontal: 6 }}>×</Text>
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
              {manifestLoading && (
                <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                  <ActivityIndicator color={ACCENT.red} />
                </View>
              )}

              {!manifestLoading && view === 'editor' && (
                <>
                  <Text style={{ fontSize: 12, color: colors.textMuted, marginBottom: 12 }}>
                    Spare = extra cylinders loaded for walk-in customers (beyond booked qty).
                    Total = booked + spare, debits depot at dispatch.
                  </Text>

                  {/* Column header */}
                  <View style={{ flexDirection: 'row', paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: colors.divider }}>
                    <Text style={{ flex: 2, fontSize: 11, fontWeight: '600', color: colors.textMuted }}>Cylinder</Text>
                    <Text style={{ flex: 1, fontSize: 11, fontWeight: '600', color: colors.textMuted, textAlign: 'right' }}>Booked</Text>
                    <Text style={{ flex: 1, fontSize: 11, fontWeight: '600', color: colors.textMuted, textAlign: 'right' }}>Spare</Text>
                    <Text style={{ flex: 1, fontSize: 11, fontWeight: '600', color: colors.textMuted, textAlign: 'right' }}>Total</Text>
                  </View>

                  {types.map((t) => {
                    const saved = existingByType.get(t.cylinderTypeId);
                    const ordered = saved?.orderedQty ?? liveOrderedByType.get(t.cylinderTypeId) ?? 0;
                    const savedSpare = saved?.floatQty ?? 0;
                    const inputRaw = spareByType[t.cylinderTypeId] ?? '';
                    const inputNum = inputRaw === '' ? null : Math.max(0, Math.floor(Number(inputRaw) || 0));
                    const totalDisplay = ordered + (inputNum ?? savedSpare);
                    return (
                      <View
                        key={t.cylinderTypeId}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          paddingVertical: 8,
                          borderBottomWidth: 1,
                          borderBottomColor: colors.divider,
                        }}
                      >
                        <Text style={{ flex: 2, fontSize: 14, color: colors.text }}>{t.typeName}</Text>
                        <Text style={{ flex: 1, fontSize: 14, color: colors.textSecondary, textAlign: 'right' }}>{ordered}</Text>
                        <View style={{ flex: 1, paddingLeft: 4 }}>
                          <TextInput
                            value={inputRaw}
                            onChangeText={(v) =>
                              setSpareByType((prev) => ({ ...prev, [t.cylinderTypeId]: v.replace(/[^0-9]/g, '') }))
                            }
                            keyboardType="number-pad"
                            placeholder={savedSpare > 0 ? String(savedSpare) : '0'}
                            placeholderTextColor={colors.textMuted}
                            style={{
                              borderWidth: 1,
                              borderColor: colors.cardBorder,
                              borderRadius: 6,
                              paddingHorizontal: 8,
                              paddingVertical: 6,
                              textAlign: 'right',
                              color: colors.text,
                            }}
                          />
                        </View>
                        <Text style={{ flex: 1, fontSize: 14, fontWeight: '600', color: colors.text, textAlign: 'right' }}>
                          {totalDisplay}
                        </Text>
                      </View>
                    );
                  })}

                  <View style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    paddingTop: 12,
                    marginTop: 8,
                  }}>
                    <Text style={{ fontSize: 13, color: colors.textSecondary }}>
                      Total cylinders to load:{' '}
                      <Text style={{ fontWeight: '700', color: colors.text }}>{totalToLoadInEditor}</Text>
                    </Text>
                  </View>

                  {saveError && (
                    <View style={{
                      backgroundColor: 'rgba(220,38,38,0.1)',
                      borderRadius: 8,
                      padding: 10,
                      marginTop: 12,
                    }}>
                      <Text style={{ color: '#dc2626', fontSize: 13 }}>{saveError}</Text>
                    </View>
                  )}

                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
                    <TouchableOpacity
                      onPress={onClose}
                      disabled={saveMutation.isPending}
                      style={{
                        flex: 1,
                        borderWidth: 1,
                        borderColor: colors.cardBorder,
                        borderRadius: 8,
                        paddingVertical: 12,
                        alignItems: 'center',
                      }}
                    >
                      <Text style={{ color: colors.text, fontWeight: '600' }}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={handleSave}
                      disabled={saveMutation.isPending}
                      style={{
                        flex: 1,
                        backgroundColor: ACCENT.red,
                        borderRadius: 8,
                        paddingVertical: 12,
                        alignItems: 'center',
                        opacity: saveMutation.isPending ? 0.6 : 1,
                      }}
                    >
                      <Text style={{ color: '#ffffff', fontWeight: '700' }}>
                        {saveMutation.isPending ? 'Saving…' : 'Save Load List'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}

              {!manifestLoading && view === 'confirmation' && (
                <>
                  <View style={{
                    backgroundColor: 'rgba(16,185,129,0.10)',
                    borderRadius: 8,
                    padding: 12,
                    marginBottom: 12,
                  }}>
                    <Text style={{ color: ACCENT.green, fontWeight: '700', fontSize: 14 }}>Load List Confirmed ✓</Text>
                    <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                      {confirmedTotal} cylinder{confirmedTotal === 1 ? '' : 's'} ready
                    </Text>
                  </View>

                  {existingRows.map((m) => (
                    <View
                      key={m.cylinderTypeId}
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        paddingVertical: 8,
                        borderBottomWidth: 1,
                        borderBottomColor: colors.divider,
                      }}
                    >
                      <Text style={{ color: colors.text, fontSize: 14 }}>
                        {m.cylinderTypeName ?? m.cylinderTypeId}
                      </Text>
                      <Text style={{ color: colors.textSecondary, fontSize: 14 }}>
                        {m.orderedQty} booked + {m.floatQty} spare ={' '}
                        <Text style={{ fontWeight: '700', color: colors.text }}>{m.totalLoaded}</Text>
                      </Text>
                    </View>
                  ))}

                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
                    <TouchableOpacity
                      onPress={() => { setSpareByType({}); setView('editor'); setSaveError(null); }}
                      style={{
                        flex: 1,
                        borderWidth: 1,
                        borderColor: colors.cardBorder,
                        borderRadius: 8,
                        paddingVertical: 12,
                        alignItems: 'center',
                      }}
                    >
                      <Text style={{ color: colors.text, fontWeight: '600' }}>Edit Load List</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={onDispatchNow}
                      style={{
                        flex: 1,
                        backgroundColor: ACCENT.red,
                        borderRadius: 8,
                        paddingVertical: 12,
                        alignItems: 'center',
                      }}
                    >
                      <Text style={{ color: '#ffffff', fontWeight: '700' }}>Dispatch Now</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
