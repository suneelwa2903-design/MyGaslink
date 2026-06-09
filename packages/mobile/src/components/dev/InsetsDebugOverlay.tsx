import { useState } from 'react';
import { View, Text, TouchableOpacity, Platform, Dimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';

/**
 * P1-2 — Temporary runtime-values overlay.
 *
 * UBB C1 set the tab-bar padding to `Math.max(6, insets.bottom)` and the
 * height to `64 + insets.bottom`, expecting that to land the bar flush with
 * the iPhone home indicator. Suneel re-tested on iPhone 11 Pro Max + iPhone 15
 * and the visible gap is still there.
 *
 * Per the brief, no speculative fix this round — we capture the actual
 * runtime values on a real iPhone first, then diagnose from data.
 *
 * This overlay shows insets.top / insets.bottom (from
 * react-native-safe-area-context's root SafeAreaProvider at app/_layout.tsx)
 * + the derived paddingBottom and height the tab bar resolves to. Tap to
 * collapse out of the way if it covers something you want to test. Only
 * renders when __DEV__ is true so it never ships to the App Store.
 *
 * Remove this component and its render in app/_layout.tsx once the iPhone
 * tab-bar gap is diagnosed and fixed.
 */
export function InsetsDebugOverlay() {
  const insets = useSafeAreaInsets();
  const [collapsed, setCollapsed] = useState(false);

  if (!__DEV__) return null;

  // Mirror the formulas used by theme.ts > getTabBarConfig and
  // components/ui/ScrollableTabBar.tsx — what we want to verify is whether
  // `insets.bottom` here matches what those derive at render time.
  const tabBarPaddingBottom = Math.max(6, insets.bottom);
  const tabBarHeight = 64 + insets.bottom;
  const screenHeight = Dimensions.get('window').height;

  // Position high on the screen (under the status bar) so it doesn't sit
  // on top of the area being investigated (the bottom). Right-aligned with
  // a small inset so it doesn't cover header-back arrows.
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: insets.top + 4,
        right: 6,
        zIndex: 9999,
        elevation: 9999,
      }}
    >
      <TouchableOpacity
        onPress={() => setCollapsed((c) => !c)}
        activeOpacity={0.7}
        style={{
          backgroundColor: 'rgba(220, 38, 38, 0.92)',
          borderRadius: 6,
          paddingHorizontal: 8,
          paddingVertical: 6,
          minWidth: collapsed ? 64 : 168,
        }}
      >
        {collapsed ? (
          <Text style={{ color: '#ffffff', fontSize: 11, fontWeight: '700' }}>
            P1-2 ▾
          </Text>
        ) : (
          <>
            <Text style={{ color: '#ffffff', fontSize: 10, fontWeight: '700', marginBottom: 2 }}>
              P1-2 RUNTIME (tap to hide)
            </Text>
            <Text style={{ color: '#ffffff', fontSize: 10 }}>
              os: {Platform.OS} {Platform.Version}
            </Text>
            <Text style={{ color: '#ffffff', fontSize: 10 }}>
              device: {Constants.deviceName ?? '?'}
            </Text>
            <Text style={{ color: '#ffffff', fontSize: 10 }}>
              insets.top: {insets.top.toFixed(2)}
            </Text>
            <Text style={{ color: '#ffffff', fontSize: 10 }}>
              insets.bottom: {insets.bottom.toFixed(2)}
            </Text>
            <Text style={{ color: '#ffffff', fontSize: 10 }}>
              insets.left: {insets.left.toFixed(2)}
            </Text>
            <Text style={{ color: '#ffffff', fontSize: 10 }}>
              insets.right: {insets.right.toFixed(2)}
            </Text>
            <Text style={{ color: '#ffffff', fontSize: 10 }}>
              tab paddingBottom: {tabBarPaddingBottom.toFixed(2)}
            </Text>
            <Text style={{ color: '#ffffff', fontSize: 10 }}>
              tab height: {tabBarHeight.toFixed(2)}
            </Text>
            <Text style={{ color: '#ffffff', fontSize: 10 }}>
              screen height: {screenHeight.toFixed(0)}
            </Text>
          </>
        )}
      </TouchableOpacity>
    </View>
  );
}
