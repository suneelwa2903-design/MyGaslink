/**
 * STAGE-E — Shared self-service Profile screen body.
 *
 * Used by (admin)/profile.tsx, (finance)/profile.tsx, and (inventory)/profile.tsx.
 * Each role wrapper just sets the accent colour and the back-route fallback;
 * the body — avatar, editable form, read-only identity fields, change-password
 * placeholder, save flow — lives here so admin/finance/inventory can't drift.
 *
 * Editable fields submit to PUT /api/users/me (users.ts) with a strict subset
 * of updateUserSchema (updateOwnProfileSchema). email/role/distributorId are
 * intentionally read-only.
 */
import { useState } from 'react';
import { DeleteAccountButton } from '../components/DeleteAccountButton';
import { ChangePasswordModal } from '../components/ChangePasswordModal';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { UserProfile, UpdateOwnProfileInput } from '@gaslink/shared';
import { useAuthStore } from '../stores/authStore';
import { useApiMutation } from '../hooks/useApi';
import { useTheme, type ThemeColors } from '../theme';

// STAGE-E: role label map — inline because the shared labels module doesn't
// export one (verified by grep on packages/shared/src/labels/index.ts).
// Six roles total per CLAUDE.md "Architecture Notes".
const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  distributor_admin: 'Distributor Admin',
  finance: 'Finance',
  inventory: 'Inventory',
  driver: 'Driver',
  customer: 'Customer',
};

function roleLabel(role: string | undefined | null): string {
  if (!role) return '—';
  return ROLE_LABELS[role] ?? role.replace(/_/g, ' ');
}

export interface ProfileScreenProps {
  accent: string;
}

