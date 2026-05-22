import { View, Text, type ViewProps } from 'react-native';
import { useTheme } from '../../theme';

interface CardProps extends ViewProps {
  children: React.ReactNode;
}

export function Card({ children, style, ...props }: CardProps) {
  // Dark-mode fix: Card was hardcoded white (#fff) with a light border, so it
  // rendered as a white island on dark screens. Use theme card surface/border.
  const { colors } = useTheme();
  return (
    <View
      style={[{
        backgroundColor: colors.cardBg,
        borderRadius: 16,
        padding: 16,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08,
        shadowRadius: 4,
        elevation: 2,
        borderWidth: 1,
        borderColor: colors.cardBorder,
      }, style]}
      {...props}
    >
      {children}
    </View>
  );
}

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  color?: string;
  icon?: React.ReactNode;
}

export function MetricCard({ title, value, subtitle, color = '#338dff', icon }: MetricCardProps) {
  const { colors } = useTheme();
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 13, color: colors.textSecondary, fontWeight: '500' }}>{title}</Text>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.5}
            style={{ fontSize: 24, fontWeight: '700', color, marginTop: 4 }}
          >
            {typeof value === 'number' ? value.toLocaleString('en-IN') : value}
          </Text>
          {subtitle && (
            <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>{subtitle}</Text>
          )}
        </View>
        {icon && <View style={{ marginLeft: 12 }}>{icon}</View>}
      </View>
    </Card>
  );
}
