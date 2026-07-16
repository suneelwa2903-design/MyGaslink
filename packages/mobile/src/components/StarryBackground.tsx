import { useEffect, useState, useMemo } from 'react';
import { View, Animated, Dimensions, StyleSheet } from 'react-native';

interface Star {
  id: number;
  x: number;
  y: number;
  size: number;
  baseOpacity: number;
  bright: boolean;
}

interface StarryBackgroundProps {
  dark: boolean;
  starCount?: number;
}

function generateStars(count: number): Star[] {
  const { width, height } = Dimensions.get('window');
  const stars: Star[] = [];
  const brightCount = Math.floor(count * 0.12); // ~12% are bright stars

  for (let i = 0; i < count; i++) {
    const bright = i < brightCount;
    stars.push({
      id: i,
      x: Math.random() * width,
      y: Math.random() * height,
      size: bright ? 3 + Math.random() * 2 : 1.5 + Math.random() * 1.5,
      baseOpacity: bright ? 0.7 + Math.random() * 0.3 : 0.2 + Math.random() * 0.4,
      bright,
    });
  }
  return stars;
}

function AnimatedStar({ star, dark }: { star: Star; dark: boolean }) {
  // Lazy useState init creates each Animated.Value exactly once and is safe to
  // read during render (unlike accessing a ref's .current during render).
  const [opacity] = useState(() => new Animated.Value(star.baseOpacity));
  const [translateX] = useState(() => new Animated.Value(0));
  const [translateY] = useState(() => new Animated.Value(0));

  useEffect(() => {
    // Twinkle animation - loop with random-ish timing
    const twinkleDuration = 1800 + Math.random() * 2400;
    const minOpacity = Math.max(star.baseOpacity * 0.2, 0.05);

    const twinkle = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: minOpacity,
          duration: twinkleDuration,
          useNativeDriver: false,
        }),
        Animated.timing(opacity, {
          toValue: star.baseOpacity,
          duration: twinkleDuration * 0.8,
          useNativeDriver: false,
        }),
      ]),
    );

    // Gentle drift animation
    const driftRange = star.bright ? 6 : 3;
    const driftDuration = 4000 + Math.random() * 4000;

    const driftX = Animated.loop(
      Animated.sequence([
        Animated.timing(translateX, {
          toValue: (Math.random() - 0.5) * driftRange * 2,
          duration: driftDuration,
          useNativeDriver: false,
        }),
        Animated.timing(translateX, {
          toValue: 0,
          duration: driftDuration,
          useNativeDriver: false,
        }),
      ]),
    );

    const driftY = Animated.loop(
      Animated.sequence([
        Animated.timing(translateY, {
          toValue: (Math.random() - 0.5) * driftRange * 2,
          duration: driftDuration * 1.3,
          useNativeDriver: false,
        }),
        Animated.timing(translateY, {
          toValue: 0,
          duration: driftDuration * 1.3,
          useNativeDriver: false,
        }),
      ]),
    );

    twinkle.start();
    driftX.start();
    driftY.start();

    return () => {
      twinkle.stop();
      driftX.stop();
      driftY.stop();
    };
  }, []);

  const color = dark
    ? star.bright ? '#e0e8ff' : '#c8d0e8'
    : star.bright ? 'rgba(80, 90, 140, 0.5)' : 'rgba(100, 110, 160, 0.25)';

  return (
    <Animated.View
      style={{
        position: 'absolute',
        left: star.x,
        top: star.y,
        width: star.size,
        height: star.size,
        borderRadius: star.size / 2,
        backgroundColor: color,
        opacity,
        transform: [{ translateX }, { translateY }],
        // Bright stars get a subtle glow via shadow
        ...(star.bright && dark
          ? {
              shadowColor: '#aabbff',
              shadowOffset: { width: 0, height: 0 },
              shadowOpacity: 0.6,
              shadowRadius: 4,
              elevation: 2,
            }
          : {}),
      }}
    />
  );
}

export default function StarryBackground({ dark, starCount = 40 }: StarryBackgroundProps) {
  const stars = useMemo(() => generateStars(starCount), [starCount]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {stars.map((star) => (
        <AnimatedStar key={star.id} star={star} dark={dark} />
      ))}
    </View>
  );
}
