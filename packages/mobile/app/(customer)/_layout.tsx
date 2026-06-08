import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getTabBarConfig } from '../../src/theme';
import { useIsDark } from '../../src/stores/themeStore';
import { AppHeader } from '../../src/components/AppHeader';

const TAB_CONFIG: Array<{
  name: string;
  title: string;
  iconOutline: keyof typeof Ionicons.glyphMap;
  iconFilled: keyof typeof Ionicons.glyphMap;
}> = [
  { name: 'dashboard', title: 'Dashboard', iconOutline: 'home-outline', iconFilled: 'home' },
  { name: 'orders', title: 'Orders', iconOutline: 'cart-outline', iconFilled: 'cart' },
  { name: 'invoices', title: 'Invoices', iconOutline: 'document-text-outline', iconFilled: 'document-text' },
  { name: 'payments', title: 'Payments', iconOutline: 'cash-outline', iconFilled: 'cash' },
  { name: 'account', title: 'Account', iconOutline: 'person-outline', iconFilled: 'person' },
];

export default function CustomerLayout() {
  const dark = useIsDark();
  const insets = useSafeAreaInsets();

  return (
    <Tabs screenOptions={{
      ...getTabBarConfig(dark, insets),
      headerTitle: () => <AppHeader />,
      headerTitleAlign: 'center',
    }}>
      {TAB_CONFIG.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.title,
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
