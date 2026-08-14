import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useIsDark } from '../../src/stores/themeStore';
import { AppHeader } from '../../src/components/AppHeader';
import { ScrollableTabBar } from '../../src/components/ui/ScrollableTabBar';
import { RoleGuard } from '../../src/components/RoleGuard';

// 2026-08-14 (Suneel): Customers + Reports promoted out of the More hub onto
// the bottom scroller, and Corp. Loads added — matching how the inventory role
// surfaces Customers/Reports. With 8 visible tabs the bar switches to the
// horizontal ScrollableTabBar (same as admin + inventory) so they stay legible.
const TAB_CONFIG: {
  name: string;
  title: string;
  iconOutline: keyof typeof Ionicons.glyphMap;
  iconFilled: keyof typeof Ionicons.glyphMap;
  hidden?: boolean;
}[] = [
  { name: 'dashboard', title: 'Analytics', iconOutline: 'bar-chart-outline', iconFilled: 'bar-chart' },
  { name: 'invoices', title: 'Invoices', iconOutline: 'document-text-outline', iconFilled: 'document-text' },
  { name: 'payments', title: 'Payments', iconOutline: 'card-outline', iconFilled: 'card' },
  { name: 'collections', title: 'Collections', iconOutline: 'cash-outline', iconFilled: 'cash' },
  { name: 'customers', title: 'Customers', iconOutline: 'people-outline', iconFilled: 'people' },
  { name: 'reports', title: 'Reports', iconOutline: 'analytics-outline', iconFilled: 'analytics' },
  { name: 'corp-loads', title: 'Corp. Loads', iconOutline: 'business-outline', iconFilled: 'business' },
  { name: 'more', title: 'More', iconOutline: 'grid-outline', iconFilled: 'grid' },
  // Hidden routes — reachable via More / stack push. For the custom
  // ScrollableTabBar, hidden tabs need BOTH href:null AND
  // tabBarItemStyle:{display:'none'} (same pattern as admin/_layout.tsx).
  { name: 'profile', title: 'Profile', iconOutline: 'person-outline', iconFilled: 'person', hidden: true },
  { name: 'orders', title: 'Orders', iconOutline: 'clipboard-outline', iconFilled: 'clipboard', hidden: true },
  { name: 'customer-detail', title: 'Customer', iconOutline: 'person-outline', iconFilled: 'person', hidden: true },
  { name: 'inventory', title: 'Godown', iconOutline: 'cube-outline', iconFilled: 'cube', hidden: true },
  { name: 'fleet', title: 'Transport', iconOutline: 'car-outline', iconFilled: 'car', hidden: true },
  { name: 'pending-payments', title: 'Pending Payments', iconOutline: 'time-outline', iconFilled: 'time', hidden: true },
];

function FinanceLayoutInner() {
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
      {TAB_CONFIG.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={tab.hidden
            ? { href: null, title: tab.title, tabBarItemStyle: { display: 'none' } }
            : {
                title: tab.title,
                tabBarIcon: ({ focused }) => (
                  <Ionicons
                    name={focused ? tab.iconFilled : tab.iconOutline}
                    size={22}
                    color={focused ? activeColor : inactiveColor}
                  />
                ),
              }}
        />
      ))}
    </Tabs>
  );
}

export default function FinanceLayout() {
  // 2026-07-19 SECURITY: only 'finance' role reaches finance tabs.
  return (
    <RoleGuard allowed={['finance']}>
      <FinanceLayoutInner />
    </RoleGuard>
  );
}
