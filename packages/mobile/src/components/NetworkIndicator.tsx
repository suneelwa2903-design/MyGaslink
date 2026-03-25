import { useEffect, useState } from 'react';
import { View, Text, Animated } from 'react-native';
import { api } from '../lib/api';

export function NetworkIndicator() {
  const [isOffline, setIsOffline] = useState(false);
  const [slideAnim] = useState(new Animated.Value(-40));

  useEffect(() => {
    // Monitor API request failures for network issues
    const requestInterceptor = api.interceptors.response.use(
      (response) => {
        if (isOffline) setIsOffline(false);
        return response;
      },
      (error) => {
        if (!error.response && error.message?.includes('Network Error')) {
          setIsOffline(true);
        }
        return Promise.reject(error);
      },
    );

    return () => {
      api.interceptors.response.eject(requestInterceptor);
    };
  }, [isOffline]);

  useEffect(() => {
    Animated.timing(slideAnim, {
      toValue: isOffline ? 0 : -40,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [isOffline, slideAnim]);

  // Retry connectivity check
  useEffect(() => {
    if (!isOffline) return;
    const interval = setInterval(async () => {
      try {
        await api.get('/health', { timeout: 5000 });
        setIsOffline(false);
      } catch {
        // Still offline
      }
    }, 10_000);
    return () => clearInterval(interval);
  }, [isOffline]);

  return (
    <Animated.View
      style={{
        position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1000,
        transform: [{ translateY: slideAnim }],
      }}
      pointerEvents={isOffline ? 'auto' : 'none'}
    >
      <View style={{
        backgroundColor: '#ef4444', paddingVertical: 8, paddingHorizontal: 16,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      }}>
        <Text style={{ fontSize: 14 }}>📡</Text>
        <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>
          No internet connection
        </Text>
      </View>
    </Animated.View>
  );
}
