import { useEffect, useState } from 'react';
import { View, Animated, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme';

interface SkeletonProps {
  width?: number | string;
  height?: number;
  borderRadius?: number;
  style?: ViewStyle;
}

export function Skeleton({ width = '100%', height = 16, borderRadius = 8, style }: SkeletonProps) {
  // Dark-mode fix: shimmer was hardcoded #e2e8f0 (light) — used theme divider
  // so the placeholder reads as a subtle block on dark surfaces, not a white flash.
  const { colors } = useTheme();
  // Lazy useState init: create the Animated.Value once; safe to read in render.
  const [opacity] = useState(() => new Animated.Value(0.3));

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[{
        width: width as any,
        height,
        borderRadius,
        backgroundColor: colors.divider,
        opacity,
      }, style]}
    />
  );
}

export function SkeletonCard() {
  const { colors } = useTheme();
  return (
    <View style={{
      backgroundColor: colors.cardBg, borderRadius: 16, padding: 16,
      borderWidth: 1, borderColor: colors.cardBorder, gap: 10,
    }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Skeleton width="60%" height={18} />
        <Skeleton width={70} height={24} borderRadius={99} />
      </View>
      <Skeleton width="80%" height={14} />
      <View style={{ flexDirection: 'row', gap: 12, marginTop: 4 }}>
        <Skeleton width="45%" height={14} />
        <Skeleton width="30%" height={14} />
      </View>
    </View>
  );
}

export function SkeletonMetricCard() {
  const { colors } = useTheme();
  return (
    <View style={{
      backgroundColor: colors.cardBg, borderRadius: 16, padding: 16,
      borderWidth: 1, borderColor: colors.cardBorder, gap: 8,
    }}>
      <Skeleton width="50%" height={14} />
      <Skeleton width="70%" height={28} />
      <Skeleton width="40%" height={12} />
    </View>
  );
}

export function ScreenSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <View style={{ padding: 16, gap: 12 }}>
      <Skeleton width="40%" height={24} />
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ flex: 1 }}><SkeletonMetricCard /></View>
        <View style={{ flex: 1 }}><SkeletonMetricCard /></View>
      </View>
      {Array.from({ length: cards }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </View>
  );
}
