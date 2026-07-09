/**
 * ChangePasswordModal — Item 3 (docs/INVESTIGATION-JUL09-B.md).
 *
 * Reusable modal wrapping a current-/new-/confirm-password form.
 * Shared by:
 *   - src/screens/ProfileScreen.tsx  (admin / finance / inventory)
 *   - app/(driver)/more.tsx          (driver More menu)
 *   - app/(customer)/account.tsx     (customer Account settings)
 *
 * The forced-reset screen at app/(auth)/force-password-reset.tsx uses the
 * same POST /auth/change-password endpoint but with a different UX (full
 * screen, no dismiss, forced) — that flow is intentionally left separate.
 *
 * Same client-side validation rules as the forced-reset screen (min 8
 * chars + new ≠ current + confirm match). All submit errors surface
 * inline; API errors ("Current password is incorrect" etc.) come back
 * from the shared error extractor.
 *
 * Item 4 side-effect: /auth/change-password revokes every refresh session
 * for the user. The caller doesn't need to do anything — the user's next
 * refresh on any OTHER device will 401 → interceptor logs them out there.
 * The device that just changed the password keeps its access token until
 * next 401, then re-authenticates cleanly. Feature-flag-safe.
 */
import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, getErrorMessage } from '../lib/api';
import { useTheme } from '../theme';

export function ChangePasswordModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { dark, colors, accent: accentPalette } = useTheme();
  // Same accent as the forced-reset screen so the "security context" reads
  // consistently across both flows.
  const accent = accentPalette.red;

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setShowCurrent(false);
    setShowNew(false);
    setError(null);
    setSubmitting(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

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
      // Server clears requiresPasswordReset + revokes all sessions on
      // success. On this device, the access token stays valid until it
      // naturally expires (~15 min); the axios interceptor's refresh
      // path on next 401 will re-authenticate the user cleanly.
      Alert.alert('Success', 'Password updated successfully.');
      reset();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.4)',
          justifyContent: 'center',
          padding: 24,
        }}
      >
        <View
          style={{
            width: '100%',
            maxWidth: 420,
            alignSelf: 'center',
            backgroundColor: colors.cardBg,
            borderRadius: 14,
            padding: 20,
          }}
        >
          <ScrollView keyboardShouldPersistTaps="handled">
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <Ionicons name="key-outline" size={20} color={accent} style={{ marginRight: 8 }} />
              <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text, flex: 1 }}>
                Change Password
              </Text>
              <TouchableOpacity onPress={handleClose} hitSlop={12}>
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            {/* Current */}
            <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 6 }}>
              Current Password
            </Text>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: dark ? colors.inputBg : '#f8fafc',
                borderRadius: 10,
                borderWidth: 1,
                borderColor: colors.divider,
                paddingHorizontal: 12,
                marginBottom: 14,
              }}
            >
              <TextInput
                value={currentPassword}
                onChangeText={setCurrentPassword}
                secureTextEntry={!showCurrent}
                autoCapitalize="none"
                placeholder="Enter your current password"
                placeholderTextColor={colors.textMuted}
                style={{ flex: 1, paddingVertical: 12, color: colors.text, fontSize: 15 }}
              />
              <TouchableOpacity onPress={() => setShowCurrent((v) => !v)} hitSlop={8}>
                <Ionicons name={showCurrent ? 'eye-off-outline' : 'eye-outline'} size={20} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            {/* New */}
            <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 6 }}>
              New Password (min 8 characters)
            </Text>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: dark ? colors.inputBg : '#f8fafc',
                borderRadius: 10,
                borderWidth: 1,
                borderColor: colors.divider,
                paddingHorizontal: 12,
                marginBottom: 14,
              }}
            >
              <TextInput
                value={newPassword}
                onChangeText={setNewPassword}
                secureTextEntry={!showNew}
                autoCapitalize="none"
                placeholder="Choose a new password"
                placeholderTextColor={colors.textMuted}
                style={{ flex: 1, paddingVertical: 12, color: colors.text, fontSize: 15 }}
              />
              <TouchableOpacity onPress={() => setShowNew((v) => !v)} hitSlop={8}>
                <Ionicons name={showNew ? 'eye-off-outline' : 'eye-outline'} size={20} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            {/* Confirm */}
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
                marginBottom: 16,
              }}
            />

            {error && (
              <View
                style={{
                  backgroundColor: '#fef2f2',
                  borderRadius: 10,
                  padding: 12,
                  marginBottom: 12,
                  borderWidth: 1,
                  borderColor: '#fecaca',
                }}
              >
                <Text style={{ color: '#b91c1c', fontSize: 13 }}>{error}</Text>
              </View>
            )}

            <View style={{ flexDirection: 'row', gap: 12 }}>
              <TouchableOpacity
                onPress={handleClose}
                disabled={submitting}
                style={{
                  flex: 1,
                  backgroundColor: dark ? colors.cardBg : '#f1f5f9',
                  borderWidth: 1,
                  borderColor: colors.divider,
                  borderRadius: 10,
                  paddingVertical: 12,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: colors.text, fontWeight: '600', fontSize: 15 }}>
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSubmit}
                disabled={submitting}
                style={{
                  flex: 1,
                  backgroundColor: accent,
                  borderRadius: 10,
                  paddingVertical: 12,
                  alignItems: 'center',
                  opacity: submitting ? 0.6 : 1,
                }}
              >
                {submitting ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>
                    Update
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
