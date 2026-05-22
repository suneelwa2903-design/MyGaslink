import { View, Text } from 'react-native';
import { useTheme, getBadgeColors } from '../../theme';

type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

interface BadgeProps {
  label: string;
  variant?: BadgeVariant;
}

export function Badge({ label, variant = 'neutral' }: BadgeProps) {
  // Dark-mode fix: was hardcoded to the light pastel variants. Use the theme's
  // mode-aware badge palette (BADGE_COLORS has bgDark/textDark) so badges match
  // the dark surface with legible text.
  const { dark } = useTheme();
  const s = getBadgeColors(variant, dark);
  return (
    <View style={{ backgroundColor: s.bg, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99 }}>
      <Text style={{ color: s.text, fontSize: 12, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}
