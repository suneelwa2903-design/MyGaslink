/**
 * Signature capture — FULLSCREEN POPOUT (2026-07-16).
 *
 * A big-canvas variant of SignaturePad that presents inside a Modal so
 * the driver has ~85% of screen width × 40% of screen height to sign
 * on, instead of the ~180px inline strip. Reuses the same WebView +
 * signature_pad.js contract as SignaturePad — the WebView side of the
 * bridge is identical (`window.SP.clear() / capture() / isReady`).
 *
 * Composition contract with the parent (orders.tsx):
 *   <SignaturePadModal
 *     visible={sigModalOpen}
 *     onClose={() => setSigModalOpen(false)}
 *     initialPhone={signingPartyPhone}
 *     onConfirm={(base64, phone) => { … set state, close modal … }}
 *   />
 *
 * The parent decides when to open/close, and gets a single onConfirm
 * callback with both artifacts. Backdrop tap and the X button both
 * fire onClose without capturing.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { SIGNATURE_PAD_JS } from './signaturePadSource';

export interface SignaturePadModalProps {
  visible: boolean;
  onClose: () => void;
  onConfirm: (pngBase64: string, phone: string) => void;
  initialPhone?: string;
}

/**
 * Fullscreen popout HTML — mirrors the inline SignaturePad's contract
 * but with a slightly larger "Sign here" font. Uses the same inline
 * signature_pad UMD (SIGNATURE_PAD_JS) so both pads share one library
 * copy and neither has a CDN dependency.
 *
 * Fix A + Fix B (2026-07-16): same option tuning and stroke-preservation
 * fixes as SignaturePad.tsx — see that file's block for rationale.
 */
const CANVAS_HTML = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; background: #ffffff;
  -webkit-user-select: none; user-select: none;
  touch-action: none; overscroll-behavior: none; }
#wrap { position: absolute; inset: 0; touch-action: none; }
canvas { display: block; background: #ffffff; width: 100%; height: 100%;
  touch-action: none; -webkit-touch-callout: none; }
#placeholder {
  position: absolute; inset: 0; display: flex;
  align-items: center; justify-content: center;
  color: #9ca3af;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 16px;
  pointer-events: none;
}
</style>
<script>${SIGNATURE_PAD_JS}</script>
</head>
<body>
<div id="wrap">
  <canvas id="pad"></canvas>
  <div id="placeholder">Sign here</div>
