import { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Stack } from 'expo-router';
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
  const isDark = useIsDark();
  const themeHasHydrated = useThemeHasHydrated();
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Push notifications are deferred to v1.1 — the expo-notifications plugin
  // was removed from app.config in 6df8856 to avoid Apple-rejecting the iOS
  // build on an entitlement-without-handler. The stub at services/notifications.ts
  // is retained for the v1.1 rebuild. SSE covers driver foreground updates
  // (services/sseService.ts) — no background push for v1.0 by design.
  useEffect(() => {
    if (!isAuthenticated || !user) {
      setCrashUser(null);
      return;
    }
    setCrashUser({ id: user.userId, email: user.email, role: user.role });
  }, [isAuthenticated, user]);

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
