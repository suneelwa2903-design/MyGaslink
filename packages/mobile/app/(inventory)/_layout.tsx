/**
 * 2026-06-15 — inventory role layout: mirrors admin layout.
 *
 * 7 visible tabs (Dashboard / Orders / Inventory / Reports /
 * Customers / Fleet / More) vs admin's 9 — Billing and Collections
 * are reachable as hidden routes from the dashboard KPI cards and
 * from the More hub but kept off the bottom bar. Uses the same
 * ScrollableTabBar so 7 tabs stay legible on narrow phones.
 *
 * Replaces the prior 5-tab purpose-built inventory layout.
 *
 * Route-name note: the Dashboard tab is named `analytics` because
 * (inventory)/analytics.tsx is the file that re-exports admin's
 * dashboard. The display title is "Dashboard" to match admin.
 */
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useIsDark } from '../../src/stores/themeStore';
import { AppHeader } from '../../src/components/AppHeader';
import { ScrollableTabBar } from '../../src/components/ui/ScrollableTabBar';
import { RoleGuard } from '../../src/components/RoleGuard';

const TAB_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  analytics: 'grid-outline',
  orders: 'receipt-outline',
  inventory: 'cube-outline',
  reports: 'bar-chart-outline',
  customers: 'people-outline',
  fleet: 'car-sport-outline',
  more: 'menu-outline',
};

const TAB_ICONS_FOCUSED: Record<string, keyof typeof Ionicons.glyphMap> = {
  analytics: 'grid',
  orders: 'receipt',
  inventory: 'cube',
  reports: 'bar-chart',
  customers: 'people',
  fleet: 'car-sport',
  more: 'menu',
};

function InventoryLayoutInner() {
  const dark = useIsDark();

  const bg = dark ? '#0f172a' : '#ffffff';
  const headerBg = dark ? '#1e293b' : '#ffffff';
  const headerText = dark ? '#f1f5f9' : '#0f172a';
  const borderColor = dark ? '#334155' : '#e2e8f0';
  const activeColor = '#dc2626';
  const inactiveColor = dark ? '#94a3b8' : '#94a3b8';

  return (
    <Tabs
      tabBar={(props) => <ScrollableTabBar {...props} />}
      screenOptions={{
        headerTitle: () => <AppHeader />,
        headerTitleAlign: 'center',
        headerStyle: {
          backgroundColor: headerBg,
          elevation: 0,
          shadowOpacity: 0,
          borderBottomWidth: 1,
          borderBottomColor: borderColor,
        },
        headerTitleStyle: { fontWeight: '700', fontSize: 18, color: headerText },
        tabBarActiveTintColor: activeColor,
        tabBarInactiveTintColor: inactiveColor,
        tabBarStyle: {
          backgroundColor: bg,
          borderTopWidth: 1,
          borderTopColor: borderColor,
          paddingTop: 6,
          paddingBottom: 8,
          height: 64,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        sceneStyle: { backgroundColor: bg },
      }}
    >
      <Tabs.Screen
        name="analytics"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? TAB_ICONS_FOCUSED.analytics : TAB_ICONS.analytics}
              size={22}
              color={focused ? activeColor : inactiveColor}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: 'Orders',
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? TAB_ICONS_FOCUSED.orders : TAB_ICONS.orders}
              size={22}
              color={focused ? activeColor : inactiveColor}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="inventory"
        options={{
          title: 'Inventory',
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? TAB_ICONS_FOCUSED.inventory : TAB_ICONS.inventory}
              size={22}
              color={focused ? activeColor : inactiveColor}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="reports"
        options={{
          title: 'Reports',
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? TAB_ICONS_FOCUSED.reports : TAB_ICONS.reports}
              size={22}
              color={focused ? activeColor : inactiveColor}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="customers"
        options={{
          title: 'Customers',
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? TAB_ICONS_FOCUSED.customers : TAB_ICONS.customers}
              size={22}
              color={focused ? activeColor : inactiveColor}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="fleet"
        options={{
          title: 'Fleet',
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? TAB_ICONS_FOCUSED.fleet : TAB_ICONS.fleet}
              size={22}
              color={focused ? activeColor : inactiveColor}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? TAB_ICONS_FOCUSED.more : TAB_ICONS.more}
              size={22}
              color={focused ? activeColor : inactiveColor}
            />
          ),
        }}
      />
      {/* Hidden routable screens — reached from dashboard KPI cards,
          More hub, or customers FAB. Same display-none pattern as
          admin/_layout.tsx so the ScrollableTabBar filters them out. */}
      <Tabs.Screen name="finance" options={{ href: null, title: 'Billing', tabBarItemStyle: { display: 'none' } }} />
      <Tabs.Screen name="collections" options={{ href: null, title: 'Collections', tabBarItemStyle: { display: 'none' } }} />
      <Tabs.Screen name="pending-actions" options={{ href: null, title: 'Pending Actions', tabBarItemStyle: { display: 'none' } }} />
      <Tabs.Screen name="customer-detail" options={{ href: null, title: 'Customer', tabBarItemStyle: { display: 'none' } }} />
      <Tabs.Screen name="customer-create" options={{ href: null, title: 'New Customer', tabBarItemStyle: { display: 'none' } }} />
      <Tabs.Screen name="profile" options={{ href: null, title: 'My Profile', tabBarItemStyle: { display: 'none' } }} />
    </Tabs>
  );
}

export default function InventoryLayout() {
  // 2026-07-19 SECURITY: only 'inventory' role reaches inventory tabs.
  return (
    <RoleGuard allowed={['inventory']}>
      <InventoryLayoutInner />
    </RoleGuard>
  );
}
