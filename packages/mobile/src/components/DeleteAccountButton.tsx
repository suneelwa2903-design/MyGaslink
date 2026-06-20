/**
 * M14 v1.0 — Account deletion entry point (IOS-ACCOUNT-DELETION-SPEC §6.1).
 *
 * Previously a mailto:-based flow (Google Play minimum). Now pushes into the
 * in-app deletion screens, which Apple §5.1.1(v) requires.
 *
 * Renders nothing for super_admin role — they cannot self-delete (server
 * enforces the same with 423 SUPERADMIN_SELF_DELETE_BLOCKED).
 */
import { TouchableOpacity, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme';
import { useAuthStore } from '../stores/authStore';

export function DeleteAccountButton({
  variant = 'card',
  style,
}: {
  variant?: 'card' | 'inline';
  style?: object;
}) {
  const { dark, colors } = useTheme();
  const router = useRouter();
  const role = useAuthStore((s) => s.user?.role);

  // Super-admin self-delete is blocked server-side (423). Hide the entry
  // point too — belt + braces per spec §6.7.
  if (role === 'super_admin') {
    return null;
  }

  const onPress = () => router.push('/(shared)/delete-account');

  if (variant === 'inline') {
    return (
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.6}
        style={[
          {
            paddingVertical: 12,
            paddingHorizontal: 14,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
          },
          style,
        ]}
      >
        <Ionicons name="trash-outline" size={18} color="#ef4444" />
        <Text style={{ fontSize: 14, fontWeight: '600', color: '#ef4444' }}>Delete Account</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View>
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.7}
        style={[
          {
            backgroundColor: dark ? 'rgba(239,68,68,0.08)' : '#fef2f2',
            borderRadius: 14,
            borderWidth: 1,
            borderColor: dark ? 'rgba(239,68,68,0.3)' : '#fecaca',
            paddingVertical: 14,
            paddingHorizontal: 16,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          },
          style,
        ]}
      >
        <Ionicons name="trash-outline" size={18} color="#ef4444" />
        <Text style={{ fontSize: 14, fontWeight: '700', color: '#ef4444' }}>Delete Account</Text>
      </TouchableOpacity>
      <Text
        style={{
          fontSize: 11,
          color: colors.textMuted,
          textAlign: 'center',
          marginTop: 6,
          paddingHorizontal: 12,
        }}
      >
        30-day cancellation window. Financial records retained anonymously for 8 years per Indian GST law.
      </Text>
    </View>
  );
}
