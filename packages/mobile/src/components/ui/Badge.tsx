import { View, Text } from 'react-native';

const variants = {
  success: { bg: '#ecfdf5', text: '#059669' },
  warning: { bg: '#fffbeb', text: '#d97706' },
  danger: { bg: '#fef2f2', text: '#dc2626' },
  info: { bg: '#eef7ff', text: '#1a6df5' },
  neutral: { bg: '#f1f5f9', text: '#475569' },
} as const;

interface BadgeProps {
  label: string;
  variant?: keyof typeof variants;
}

export function Badge({ label, variant = 'neutral' }: BadgeProps) {
  const s = variants[variant];
  return (
    <View style={{ backgroundColor: s.bg, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99 }}>
      <Text style={{ color: s.text, fontSize: 12, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}
