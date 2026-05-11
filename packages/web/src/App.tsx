import { AppRoutes } from '@/routes';
import { FullPageLoader } from '@/components/ui';
import { useAuthStore } from '@/stores/authStore';

export function App() {
  // Wait for zustand/persist to finish reading localStorage before mounting
  // the router. Without this gate, the first synchronous render sees the
  // initial (unauthenticated) state and ProtectedRoute bounces refreshing
  // users to /login before persist has had a chance to rehydrate.
  const hasHydrated = useAuthStore((s) => s._hasHydrated);
  if (!hasHydrated) return <FullPageLoader />;
  return <AppRoutes />;
}
