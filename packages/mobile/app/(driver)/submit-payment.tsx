/**
 * WI-PENDING-PAYMENTS — driver self-reports a payment collected at delivery.
 *
 * Entry point: tap "Submit Payment" on an order row in (driver)/orders.tsx.
 * Submits via POST /api/drivers/me/payment-submissions, landing as a
 * pending_verification PaymentSubmission. Office staff verify in the
 * web/mobile Pending Approval tab.
 *
 * Receipt photo flow (optional): camera → S3 presigned PUT URL → finalUrl
 * stored on the submission. Bypasses the API for the bytes themselves.
 */
import { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Alert,
  Image,
  Modal,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useLocalSearchParams, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, ACCENT } from '../../src/theme';
import { Button } from '../../src/components/ui';
import { apiPost, getErrorMessage } from '../../src/lib/api';
import { CameraView, useCameraPermissions } from '../../src/services/camera';

type Method = 'cash' | 'upi' | 'bank_transfer' | 'cheque' | 'online';
const METHODS: { value: Method; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'online', label: 'Online' },
];

export default function DriverSubmitPaymentScreen() {
  const { dark, colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{
    customerId?: string;
    customerName?: string;
    orderId?: string;
    prefillAmount?: string;
  }>();

  const [amount, setAmount] = useState(params.prefillAmount ?? '');
  const [method, setMethod] = useState<Method>('cash');
  const [transactionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [referenceNumber, setReferenceNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(null);

  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const customerId = params.customerId ?? '';
  const customerName = params.customerName ?? 'Customer';

  if (!customerId) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg, padding: 16 }}>
        <Text style={{ color: colors.text }}>Missing customer context — go back and reopen from an order.</Text>
        <Button title="Back" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  const handleTakePhoto = async () => {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        Alert.alert('Camera permission denied', 'Enable camera access in Settings to attach a receipt photo.');
        return;
      }
    }
    setCameraOpen(true);
  };

  const handlePhotoCaptured = async (uri: string) => {
    setCameraOpen(false);
    try {
      setUploading(true);
      const urls = await apiPost<{ uploadUrl: string; finalUrl: string }>(
        '/drivers/me/payment-submissions/attachment-upload-url',
        {},
      );
      // fetch the local file bytes and PUT to the presigned URL
      const fileRes = await fetch(uri);
      const blob = await fileRes.blob();
      const putRes = await fetch(urls.uploadUrl, {
        method: 'PUT',
        body: blob,
        headers: { 'Content-Type': 'image/jpeg' },
      });
      if (!putRes.ok) throw new Error('S3 upload failed');
      setAttachmentUrl(urls.finalUrl);
    } catch (err) {
      Alert.alert('Upload failed', getErrorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async () => {
    const amt = Number(amount);
    if (!(amt > 0)) {
      Alert.alert('Invalid amount', 'Enter an amount greater than zero.');
      return;
    }
    try {
      setSubmitting(true);
      await apiPost('/drivers/me/payment-submissions', {
        customerId,
        amount: amt,
        paymentMethod: method,
        transactionDate,
        referenceNumber: referenceNumber || undefined,
        notes: notes || undefined,
        attachmentUrl: attachmentUrl || undefined,
      });
      Alert.alert('Submitted', 'Payment submitted for verification.', [
        {
          text: 'OK',
          onPress: () => {
            queryClient.invalidateQueries({ queryKey: ['driver-payment-submissions'] });
            router.back();
          },
        },
      ]);
    } catch (err) {
      Alert.alert('Submission failed', getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: 'Submit Payment', headerShown: true }} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 12 }}>
          <View style={cardStyle(colors)}>
            <Text style={{ fontSize: 13, color: colors.textSecondary }}>Customer</Text>
            <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text, marginTop: 2 }}>
              {customerName}
            </Text>
          </View>

          <View style={cardStyle(colors)}>
            <Text style={labelStyle(colors)}>Amount (₹)</Text>
            <TextInput
              keyboardType="decimal-pad"
              value={amount}
              onChangeText={setAmount}
              placeholder="0.00"
              placeholderTextColor={colors.textMuted}
              style={inputStyle(colors)}
            />
          </View>

          <View style={cardStyle(colors)}>
            <Text style={labelStyle(colors)}>Payment Method</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              {METHODS.map((m) => {
                const active = m.value === method;
                return (
                  <TouchableOpacity
                    key={m.value}
                    onPress={() => setMethod(m.value)}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      borderRadius: 8,
                      borderWidth: 1,
                      backgroundColor: active ? ACCENT.blue : 'transparent',
                      borderColor: active ? ACCENT.blue : colors.cardBorder,
                    }}
                  >
                    <Text style={{ color: active ? '#fff' : colors.text, fontWeight: '600' }}>
                      {m.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={cardStyle(colors)}>
            <Text style={labelStyle(colors)}>Reference / UTR (optional)</Text>
            <TextInput
              value={referenceNumber}
              onChangeText={setReferenceNumber}
              placeholder="UPI ref / cheque no."
              placeholderTextColor={colors.textMuted}
              style={inputStyle(colors)}
            />
          </View>

          <View style={cardStyle(colors)}>
            <Text style={labelStyle(colors)}>Notes (optional)</Text>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={3}
              placeholder="Any additional context"
              placeholderTextColor={colors.textMuted}
              style={[inputStyle(colors), { height: 80, textAlignVertical: 'top' }]}
            />
          </View>

          <View style={cardStyle(colors)}>
            <Text style={labelStyle(colors)}>Receipt photo (optional)</Text>
            {attachmentUrl ? (
              <View style={{ marginTop: 8, gap: 8 }}>
                <Image source={{ uri: attachmentUrl }} style={{ width: '100%', height: 160, borderRadius: 8 }} resizeMode="cover" />
                <Button title="Remove" variant="secondary" size="sm" onPress={() => setAttachmentUrl(null)} />
              </View>
            ) : (
              <TouchableOpacity
                onPress={handleTakePhoto}
                disabled={uploading}
                style={{
                  marginTop: 8,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  borderWidth: 1,
                  borderStyle: 'dashed',
                  borderColor: colors.cardBorder,
                  borderRadius: 8,
                  padding: 14,
                  justifyContent: 'center',
                }}
              >
                <Ionicons name="camera-outline" size={20} color={colors.textSecondary} />
                <Text style={{ color: colors.textSecondary, fontWeight: '600' }}>
                  {uploading ? 'Uploading…' : 'Take a photo'}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          <View style={{ marginTop: 8 }}>
            <Button
              title={submitting ? 'Submitting…' : 'Submit for Verification'}
              variant="primary"
              onPress={handleSubmit}
              disabled={submitting || uploading || !(Number(amount) > 0)}
            />
          </View>
          <Text style={{ fontSize: 12, color: colors.textMuted, textAlign: 'center' }}>
            Your submission goes to the office for verification before posting to the customer's account.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal visible={cameraOpen} animationType="slide" presentationStyle="fullScreen">
        <ReceiptCameraScreen
          onCapture={handlePhotoCaptured}
          onCancel={() => setCameraOpen(false)}
        />
      </Modal>
    </SafeAreaView>
  );
}

function ReceiptCameraScreen({
  onCapture,
  onCancel,
}: {
  onCapture: (uri: string) => void;
  onCancel: () => void;
}) {
  const [cameraRef, setCameraRef] = useState<React.ComponentRef<typeof CameraView> | null>(null);
  const [capturing, setCapturing] = useState(false);

  const handleTake = async () => {
    if (!cameraRef || capturing) return;
    try {
      setCapturing(true);
      const photo = await (cameraRef as unknown as {
        takePictureAsync: (opts: { quality: number; base64: boolean }) => Promise<{ uri: string }>;
      }).takePictureAsync({ quality: 0.7, base64: false });
      onCapture(photo.uri);
    } catch (err) {
      Alert.alert('Capture failed', String(err));
    } finally {
      setCapturing(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        ref={(r) => setCameraRef(r)}
        style={{ flex: 1 }}
        facing="back"
      />
      <SafeAreaView edges={['bottom']} style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: 24 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <TouchableOpacity onPress={onCancel} style={{ padding: 12 }}>
            <Ionicons name="close" size={32} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleTake}
            disabled={capturing}
            style={{
              width: 72,
              height: 72,
              borderRadius: 36,
              backgroundColor: '#fff',
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 4,
              borderColor: '#000',
              opacity: capturing ? 0.5 : 1,
            }}
          >
            <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: '#fff' }} />
          </TouchableOpacity>
          <View style={{ width: 56 }} />
        </View>
      </SafeAreaView>
    </View>
  );
}

const cardStyle = (colors: { cardBg: string; cardBorder: string }) => ({
  backgroundColor: colors.cardBg,
  borderRadius: 12,
  borderWidth: 1,
  borderColor: colors.cardBorder,
  padding: 14,
});

const labelStyle = (colors: { textSecondary: string }) => ({
  fontSize: 12,
  color: colors.textSecondary,
  fontWeight: '600' as const,
  letterSpacing: 0.3,
  textTransform: 'uppercase' as const,
});

const inputStyle = (colors: { text: string; cardBorder: string }) => ({
  marginTop: 6,
  borderWidth: 1,
  borderColor: colors.cardBorder,
  borderRadius: 8,
  padding: 10,
  fontSize: 16,
  color: colors.text,
});
