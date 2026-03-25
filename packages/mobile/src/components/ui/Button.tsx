import { TouchableOpacity, Text, ActivityIndicator, type TouchableOpacityProps } from 'react-native';

const variantStyles = {
  primary: { bg: '#338dff', text: '#fff' },
  secondary: { bg: '#f1f5f9', text: '#334155' },
  accent: { bg: '#10b981', text: '#fff' },
  danger: { bg: '#ef4444', text: '#fff' },
  ghost: { bg: 'transparent', text: '#64748b' },
} as const;

interface ButtonProps extends TouchableOpacityProps {
  title: string;
  variant?: keyof typeof variantStyles;
  loading?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export function Button({ title, variant = 'primary', loading, disabled, size = 'md', style, ...props }: ButtonProps) {
  const s = variantStyles[variant];
  const py = size === 'sm' ? 8 : size === 'lg' ? 16 : 12;
  const fontSize = size === 'sm' ? 13 : size === 'lg' ? 16 : 14;

  return (
    <TouchableOpacity
      style={[{
        backgroundColor: s.bg,
        paddingVertical: py,
        paddingHorizontal: 20,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 8,
        opacity: disabled || loading ? 0.6 : 1,
      }, style]}
      disabled={disabled || loading}
      activeOpacity={0.7}
      {...props}
    >
      {loading && <ActivityIndicator size="small" color={s.text} />}
      <Text style={{ color: s.text, fontWeight: '600', fontSize }}>{title}</Text>
    </TouchableOpacity>
  );
}
