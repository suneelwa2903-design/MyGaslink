import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { getTabBarConfig } from '../../src/theme';
import { useIsDark } from '../../src/stores/themeStore';

const TAB_CONFIG: { name: string; title: string; iconFocused: string; iconOutline: string }[] = [
  { name: 'dashboard', title: 'Analytics', iconFocused: 'analytics', iconOutline: 'analytics-outline' },
  { name: 'orders', title: 'Orders', iconFocused: 'receipt', iconOutline: 'receipt-outline' },
  { name: 'inventory', title: 'Inventory', iconFocused: 'cube', iconOutline: 'cube-outline' },
  { name: 'customers', title: 'Customers', iconFocused: 'people', iconOutline: 'people-outline' },
  { name: 'more', title: 'More', iconFocused: 'grid', iconOutline: 'grid-outline' },
];

// These files still exist for routing but are hidden from the bottom tab bar.
// They are accessed via the More menu or deep links.
const HIDDEN_TABS = ['distributors', 'billing', 'users', 'fleet', 'settings', 'provider-catalog', 'health'];

export default function SuperAdminLayout() {
  const dark = useIsDark();
  const tabBarConfig = getTabBarConfig(dark);

  return (
    <Tabs screenOptions={tabBarConfig}>
      {TAB_CONFIG.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.title,
            tabBarIcon: ({ focused, color, size }) => (
              <Ionicons
                name={(focused ? tab.iconFocused : tab.iconOutline) as keyof typeof Ionicons.glyphMap}
                size={size ?? 22}
                color={color}
              />
            ),
          }}
        />
      ))}
      {/* Hidden screens -- still routable but not shown as tabs */}
      {HIDDEN_TABS.map((name) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{ href: null }}
        />
      ))}
    </Tabs>
  );
}
