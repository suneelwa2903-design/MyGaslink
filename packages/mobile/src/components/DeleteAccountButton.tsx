import { useState } from 'react';
import { View, Text, TouchableOpacity, Modal, Linking, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme';

const DELETION_EMAIL = 'info@mygaslink.com';
const DELETION_SUBJECT = 'Account Deletion Request';
const DELETION_BODY_TEMPLATE =
  'Hello MyGasLink team,\n\nPlease delete my MyGasLink account and all associated personal data.\n\nRegistered email: \nRegistered phone: \n\nThank you.';

/**
 * M14 — Account deletion entry point.
 *
 * Google Play Data Safety + India's DPDP Act 2023 both require an in-app
 * path for users to request deletion of their account and personal data.
 * The privacy policy at mygaslink.com/privacy declares info@mygaslink.com
 * as the deletion contact, so the modal points the user there with a
 * pre-filled mailto: link and a clipboard fallback for users without a
 * configured mail app.
 *
 * The actual deletion is processed off-app within 30 days per the policy
 * (and the body of the modal repeats that promise so the user knows what
 * to expect). Keeping the operation off-app means no extra API surface,
 * no authentication races between deletion and active sessions, and no
 * risk of a partial-delete leaving orphaned tenant data behind.
 */
export function DeleteAccountButton({
  variant = 'card',
  style,
}: {
  variant?: 'card' | 'inline';
  style?: object;
}) {
  const { dark, colors } = useTheme();
  const [open, setOpen] = useState(false);

  const handleOpenMail = async () => {
    const url = `mailto:${DELETION_EMAIL}?subject=${encodeURIComponent(DELETION_SUBJECT)}&body=${encodeURIComponent(DELETION_BODY_TEMPLATE)}`;
    try {
      const can = await Linking.canOpenURL(url);
      if (!can) {
        Alert.alert(
          'No mail app',
          `Please email ${DELETION_EMAIL} with subject "${DELETION_SUBJECT}" from your preferred mail client.`,
        );
        return;
      }
      await Linking.openURL(url);
    } catch {
      Alert.alert(
        'Could not open mail app',
        `Please email ${DELETION_EMAIL} with subject "${DELETION_SUBJECT}".`,
      );
    }
  };

  const trigger =
    variant === 'inline' ? (
      <TouchableOpacity
        onPress={() => setOpen(true)}
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
    ) : (
      <TouchableOpacity
        onPress={() => setOpen(true)}
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
    );

  return (
    <>
      {trigger}
      <Modal
        visible={open}
        animationType="fade"
        transparent
        statusBarTranslucent
        onRequestClose={() => setOpen(false)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.5)',
            justifyContent: 'center',
            paddingHorizontal: 24,
          }}
        >
          <View
            style={{
              backgroundColor: dark ? colors.cardBg : '#ffffff',
              borderRadius: 18,
              padding: 24,
              borderWidth: 1,
              borderColor: colors.cardBorder,
            }}
          >
            <View
              style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}
            >
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  backgroundColor: dark ? 'rgba(239,68,68,0.15)' : '#fee2e2',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ionicons name="trash-outline" size={18} color="#ef4444" />
              </View>
              <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, flex: 1 }}>
                Delete Account
              </Text>
            </View>

            <Text style={{ fontSize: 14, color: colors.textSecondary, lineHeight: 20 }}>
              To delete your MyGasLink account and all associated personal data, email us with
              the subject{' '}
              <Text style={{ fontWeight: '700', color: colors.text }}>
                {`"${DELETION_SUBJECT}"`}
              </Text>
              . We will process your request within 30 days as described in our Privacy Policy.
            </Text>

            <View
              style={{
                marginTop: 16,
                marginBottom: 20,
                paddingVertical: 12,
                paddingHorizontal: 14,
                backgroundColor: dark ? colors.inputBg : '#f8fafc',
                borderRadius: 10,
                borderWidth: 1,
                borderColor: colors.cardBorder,
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>
                {DELETION_EMAIL}
              </Text>
            </View>

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                onPress={() => setOpen(false)}
                style={{
                  flex: 1,
                  paddingVertical: 12,
                  borderRadius: 10,
                  backgroundColor: dark ? colors.inputBg : '#f1f5f9',
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleOpenMail}
                style={{
                  flex: 1,
                  paddingVertical: 12,
                  borderRadius: 10,
                  backgroundColor: '#ef4444',
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#ffffff' }}>
                  Email Now
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}
