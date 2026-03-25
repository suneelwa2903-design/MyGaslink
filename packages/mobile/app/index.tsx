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
        router.replace('/(inventory)/summary');
        break;
      case 'finance':
        router.replace('/(finance)/dashboard');
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
