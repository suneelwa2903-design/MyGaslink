/**
 * Proof-of-collection Phase 1 (2026-07-15) — Option E rewrite (2026-07-16).
 *
 * Signature capture UI, now implemented DIRECTLY on top of react-native-webview
 * + a bundled signature_pad.js. Replaces the react-native-signature-canvas
 * wrapper, which broke on Expo SDK 54 / React 19.1 because its top-level
 * `forwardRef((_, ref) => { useState() })` resolved a null dispatcher on
 * Fabric's initial mount → the entire (driver) tree crashed on module load.
 *
 * Design decisions preserved from the previous impl:
 *  - Base64 PNG (not SVG paths) — matches pdfkit doc.image() + S3 pre-signed
 *    PUT with content-type image/png.
 *  - Paired phone TextInput lives next to the canvas — both fields are
 *    required for a signature-type proof, so they stay coupled.
 *  - Parent owns "capture pending → captured" flow; this component fires
 *    callbacks. The public props interface is IDENTICAL to the previous
 *    version — orders.tsx does not need to change.
 *
 * Bridge:
 *  - RN → WebView: `webRef.current.injectJavaScript('SP.clear(); true;')`
 *    and `'SP.capture(); true;'`. Direct method invocation on the in-page
 *    controller — no message dispatch on the WebView side.
 *  - WebView → RN: `window.ReactNativeWebView.postMessage(JSON.stringify({
 *    type: 'ready' | 'empty' | 'capture', data?: base64 }))`. Consumed by
 *    onMessage on the RN side.
 *  - `ready` flag gates the RN-side buttons so a tap before onLoad is a
 *    no-op instead of a silent JS eval into a missing controller.
 */
import React, { useCallback, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, TextInput } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { SIGNATURE_PAD_JS } from './signaturePadSource';

export interface SignaturePadProps {
  onCapture: (pngBase64: string) => void;
  onClear: () => void;
  signingPartyPhone: string;
  onPhoneChange: (phone: string) => void;
  phoneError?: string;
}

/**
 * Inline HTML for the WebView. Bundles signature_pad@4.1.7 inline via
 * SIGNATURE_PAD_JS (see signaturePadSource.ts) — no CDN dependency, no
 * cold-offline hang. Hangs an `SP` controller on `window` with
 * `.clear()` / `.capture()` / `.isReady`. The controller posts
 * messages back to RN via `window.ReactNativeWebView.postMessage`.
 *
 * Fix A (2026-07-16): signature_pad constructor now overrides the
 * library defaults — minDistance/throttle/velocityFilterWeight —
 * because the defaults dropped ~40% of touch samples on slow signatures
 * and produced angular corners. See docs commit and the earlier
 * diagnosis report.
 *
 * Fix B (2026-07-16): sizeCanvas() now saves + restores the stroke
 * data buffer around the destructive `canvas.width = …` reset so a
 * mid-draw resize event no longer wipes the pad. Resize handler is
 * debounced 150ms to skip transient no-delta events fired during
 * modal animations on Android.
 */
const CANVAS_HTML = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
/* touch-action:none on html/body prevents the WebView from interpreting
   drags as page-scroll/pinch-zoom and stealing them from signature_pad. */
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
  font-size: 14px;
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
    // Fix B: preserve strokes across resize. Reading toData() before
    // the destructive canvas.width write and re-playing via fromData()
    // after keeps the driver's in-progress signature intact even if
    // a resize event fires mid-signing.
    var data = (window._pad && window._pad.toData) ? window._pad.toData() : null;
    // Bump the backing-store scale to at least 2× so strokes stay
    // crisp even on lower-DPR devices — signature_pad's internal
    // interpolation looks noticeably better with the higher resolution.
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

  // Belt-and-suspenders: preventDefault on native touch events at the
  // document level so nothing between us and signature_pad steals a
  // touchmove. touch-action:none in CSS should handle this on iOS 13+
  // and Android WebView 79+, but the explicit listener catches the tail.
  // Document-level preventDefault handlers removed 2026-07-16 — they
  // caused Android WebView to silently swallow touchmove events after
  // touchstart, producing dots instead of connected strokes. See the
  // matching comment block in SignaturePadModal.tsx.

  function post(payload) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  }

  window.SP = { isReady: false };

  function bootstrap() {
    if (typeof SignaturePad === 'undefined') {
      // Should never happen with inline bundle, but keep the retry as
      // insurance for a bundle that fails to parse for some reason.
      setTimeout(bootstrap, 50);
      return;
    }
    sizeCanvas();
    // Fix B: promote pad to window._pad so sizeCanvas() (called from
    // the debounced resize handler below) can save+restore strokes.
    // 2026-07-16 dots-fix: same options as SignaturePadModal — see the
    // comment in that file for rationale.
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
    window._pad.clear();
    window._pad.addEventListener('beginStroke', function () {
      if (placeholder) placeholder.style.display = 'none';
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

    // Fix B: debounce the resize handler so bursts of transient no-delta
    // events during Modal animation don't repeatedly wipe/re-fill the
    // canvas. 150ms is short enough to feel instant on rotation, long
    // enough to coalesce animation-frame jitter.
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
  type: 'ready' | 'empty' | 'capture';
  data?: string;
}

export function SignaturePad({
  onCapture,
  onClear,
  signingPartyPhone,
  onPhoneChange,
  phoneError,
}: SignaturePadProps) {
  const webRef = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const [captured, setCaptured] = useState(false);

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
      if (msg.type === 'capture' && typeof msg.data === 'string' && msg.data.length > 0) {
        setCaptured(true);
        onCapture(msg.data);
        return;
      }
      if (msg.type === 'empty') {
        setCaptured(false);
        onClear();
      }
    },
    [onCapture, onClear],
  );

  const handleClearPress = () => {
    if (!ready) return;
    // The trailing `true;` prevents a JSON deserialization warning on
    // Android WebView when injectJavaScript returns a non-JSON value.
    webRef.current?.injectJavaScript('window.SP && window.SP.clear && window.SP.clear(); true;');
  };

  const handleConfirmPress = () => {
    if (!ready) return;
    webRef.current?.injectJavaScript('window.SP && window.SP.capture && window.SP.capture(); true;');
  };

  return (
    <View style={{ gap: 12 }}>
      <View style={{ height: 180, borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8, overflow: 'hidden' }}>
        <WebView
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
          // Route the pen down through the WebView's touch handling —
          // otherwise the outer ScrollView in orders.tsx will intercept
          // vertical drags and prevent strokes.
          nestedScrollEnabled={false}
          // Disable RN gesture bubbling on Android so strokes aren't
          // stolen by the parent tab navigator.
          androidLayerType="hardware"
        />
      </View>

      <View style={{ flexDirection: 'row', gap: 12 }}>
        <TouchableOpacity
          onPress={handleClearPress}
          disabled={!ready}
          style={{
            flex: 1,
            paddingVertical: 10,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: '#d1d5db',
            alignItems: 'center',
            opacity: ready ? 1 : 0.5,
          }}
        >
          <Text style={{ color: '#111827', fontWeight: '500' }}>Clear</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleConfirmPress}
          disabled={!ready}
          style={{
            flex: 2,
            paddingVertical: 10,
            borderRadius: 8,
            backgroundColor: captured ? '#059669' : '#0a3d62',
            alignItems: 'center',
            opacity: ready ? 1 : 0.5,
          }}
        >
          <Text style={{ color: '#ffffff', fontWeight: '600' }}>
            {captured ? '✓ Signature captured' : ready ? 'Capture signature' : 'Loading…'}
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
