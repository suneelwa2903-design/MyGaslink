import { CameraView, useCameraPermissions } from 'expo-camera';

export { CameraView, useCameraPermissions };

// Re-export for convenience — actual camera UI is built into the delivery screen component
export const PHOTO_OPTIONS = {
  quality: 0.7,
  base64: false,
  exif: false,
} as const;
