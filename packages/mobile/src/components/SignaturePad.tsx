/**
 * Proof-of-collection Phase 1 (2026-07-15): signature capture UI.
 *
 * Wraps `react-native-signature-canvas` (WebView-based; uses the
 * signature_pad JS lib inside). Chosen over react-native alternatives
 * for maturity + Expo SDK 54 compatibility + Expo managed-workflow
 * support (no native code required).
 *
 * Design decisions:
 *  - Base64 PNG data (not SVG paths) — matches what pdfkit's doc.image()
 *    can embed directly, and what the S3 pre-signed PUT expects for the
 *    "image/png" content-type.
 *  - Paired phone input (signingPartyPhone) rendered below the canvas —
 *    both fields are required for a signature-type proof, so keeping
 *    them in one component prevents partial-submission mistakes.
 *  - The parent owns the "capture pending → captured" state; this
 *    component just fires callbacks. Keeps the driver-orders modal in
 *    control of when the Confirm-Delivery button unlocks.
 */
import React, { useRef, useState } from 'react';
import { View, Text, TouchableOpacity, TextInput } from 'react-native';
import Signature, { type SignatureViewRef } from 'react-native-signature-canvas';

export interface SignaturePadProps {
  onCapture: (pngBase64: string) => void;
  onClear: () => void;
  signingPartyPhone: string;
  onPhoneChange: (phone: string) => void;
  phoneError?: string;
}

// WebView styling for the signature_pad content — no toolbar, plain
// white canvas, black ink. Keeps the pad legible on any theme.
const WEB_STYLE = `
  .m-signature-pad--footer { display: none; margin: 0; }
  body,html { height: 100%; margin: 0; padding: 0; background: #fff; }
  .m-signature-pad { position: absolute; inset: 0; box-shadow: none; border: none; }
  .m-signature-pad--body { border: 1px solid #d1d5db; border-radius: 8px; }
`;

export function SignaturePad({
  onCapture,
  onClear,
  signingPartyPhone,
  onPhoneChange,
  phoneError,
}: SignaturePadProps) {
  const ref = useRef<SignatureViewRef>(null);
  const [captured, setCaptured] = useState(false);

  // Called by the lib when readSignature() resolves — that's how we get
  // the PNG bytes back. Empty guard prevents "confirming" a blank pad.
  const handleOK = (signatureDataUri: string) => {
    // signatureDataUri is `data:image/png;base64,iVBORw0K...` — strip the
    // prefix so callers get bare base64. Keeps the S3 fetch/blob code
    // simpler on the calling side.
    const prefix = 'data:image/png;base64,';
    const base64 = signatureDataUri.startsWith(prefix)
      ? signatureDataUri.slice(prefix.length)
      : signatureDataUri;
    setCaptured(true);
    onCapture(base64);
  };

  const handleEmpty = () => {
    setCaptured(false);
    onClear();
  };

  const handleClearPress = () => {
    ref.current?.clearSignature();
    setCaptured(false);
    onClear();
  };

  const handleConfirmPress = () => {
    // Fires either onOK (if signed) or onEmpty (if blank).
    ref.current?.readSignature();
  };

  return (
    <View style={{ gap: 12 }}>
      <View style={{ height: 180, borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8, overflow: 'hidden' }}>
        <Signature
          ref={ref}
          onOK={handleOK}
          onEmpty={handleEmpty}
          webStyle={WEB_STYLE}
          backgroundColor="#ffffff"
          penColor="#111827"
          descriptionText=""
          autoClear={false}
        />
      </View>

      <View style={{ flexDirection: 'row', gap: 12 }}>
        <TouchableOpacity
          onPress={handleClearPress}
          style={{ flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#d1d5db', alignItems: 'center' }}
        >
          <Text style={{ color: '#111827', fontWeight: '500' }}>Clear</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleConfirmPress}
          style={{ flex: 2, paddingVertical: 10, borderRadius: 8, backgroundColor: captured ? '#059669' : '#0a3d62', alignItems: 'center' }}
        >
          <Text style={{ color: '#ffffff', fontWeight: '600' }}>
            {captured ? '✓ Signature captured' : 'Capture signature'}
          </Text>
        </TouchableOpacity>
      </View>

      <View>
        <Text style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
          Signing party mobile number
        </Text>
        <TextInput
          value={signingPartyPhone}
          onChangeText={onPhoneChange}
          placeholder="e.g. 9876543210"
          keyboardType="phone-pad"
          maxLength={15}
          style={{
            borderWidth: 1,
            borderColor: phoneError ? '#dc2626' : '#d1d5db',
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 10,
            fontSize: 15,
            color: '#111827',
            backgroundColor: '#ffffff',
          }}
        />
        {phoneError ? (
          <Text style={{ fontSize: 12, color: '#dc2626', marginTop: 4 }}>{phoneError}</Text>
        ) : null}
      </View>
    </View>
  );
}
