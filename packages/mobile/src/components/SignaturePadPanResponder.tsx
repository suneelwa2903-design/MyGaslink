/**
 * Signature capture — PanResponder + Views (Path C, 2026-07-16).
 *
 * Replaces SignaturePadModal.tsx entirely. WebView + signature_pad.js
 * was producing dots-only on Android for reasons that never surfaced
 * (WebView touchmove suppression + HTML cache + host of other quirks —
 * see the last five commits). Path C sidesteps the entire class of
 * problems by not rendering signature capture through a WebView at all.
 *
 * Capture:
 *   - RN PanResponder tracks {x, y} coords on every touch move.
 *   - Points are pushed into a mutable ref (no re-render per point).
 *   - A `nudge` counter in state triggers a re-render every 4 points
 *     so the visible stroke updates in near-real-time while the driver
 *     is drawing.
 *
 * Rendering:
 *   - Each stroke is drawn as a series of short absolutely-positioned
 *     <View> rectangles between consecutive points. The rectangle is
 *     rotated to match the angle from p_i → p_{i+1}. A round-ish
 *     "cap" dot is drawn at every point to cover joints.
 *   - Zero SVG / canvas / native modules — pure RN primitives.
 *
 * Persistence:
 *   - On "Confirm Signature" we POST {points, w, h} to
 *     /api/orders/:id/delivery-proof/signature-vector. Server writes a
 *     .json file to the delivery-proofs namespace and returns the
 *     s3Key. The parent (orders.tsx) then reuses the existing
 *     /delivery-proof upsert flow with proofType='signature'.
 *
 * Public API — subtly changed on purpose. The old callback returned a
 * PNG base64 string; there is no on-device PNG here, so the callback
 * hands back the s3Key directly. The parent skips its old
 * handleUploadProof step because the upload is complete before this
 * component fires onConfirm.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  PanResponder,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from 'react-native';
import { apiPost, getErrorMessage } from '../lib/api';

export interface SignaturePadPanResponderProps {
  visible: boolean;
  orderId: string;
  onClose: () => void;
  /** s3Key + phone are handed back; parent uses these for the /delivery-proof upsert. */
  onConfirm: (s3Key: string, phone: string) => void;
  initialPhone?: string;
}

type Point = [number, number];

/** Interior stroke thickness in CSS points. Fixed — velocity-based
 * width is intentionally out of scope for this pass; the driver just
 * needs a legible signature, not a calligraphic one. */
const STROKE = 2.5;
const CAP = 2.6;

