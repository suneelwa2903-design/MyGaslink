import { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuthStore } from '../src/stores/authStore';

export default function Index() {
  const router = useRouter();
  const { isAuthenticated, isLoading, user } = useAuthStore();

  useEffect(() => {
    if (isLoading) return;

    if (!isAuthenticated || !user) {
      router.replace('/(auth)/login');
      return;
    }

    // Route based on role
    switch (user.role) {
      case 'customer':
        router.replace('/(customer)/dashboard');
        break;
      case 'driver':
        router.replace('/(driver)/orders');
        break;
      case 'super_admin':
        router.replace('/(super-admin)/dashboard');
        break;
      case 'distributor_admin':
        router.replace('/(admin)/dashboard');
        break;
      case 'inventory':
        // STEP-2B: `summary` is marked href:null in (inventory)/_layout.tsx and
        // isn't reachable from the tab bar. Land on the first visible tab
        // (`analytics`) instead so the user sees a real screen + active tab.
        router.replace('/(inventory)/analytics');
        break;
      case 'finance':
        router.replace('/(finance)/dashboard');
        break;
      case 'customer_hq':
        // Feature A (2026-07-15): HQ portal is web-only in v1. Land
        // on a dedicated (hq) screen that explains the situation and
        // offers a "Open in Browser" button. Full mobile HQ UX is
        // deferred to a later phase per docs/HQ-PORTAL-BRAINSTORM.md §7.
        router.replace('/(hq)');
        break;
      default:
        router.replace('/(auth)/login');
    }
  }, [isAuthenticated, isLoading, user, router]);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' }}>
      <ActivityIndicator size="large" color="#338dff" />
    </View>
  );
}
