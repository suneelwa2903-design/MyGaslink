/**
 * Proof-of-collection Phase 2 (2026-07-15): photo capture UI.
 *
 * Rear-camera viewfinder → takePictureAsync (quality 0.7) → manipulateAsync
 * resize to max 1200px wide at JPEG 70% (typical 30-80KB) → presigned S3
 * PUT → onCapture(s3Key). Retake option before the parent accepts.
 *
 * Upload runs entirely inside this component (unlike signature where the
 * base64 is captured on the pad and the parent kicks off upload) because
 * the compressed JPEG is too large to hold in React state comfortably
 * and we want tight coupling between capture UI, upload progress, and
 * retake affordance.
 *
 * Offline handling: the parent (driver orders screen) hides the Photo
 * tab when offline. This component assumes connectivity is present;
 * if the presigned-URL fetch or S3 PUT fails, onError fires and the
 * user retakes.
 */
import { useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Linking } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import { apiPost } from '../lib/api';
import { uploadToPresignedUrl } from '../services/s3Upload';

export interface PhotoCaptureProps {
  onCapture: (s3Key: string) => void;
  onError: (message: string) => void;
  orderId: string;
}

type Stage = 'viewfinder' | 'preview' | 'uploading';

export function PhotoCapture({ onCapture, onError, orderId }: PhotoCaptureProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [stage, setStage] = useState<Stage>('viewfinder');
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [cameraRef, setCameraRef] = useState<CameraView | null>(null);

  // Permission state — 3 branches: undetermined (initial), granted, denied.
  if (!permission) {
    // useCameraPermissions is still loading the initial status.
    return (
      <View style={{ paddingVertical: 24, alignItems: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={{ paddingVertical: 20, gap: 12 }}>
        <Text style={{ color: '#111827', fontSize: 14, fontWeight: '500' }}>
          Camera permission required
        </Text>
        <Text style={{ color: '#6b7280', fontSize: 13 }}>
          MyGasLink needs camera access to capture proof-of-delivery photos.
        </Text>
        {permission.canAskAgain ? (
          <TouchableOpacity
            onPress={() => { void requestPermission(); }}
            style={{ paddingVertical: 10, borderRadius: 8, backgroundColor: '#0a3d62', alignItems: 'center' }}
          >
            <Text style={{ color: '#ffffff', fontWeight: '600' }}>Allow camera</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            onPress={() => { void Linking.openSettings(); }}
            style={{ paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#0a3d62', alignItems: 'center' }}
          >
            <Text style={{ color: '#0a3d62', fontWeight: '600' }}>Open Settings</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  async function handleShoot() {
    if (!cameraRef) return;
    try {
      const shot = await cameraRef.takePictureAsync({ quality: 0.7, skipProcessing: false });
      if (!shot?.uri) {
        onError('Camera returned no image. Please try again.');
        return;
      }
      setPreviewUri(shot.uri);
      setStage('preview');
    } catch (err) {
      onError((err as Error).message || 'Camera capture failed.');
    }
  }

  async function handleConfirm() {
    if (!previewUri) return;
    setStage('uploading');
    try {
      // Client-side resize + recompress. Max 1200px on the long edge,
      // JPEG 70% — typically lands at 30-80KB per plan §B recommendation.
      const compressed = await ImageManipulator.manipulateAsync(
        previewUri,
        [{ resize: { width: 1200 } }],
        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG },
      );

      // 1. Presigned URL from server (validates order + driver + flag).
      const presigned = await apiPost<{ uploadUrl: string; finalUrl: string; s3Key: string }>(
        `/orders/${orderId}/delivery-proof-upload-url`,
        { proofType: 'photo' },
      );

      // 2. Fetch the compressed image into a Blob for PUT.
      const imgRes = await fetch(compressed.uri);
      const blob = await imgRes.blob();

      // 3. S3 PUT (Content-Type must match what the URL was signed for).
      await uploadToPresignedUrl(presigned.uploadUrl, blob, 'image/jpeg');

      onCapture(presigned.s3Key);
    } catch (err) {
      onError((err as Error).message || 'Failed to upload photo. Try again.');
      // Return to preview so the driver can retry without re-capturing.
      setStage('preview');
    }
  }

  function handleRetake() {
    setPreviewUri(null);
    setStage('viewfinder');
  }

  if (stage === 'viewfinder') {
    return (
      <View style={{ gap: 10 }}>
        <View style={{ height: 300, borderRadius: 8, overflow: 'hidden', backgroundColor: '#000' }}>
          <CameraView
            ref={(r) => setCameraRef(r)}
            style={{ flex: 1 }}
            facing="back"
          />
        </View>
        <TouchableOpacity
          onPress={handleShoot}
          style={{ paddingVertical: 14, borderRadius: 8, backgroundColor: '#0a3d62', alignItems: 'center' }}
        >
          <Text style={{ color: '#ffffff', fontWeight: '600', fontSize: 15 }}>Take Photo</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // stage === 'preview' or 'uploading' — same layout, buttons swap.
  return (
    <View style={{ gap: 10 }}>
      <View style={{ height: 300, borderRadius: 8, overflow: 'hidden', backgroundColor: '#000' }}>
        {/* Preview the captured shot before upload — driver can retake if blurry. */}
        {previewUri ? (
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          <ImagePreview uri={previewUri} />
        ) : null}
      </View>
      {stage === 'uploading' ? (
        <View style={{ paddingVertical: 14, borderRadius: 8, backgroundColor: '#e5e7eb', alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 10 }}>
          <ActivityIndicator color="#0a3d62" />
          <Text style={{ color: '#111827', fontWeight: '500' }}>Uploading photo…</Text>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <TouchableOpacity
            onPress={handleRetake}
            style={{ flex: 1, paddingVertical: 12, borderRadius: 8, borderWidth: 1, borderColor: '#d1d5db', alignItems: 'center' }}
          >
            <Text style={{ color: '#111827', fontWeight: '500' }}>Retake</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleConfirm}
            style={{ flex: 2, paddingVertical: 12, borderRadius: 8, backgroundColor: '#0a3d62', alignItems: 'center' }}
          >
            <Text style={{ color: '#ffffff', fontWeight: '600' }}>Upload photo</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

/**
 * Tiny preview subview — split out so react-native's <Image> import is
 * scoped to just the preview branch (viewfinder branch renders CameraView
 * over the same area).
 */
function ImagePreview({ uri }: { uri: string }) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Image } = require('react-native') as typeof import('react-native');
  return <Image source={{ uri }} style={{ flex: 1 }} resizeMode="cover" />;
}
