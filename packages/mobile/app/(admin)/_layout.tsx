import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useIsDark } from '../../src/stores/themeStore';
import { AppHeader } from '../../src/components/AppHeader';

const TAB_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  dashboard: 'grid-outline',
  orders: 'receipt-outline',
  billing: 'card-outline',
  inventory: 'cube-outline',
  more: 'menu-outline',
};

const TAB_ICONS_FOCUSED: Record<string, keyof typeof Ionicons.glyphMap> = {
  dashboard: 'grid',
  orders: 'receipt',
  billing: 'card',
  inventory: 'cube',
  more: 'menu',
};

export default function AdminLayout() {
  const dark = useIsDark();

  const bg = dark ? '#0f172a' : '#ffffff';
  const headerBg = dark ? '#1e293b' : '#ffffff';
  const headerText = dark ? '#f1f5f9' : '#0f172a';
  const borderColor = dark ? '#334155' : '#e2e8f0';
  const activeColor = '#dc2626';
  const inactiveColor = dark ? '#94a3b8' : '#94a3b8';
  const tabBg = dark ? '#0f172a' : '#ffffff';

  return (
    <Tabs screenOptions={{
      headerTitle: () => <AppHeader />,
      headerTitleAlign: 'center',
      headerStyle: { backgroundColor: headerBg, elevation: 0, shadowOpacity: 0, borderBottomWidth: 1, borderBottomColor: borderColor },
      headerTitleStyle: { fontWeight: '700', fontSize: 18, color: headerText },
      tabBarActiveTintColor: activeColor,
      tabBarInactiveTintColor: inactiveColor,
      tabBarStyle: {
        backgroundColor: tabBg,
        borderTopWidth: 1,
        borderTopColor: borderColor,
        paddingTop: 6,
        paddingBottom: 8,
        height: 64,
      },
      tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      sceneStyle: { backgroundColor: bg },
    }}>
      <Tabs.Screen name="dashboard" options={{
        title: 'Dashboard',
        tabBarIcon: ({ focused }) => (
          <Ionicons name={focused ? TAB_ICONS_FOCUSED.dashboard : TAB_ICONS.dashboard} size={22} color={focused ? activeColor : inactiveColor} />
        ),
      }} />
      <Tabs.Screen name="orders" options={{
        title: 'Orders',
        tabBarIcon: ({ focused }) => (
          <Ionicons name={focused ? TAB_ICONS_FOCUSED.orders : TAB_ICONS.orders} size={22} color={focused ? activeColor : inactiveColor} />
        ),
      }} />
      <Tabs.Screen name="finance" options={{
        title: 'Billing',
        tabBarIcon: ({ focused }) => (
          <Ionicons name={focused ? TAB_ICONS_FOCUSED.billing : TAB_ICONS.billing} size={22} color={focused ? activeColor : inactiveColor} />
        ),
      }} />
      <Tabs.Screen name="inventory" options={{
        title: 'Inventory',
        tabBarIcon: ({ focused }) => (
          <Ionicons name={focused ? TAB_ICONS_FOCUSED.inventory : TAB_ICONS.inventory} size={22} color={focused ? activeColor : inactiveColor} />
        ),
      }} />
      <Tabs.Screen name="more" options={{
        title: 'More',
        tabBarIcon: ({ focused }) => (
          <Ionicons name={focused ? TAB_ICONS_FOCUSED.more : TAB_ICONS.more} size={22} color={focused ? activeColor : inactiveColor} />
        ),
      }} />
      {/* STEP-3B: Pending Actions full screen. Hidden from the tab bar —
          reached via the dashboard "View All" link and (future) the bell. */}
      <Tabs.Screen name="pending-actions" options={{ href: null, title: 'Pending Actions' }} />
    </Tabs>
  );
}
