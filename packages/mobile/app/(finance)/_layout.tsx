import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getTabBarConfig } from '../../src/theme';
import { useIsDark } from '../../src/stores/themeStore';
import { AppHeader } from '../../src/components/AppHeader';

const TAB_CONFIG: {
  name: string;
  title: string;
  iconOutline: keyof typeof Ionicons.glyphMap;
  iconFilled: keyof typeof Ionicons.glyphMap;
  href?: null;
}[] = [
  { name: 'dashboard', title: 'Analytics', iconOutline: 'bar-chart-outline', iconFilled: 'bar-chart' },
  { name: 'invoices', title: 'Invoices', iconOutline: 'document-text-outline', iconFilled: 'document-text' },
  { name: 'payments', title: 'Payments', iconOutline: 'card-outline', iconFilled: 'card' },
  { name: 'collections', title: 'Collections', iconOutline: 'cash-outline', iconFilled: 'cash' },
  { name: 'more', title: 'More', iconOutline: 'grid-outline', iconFilled: 'grid' },
  { name: 'profile', title: 'Profile', iconOutline: 'person-outline', iconFilled: 'person', href: null },
  // Phase A (2026-06-12): the finance role gets read-only orders + full
  // customers + the same 7 reports admin has, reached from the More tab.
  // Hidden from the tab bar with href: null to keep the bottom bar at the
  // mobile-mandated 5-tab limit. Mounting them under (finance) is required
  // so navigation stays inside this layout — re-routing into (admin) would
  // surface the admin tab bar mid-flow.
  { name: 'orders', title: 'Orders', iconOutline: 'clipboard-outline', iconFilled: 'clipboard', href: null },
  { name: 'customers', title: 'Customers', iconOutline: 'people-outline', iconFilled: 'people', href: null },
  { name: 'customer-detail', title: 'Customer', iconOutline: 'person-outline', iconFilled: 'person', href: null },
  { name: 'reports', title: 'Reports', iconOutline: 'analytics-outline', iconFilled: 'analytics', href: null },
];

export default function FinanceLayout() {
  const dark = useIsDark();
  const insets = useSafeAreaInsets();
  const tabBarConfig = getTabBarConfig(dark, insets);

  return (
    <Tabs screenOptions={{
      ...tabBarConfig,
      headerTitle: () => <AppHeader />,
      headerTitleAlign: 'center',
    }}>
      {TAB_CONFIG.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.title,
            ...(tab.href === null ? { href: null } : {}),
            tabBarIcon: ({ focused, color }) => (
              <Ionicons
                name={focused ? tab.iconFilled : tab.iconOutline}
                size={22}
                color={color}
              />
            ),
          }}
        />
      ))}
    </Tabs>
  );
}
