/**
 * Preserved from the pre-2026-07-19 mobile HQ layout — the original
 * "open in browser" screen shown when the mobile HQ experience was
 * disabled by the CLAUDE.md "HQ portal is web-only in v1" decision.
 *
 * Kept in the tree (marked href:null so it never surfaces on the tab
 * bar) so a future per-tenant feature flag can route to it if we need
 * to quickly disable the mobile HQ surface for a specific distributor.
 */
import { View, Text, TouchableOpacity, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuthStore } from '../../src/stores/authStore';
import { useTheme, ACCENT } from '../../src/theme';

const WEB_URL = 'https://mygaslink.com';

export default function HqFallbackScreen() {
  const { logout, user } = useAuthStore();
  // 2026-07-19: dropped hardcoded #ffffff/#0f172a/#0a3d62 palette in
  // favour of the app-wide theme so this fallback matches the rest of
  // the mobile surface in both light and dark modes. Button uses
  // ACCENT.red — same accent the login screen + admin/inventory tab
  // bars use.
  const { colors } = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flex: 1, padding: 24, justifyContent: 'center', gap: 24 }}>
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 24, fontWeight: '700', color: colors.text }}>
            MyGasLink Group Portal
          </Text>
          <Text style={{ fontSize: 15, color: colors.textSecondary, lineHeight: 22 }}>
            The group portal is available on the web at mygaslink.com.
            Please log in from a browser to see your consolidated
            dashboard, orders, invoices and ledger across all
            properties.
          </Text>
        </View>

        <View style={{ backgroundColor: colors.cardBg, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: colors.cardBorder }}>
          <Text style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 4 }}>Signed in as</Text>
          <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>{user?.email ?? '—'}</Text>
        </View>

        <View style={{ gap: 12 }}>
          <TouchableOpacity
            onPress={() => { void Linking.openURL(WEB_URL); }}
            style={{ backgroundColor: ACCENT.red, paddingVertical: 14, borderRadius: 10, alignItems: 'center' }}
          >
            <Text style={{ color: '#ffffff', fontSize: 15, fontWeight: '600' }}>Open in Browser</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => { void logout(); }}
            style={{ paddingVertical: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.cardBorder, alignItems: 'center' }}
          >
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '500' }}>Sign out</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}
