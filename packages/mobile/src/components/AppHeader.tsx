import { View, Text, Image } from 'react-native';
import { useTheme, ACCENT } from '../theme';
import { useAuthStore } from '../stores/authStore';
import logo from '../../assets/logo.png';

/**
 * Centered "MyGasLink" wordmark + small logo, with the current tenant
 * name prepended when present. Used as `headerTitle` in every role
 * layout so post-login screens have a consistent identity bar regardless
 * of which tab the user is on.
 *
 * React Navigation centers `headerTitle` automatically when
 * `headerTitleAlign: 'center'` is set on the navigator. We render the logo
 * inline with the text so the whole thing stays grouped under that center
 * alignment (rather than splitting logo into headerLeft, which would push
 * the title off-center on Android).
 *
 * Tenant name visibility:
 *   - super_admin → distributorName is null → skip (logo stays centered)
 *   - any user with a distributorId set → show businessName, truncated
 *     to one line, theme-aware color (lighter on dark headers, darker on
 *     light) so it reads as secondary metadata next to the wordmark.
 */
export function AppHeader() {
  const { dark, colors } = useTheme();
  const distributorName = useAuthStore((s) => s.user?.distributorName);
  const brandText = dark ? '#ffffff' : ACCENT.navy;
  const tenantColor = dark ? '#cbd5e1' : '#475569'; // slate-300 / slate-600

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 320 }}>
      {distributorName ? (
        <Text
          numberOfLines={1}
          style={{
            fontSize: 12,
            fontWeight: '400',
            color: tenantColor,
            maxWidth: 140,
          }}
        >
          {distributorName}
        </Text>
      ) : null}
      <Image
        source={logo}
        style={{ width: 28, height: 28, borderRadius: 6 }}
        resizeMode="contain"
      />
      <Text style={{ fontSize: 17, fontWeight: '800', color: colors.text }}>
        <Text style={{ color: brandText }}>MyGas</Text>
        <Text style={{ color: ACCENT.red }}>Link</Text>
      </Text>
    </View>
  );
}
