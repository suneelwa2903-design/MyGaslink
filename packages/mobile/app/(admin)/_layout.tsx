import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useIsDark } from '../../src/stores/themeStore';
import { useAuthStore } from '../../src/stores/authStore';
import { AppHeader } from '../../src/components/AppHeader';
import { ScrollableTabBar } from '../../src/components/ui/ScrollableTabBar';

// STAGE-H: extended from 5 → 9 visible tabs. ScrollableTabBar gives us a
// horizontal scroll so a 9-tab strip stays legible on narrow phones (the
// React-Navigation default packs them and starts truncating around 6+).
// Collections moved from hidden (href:null) to a visible tab; Reports,
// Customers, and Fleet are promoted out of the More-modal-soup.
const TAB_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  dashboard: 'grid-outline',
  orders: 'receipt-outline',
  billing: 'card-outline',
  inventory: 'cube-outline',
  reports: 'bar-chart-outline',
  customers: 'people-outline',
  fleet: 'car-sport-outline',
  collections: 'wallet-outline',
  more: 'menu-outline',
  // Mini-Operator (2026-07-16): purchases screen — stock IN from source
  // distributors. Only surfaced for accountType='mini_operator' tenants.
  purchases: 'cart-outline',
};

const TAB_ICONS_FOCUSED: Record<string, keyof typeof Ionicons.glyphMap> = {
  dashboard: 'grid',
  orders: 'receipt',
  billing: 'card',
  inventory: 'cube',
  reports: 'bar-chart',
  customers: 'people',
  fleet: 'car-sport',
  collections: 'wallet',
  more: 'menu',
  purchases: 'cart',
};

export default function AdminLayout() {
  const dark = useIsDark();
  // Mini-Operator (2026-07-16): reduce the tab set for accountType=
  // mini_operator tenants. Purchases tab lands in Step 8 — for now the
  // visible-for-mini-op set is Dashboard / Orders / Inventory /
  // Customers / More. Hidden: finance (Billing), fleet, reports,
  // collections. Regular distributor_admin sees every tab as before.
  const user = useAuthStore((s) => s.user);
  const isMiniOperator = user?.role === 'mini_operator_admin';

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
        // ScrollableTabBar reads height/border itself; these stay for any
        // screen that briefly falls back to defaults (none today).
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
        name="dashboard"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? TAB_ICONS_FOCUSED.dashboard : TAB_ICONS.dashboard}
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
        name="finance"
        options={isMiniOperator ? { href: null, title: 'Billing', tabBarItemStyle: { display: 'none' } } : {
          title: 'Billing',
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? TAB_ICONS_FOCUSED.billing : TAB_ICONS.billing}
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
      {/* Mini-Operator (2026-07-16): Purchases tab is visible ONLY for
          mini_operator_admin. For every other role (distributor_admin,
          super_admin, etc.) the tab is hidden via the standard
          `href: null + tabBarItemStyle:{display:'none'}` pattern used
          elsewhere in this layout — the file itself still exists so
          expo-router can route to it programmatically, but it never
          appears in the tab bar. */}
      <Tabs.Screen
        name="purchases"
        options={isMiniOperator ? {
          title: 'Purchases',
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? TAB_ICONS_FOCUSED.purchases : TAB_ICONS.purchases}
              size={22}
              color={focused ? activeColor : inactiveColor}
            />
          ),
        } : { href: null, title: 'Purchases', tabBarItemStyle: { display: 'none' } }}
      />
      {/* STAGE-H: new — was a 3-tab quasi-modal (Revenue/Top Customers/Drivers)
          inside more.tsx. Now a real screen that hits every report at
          /api/reports/:reportType. */}
      <Tabs.Screen
        name="reports"
        options={isMiniOperator ? { href: null, title: 'Reports', tabBarItemStyle: { display: 'none' } } : {
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
      {/* STAGE-H: promoted from CustomersModal in more.tsx. */}
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
      {/* STAGE-H: promoted from FleetModal in more.tsx. */}
      <Tabs.Screen
        name="fleet"
        options={isMiniOperator ? { href: null, title: 'Fleet', tabBarItemStyle: { display: 'none' } } : {
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
      {/* STAGE-H: was hidden (href:null) since STEP-3C and reached via the
          More → Collections row. Now a first-class tab. */}
      <Tabs.Screen
        name="collections"
        options={isMiniOperator ? { href: null, title: 'Collections', tabBarItemStyle: { display: 'none' } } : {
          title: 'Collections',
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? TAB_ICONS_FOCUSED.collections : TAB_ICONS.collections}
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
      {/* Hidden screens (still routable via router.push). The `href: null`
          expo-router option stops the tab bar from receiving the route as
          a link target, but our custom ScrollableTabBar still saw them
          because expo-router strips `href` from the descriptor options
          before passing them to a custom bar — so `opts.href !== null`
          evaluated to `undefined !== null === true` and the screens
          leaked into the bar. Adding `tabBarItemStyle: { display: 'none' }`
          gives the custom bar a property it can actually filter on. */}
      <Tabs.Screen name="pending-actions" options={{ href: null, title: 'Pending Actions', tabBarItemStyle: { display: 'none' } }} />
      <Tabs.Screen name="customer-detail" options={{ href: null, title: 'Customer', tabBarItemStyle: { display: 'none' } }} />
      <Tabs.Screen name="customer-create" options={{ href: null, title: 'New Customer', tabBarItemStyle: { display: 'none' } }} />
      <Tabs.Screen name="profile" options={{ href: null, title: 'My Profile', tabBarItemStyle: { display: 'none' } }} />
      {/* WI-PENDING-PAYMENTS: pending approval queue. Stack-pushed from
          the More tab, never a primary tab. */}
      <Tabs.Screen name="pending-payments" options={{ href: null, title: 'Pending Payments', tabBarItemStyle: { display: 'none' } }} />
    </Tabs>
  );
}
