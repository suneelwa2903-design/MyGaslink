import { useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, TextInput, Modal, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { useDistributorStore } from '../../src/stores/distributorStore';
import { Card, Badge, Button, EmptyState } from '../../src/components/ui';
import { useTheme, ACCENT } from '../../src/theme';
import type { Distributor } from '@gaslink/shared';

export default function DistributorsScreen() {
  const { dark, colors, accent } = useTheme();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const { selectedDistributorId, setSelectedDistributor } = useDistributorStore();

  const { data: distributorsData, isLoading, refetch } = useApiQuery<{ distributors: Distributor[] } | Distributor[]>(
    ['distributors'],
    '/distributors',
  );

  // API may return { distributors: [...] } or [...] directly — handle both
  const distributors: Distributor[] = Array.isArray(distributorsData)
    ? distributorsData
    : (distributorsData as any)?.distributors ?? [];

  const filtered = distributors.filter((d) =>
    !search || d.businessName.toLowerCase().includes(search.toLowerCase()) || d.legalName?.toLowerCase().includes(search.toLowerCase()),
  );

  const handleSelectDistributor = (dist: Distributor) => {
    setSelectedDistributor(dist.distributorId, dist.businessName);
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Header with back button */}
      <View style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.cardBorder,
        backgroundColor: colors.bg,
      }}>
        <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>Distributors</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text }}>Distributors</Text>
          <Button title="+ Add" size="sm" onPress={() => setShowCreate(true)} />
        </View>

        {/* Search */}
        <TextInput
          placeholder="Search distributors..."
          value={search}
          onChangeText={setSearch}
          style={{
            borderWidth: 1,
            borderColor: colors.inputBorder,
            borderRadius: 12,
            paddingHorizontal: 16,
            paddingVertical: 12,
            fontSize: 15,
            backgroundColor: colors.inputBg,
            color: colors.text,
          }}
          placeholderTextColor={colors.textMuted}
        />

        <Text style={{ fontSize: 13, color: colors.textSecondary, fontWeight: '500' }}>
          {filtered.length} distributor{filtered.length !== 1 ? 's' : ''}
        </Text>

        {filtered.length === 0 ? (
          <EmptyState title="No distributors found" description={search ? 'Try a different search' : 'Add your first distributor'} />
        ) : (
          filtered.map((dist) => {
            const isSelected = selectedDistributorId === dist.distributorId;
            return (
              <TouchableOpacity
                key={dist.distributorId}
                onPress={() => handleSelectDistributor(dist)}
                activeOpacity={0.7}
              >
                <Card style={{
                  backgroundColor: dark ? colors.cardBg : '#fff',
                  borderColor: isSelected ? accent.red : colors.cardBorder,
                  borderWidth: isSelected ? 2 : 1,
                }}>
                  {/* Selected indicator */}
                  {isSelected && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                      <Ionicons name="checkmark-circle" size={16} color={accent.red} />
                      <Text style={{ fontSize: 12, fontWeight: '700', color: accent.red }}>ACTIVE</Text>
                    </View>
                  )}

                  {/* Header */}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                    <View style={{ flex: 1, marginRight: 8 }}>
                      <Text style={{ fontWeight: '700', fontSize: 16, color: colors.text }}>{dist.businessName}</Text>
                      {dist.legalName && dist.legalName !== dist.businessName && (
                        <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>{dist.legalName}</Text>
                      )}
                    </View>
                    <Badge
                      label={dist.status}
                      variant={dist.status === 'active' ? 'success' : dist.status === 'suspended' ? 'warning' : 'danger'}
                    />
                  </View>

                  {/* Details Grid */}
                  <View style={{ backgroundColor: dark ? colors.inputBg : colors.cardBg, borderRadius: 10, padding: 12, gap: 8 }}>
                    <InfoRow label="GSTIN" value={dist.gstin || 'Not set'} muted={!dist.gstin} dark={dark} colors={colors} />
                    <InfoRow label="State" value={dist.state || 'Not set'} muted={!dist.state} dark={dark} colors={colors} />
                    <InfoRow
                      label="GST Status"
                      value={dist.gstMode === 'disabled' ? 'Disabled' : dist.gstMode === 'sandbox' ? 'Sandbox' : 'Live'}
                      valueColor={dist.gstMode !== 'disabled' ? ACCENT.green : colors.textMuted}
                      dark={dark}
                      colors={colors}
                    />
                    <InfoRow label="Address" value={dist.address || 'Not set'} muted={!dist.address} dark={dark} colors={colors} />
                  </View>

                  {/* Contact */}
                  {(dist.phone || dist.email) && (
                    <View style={{ flexDirection: 'row', gap: 16, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.divider }}>
                      {dist.phone && (
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 11, color: colors.textSecondary }}>Phone</Text>
                          <Text style={{ fontWeight: '600', fontSize: 13, color: colors.text }}>{dist.phone}</Text>
                        </View>
                      )}
                      {dist.email && (
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 11, color: colors.textSecondary }}>Email</Text>
                          <Text style={{ fontWeight: '600', fontSize: 13, color: colors.text }} numberOfLines={1}>{dist.email}</Text>
                        </View>
                      )}
                    </View>
                  )}
                </Card>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>

      {/* Create Distributor Modal */}
      <CreateDistributorModal
        visible={showCreate}
        onClose={() => setShowCreate(false)}
        dark={dark}
        colors={colors}
      />
    </SafeAreaView>
  );
}

