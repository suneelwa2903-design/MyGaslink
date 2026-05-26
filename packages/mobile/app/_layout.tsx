import { useEffect, useRef } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import { useAuthStore } from '../src/stores/authStore';
import { useIsDark, useThemeHasHydrated } from '../src/stores/themeStore';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { NetworkIndicator } from '../src/components/NetworkIndicator';
import { initCrashReporting, setUser as setCrashUser } from '../src/services/crashReporting';

// Initialize crash reporting on app load
initCrashReporting();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 2, staleTime: 30_000 },
  },
});

export default function RootLayout() {
  const hydrate = useAuthStore((s) => s.hydrate);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const router = useRouter();
  const isDark = useIsDark();
  const themeHasHydrated = useThemeHasHydrated();
  const notificationResponseListener = useRef<{ remove: () => void } | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Register push notifications & crash user when authenticated
  // Lazy-load notifications to avoid expo-notifications crash in Expo Go
  const user = useAuthStore((s) => s.user);
  useEffect(() => {
    if (!isAuthenticated || !user) {
      setCrashUser(null);
      return;
    }
    setCrashUser({ id: user.userId, email: user.email, role: user.role });

    // Lazy-load to prevent expo-notifications from crashing at import time in Expo Go
    import('../src/services/notifications')
      .then(({ registerForPushNotifications }) => registerForPushNotifications())
      .catch(() => {
        // Push notifications not available in Expo Go
      });
  }, [isAuthenticated, user]);

  // Handle notification taps → deep link (lazy-loaded)
  useEffect(() => {
    import('../src/services/notifications')
      .then(({ addNotificationResponseListener }) => {
        notificationResponseListener.current = addNotificationResponseListener((response: unknown) => {
          const data = (response as { notification: { request: { content: { data: Record<string, unknown> } } } }).notification.request.content.data;
          if (data?.screen) {
            router.push(data.screen as string);
          }
        });
      })
      .catch(() => {
        // Notifications not available in Expo Go
      });

    return () => {
      notificationResponseListener.current?.remove();
    };
  }, [router]);

  // Gate first render until the persisted theme is restored from SecureStore.
  // Without this gate, users who picked dark would briefly see light on
  // every cold launch before persist finishes (~50ms async read).
  if (!themeHasHydrated) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#ffffff' }}>
        <ActivityIndicator size="large" color="#338dff" />
      </View>
    );
  }

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <View style={{ flex: 1 }}>
          <NetworkIndicator />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(customer)" />
            <Stack.Screen name="(driver)" />
            <Stack.Screen name="(admin)" />
            <Stack.Screen name="(super-admin)" />
            <Stack.Screen name="(inventory)" />
            <Stack.Screen name="(finance)" />
          </Stack>
        </View>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
