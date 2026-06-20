/**
 * Screen 3 of the deletion flow (IOS-ACCOUNT-DELETION-SPEC §6.3).
 * Force-typed confirmation — submit only enabled on exact match.
 */
import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../../src/theme';
import { submitDeletionRequest, getErrorMessage } from '../../../src/api/account';

const REQUIRED_TEXT = 'DELETE MY ACCOUNT';

export default function DeleteAccountConfirm() {
  const router = useRouter();
  const { colors } = useTheme();
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const enabled = typed === REQUIRED_TEXT && !submitting;

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await submitDeletionRequest(reason.trim() || undefined);
      router.replace('/(shared)/delete-account/success');
    } catch (err: unknown) {
      // Spec §6.8 — surface 423 / 409 codes inline.
      const e = err as { response?: { status?: number; data?: { code?: string; error?: string } } };
      const code = e?.response?.data?.code;
      if (code === 'SOLE_ADMIN_BLOCK') {
        Alert.alert('Cannot delete', 'You are the only admin for this distributor. Please add a second admin before deleting your account.');
      } else if (code === 'SUPERADMIN_SELF_DELETE_BLOCKED') {
        Alert.alert('Cannot delete', 'Super-admin accounts cannot be self-deleted. Contact another super-admin.');
      } else if (code === 'OUTSTANDING_BALANCE') {
        Alert.alert('Outstanding balance', getErrorMessage(err));
      } else {
        Alert.alert('Something went wrong', getErrorMessage(err));
      }
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12 }}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={12} disabled={submitting}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>Final Confirmation</Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
          <Text style={{ fontSize: 15, lineHeight: 22, color: colors.text, marginBottom: 16 }}>
            Type <Text style={{ fontWeight: '700' }}>{REQUIRED_TEXT}</Text> below to confirm. You can
            cancel this request within 30 days.
          </Text>
          <TextInput
            value={typed}
            onChangeText={setTyped}
            placeholder={REQUIRED_TEXT}
            placeholderTextColor={colors.textMuted}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!submitting}
            style={{
              borderWidth: 1,
              borderColor: typed === REQUIRED_TEXT ? '#dc2626' : colors.cardBorder,
              borderRadius: 10,
              padding: 12,
              fontSize: 16,
              color: colors.text,
              marginBottom: 20,
            }}
          />
          <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 6 }}>
            Reason (optional)
          </Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="Help us understand why you're leaving"
            placeholderTextColor={colors.textMuted}
            multiline
            numberOfLines={3}
            maxLength={500}
            editable={!submitting}
            style={{
              borderWidth: 1,
              borderColor: colors.cardBorder,
              borderRadius: 10,
              padding: 12,
              minHeight: 80,
              fontSize: 14,
              color: colors.text,
              marginBottom: 24,
              textAlignVertical: 'top',
            }}
          />
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <TouchableOpacity
              onPress={() => router.back()}
              disabled={submitting}
              style={{
                flex: 1,
                paddingVertical: 14,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: colors.cardBorder,
                alignItems: 'center',
                opacity: submitting ? 0.5 : 1,
              }}
            >
              <Text style={{ color: colors.text, fontWeight: '600' }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={!enabled}
              style={{
                flex: 1,
                paddingVertical: 14,
                borderRadius: 10,
                backgroundColor: enabled ? '#dc2626' : colors.cardBorder,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: '#ffffff', fontWeight: '700' }}>
                {submitting ? 'Submitting…' : 'Submit'}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
