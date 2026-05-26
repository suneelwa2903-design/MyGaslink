import { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Modal, TextInput, Alert, KeyboardAvoidingView, Platform, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { Card, Button, Badge } from '../../src/components/ui';
import { useTheme } from '../../src/theme';
import type { CylinderType, InventoryEvent } from '@gaslink/shared';

type ActionType = 'incoming_fulls' | 'outgoing_empties' | 'manual_adjustment';

const ACTION_TABS: { label: string; value: ActionType; icon: string; color: string }[] = [
  { label: 'Incoming Fulls', value: 'incoming_fulls', icon: '📥', color: '#10b981' },
  { label: 'Outgoing Empties', value: 'outgoing_empties', icon: '📤', color: '#3b82f6' },
  { label: 'Manual Adjustment', value: 'manual_adjustment', icon: '🔧', color: '#8b5cf6' },
];

export default function InventoryActionsScreen() {
  const { dark, colors } = useTheme();
  const [activeAction, setActiveAction] = useState<ActionType | null>(null);

  const { data: cylinderTypesResponse } = useApiQuery<{ cylinderTypes: CylinderType[] }>(
    ['cylinder-types'],
    '/cylinder-types',
  );
  const cylinderTypes: CylinderType[] = cylinderTypesResponse?.cylinderTypes ?? [];

  const { data: recentEventsResponse, isLoading, refetch: refetchEvents } = useApiQuery<{ events: InventoryEvent[] }>(
    ['depot-history-recent'],
    '/inventory/depot-history',
    { pageSize: 10 },
  );
  const recentEvents: InventoryEvent[] = recentEventsResponse?.events ?? [];

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetchEvents} />}
      >
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
          Inventory Actions
        </Text>

        {/* Action Cards */}
        {ACTION_TABS.map((action) => (
          <TouchableOpacity
            key={action.value}
            onPress={() => setActiveAction(action.value)}
            style={{
              backgroundColor: colors.cardBg, borderRadius: 16, padding: 18,
              borderWidth: 2, borderColor: colors.cardBorder,
              flexDirection: 'row', alignItems: 'center', gap: 14,
            }}
            activeOpacity={0.7}
          >
            <View style={{
              width: 48, height: 48, borderRadius: 14,
              backgroundColor: action.color + '15', alignItems: 'center', justifyContent: 'center',
            }}>
              <Text style={{ fontSize: 24 }}>{action.icon}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '700', fontSize: 16, color: colors.text }}>{action.label}</Text>
              <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
                {action.value === 'incoming_fulls' ? 'Record stock received from supplier' :
                 action.value === 'outgoing_empties' ? 'Record empty cylinders sent out' :
                 'Adjust stock for corrections'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </TouchableOpacity>
        ))}

        {/* Recent Activity */}
        <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8 }}>
          Recent Activity
        </Text>

        {(!recentEvents || recentEvents.length === 0) ? (
          <Card>
            <Text style={{ textAlign: 'center', color: colors.textMuted, fontSize: 14 }}>No recent activity</Text>
          </Card>
        ) : (
          recentEvents.map((event) => (
            <Card key={event.eventId}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <Badge
                      label={(event.eventType || '').replace(/_/g, ' ')}
                      variant={
                        event.eventType === 'incoming_fulls' ? 'success' :
                        event.eventType === 'outgoing_empties' ? 'info' :
                        event.eventType === 'manual_adjustment' ? 'warning' : 'neutral'
                      }
                    />
                  </View>
                  <Text style={{ fontWeight: '600', fontSize: 14, color: colors.text }}>{event.cylinderTypeName}</Text>
                  {event.notes && <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>{event.notes}</Text>}
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={{ fontWeight: '700', fontSize: 18, color: (event.quantity ?? 0) >= 0 ? '#10b981' : '#ef4444' }}>
                    {(event.quantity ?? 0) >= 0 ? '+' : ''}{event.quantity ?? 0}
                  </Text>
                  <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 2 }}>{event.eventDate}</Text>
                </View>
              </View>
            </Card>
          ))
        )}
      </ScrollView>

      {/* Action Modal */}
      {activeAction && (
        <ActionModal
          type={activeAction}
          cylinderTypes={cylinderTypes ?? []}
          onClose={() => setActiveAction(null)}
          onSuccess={() => { refetchEvents(); setActiveAction(null); }}
          dark={dark}
          colors={colors}
        />
      )}
    </SafeAreaView>
  );
}

