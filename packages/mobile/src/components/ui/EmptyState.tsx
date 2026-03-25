import { View, Text } from 'react-native';

interface EmptyStateProps {
  title?: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({ title = 'No data found', description, action }: EmptyStateProps) {
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', paddingVertical: 48, paddingHorizontal: 24 }}>
      <Text style={{ fontSize: 48, marginBottom: 12 }}>📭</Text>
      <Text style={{ fontSize: 16, fontWeight: '600', color: '#334155', textAlign: 'center' }}>{title}</Text>
      {description && (
        <Text style={{ fontSize: 14, color: '#64748b', textAlign: 'center', marginTop: 6, maxWidth: 280 }}>
          {description}
        </Text>
      )}
      {action && <View style={{ marginTop: 16 }}>{action}</View>}
    </View>
  );
}
