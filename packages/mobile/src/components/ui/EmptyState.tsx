import { View, Text } from 'react-native';
import { useTheme } from '../../theme';

interface EmptyStateProps {
  title?: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({ title = 'No data found', description, action }: EmptyStateProps) {
  // Dark-mode contrast: title/description were hardcoded slate (#334155/#64748b)
  // and vanished on dark backgrounds. Use theme text colors.
  const { colors } = useTheme();
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', paddingVertical: 48, paddingHorizontal: 24 }}>
      <Text style={{ fontSize: 48, marginBottom: 12 }}>📭</Text>
      <Text style={{ fontSize: 16, fontWeight: '600', color: colors.text, textAlign: 'center' }}>{title}</Text>
      {description && (
        <Text style={{ fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginTop: 6, maxWidth: 280 }}>
          {description}
        </Text>
      )}
      {action && <View style={{ marginTop: 16 }}>{action}</View>}
    </View>
  );
}
