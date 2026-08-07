/**
 * Full-screen blocking overlay shown when SSL-pin failure is detected
 * (see src/lib/pinning.ts for the detection heuristic). Rendered from
 * app/_layout.tsx above the router Stack — nothing behind it is tappable
 * while a suspected man-in-the-middle is on the network.
 */
import { useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Linking, Platform } from 'react-native';
import { useNetworkSecurityStore, retryConnectivity } from '../lib/pinning';

const STORE_URL = Platform.select({
  ios: 'https://apps.apple.com/app/id6783034856',
  default: 'https://play.google.com/store/apps/details?id=com.mygaslink.app',
});

export function NetworkSecurityScreen() {
  const blocked = useNetworkSecurityStore((s) => s.blocked);
  const advisory = useNetworkSecurityStore((s) => s.advisory);
  const [retrying, setRetrying] = useState(false);

  if (!blocked) return null;

  const onRetry = async () => {
    setRetrying(true);
    try {
      await retryConnectivity();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <View
      style={{
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 2000,
        backgroundColor: '#0f172a', alignItems: 'center', justifyContent: 'center',
        paddingHorizontal: 28,
      }}
    >
      <Text style={{ fontSize: 44, marginBottom: 16 }}>🔒</Text>
      <Text style={{ color: '#f8fafc', fontSize: 20, fontWeight: '700', textAlign: 'center', marginBottom: 12 }}>
        Secure connection blocked
      </Text>
      <Text style={{ color: '#cbd5e1', fontSize: 14, lineHeight: 21, textAlign: 'center', marginBottom: 8 }}>
        This network appears to be intercepting secure traffic, so MyGasLink
        stopped the connection to protect your data.
      </Text>
      <Text style={{ color: '#cbd5e1', fontSize: 14, lineHeight: 21, textAlign: 'center', marginBottom: 24 }}>
        Switch to mobile data or a trusted Wi-Fi network and retry. If this
        keeps happening on every network, check for an app update.
      </Text>

      {advisory ? (
        <View style={{
          backgroundColor: '#1e293b', borderRadius: 10, padding: 14, marginBottom: 24,
          borderWidth: 1, borderColor: '#334155',
        }}>
          <Text style={{ color: '#fbbf24', fontSize: 13, lineHeight: 19, textAlign: 'center' }}>
            {advisory}
          </Text>
        </View>
      ) : null}

      <TouchableOpacity
        onPress={onRetry}
        disabled={retrying}
        style={{
          backgroundColor: '#338dff', borderRadius: 10, paddingVertical: 14,
          paddingHorizontal: 48, marginBottom: 12, minWidth: 220, alignItems: 'center',
          opacity: retrying ? 0.7 : 1,
        }}
      >
        {retrying
          ? <ActivityIndicator size="small" color="#ffffff" />
          : <Text style={{ color: '#ffffff', fontSize: 15, fontWeight: '700' }}>Retry connection</Text>}
      </TouchableOpacity>

      <TouchableOpacity
        onPress={() => Linking.openURL(STORE_URL)}
        style={{
          borderRadius: 10, paddingVertical: 14, paddingHorizontal: 48,
          minWidth: 220, alignItems: 'center', borderWidth: 1, borderColor: '#334155',
        }}
      >
        <Text style={{ color: '#cbd5e1', fontSize: 15, fontWeight: '600' }}>Check for app update</Text>
      </TouchableOpacity>
    </View>
  );
}
