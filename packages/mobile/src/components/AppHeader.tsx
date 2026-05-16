import { View, Text, Image } from 'react-native';
import { useTheme, ACCENT } from '../theme';

/**
 * Centered "MyGasLink" wordmark + small logo. Used as `headerTitle` in
 * every role layout so post-login screens have a consistent identity bar
 * regardless of which tab the user is on.
 *
 * React Navigation centers `headerTitle` automatically when
 * `headerTitleAlign: 'center'` is set on the navigator. We render the logo
 * inline with the text so the whole thing stays grouped under that center
 * alignment (rather than splitting logo into headerLeft, which would push
 * the title off-center on Android).
 */
export function AppHeader() {
  const { dark, colors } = useTheme();
  const brandText = dark ? '#ffffff' : ACCENT.navy;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Image
        source={require('../../assets/logo.png')}
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
