/**
 * Feature A (2026-07-15): customer_hq mobile fallback screen.
 *
 * Shown when an HQ user (role='customer_hq') opens the mobile app.
 * The HQ portal itself is web-only in v1 — this screen exists so we
 * don't silently reject the login or leave them staring at a blank
 * app; instead we explain the situation and give them a one-tap
 * shortcut to open the web portal in their browser + a logout option.
 *
 * If a mobile HQ experience is ever built (post-v1), this file gets
 * replaced with a real dashboard tile per HQ-PORTAL-BRAINSTORM.md §7.
 */
import { View, Text, TouchableOpacity, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuthStore } from '../../src/stores/authStore';

const WEB_URL = 'https://mygaslink.com';

export default function HqFallbackScreen() {
  const { logout, user } = useAuthStore();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#ffffff' }}>
      <View style={{ flex: 1, padding: 24, justifyContent: 'center', gap: 24 }}>
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 24, fontWeight: '700', color: '#0f172a' }}>
            MyGasLink Group Portal
          </Text>
          <Text style={{ fontSize: 15, color: '#64748b', lineHeight: 22 }}>
            The group portal is available on the web at mygaslink.com.
            Please log in from a browser to see your consolidated
            dashboard, orders, invoices and ledger across all
            properties.
          </Text>
        </View>

        <View style={{ backgroundColor: '#f8fafc', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#e2e8f0' }}>
          <Text style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>Signed in as</Text>
          <Text style={{ fontSize: 14, fontWeight: '600', color: '#0f172a' }}>{user?.email ?? '—'}</Text>
        </View>

        <View style={{ gap: 12 }}>
          <TouchableOpacity
            onPress={() => { void Linking.openURL(WEB_URL); }}
            style={{ backgroundColor: '#0a3d62', paddingVertical: 14, borderRadius: 10, alignItems: 'center' }}
          >
            <Text style={{ color: '#ffffff', fontSize: 15, fontWeight: '600' }}>Open in Browser</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => { void logout(); }}
            style={{ paddingVertical: 14, borderRadius: 10, borderWidth: 1, borderColor: '#d1d5db', alignItems: 'center' }}
          >
            <Text style={{ color: '#0f172a', fontSize: 15, fontWeight: '500' }}>Sign out</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}
