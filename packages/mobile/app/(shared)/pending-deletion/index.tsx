/**
 * Screen 5 — pending-deletion landing (IOS-ACCOUNT-DELETION-SPEC §6.5).
 * Shown when a user with a pending deletion request logs back in.
 */
import { useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTheme } from '../../../src/theme';
import {
  getDeletionRequestStatus,
  cancelDeletionRequest,
  getErrorMessage,
  type DeletionRequestStatus,
} from '../../../src/api/account';
import { useAuthStore } from '../../../src/stores/authStore';
import { tokenStorage } from '../../../src/lib/api';

function formatDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
  } catch {
    return iso;
  }
}

export default function PendingDeletionScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const logout = useAuthStore((s) => s.logout);
  const [cancelling, setCancelling] = useState(false);

  const { data, isLoading } = useQuery<DeletionRequestStatus>({
    queryKey: ['deletion-request-status'],
    queryFn: getDeletionRequestStatus,
  });

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await cancelDeletionRequest();
      await queryClient.invalidateQueries({ queryKey: ['deletion-request-status'] });
      Alert.alert('Cancelled', 'Your deletion request has been cancelled.');
      router.replace('/');
    } catch (err: unknown) {
      Alert.alert('Error', getErrorMessage(err));
      setCancelling(false);
    }
  };

  const handleSignOut = async () => {
    queryClient.clear();
    await tokenStorage.clearTokens();
    await logout();
    router.replace('/(auth)/login');
  };

  return (
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flex: 1, padding: 24, justifyContent: 'center', gap: 16 }}>
        <Text style={{ fontSize: 22, fontWeight: '700', color: colors.text }}>
          Account Pending Deletion
        </Text>
        {isLoading ? (
          <ActivityIndicator color="#dc2626" />
        ) : (
          <>
            <Text style={{ fontSize: 16, color: colors.text }}>
              Your account will be deleted in{' '}
              <Text style={{ fontWeight: '700', color: '#dc2626' }}>
                {data?.daysRemaining ?? '—'} days
              </Text>
              .
            </Text>
            <View
              style={{
                backgroundColor: colors.cardBg,
                borderRadius: 10,
                padding: 14,
                borderWidth: 1,
                borderColor: colors.cardBorder,
              }}
            >
              <Text style={{ fontSize: 13, color: colors.textMuted, marginBottom: 4 }}>
                Scheduled completion
              </Text>
              <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>
                {formatDate(data?.scheduledCompletionAt)}
              </Text>
            </View>
            <Text style={{ fontSize: 14, lineHeight: 20, color: colors.textSecondary }}>
              After 30 days from your request, your personal information will be removed and cannot
              be recovered.
            </Text>
            <Text style={{ fontSize: 14, lineHeight: 20, color: colors.textSecondary }}>
              If you&apos;ve changed your mind, cancel below — your account will resume normally.
            </Text>
          </>
        )}

        <TouchableOpacity
          onPress={handleCancel}
          disabled={cancelling || isLoading}
          style={{
            marginTop: 8,
            paddingVertical: 14,
            borderRadius: 10,
            backgroundColor: '#dc2626',
            alignItems: 'center',
            opacity: cancelling || isLoading ? 0.5 : 1,
          }}
        >
          <Text style={{ color: '#ffffff', fontWeight: '700', fontSize: 16 }}>
            {cancelling ? 'Cancelling…' : 'Cancel Deletion Request'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handleSignOut}
          disabled={cancelling}
          style={{
            paddingVertical: 14,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.cardBorder,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: colors.text, fontWeight: '600', fontSize: 16 }}>Sign Out</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