function InfoRow({ label, value, muted, valueColor, colors }: {
  label: string;
  value: string;
  muted?: boolean;
  valueColor?: string;
  dark: boolean;
  colors: any;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <Text style={{ fontSize: 13, color: colors.textSecondary }}>{label}</Text>
      <Text style={{ fontSize: 13, fontWeight: '600', color: valueColor || (muted ? colors.textMuted : colors.text) }}>{value}</Text>
    </View>
  );
}

function CreateDistributorModal({ visible, onClose, dark, colors }: {
  visible: boolean;
  onClose: () => void;
  dark: boolean;
  colors: any;
}) {
  const [form, setForm] = useState({
    businessName: '', legalName: '', gstin: '', phone: '', email: '', address: '', state: '',
  });

  const mutation = useApiMutation<Distributor, typeof form>(
    'post',
    '/distributors',
    {
      invalidateKeys: [['distributors'], ['sa-distributors-summary']],
      successMessage: 'Distributor created successfully',
      onSuccess: () => {
        onClose();
        setForm({ businessName: '', legalName: '', gstin: '', phone: '', email: '', address: '', state: '' });
      },
    },
  );

  const handleSubmit = () => {
    if (!form.businessName.trim()) {
      Alert.alert('Required', 'Business name is required');
      return;
    }
    mutation.mutate(form);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
          <View style={{
            backgroundColor: dark ? colors.cardBg : '#fff',
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            padding: 24,
            maxHeight: '85%',
          }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text }}>New Distributor</Text>
              <TouchableOpacity onPress={onClose}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 14 }}>
              <FormField label="Business Name *" value={form.businessName} onChange={(v) => setForm({ ...form, businessName: v })} dark={dark} colors={colors} />
              <FormField label="Legal Name" value={form.legalName} onChange={(v) => setForm({ ...form, legalName: v })} dark={dark} colors={colors} />
              <FormField label="GSTIN" value={form.gstin} onChange={(v) => setForm({ ...form, gstin: v })} autoCapitalize="characters" dark={dark} colors={colors} />
              <FormField label="State" value={form.state} onChange={(v) => setForm({ ...form, state: v })} dark={dark} colors={colors} />
              <FormField label="Phone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} keyboardType="phone-pad" dark={dark} colors={colors} />
              <FormField label="Email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} keyboardType="email-address" dark={dark} colors={colors} />
              <FormField label="Address" value={form.address} onChange={(v) => setForm({ ...form, address: v })} multiline dark={dark} colors={colors} />

              <Button title="Create Distributor" onPress={handleSubmit} loading={mutation.isPending} style={{ marginTop: 8 }} />
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function FormField({ label, value, onChange, colors, ...props }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  dark: boolean;
  colors: any;
  keyboardType?: 'default' | 'phone-pad' | 'email-address';
  autoCapitalize?: 'none' | 'characters';
  multiline?: boolean;
}) {
  return (
    <View>
      <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        style={{
          borderWidth: 1,
          borderColor: colors.inputBorder,
          borderRadius: 12,
          paddingHorizontal: 16,
          paddingVertical: 14,
          fontSize: 16,
          backgroundColor: colors.inputBg,
          color: colors.text,
          ...(props.multiline ? { minHeight: 80, textAlignVertical: 'top' as const } : {}),
        }}
        placeholderTextColor={colors.textMuted}
        {...props}
      />
    </View>
  );
}
