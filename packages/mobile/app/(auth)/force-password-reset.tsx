/**
 * Phase 6i (2026-06-12) — in-app force-password-reset screen.
 *
 * Triggered after a successful login when the server returns
 * user.requiresPasswordReset === true. Pre-Phase-6i the mobile app
 * just popped an Alert telling the user to "change your password on
 * the web app first" — which doesn't work in the field for drivers
 * who only have the mobile app installed.
 *
 * Same validation rules as the web force-reset screen: current password
 * + new password >= 8 chars + new ≠ current + confirm match. On success
 * we route the user into their role-scoped home tab.
 */
import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, KeyboardAvoidingView,
  Platform, ScrollView, ActivityIndicator,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/stores/authStore';
import { api, getErrorMessage } from '../../src/lib/api';
import { useTheme } from '../../src/theme';

export default function ForcePasswordResetScreen() {
  const { dark, colors, accent } = useTheme();
  const router = useRouter();
  const { user } = useAuthStore();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setError(null);
    if (!currentPassword || !newPassword || !confirmPassword) {
      setError('All fields are required.');
      return;
    }
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.');
      return;
    }
    if (newPassword === currentPassword) {
      setError('New password must be different from current password.');
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/auth/change-password', {
        currentPassword,
        newPassword,
        confirmPassword,
      });
      // The server clears requiresPasswordReset on success. Mirror that
      // locally so the auth store doesn't re-trigger this screen on next
      // mount, then route into the role-scoped home tab.
      const authState = useAuthStore.getState();
      if (authState.user) {
        authState.setUser({ ...authState.user, requiresPasswordReset: false });
      }
      // 2026-07-19 SECURITY: mirror the customer_hq handling from
      // login.tsx. Prior default was '/(admin)/dashboard' — any HQ or
      // unknown-role user finishing the forced reset was silently
      // landed on the distributor-admin surface.
      switch (user?.role) {
        case 'customer': router.replace('/(customer)/dashboard'); break;
        case 'driver': router.replace('/(driver)/orders'); break;
        case 'super_admin': router.replace('/(super-admin)/dashboard'); break;
        case 'finance': router.replace('/(finance)/dashboard'); break;
        case 'inventory': router.replace('/(inventory)/analytics'); break;
        case 'customer_hq': router.replace('/(hq)'); break;
        case 'distributor_admin':
        case 'mini_operator_admin':
          router.replace('/(admin)/dashboard'); break;
        default: router.replace('/(auth)/login'); break;
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top', 'bottom', 'left', 'right']}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerStyle={{ flexGrow: 1, padding: 24, justifyContent: 'center' }}
            keyboardShouldPersistTaps="handled"
          >
            <View style={{ alignItems: 'center', marginBottom: 24 }}>
              <Ionicons name="lock-closed-outline" size={48} color={accent.red} />
            </View>
            <Text style={{ fontSize: 24, fontWeight: '800', color: colors.text, textAlign: 'center', marginBottom: 8 }}>
              Update Your Password
            </Text>
            <Text style={{ fontSize: 14, color: colors.textMuted, textAlign: 'center', marginBottom: 24 }}>
              Your administrator requires you to change your password before you can continue.
            </Text>

            {/* Current password */}
            <View style={{ marginBottom: 16 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 6 }}>
                Current Password
              </Text>
              <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: dark ? colors.inputBg : '#f8fafc',
                borderRadius: 10,
                borderWidth: 1,
                borderColor: colors.divider,
                paddingHorizontal: 12,
              }}>
                <TextInput
                  value={currentPassword}
                  onChangeText={setCurrentPassword}
                  secureTextEntry={!showCurrent}
                  autoCapitalize="none"
                  placeholder="Enter your current password"
                  placeholderTextColor={colors.textMuted}
                  style={{ flex: 1, paddingVertical: 12, color: colors.text, fontSize: 15 }}
                />
                <TouchableOpacity onPress={() => setShowCurrent((v) => !v)}>
                  <Ionicons name={showCurrent ? 'eye-off-outline' : 'eye-outline'} size={20} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
            </View>

            {/* New password */}
            <View style={{ marginBottom: 16 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 6 }}>
                New Password (min 8 characters)
              </Text>
              <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: dark ? colors.inputBg : '#f8fafc',
                borderRadius: 10,
                borderWidth: 1,
                borderColor: colors.divider,
                paddingHorizontal: 12,
              }}>
                <TextInput
                  value={newPassword}
                  onChangeText={setNewPassword}
                  secureTextEntry={!showNew}
                  autoCapitalize="none"
                  placeholder="Choose a new password"
                  placeholderTextColor={colors.textMuted}
                  style={{ flex: 1, paddingVertical: 12, color: colors.text, fontSize: 15 }}
                />
                <TouchableOpacity onPress={() => setShowNew((v) => !v)}>
                  <Ionicons name={showNew ? 'eye-off-outline' : 'eye-outline'} size={20} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
            </View>

            {/* Confirm */}
            <View style={{ marginBottom: 20 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 6 }}>
                Confirm New Password
              </Text>
              <TextInput
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry={!showNew}
                autoCapitalize="none"
                placeholder="Re-enter the new password"
                placeholderTextColor={colors.textMuted}
                style={{
                  backgroundColor: dark ? colors.inputBg : '#f8fafc',
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: colors.divider,
                  paddingHorizontal: 12,
                  paddingVertical: 12,
                  color: colors.text,
                  fontSize: 15,
                }}
              />
            </View>

            {error && (
              <View style={{
                backgroundColor: '#fef2f2',
                borderRadius: 10,
                padding: 12,
                marginBottom: 16,
                borderWidth: 1,
                borderColor: '#fecaca',
              }}>
                <Text style={{ color: '#b91c1c', fontSize: 13 }}>{error}</Text>
              </View>
            )}

            <TouchableOpacity
              onPress={handleSubmit}
              disabled={submitting}
              style={{
                backgroundColor: accent.red,
                borderRadius: 10,
                paddingVertical: 14,
                alignItems: 'center',
                opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>
                  Update Password
                </Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
