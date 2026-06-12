import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getTabBarConfig } from '../../src/theme';
import { useIsDark } from '../../src/stores/themeStore';
import { AppHeader } from '../../src/components/AppHeader';

const TAB_ICONS: Record<string, { outline: keyof typeof Ionicons.glyphMap; filled: keyof typeof Ionicons.glyphMap }> = {
  analytics: { outline: 'bar-chart-outline', filled: 'bar-chart' },
  orders: { outline: 'receipt-outline', filled: 'receipt' },
  inventory: { outline: 'cube-outline', filled: 'cube' },
  fleet: { outline: 'car-outline', filled: 'car' },
  more: { outline: 'grid-outline', filled: 'grid' },
};

export default function InventoryLayout() {
  const dark = useIsDark();
  const insets = useSafeAreaInsets();
  const tabBarConfig = getTabBarConfig(dark, insets);

  return (
    <Tabs screenOptions={{
      ...tabBarConfig,
      headerTitle: () => <AppHeader />,
      headerTitleAlign: 'center',
    }}>
      <Tabs.Screen name="analytics" options={{
        title: 'Analytics',
        tabBarIcon: ({ focused, color }) => (
          <Ionicons name={focused ? TAB_ICONS.analytics.filled : TAB_ICONS.analytics.outline} size={22} color={color} />
        ),
      }} />
      <Tabs.Screen name="orders" options={{
        title: 'Orders',
        tabBarIcon: ({ focused, color }) => (
          <Ionicons name={focused ? TAB_ICONS.orders.filled : TAB_ICONS.orders.outline} size={22} color={color} />
        ),
      }} />
      <Tabs.Screen name="inventory" options={{
        title: 'Inventory',
        tabBarIcon: ({ focused, color }) => (
          <Ionicons name={focused ? TAB_ICONS.inventory.filled : TAB_ICONS.inventory.outline} size={22} color={color} />
        ),
      }} />
      <Tabs.Screen name="fleet" options={{
        title: 'Fleet',
        tabBarIcon: ({ focused, color }) => (
          <Ionicons name={focused ? TAB_ICONS.fleet.filled : TAB_ICONS.fleet.outline} size={22} color={color} />
        ),
      }} />
      <Tabs.Screen name="more" options={{
        title: 'More',
        tabBarIcon: ({ focused, color }) => (
          <Ionicons name={focused ? TAB_ICONS.more.filled : TAB_ICONS.more.outline} size={22} color={color} />
        ),
      }} />

      {/* Hidden legacy screens - accessible from Inventory tab sub-pills */}
      <Tabs.Screen name="summary" options={{ href: null }} />
      <Tabs.Screen name="actions" options={{ href: null }} />
      <Tabs.Screen name="reconciliation" options={{ href: null }} />
      <Tabs.Screen name="alerts" options={{ href: null }} />
      <Tabs.Screen name="profile" options={{ href: null }} />
      {/* Phase B (2026-06-12): Customers (read-only, cylinder-balance
          focused) + Reports (subset of 3) under the More tab, kept off
          the bottom bar with href: null. */}
      <Tabs.Screen name="customers" options={{ href: null }} />
      <Tabs.Screen name="customer-detail" options={{ href: null }} />
      <Tabs.Screen name="reports" options={{ href: null }} />
    </Tabs>
  );
}