function ActionModal({ type, cylinderTypes, onClose, onSuccess, dark, colors }: {
  type: ActionType;
  cylinderTypes: CylinderType[];
  onClose: () => void;
  onSuccess: () => void;
  dark: boolean;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const [selectedType, setSelectedType] = useState<string>('');
  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [documentNumber, setDocumentNumber] = useState('');

  const endpoint =
    type === 'incoming_fulls' ? '/inventory/incoming-fulls' :
    type === 'outgoing_empties' ? '/inventory/outgoing-empties' :
    '/inventory/manual-adjustment';

  const mutation = useApiMutation<void, Record<string, unknown>>(
    'post', endpoint,
    {
      invalidateKeys: [['inv-summary'], ['depot-history-recent']],
      successMessage: 'Inventory updated successfully',
      onSuccess,
    },
  );

  const config = ACTION_TABS.find((a) => a.value === type)!;

  const handleSubmit = () => {
    if (!selectedType) { Alert.alert('Required', 'Select a cylinder type'); return; }
    if (!quantity || parseInt(quantity) === 0) { Alert.alert('Required', 'Enter a valid quantity'); return; }

    const payload: Record<string, unknown> = {
      cylinderTypeId: selectedType,
      quantity: parseInt(quantity),
      notes: notes.trim() || undefined,
    };

    if (type !== 'manual_adjustment') {
      payload.vehicleNumber = vehicleNumber.trim() || undefined;
      payload.documentNumber = documentNumber.trim() || undefined;
    }

    mutation.mutate(payload);
  };

  const inputStyle = {
    borderWidth: 1,
    borderColor: colors.inputBorder,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    backgroundColor: colors.inputBg,
    color: colors.text,
  };

  return (
    <Modal visible animationType="slide" transparent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
          <View style={{
            backgroundColor: dark ? colors.cardBg : '#fff',
            borderTopLeftRadius: 24, borderTopRightRadius: 24,
            padding: 24, maxHeight: '85%',
          }}>
            {/* Header */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text style={{ fontSize: 24 }}>{config.icon}</Text>
                <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text }}>{config.label}</Text>
              </View>
              <TouchableOpacity onPress={onClose}>
                <Ionicons name="close" size={28} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 16 }}>
              {/* Cylinder Type Selector */}
              <View>
                <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 8 }}>Cylinder Type *</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {cylinderTypes.map((ct) => {
                    const isSelected = selectedType === ct.cylinderTypeId;
                    return (
                      <TouchableOpacity
                        key={ct.cylinderTypeId}
                        onPress={() => setSelectedType(ct.cylinderTypeId)}
                        style={{
                          paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12,
                          backgroundColor: isSelected ? config.color : colors.inputBg,
                          borderWidth: 1, borderColor: isSelected ? config.color : colors.inputBorder,
                        }}
                      >
                        <Text style={{
                          fontSize: 14, fontWeight: '600',
                          color: isSelected ? '#fff' : colors.textSecondary,
                        }}>
                          {ct.typeName}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* Quantity */}
              <View>
                <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>
                  Quantity *{type === 'manual_adjustment' ? ' (negative to reduce)' : ''}
                </Text>
                <TextInput
                  value={quantity}
                  onChangeText={setQuantity}
                  keyboardType={type === 'manual_adjustment' ? 'number-pad' : 'numeric'}
                  placeholder="0"
                  style={{
                    ...inputStyle,
                    fontSize: 20, fontWeight: '700', textAlign: 'center',
                  }}
                  placeholderTextColor={colors.textMuted}
                />
              </View>

              {/* Vehicle Number (not for manual adj) */}
              {type !== 'manual_adjustment' && (
                <View>
                  <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>Vehicle Number</Text>
                  <TextInput
                    value={vehicleNumber}
                    onChangeText={setVehicleNumber}
                    placeholder="e.g., KA-01-AB-1234"
                    autoCapitalize="characters"
                    style={inputStyle}
                    placeholderTextColor={colors.textMuted}
                  />
                </View>
              )}

              {/* Document Number */}
              {type !== 'manual_adjustment' && (
                <View>
                  <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>Document / Invoice No.</Text>
                  <TextInput
                    value={documentNumber}
                    onChangeText={setDocumentNumber}
                    placeholder="Optional reference"
                    style={inputStyle}
                    placeholderTextColor={colors.textMuted}
                  />
                </View>
              )}

              {/* Notes */}
              <View>
                <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>Notes</Text>
                <TextInput
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Optional notes..."
                  multiline
                  style={{
                    ...inputStyle,
                    minHeight: 80, textAlignVertical: 'top',
                  }}
                  placeholderTextColor={colors.textMuted}
                />
              </View>

              <Button
                title={`Record ${config.label}`}
                onPress={handleSubmit}
                loading={mutation.isPending}
                style={{ marginTop: 4, backgroundColor: config.color }}
              />
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
