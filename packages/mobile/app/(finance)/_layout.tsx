import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { getTabBarConfig } from '../../src/theme';
import { useIsDark } from '../../src/stores/themeStore';

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
];

export default function FinanceLayout() {
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