</div>
<script>
(function () {
  var canvas = document.getElementById('pad');
  var placeholder = document.getElementById('placeholder');

  function sizeCanvas() {
    // Fix B: preserve strokes across resize.
    var data = (window._pad && window._pad.toData) ? window._pad.toData() : null;
    var ratio = Math.max(window.devicePixelRatio || 1, 2);
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    var ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (window._pad && data && data.length) {
      window._pad.fromData(data);
    }
  }

  // NOTE: document-level touchstart/touchmove preventDefault handlers
  // used to live here. Removed 2026-07-16 — they were the "belt-and-
  // suspenders" that caused Android WebView to silently swallow all
  // touchmove events after the first touchstart. Symptom: signature
  // pad drew individual dots at each tap-down but never connecting
  // strokes. signature_pad already handles preventDefault on its own
  // canvas-scoped touchstart/touchmove listeners (respecting
  // t.cancelable), plus the CSS touch-action: none on html/body/canvas
  // stops the WebView from interpreting drags as scroll — so no
  // document-level handler is needed.

  function post(payload) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  }

  window.SP = { isReady: false };

  function bootstrap() {
    if (typeof SignaturePad === 'undefined') {
      setTimeout(bootstrap, 50);
      return;
    }
    sizeCanvas();
    // Fix B: promote pad to window._pad so sizeCanvas() can save+restore.
    // 2026-07-16 (dots-fix): minDistance ⇒ 0 (connect EVERY sample),
    // velocityFilterWeight ⇒ 0.3 (minimal over-smoothing), thicker
    // min/max, explicit dotSize function so lifted-pen taps render at
    // stroke thickness rather than a hair-thin fleck.
    window._pad = new SignaturePad(canvas, {
      backgroundColor: 'rgb(255,255,255)',
      penColor: 'rgb(17, 24, 39)',
      minWidth: 1.5,
      maxWidth: 4.5,
      minDistance: 0,
      throttle: 0,
      velocityFilterWeight: 0.3,
      dotSize: function () {
        return (this.minWidth + this.maxWidth) / 2;
      },
    });
    // Force a fresh canvas + reset internal state to defeat any
    // half-initialized touch handler from the previous mount.
    window._pad.clear();
    window._pad.addEventListener('beginStroke', function () {
      if (placeholder) placeholder.style.display = 'none';
      post({ type: 'drawn' });
    });
    window.SP.clear = function () {
      window._pad.clear();
      if (placeholder) placeholder.style.display = 'flex';
      post({ type: 'empty' });
    };
    window.SP.capture = function () {
      if (window._pad.isEmpty()) {
        post({ type: 'empty' });
        return;
      }
      var dataUrl = window._pad.toDataURL('image/png');
      var comma = dataUrl.indexOf(',');
      var b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      post({ type: 'capture', data: b64 });
    };
    window.SP.isReady = true;

    // Fix B: 150ms debounced resize handler.
    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(sizeCanvas, 150);
    });

    post({ type: 'ready' });
  }
  bootstrap();
})();
</script>
</body>
</html>`;

interface IncomingMessage {
  type: 'ready' | 'empty' | 'drawn' | 'capture';
  data?: string;
}

export function SignaturePadModal({
  visible,
  onClose,
  onConfirm,
  initialPhone,
}: SignaturePadModalProps) {
  const webRef = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const [hasDrawn, setHasDrawn] = useState(false);
  const [phone, setPhone] = useState(initialPhone ?? '');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [awaitingCapture, setAwaitingCapture] = useState(false);

  // 2026-07-16 (Path D): reset on open + timestamp-keyed WebView so
  // every modal-open forces a full WebView remount with a fresh HTML
  // load. Previously a monotonic counter (`visibleKey`) was used, but
  // that key was preserved across the same mount cycle — combined with
  // Android WebView aggressive HTML caching this meant the pad HTML
  // was NOT reloaded even when the WebView was re-created. Date.now()
  // guarantees a distinct key per open, and the incognito + no-cache
  // props below make sure the fetch itself never hits the disk cache.
  const [openTs, setOpenTs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!visible) return;
    // Defer the state-fanout to the next microtask so React doesn't
    // schedule the cascade synchronously inside the same commit — the
    // "Calling setState synchronously within an effect can trigger
    // cascading renders" lint rule flags the eager form.
    void Promise.resolve().then(() => {
      setReady(false);
      setHasDrawn(false);
      setPhone(initialPhone ?? '');
      setPhoneError(null);
      setAwaitingCapture(false);
      setOpenTs(Date.now());
    });
  // We intentionally only re-run on `visible` transitions; a change to
  // `initialPhone` mid-open should not remount the pad.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const { width: winW, height: winH } = useMemo(() => Dimensions.get('window'), [openTs]);
  const canvasW = Math.round(winW * 0.85);
  const canvasH = Math.round(winH * 0.4);

  const handleMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let msg: IncomingMessage | null = null;
      try {
        msg = JSON.parse(e.nativeEvent.data) as IncomingMessage;
      } catch {
        return;
      }
      if (!msg) return;
      if (msg.type === 'ready') {
        setReady(true);
        return;
      }
      if (msg.type === 'drawn') {
        setHasDrawn(true);
        return;
      }
      if (msg.type === 'empty') {
        setHasDrawn(false);
        return;
      }
      if (msg.type === 'capture' && typeof msg.data === 'string' && msg.data.length > 0) {
        setAwaitingCapture(false);
        onConfirm(msg.data, phone.trim());
      }
    },
    [onConfirm, phone],
  );

  const handleClearPress = () => {
    if (!ready) return;
    webRef.current?.injectJavaScript('window.SP && window.SP.clear && window.SP.clear(); true;');
  };

  const handleDonePress = () => {
    if (!ready) return;
    if (!hasDrawn) return;
    const digits = phone.replace(/[^0-9]/g, '');
    if (digits.length < 10) {
      setPhoneError('Enter a valid mobile number (min 10 digits)');
      return;
    }
    setPhoneError(null);
    setAwaitingCapture(true);
    webRef.current?.injectJavaScript('window.SP && window.SP.capture && window.SP.capture(); true;');
  };

  const canConfirm = ready && hasDrawn && phone.replace(/[^0-9]/g, '').length >= 10;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      presentationStyle="overFullScreen"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.75)' }}>
          <TouchableWithoutFeedback onPress={() => { /* swallow taps inside */ }}>
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 }}
            >
              {/* Close (X) button top-right, above canvas. */}
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

              {/* Canvas — 85% wide × 40% tall. */}
              <View
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
                <WebView
                  key={`sig-webview-${openTs}`}
                  ref={webRef}
                  originWhitelist={['*']}
                  source={{ html: CANVAS_HTML }}
                  onMessage={handleMessage}
                  style={{ backgroundColor: '#ffffff' }}
                  scrollEnabled={false}
                  bounces={false}
                  overScrollMode="never"
                  javaScriptEnabled
                  domStorageEnabled
                  setSupportMultipleWindows={false}
                  nestedScrollEnabled={false}
                  androidLayerType="hardware"
                  // Path D cache-busting trio. incognito disables ALL
                  // WebView-scoped storage (cookies, localStorage,
                  // HTTP cache); cacheEnabled=false is the RN prop
                  // alias for the same on iOS; cacheMode is the
                  // Android-specific override that forces every
                  // request through the network layer. Together they
                  // guarantee no stale HTML/JS survives a remount.
                  incognito
                  cacheEnabled={false}
                  cacheMode="LOAD_NO_CACHE"
                />
              </View>

              {/* Phone input BELOW canvas — required before Done is tappable. */}
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

              {/* Bottom action bar: Clear (left) + Done (right). */}
              <View style={{ width: canvasW, marginTop: 16, flexDirection: 'row', gap: 12 }}>
                <TouchableOpacity
                  onPress={handleClearPress}
                  disabled={!ready}
                  style={{
                    flex: 1,
                    paddingVertical: 14,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: '#ffffff',
                    alignItems: 'center',
                    opacity: ready ? 1 : 0.5,
                  }}
                >
                  <Text style={{ color: '#ffffff', fontWeight: '600' }}>Clear</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleDonePress}
                  disabled={!canConfirm || awaitingCapture}
                  style={{
                    flex: 2,
                    paddingVertical: 14,
                    borderRadius: 10,
                    backgroundColor: canConfirm ? '#059669' : '#065f46',
                    alignItems: 'center',
                    opacity: canConfirm && !awaitingCapture ? 1 : 0.5,
                  }}
                >
                  <Text style={{ color: '#ffffff', fontWeight: '700', fontSize: 15 }}>
                    {awaitingCapture ? 'Capturing…' : 'Confirm Signature'}
                  </Text>
                </TouchableOpacity>
              </View>

              {!ready && (
                <Text style={{ color: '#e5e7eb', marginTop: 12, fontSize: 12 }}>Loading pad…</Text>
              )}
            </KeyboardAvoidingView>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}