export function SignaturePadPanResponder({
  visible,
  orderId,
  onClose,
  onConfirm,
  initialPhone,
}: SignaturePadPanResponderProps) {
  const [phone, setPhone] = useState(initialPhone ?? '');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Strokes live in a ref while drawing. Bumping `nudge` forces a
  // re-render so the visible strokes catch up. We keep a snapshot in
  // state — `strokesState` — mirroring the ref every N points so
  // useMemo dependencies work naturally.
  const strokesRef = useRef<Point[][]>([]);
  const currentRef = useRef<Point[]>([]);
  const [strokesState, setStrokesState] = useState<Point[][]>([]);
  const [hasAnyPoint, setHasAnyPoint] = useState(false);

  // Reset on open — every re-open should behave like a fresh pad.
  // Ref writes are safe inside effect; state writes are deferred to the
  // next microtask so React doesn't schedule the cascade synchronously
  // within the current commit (lint: setState-in-effect cascade rule).
  useEffect(() => {
    if (!visible) return;
    strokesRef.current = [];
    currentRef.current = [];
    void Promise.resolve().then(() => {
      setStrokesState([]);
      setHasAnyPoint(false);
      setPhone(initialPhone ?? '');
      setPhoneError(null);
      setUploading(false);
      setUploadError(null);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const { width: winW, height: winH } = useMemo(
    () => Dimensions.get('window'),
    [visible],
  );
  const canvasW = Math.round(winW * 0.85);
  const canvasH = Math.round(winH * 0.4);

  const canvasOriginRef = useRef<{ pageX: number; pageY: number }>({ pageX: 0, pageY: 0 });

  const flushState = () => {
    // Snapshot ref → state so React re-renders with the up-to-date lines.
    // We clone the in-progress current stroke so the state reference is
    // stable across re-renders (React shallow-compares).
    const snapshot: Point[][] = strokesRef.current.map((s) => s.slice());
    if (currentRef.current.length > 0) snapshot.push(currentRef.current.slice());
    setStrokesState(snapshot);
  };

  // The PanResponder callbacks below capture `strokesRef` / `currentRef`,
  // but every callback fires on a native touch event — never during the
  // render commit. `react-hooks/refs` can't prove that, so we suppress
  // the false positive on this useMemo block.
  /* eslint-disable react-hooks/refs */
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e: GestureResponderEvent) => {
          const { locationX, locationY } = e.nativeEvent;
          currentRef.current = [[locationX, locationY]];
          setHasAnyPoint(true);
          flushState();
        },
        onPanResponderMove: (
          e: GestureResponderEvent,
          _g: PanResponderGestureState,
        ) => {
          const { locationX, locationY } = e.nativeEvent;
          currentRef.current.push([locationX, locationY]);
          // Flush every 4 points to keep re-render cost bounded — the
          // stroke visibly lags the finger by ~4 samples (~16-30ms)
          // which is imperceptible in practice.
          if (currentRef.current.length % 4 === 0) flushState();
        },
        onPanResponderRelease: () => {
          if (currentRef.current.length > 0) {
            strokesRef.current.push(currentRef.current);
            currentRef.current = [];
          }
          flushState();
        },
        onPanResponderTerminate: () => {
          if (currentRef.current.length > 0) {
            strokesRef.current.push(currentRef.current);
            currentRef.current = [];
          }
          flushState();
        },
      }),
    [],
  );
  /* eslint-enable react-hooks/refs */

  const handleClear = () => {
    strokesRef.current = [];
    currentRef.current = [];
    setStrokesState([]);
    setHasAnyPoint(false);
    setUploadError(null);
  };

  const handleConfirm = async () => {
    if (!hasAnyPoint || strokesRef.current.length === 0) return;
    const digits = phone.replace(/[^0-9]/g, '');
    if (digits.length < 10) {
      setPhoneError('Enter a valid mobile number (min 10 digits)');
      return;
    }
    setPhoneError(null);
    setUploading(true);
    setUploadError(null);
    try {
      const payload = {
        points: strokesRef.current,
        w: canvasW,
        h: canvasH,
      };
      const resp = await apiPost<{ s3Key: string; finalUrl: string; uploadUrl: string }>(
        `/orders/${orderId}/delivery-proof/signature-vector`,
        payload,
      );
      onConfirm(resp.s3Key, phone.trim());
    } catch (err) {
      setUploadError(getErrorMessage(err) || 'Could not save signature. Check connectivity.');
      setUploading(false);
    }
  };

  const canConfirm =
    hasAnyPoint && phone.replace(/[^0-9]/g, '').length >= 10 && !uploading;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      presentationStyle="overFullScreen"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.75)' }}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 }}
        >
          {/* Close (X) top-right, above canvas. */}
          <View style={{ width: canvasW, flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 12 }}>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              style={{
                width: 36, height: 36, borderRadius: 18,
                backgroundColor: 'rgba(255,255,255,0.15)',
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              <Text style={{ color: '#ffffff', fontSize: 20, lineHeight: 22, fontWeight: '600' }}>×</Text>
            </TouchableOpacity>
          </View>

          {/* Canvas surface. onLayout captures the origin so we could
              use pageX/pageY for hit-test verification during dev; the
              locationX/Y of PanResponder events is already canvas-local. */}
          <View
            {...panResponder.panHandlers}
            onLayout={(ev) => {
              // Capture the canvas origin for potential absolute-hit tests.
              const { x, y } = ev.nativeEvent.layout;
              canvasOriginRef.current = { pageX: x, pageY: y };
            }}
            style={{
              width: canvasW,
              height: canvasH,
              backgroundColor: '#ffffff',
              borderRadius: 12,
              overflow: 'hidden',
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.3,
              shadowRadius: 8,
              elevation: 6,
            }}
          >
            {!hasAnyPoint && (
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                  alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Text style={{ color: '#9ca3af', fontSize: 16 }}>Sign here</Text>
              </View>
            )}
            {strokesState.map((stroke, si) => (
              <StrokeView key={si} points={stroke} />
            ))}
          </View>

          {/* Phone input BELOW canvas. */}
          <View style={{ width: canvasW, marginTop: 16 }}>
            <Text style={{ fontSize: 12, color: '#e5e7eb', marginBottom: 4 }}>
              Signing party mobile number
            </Text>
            <TextInput
              value={phone}
              onChangeText={(t) => { setPhone(t); if (phoneError) setPhoneError(null); }}
              placeholder="e.g. 9876543210"
              placeholderTextColor="#9ca3af"
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
              <Text style={{ fontSize: 12, color: '#fca5a5', marginTop: 4 }}>{phoneError}</Text>
            ) : null}
          </View>

          {/* Bottom action bar. */}
          <View style={{ width: canvasW, marginTop: 16, flexDirection: 'row', gap: 12 }}>
            <TouchableOpacity
              onPress={handleClear}
              disabled={uploading}
              style={{
                flex: 1,
                paddingVertical: 14,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: '#ffffff',
                alignItems: 'center',
                opacity: uploading ? 0.5 : 1,
              }}
            >
              <Text style={{ color: '#ffffff', fontWeight: '600' }}>Clear</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleConfirm}
              disabled={!canConfirm}
              style={{
                flex: 2,
                paddingVertical: 14,
                borderRadius: 10,
                backgroundColor: canConfirm ? '#059669' : '#065f46',
                alignItems: 'center',
                opacity: canConfirm ? 1 : 0.5,
              }}
            >
              <Text style={{ color: '#ffffff', fontWeight: '700', fontSize: 15 }}>
                {uploading ? 'Saving…' : 'Confirm Signature'}
              </Text>
            </TouchableOpacity>
          </View>

          {uploadError ? (
            <Text style={{ color: '#fca5a5', marginTop: 12, fontSize: 12, maxWidth: canvasW, textAlign: 'center' }}>
              {uploadError}
            </Text>
          ) : null}
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

/**
 * Renders one stroke as: a small "cap" dot at every point + a thin
 * rotated rectangle between consecutive points. Not the prettiest
 * rasterizer, but it's a pure-JS render — zero native deps.
 */
function StrokeView({ points }: { points: Point[] }) {
  const segments: React.ReactNode[] = [];
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    // Cap dot at every point covers segment joints.
    segments.push(
      <View
        key={`d${i}`}
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: x - CAP / 2,
          top: y - CAP / 2,
          width: CAP,
          height: CAP,
          borderRadius: CAP / 2,
          backgroundColor: '#111827',
        }}
      />,
    );
    if (i > 0) {
      const [px, py] = points[i - 1];
      const dx = x - px;
      const dy = y - py;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        const cx = (x + px) / 2;
        const cy = (y + py) / 2;
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        segments.push(
          <View
            key={`s${i}`}
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: cx - len / 2,
              top: cy - STROKE / 2,
              width: len,
              height: STROKE,
              backgroundColor: '#111827',
              transform: [{ rotate: `${angle}deg` }],
            }}
          />,
        );
      }
    }
  }
  return <>{segments}</>;
}
