/**
 * Screen 2 of the deletion flow (IOS-ACCOUNT-DELETION-SPEC §6.2).
 * Disclosure copy is locked at spec §7 — DO NOT paraphrase.
 */
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../../src/theme';

export default function DeleteAccountDisclosure() {
  const router = useRouter();
  const { colors } = useTheme();

  return (
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12 }}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>Delete Your Account</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
        <Text style={{ fontSize: 15, lineHeight: 22, color: colors.text, marginBottom: 16 }}>
          Your account deletion request will be submitted. Your personal information — name, email,
          phone, address, and photo — will be removed within 30 days.
        </Text>
        <Text style={{ fontSize: 15, lineHeight: 22, color: colors.text, marginBottom: 16 }}>
          You can cancel this request anytime in those 30 days by logging in.
        </Text>
        <Text style={{ fontSize: 15, lineHeight: 22, color: colors.text, marginBottom: 16 }}>
          After 30 days, as required by Indian Income Tax and GST law, your invoice and payment
          history will be retained anonymously for 8 years. Anonymized records are linked to a
          random ID — not to you — and are used only for statutory tax compliance and audit, never
          for marketing or analytics.
        </Text>
        <Text style={{ fontSize: 15, lineHeight: 22, color: colors.text, marginBottom: 16 }}>
          After 8 years, all records will be permanently deleted.
        </Text>
        <Text style={{ fontSize: 15, lineHeight: 22, color: '#dc2626', fontWeight: '700', marginBottom: 24 }}>
          This cannot be undone after 30 days.
        </Text>

        <View style={{ flexDirection: 'row', gap: 12 }}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={{
              flex: 1,
              paddingVertical: 14,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: colors.cardBorder,
              alignItems: 'center',
            }}
          >
            <Text style={{ color: colors.text, fontWeight: '600' }}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.push('/(shared)/delete-account/confirm')}
            style={{
              flex: 1,
              paddingVertical: 14,
              borderRadius: 10,
              backgroundColor: '#dc2626',
              alignItems: 'center',
            }}
          >
            <Text style={{ color: '#ffffff', fontWeight: '700' }}>Continue</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
