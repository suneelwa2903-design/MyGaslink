import { useState, useRef } from 'react';
import { View, Text, TouchableOpacity, Image, Modal } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Button } from './ui';

interface DeliveryProofCameraProps {
  visible: boolean;
  onCapture: (uri: string) => void;
  onClose: () => void;
}

export function DeliveryProofCamera({ visible, onCapture, onClose }: DeliveryProofCameraProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [photo, setPhoto] = useState<string | null>(null);
  const cameraRef = useRef<CameraView>(null);

  const handleTakePhoto = async () => {
    if (!cameraRef.current) return;
    const result = await cameraRef.current.takePictureAsync({
      quality: 0.7,
      base64: false,
    });
    if (result?.uri) {
      setPhoto(result.uri);
    }
  };

  const handleConfirm = () => {
    if (photo) {
      onCapture(photo);
      setPhoto(null);
    }
  };

  const handleRetake = () => {
    setPhoto(null);
  };

  const handleClose = () => {
    setPhoto(null);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide">
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {/* Header */}
        <View style={{
          paddingTop: 50, paddingHorizontal: 16, paddingBottom: 12,
          flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
          backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 10,
        }}>
          <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>Delivery Proof</Text>
          <TouchableOpacity onPress={handleClose}>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>Cancel</Text>
          </TouchableOpacity>
        </View>

        {!permission?.granted ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <Text style={{ color: '#fff', fontSize: 16, textAlign: 'center', marginBottom: 16 }}>
              Camera permission is required to take delivery proof photos.
            </Text>
            <Button title="Grant Permission" onPress={requestPermission} />
          </View>
        ) : photo ? (
          /* Photo Preview */
          <View style={{ flex: 1 }}>
            <Image source={{ uri: photo }} style={{ flex: 1 }} resizeMode="contain" />
            <View style={{
              flexDirection: 'row', gap: 12, padding: 24,
              backgroundColor: 'rgba(0,0,0,0.6)',
            }}>
              <View style={{ flex: 1 }}>
                <Button title="Retake" variant="secondary" onPress={handleRetake} />
              </View>
              <View style={{ flex: 1 }}>
                <Button title="Use Photo" variant="accent" onPress={handleConfirm} />
              </View>
            </View>
          </View>
        ) : (
          /* Camera View */
          <View style={{ flex: 1 }}>
            <CameraView
              ref={cameraRef}
              style={{ flex: 1 }}
              facing="back"
            >
              {/* Crosshair guide */}
              <View style={{
                flex: 1, alignItems: 'center', justifyContent: 'center',
              }}>
                <View style={{
                  width: 250, height: 250, borderWidth: 2, borderColor: 'rgba(255,255,255,0.3)',
                  borderRadius: 16,
                }} />
                <Text style={{
                  color: 'rgba(255,255,255,0.6)', fontSize: 13, marginTop: 12,
                  fontWeight: '500',
                }}>
                  Align delivery items in frame
                </Text>
              </View>
            </CameraView>

            {/* Capture Button */}
            <View style={{
              padding: 24, alignItems: 'center',
              backgroundColor: 'rgba(0,0,0,0.6)',
            }}>
              <TouchableOpacity
                onPress={handleTakePhoto}
                style={{
                  width: 72, height: 72, borderRadius: 36,
                  backgroundColor: '#fff', borderWidth: 4, borderColor: '#338dff',
                  alignItems: 'center', justifyContent: 'center',
                }}
                activeOpacity={0.7}
              >
                <View style={{
                  width: 56, height: 56, borderRadius: 28,
                  backgroundColor: '#338dff',
                }} />
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}