export function ProfileScreen({ accent }: ProfileScreenProps) {
  const { colors, dark } = useTheme();
  const router = useRouter();
  const { user, setUser } = useAuthStore();

  const [firstName, setFirstName] = useState(user?.firstName ?? '');
  const [lastName, setLastName] = useState(user?.lastName ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [showChangePassword, setShowChangePassword] = useState(false);

  // STAGE-E: PUT /api/users/me. Response shape = mapUser output, which renames
  // `id` → `userId` and preserves the UserProfile fields (mappers.ts:352).
  const updateMutation = useApiMutation<UserProfile, UpdateOwnProfileInput>(
    'put',
    '/users/me',
    {
      invalidateKeys: [['auth-me']],
      onSuccess: (updated) => {
        // Refresh the auth store so the new name/phone appears in the user
        // card, headers, and any other screen that reads from authStore.
        if (updated) setUser(updated);
        Alert.alert('Saved', 'Your profile has been updated.', [
          { text: 'OK', onPress: () => router.back() },
        ]);
      },
    },
  );

  const dirty =
    firstName.trim() !== (user?.firstName ?? '') ||
    lastName.trim() !== (user?.lastName ?? '') ||
    phone.trim() !== (user?.phone ?? '');

  const handleSave = () => {
    if (!user) return;
    if (!firstName.trim() || !lastName.trim()) {
      Alert.alert('Validation', 'First name and last name are required.');
      return;
    }
    const patch: UpdateOwnProfileInput = {};
    if (firstName.trim() !== (user.firstName ?? '')) patch.firstName = firstName.trim();
    if (lastName.trim() !== (user.lastName ?? '')) patch.lastName = lastName.trim();
    if (phone.trim() !== (user.phone ?? '')) patch.phone = phone.trim();
    if (Object.keys(patch).length === 0) {
      router.back();
      return;
    }
    updateMutation.mutate(patch);
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Back header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 12,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: colors.divider,
        }}
      >
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text
          style={{
            flex: 1,
            textAlign: 'center',
            fontSize: 17,
            fontWeight: '700',
            color: colors.text,
          }}
        >
          My Profile
        </Text>
        <View style={{ width: 26 }} />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }} keyboardShouldPersistTaps="handled">
          {/* Avatar */}
          <View style={{ alignItems: 'center', paddingVertical: 8 }}>
            <View
              style={{
                width: 80,
                height: 80,
                borderRadius: 40,
                backgroundColor: accent + (dark ? '22' : '15'),
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 8,
              }}
            >
              <Text style={{ fontSize: 34, fontWeight: '700', color: accent }}>
                {user?.firstName?.[0]?.toUpperCase() || '?'}
              </Text>
            </View>
            <Text style={{ fontSize: 13, color: colors.textMuted }}>
              {roleLabel(user?.role)}
            </Text>
          </View>

          {/* Editable section */}
          <SectionLabel label="Personal Details" theme={colors} />
          <View
            style={{
              backgroundColor: colors.cardBg,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: colors.cardBorder,
              padding: 16,
              gap: 12,
            }}
          >
            <FormField
              label="First Name"
              value={firstName}
              onChangeText={setFirstName}
              placeholder="First name"
              theme={colors}
            />
            <FormField
              label="Last Name"
              value={lastName}
              onChangeText={setLastName}
              placeholder="Last name"
              theme={colors}
            />
            <FormField
              label="Phone"
              value={phone}
              onChangeText={setPhone}
              placeholder="Phone number"
              keyboardType="phone-pad"
              theme={colors}
            />
          </View>

          {/* Read-only identity section */}
          <SectionLabel label="Account" theme={colors} />
          <View
            style={{
              backgroundColor: colors.cardBg,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: colors.cardBorder,
              padding: 16,
              gap: 12,
            }}
          >
            <ReadonlyRow label="Email" value={user?.email ?? '—'} theme={colors} />
            <ReadonlyRow label="Role" value={roleLabel(user?.role)} theme={colors} />
            {user?.distributorName ? (
              <ReadonlyRow label="Distributor" value={user.distributorName} theme={colors} />
            ) : null}
          </View>

          {/* Item 3 (2026-07-09) — voluntary Change Password. Opens the
              shared ChangePasswordModal which posts to /auth/change-password
              (rate-limited on the backend). Same endpoint the forced-reset
              screen uses. */}
          <TouchableOpacity
            onPress={() => setShowChangePassword(true)}
            activeOpacity={0.7}
            style={{
              backgroundColor: colors.cardBg,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: colors.cardBorder,
              padding: 16,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 14,
            }}
          >
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: accent + (dark ? '22' : '15'),
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name="key-outline" size={20} color={accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>
                Change Password
              </Text>
              <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                Update your password
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </TouchableOpacity>

          {/* Save */}
          <TouchableOpacity
            onPress={handleSave}
            disabled={!dirty || updateMutation.isPending}
            activeOpacity={0.8}
            style={{
              backgroundColor: accent,
              borderRadius: 12,
              paddingVertical: 14,
              alignItems: 'center',
              marginTop: 4,
              opacity: !dirty || updateMutation.isPending ? 0.5 : 1,
            }}
          >
            {updateMutation.isPending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>
                Save Changes
              </Text>
            )}
          </TouchableOpacity>

          {/* M14 v1.0 — defence in depth: profile tab also exposes the
              deletion entry. Roles still get it on More/Settings too. */}
          <View style={{ marginTop: 16 }}>
            <DeleteAccountButton variant="inline" />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Item 3 (2026-07-09) — real change-password modal replaces the
          former "Coming soon" placeholder. Shared component; same UI on
          driver + customer roles. */}
      <ChangePasswordModal
        visible={showChangePassword}
        onClose={() => setShowChangePassword(false)}
      />
    </SafeAreaView>
  );
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function SectionLabel({ label, theme }: { label: string; theme: ThemeColors }) {
  return (
    <Text
      style={{
        fontSize: 12,
        fontWeight: '700',
        color: theme.textMuted,
        letterSpacing: 0.8,
        textTransform: 'uppercase',
        marginLeft: 4,
        marginTop: 4,
      }}
    >
      {label}
    </Text>
  );
}

function FormField({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  theme,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'phone-pad' | 'email-address';
  theme: ThemeColors;
}) {
  return (
    <View>
      <Text style={{ fontSize: 13, fontWeight: '600', color: theme.textSecondary, marginBottom: 6 }}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.textMuted}
        keyboardType={keyboardType}
        style={{
          backgroundColor: theme.inputBg,
          borderWidth: 1,
          borderColor: theme.inputBorder,
          borderRadius: 10,
          paddingHorizontal: 14,
          paddingVertical: 12,
          fontSize: 15,
          color: theme.text,
        }}
      />
    </View>
  );
}

function ReadonlyRow({
  label,
  value,
  theme,
}: {
  label: string;
  value: string;
  theme: ThemeColors;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <Text style={{ fontSize: 13, color: theme.textSecondary }}>{label}</Text>
      <Text
        style={{ fontSize: 14, fontWeight: '600', color: theme.textMuted, maxWidth: '60%' }}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}
