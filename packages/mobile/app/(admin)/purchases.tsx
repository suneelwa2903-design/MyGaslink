/**
 * Mini-Operator (2026-07-16) — Purchases mobile screen.
 *
 * Rendered under the (admin) route group but only surfaced as a tab
 * when user.role === 'mini_operator_admin' (see (admin)/_layout.tsx).
 *
 * Screen layout:
 *   • List of purchase entries — one Card per entry.
 *   • Floating "+ New Purchase Entry" button opens a modal-form.
 *   • Modal form has: purchaseDate (defaults today), sourceDistributor
 *     dropdown, one item line (cyl type + fullsReceived + emptiesGivenOut),
 *     notes. Add-more items is a v1.1 enhancement — one line covers
 *     the primary "20 fulls in, 15 empties out from Sharma" use case.
 */
import { useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, Modal, StyleSheet, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { Card, EmptyState, DateInput, todayLocalIso, SelectField, type SelectOption } from '../../src/components/ui';
import { useIsDark } from '../../src/stores/themeStore';

interface SourceDistributor {
  id: string;
  distributorId: string;
  name: string;
  createdAt: string;
}

interface PurchaseEntryItem {
  id: string;
  cylinderTypeId: string;
  fullsReceived: number;
  emptiesGivenOut: number;
  cylinderType?: { id: string; typeName: string } | null;
}

interface PurchaseEntry {
  id: string;
  purchaseNumber: string;
  distributorId: string;
  sourceDistributorId: string | null;
  sourceDistributorName: string | null;
  purchaseDate: string;
  notes: string | null;
  createdAt: string;
  items: PurchaseEntryItem[];
}

interface CylinderType {
  cylinderTypeId: string;
  typeName: string;
  capacity: number;
  isActive: boolean;
}

interface PurchaseEntriesListResponse {
  purchaseEntries: PurchaseEntry[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export default function PurchasesScreen() {
  const dark = useIsDark();
  const [modalOpen, setModalOpen] = useState(false);

  const { data, isLoading, refetch } = useApiQuery<PurchaseEntriesListResponse>(
    ['purchase-entries'],
    '/purchase-entries',
    { page: 1, pageSize: 50 },
  );

  const rows = data?.purchaseEntries ?? [];
  const bg = dark ? '#0f172a' : '#f8fafc';
  const cardBg = dark ? '#1e293b' : '#ffffff';
  const text = dark ? '#f1f5f9' : '#0f172a';
  const muted = dark ? '#94a3b8' : '#64748b';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: bg }} edges={['left', 'right', 'bottom']}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 100 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View>
            <Text style={{ fontSize: 22, fontWeight: '700', color: text }}>Purchases</Text>
            <Text style={{ fontSize: 13, color: muted, marginTop: 2 }}>
              Stock received from source distributors.
            </Text>
          </View>
        </View>

        {isLoading ? (
          <View style={{ paddingVertical: 60, alignItems: 'center' }}>
            <Text style={{ color: muted }}>Loading…</Text>
          </View>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No purchase entries yet"
            description="Tap the + button to record your first stock-in."
          />
        ) : (
          rows.map((row) => (
            <Card key={row.id} style={{ backgroundColor: cardBg }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <Text style={{ fontSize: 14, fontFamily: 'monospace', color: text }}>
                  {row.purchaseNumber}
                </Text>
                <Text style={{ fontSize: 12, color: muted }}>{row.purchaseDate}</Text>
              </View>
              <Text style={{ marginTop: 6, fontSize: 14, fontWeight: '600', color: text }}>
                {row.sourceDistributorName ?? '— no source —'}
              </Text>
              {row.items.map((it) => (
                <View key={it.id} style={{ marginTop: 6, flexDirection: 'row', gap: 12 }}>
                  <Text style={{ fontSize: 13, color: text, flex: 1 }}>
                    {it.cylinderType?.typeName ?? 'Cylinder'}
                  </Text>
                  <Text style={{ fontSize: 13, color: text }}>
                    +{it.fullsReceived} fulls
                  </Text>
                  <Text style={{ fontSize: 13, color: text }}>
                    −{it.emptiesGivenOut} empties
                  </Text>
                </View>
              ))}
              {row.notes && (
                <Text style={{ marginTop: 8, fontSize: 12, color: muted, fontStyle: 'italic' }}>
                  {row.notes}
                </Text>
              )}
            </Card>
          ))
        )}
      </ScrollView>

      {/* Floating FAB */}
      <TouchableOpacity
        onPress={() => setModalOpen(true)}
        activeOpacity={0.8}
        style={[styles.fab, { backgroundColor: '#dc2626' }]}
        accessibilityLabel="New Purchase Entry"
      >
        <Ionicons name="add" size={30} color="#ffffff" />
      </TouchableOpacity>

      <NewPurchaseModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={() => {
          setModalOpen(false);
          refetch();
        }}
      />
    </SafeAreaView>
  );
}

function NewPurchaseModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const dark = useIsDark();
  const [purchaseDate, setPurchaseDate] = useState<string>(todayLocalIso());
  const [sourceDistributorId, setSourceDistributorId] = useState<string>('');
  const [cylinderTypeId, setCylinderTypeId] = useState<string>('');
  const [fullsReceived, setFullsReceived] = useState<string>('0');
  const [emptiesGivenOut, setEmptiesGivenOut] = useState<string>('0');
  const [notes, setNotes] = useState<string>('');

  const bg = dark ? '#0f172a' : '#ffffff';
  const text = dark ? '#f1f5f9' : '#0f172a';
  const muted = dark ? '#94a3b8' : '#64748b';
  const border = dark ? '#334155' : '#e2e8f0';

  const { data: sources } = useApiQuery<SourceDistributor[]>(
    ['source-distributors'],
    '/source-distributors',
  );
  const { data: types } = useApiQuery<CylinderType[]>(
    ['cylinder-types'],
    '/cylinder-types',
  );

  const activeTypes = useMemo(() => (types ?? []).filter((t) => t.isActive), [types]);

  const sourceOptions: SelectOption[] = useMemo(
    () => [
      { value: '', label: '— optional —' },
      ...(sources ?? []).map((s) => ({ value: s.id, label: s.name })),
    ],
    [sources],
  );
  const typeOptions: SelectOption[] = useMemo(
    () => [
      { value: '', label: 'Select cylinder…' },
      ...activeTypes.map((t) => ({ value: t.cylinderTypeId, label: t.typeName })),
    ],
    [activeTypes],
  );

  const create = useApiMutation<PurchaseEntry, unknown>('post', '/purchase-entries', {
    invalidateKeys: [['purchase-entries'], ['inventory-summary']],
    successMessage: 'Purchase entry recorded',
    onSuccess: () => {
      // Reset the form so re-open is clean.
      setPurchaseDate(todayLocalIso());
      setSourceDistributorId('');
      setCylinderTypeId('');
      setFullsReceived('0');
      setEmptiesGivenOut('0');
      setNotes('');
      onCreated();
    },
  });

  const handleSubmit = () => {
    if (!cylinderTypeId) {
      Alert.alert('Missing cylinder type', 'Please pick a cylinder type.');
      return;
    }
    const fullsN = Math.max(0, parseInt(fullsReceived, 10) || 0);
    const emptiesN = Math.max(0, parseInt(emptiesGivenOut, 10) || 0);
    if (fullsN === 0 && emptiesN === 0) {
      Alert.alert('Empty entry', 'Enter at least one non-zero quantity.');
      return;
    }
    create.mutate({
      sourceDistributorId: sourceDistributorId || undefined,
      purchaseDate,
      notes: notes.trim() || undefined,
      items: [
        {
          cylinderTypeId,
          fullsReceived: fullsN,
          emptiesGivenOut: emptiesN,
        },
      ],
    });
  };

  return (
    <Modal visible={open} animationType="slide" onRequestClose={onClose} transparent={false}>
      <SafeAreaView style={{ flex: 1, backgroundColor: bg }} edges={['top', 'left', 'right', 'bottom']}>
        <View style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: border, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <TouchableOpacity onPress={onClose} accessibilityLabel="Cancel">
            <Text style={{ fontSize: 16, color: muted }}>Cancel</Text>
          </TouchableOpacity>
          <Text style={{ fontSize: 17, fontWeight: '700', color: text }}>New Purchase Entry</Text>
          <TouchableOpacity onPress={handleSubmit} disabled={create.isPending} accessibilityLabel="Save">
            <Text style={{ fontSize: 16, color: create.isPending ? muted : '#dc2626', fontWeight: '600' }}>
              {create.isPending ? '…' : 'Save'}
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
          <DateInput label="Purchase Date" value={purchaseDate} onChange={setPurchaseDate} />

          <SelectField
            label="Source Distributor"
            value={sourceDistributorId}
            onChange={setSourceDistributorId}
            options={sourceOptions}
          />

          <SelectField
            label="Cylinder Type"
            value={cylinderTypeId}
            onChange={setCylinderTypeId}
            options={typeOptions}
          />

          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ marginBottom: 6, fontSize: 13, fontWeight: '600', color: text }}>
                Fulls received
              </Text>
              <TextInput
                value={fullsReceived}
                onChangeText={setFullsReceived}
                keyboardType="number-pad"
                style={{
                  borderWidth: 1,
                  borderColor: border,
                  borderRadius: 8,
                  padding: 12,
                  fontSize: 16,
                  color: text,
                  backgroundColor: bg,
                }}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ marginBottom: 6, fontSize: 13, fontWeight: '600', color: text }}>
                Empties given out
              </Text>
              <TextInput
                value={emptiesGivenOut}
                onChangeText={setEmptiesGivenOut}
                keyboardType="number-pad"
                style={{
                  borderWidth: 1,
                  borderColor: border,
                  borderRadius: 8,
                  padding: 12,
                  fontSize: 16,
                  color: text,
                  backgroundColor: bg,
                }}
              />
            </View>
          </View>

          <View>
            <Text style={{ marginBottom: 6, fontSize: 13, fontWeight: '600', color: text }}>
              Notes (optional)
            </Text>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder="e.g. Delivery from Sharma depot"
              placeholderTextColor={muted}
              multiline
              numberOfLines={3}
              style={{
                borderWidth: 1,
                borderColor: border,
                borderRadius: 8,
                padding: 12,
                fontSize: 15,
                color: text,
                backgroundColor: bg,
                minHeight: 72,
                textAlignVertical: 'top',
              }}
            />
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
});
