import { useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TextInput, TouchableOpacity, Modal, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { Card, Badge, Button, EmptyState } from '../../src/components/ui';
import { useTheme, ACCENT } from '../../src/theme';
import type { User, UserRole } from '@gaslink/shared';

const ROLE_OPTIONS: { label: string; value: UserRole }[] = [
  { label: 'Distributor Admin', value: 'distributor_admin' },
  { label: 'Finance', value: 'finance' },
  { label: 'Inventory', value: 'inventory' },
  { label: 'Driver', value: 'driver' },
];

const roleVariant = (role: string) => {
  switch (role) {
    case 'super_admin': return 'danger' as const;
    case 'distributor_admin': return 'info' as const;
    case 'finance': return 'warning' as const;
    case 'inventory': return 'success' as const;
    case 'driver': return 'neutral' as const;
    default: return 'neutral' as const;
  }
};

export default function UsersScreen() {
  const { dark, colors, accent } = useTheme();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const { data: usersData, isLoading, refetch } = useApiQuery<{ users: User[] } | User[]>(
    ['users'],
    '/users',
  );

  // API may return { users: [...] } or [...] directly — handle both
  const users: User[] = Array.isArray(usersData)
    ? usersData
    : (usersData as any)?.users ?? [];

  const filtered = users.filter((u) =>
    !search || `${u.firstName ?? ''} ${u.lastName ?? ''} ${u.email ?? ''}`.toLowerCase().includes(search.toLowerCase()),
  );

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
        <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>Users</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text }}>Users</Text>
          <Button title="+ Add" size="sm" onPress={() => setShowCreate(true)} />
        </View>

        <TextInput
          placeholder="Search users..."
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
          {filtered.length} user{filtered.length !== 1 ? 's' : ''}
        </Text>

        {filtered.length === 0 ? (
          <EmptyState title="No users found" description={search ? 'Try a different search' : 'Create your first user'} />
        ) : (
          filtered.map((user) => (
            <Card key={user.userId} style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                {/* Avatar */}
                <View style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: dark ? 'rgba(220, 38, 38, 0.15)' : '#fef2f2',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: accent.red }}>
                    {user.firstName?.[0]?.toUpperCase() || '?'}
                  </Text>
                </View>

                {/* Info */}
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>
                    {user.firstName} {user.lastName}
                  </Text>
                  <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 1 }}>{user.email}</Text>
                </View>

                {/* Role */}
                <Badge label={user.role.replace(/_/g, ' ')} variant={roleVariant(user.role)} />
              </View>

              {/* Details */}
              <View style={{ flexDirection: 'row', gap: 16, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.divider }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, color: colors.textSecondary }}>Status</Text>
                  <Text style={{ fontWeight: '600', fontSize: 13, color: user.status === 'active' ? ACCENT.green : ACCENT.red }}>
                    {user.status === 'active' ? 'Active' : 'Inactive'}
                  </Text>
                </View>
                {user.phone && (
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11, color: colors.textSecondary }}>Phone</Text>
                    <Text style={{ fontWeight: '600', fontSize: 13, color: colors.text }}>{user.phone}</Text>
                  </View>
                )}
                {user.distributorId && (
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11, color: colors.textSecondary }}>Distributor ID</Text>
                    <Text style={{ fontWeight: '600', fontSize: 13, color: colors.text }} numberOfLines={1}>
                      {user.distributorId}
                    </Text>
                  </View>
                )}
              </View>
            </Card>
          ))
        )}
      </ScrollView>

      <CreateUserModal visible={showCreate} onClose={() => setShowCreate(false)} dark={dark} colors={colors} accent={accent} />
    </SafeAreaView>
  );
}

function CreateUserModal({ visible, onClose, dark, colors, accent }: {
  visible: boolean;
  onClose: () => void;
  dark: boolean;
  colors: any;
  accent: any;
}) {
  const [form, setForm] = useState({
    firstName: '', lastName: '', email: '', phone: '', role: 'distributor_admin' as UserRole, password: '',
  });

  const mutation = useApiMutation<User, typeof form>(
    'post',
    '/users',
    {
      invalidateKeys: [['users']],
      successMessage: 'User created successfully',
      onSuccess: () => {
        onClose();
        setForm({ firstName: '', lastName: '', email: '', phone: '', role: 'distributor_admin', password: '' });
      },
    },
  );

  const handleSubmit = () => {
    if (!form.firstName.trim() || !form.email.trim() || !form.password.trim()) {
      Alert.alert('Required', 'Name, email, and password are required');
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
              <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text }}>New User</Text>
              <TouchableOpacity onPress={onClose}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 14 }}>
              <FormField label="First Name *" value={form.firstName} onChange={(v) => setForm({ ...form, firstName: v })} dark={dark} colors={colors} />
              <FormField label="Last Name" value={form.lastName} onChange={(v) => setForm({ ...form, lastName: v })} dark={dark} colors={colors} />
              <FormField label="Email *" value={form.email} onChange={(v) => setForm({ ...form, email: v })} keyboardType="email-address" dark={dark} colors={colors} />
              <FormField label="Phone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} keyboardType="phone-pad" dark={dark} colors={colors} />
              <FormField label="Password *" value={form.password} onChange={(v) => setForm({ ...form, password: v })} secureTextEntry dark={dark} colors={colors} />

              {/* Role Selector */}
              <View>
                <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 8 }}>Role</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {ROLE_OPTIONS.map((opt) => (
                    <TouchableOpacity
                      key={opt.value}
                      onPress={() => setForm({ ...form, role: opt.value })}
                      style={{
                        paddingHorizontal: 14,
                        paddingVertical: 8,
                        borderRadius: 99,
                        backgroundColor: form.role === opt.value ? accent.red : (dark ? colors.inputBg : colors.cardBg),
                        borderWidth: 1,
                        borderColor: form.role === opt.value ? accent.red : colors.inputBorder,
                      }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: '600', color: form.role === opt.value ? '#fff' : colors.textSecondary }}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              <Button title="Create User" onPress={handleSubmit} loading={mutation.isPending} style={{ marginTop: 8 }} />
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function FormField({ label, value, onChange, dark, colors, ...props }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  dark: boolean;
  colors: any;
  keyboardType?: 'default' | 'phone-pad' | 'email-address';
  secureTextEntry?: boolean;
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
        }}
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        {...props}
      />
    </View>
  );
}
