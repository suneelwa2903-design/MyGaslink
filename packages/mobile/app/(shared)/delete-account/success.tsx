/**
 * Screen 4 of the deletion flow (IOS-ACCOUNT-DELETION-SPEC §6.4).
 * Forced logout on OK — clears tokens + redirects to /login.
 */
import { View, Text, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../../src/theme';
import { useAuthStore } from '../../../src/stores/authStore';
import { tokenStorage } from '../../../src/lib/api';

export default function DeleteAccountSuccess() {
  const router = useRouter();
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const logout = useAuthStore((s) => s.logout);

  const handleOk = async () => {
    queryClient.clear();
    await tokenStorage.clearTokens();
    await logout();
    router.replace('/(auth)/login');
  };

  return (
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flex: 1, padding: 24, justifyContent: 'center', alignItems: 'center', gap: 16 }}>
        <View
          style={{
            width: 72,
            height: 72,
            borderRadius: 36,
            backgroundColor: 'rgba(16,185,129,0.12)',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 12,
          }}
        >
          <Ionicons name="checkmark" size={36} color="#10b981" />
        </View>
        <Text style={{ fontSize: 22, fontWeight: '700', color: colors.text, textAlign: 'center' }}>
          Request Submitted
        </Text>
        <Text style={{ fontSize: 15, lineHeight: 22, color: colors.textSecondary, textAlign: 'center' }}>
          Your deletion request has been submitted. Your account will be removed within 30 days.
        </Text>
        <Text style={{ fontSize: 14, lineHeight: 20, color: colors.textSecondary, textAlign: 'center' }}>
          You can cancel anytime within 30 days by logging in.
        </Text>
        <Text style={{ fontSize: 13, color: colors.textMuted, textAlign: 'center', marginTop: 8 }}>
          The app will now sign you out.
        </Text>
        <TouchableOpacity
          onPress={handleOk}
          style={{
            marginTop: 24,
            paddingVertical: 14,
            paddingHorizontal: 48,
            borderRadius: 10,
            backgroundColor: '#dc2626',
          }}
        >
          <Text style={{ color: '#ffffff', fontWeight: '700', fontSize: 16 }}>OK</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
