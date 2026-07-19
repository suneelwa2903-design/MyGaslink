/**
 * Mobile HQ portal layout (2026-07-19).
 *
 * Full parity with the web /hq portal: Dashboard / Orders / Invoices /
 * Ledger / Payments / Aging / Profile — 7 tabs surfaced through the
 * ScrollableTabBar the admin surface uses. Same design language as
 * (admin)/_layout so a hotel-chain owner switching between admin and
 * HQ contexts (some suneel test users have both roles at different
 * distributors) doesn't get a shape change.
 *
 * Security: RoleGuard restricts every screen in this group to the
 * `customer_hq` role. Server-side, /api/customer-group-portal/* is
 * gated by requireGroupAccess middleware which additionally validates
 * that req.user.groupId belongs to req.user.distributorId AND
 * populates req.visibleCustomerIds tenant-scoped. Two-layer defence.
 *
 * The pre-2026-07-19 "Open in Browser" fallback screen is preserved at
 * `_fallback.tsx` for any future case where the mobile HQ experience
 * needs to be disabled per-tenant (feature flag land).
 */
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useIsDark } from '../../src/stores/themeStore';
import { AppHeader } from '../../src/components/AppHeader';
import { ScrollableTabBar } from '../../src/components/ui/ScrollableTabBar';
import { RoleGuard } from '../../src/components/RoleGuard';

const TAB_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  index: 'grid-outline',
  orders: 'receipt-outline',
  invoices: 'document-text-outline',
  ledger: 'book-outline',
  payments: 'cash-outline',
  aging: 'time-outline',
  profile: 'person-outline',
};
const TAB_ICONS_FOCUSED: Record<string, keyof typeof Ionicons.glyphMap> = {
  index: 'grid',
  orders: 'receipt',
  invoices: 'document-text',
  ledger: 'book',
  payments: 'cash',
  aging: 'time',
  profile: 'person',
};

function HqLayoutInner() {
  const dark = useIsDark();

  const bg = dark ? '#0f172a' : '#ffffff';
  const headerBg = dark ? '#1e293b' : '#ffffff';
  const headerText = dark ? '#f1f5f9' : '#0f172a';
  const borderColor = dark ? '#334155' : '#e2e8f0';
  // Match the (admin) and (inventory) tab bars — same red so a hotel-
  // chain owner switching between admin (they own the LPG business
  // relationship for their chain) and HQ contexts doesn't get a
  // chromatic shift on the tab strip. See ACCENT.red in theme.ts.
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
        name="index"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ focused }) => (
            <Ionicons name={focused ? TAB_ICONS_FOCUSED.index : TAB_ICONS.index} size={22} color={focused ? activeColor : inactiveColor} />
          ),
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: 'Orders',
          tabBarIcon: ({ focused }) => (
            <Ionicons name={focused ? TAB_ICONS_FOCUSED.orders : TAB_ICONS.orders} size={22} color={focused ? activeColor : inactiveColor} />
          ),
        }}
      />
      <Tabs.Screen
        name="invoices"
        options={{
          title: 'Invoices',
          tabBarIcon: ({ focused }) => (
            <Ionicons name={focused ? TAB_ICONS_FOCUSED.invoices : TAB_ICONS.invoices} size={22} color={focused ? activeColor : inactiveColor} />
          ),
        }}
      />
      <Tabs.Screen
        name="ledger"
        options={{
          title: 'Ledger',
          tabBarIcon: ({ focused }) => (
            <Ionicons name={focused ? TAB_ICONS_FOCUSED.ledger : TAB_ICONS.ledger} size={22} color={focused ? activeColor : inactiveColor} />
          ),
        }}
      />
      <Tabs.Screen
        name="payments"
        options={{
          title: 'Payments',
          tabBarIcon: ({ focused }) => (
            <Ionicons name={focused ? TAB_ICONS_FOCUSED.payments : TAB_ICONS.payments} size={22} color={focused ? activeColor : inactiveColor} />
          ),
        }}
      />
      <Tabs.Screen
        name="aging"
        options={{
          title: 'Aging',
          tabBarIcon: ({ focused }) => (
            <Ionicons name={focused ? TAB_ICONS_FOCUSED.aging : TAB_ICONS.aging} size={22} color={focused ? activeColor : inactiveColor} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ focused }) => (
            <Ionicons name={focused ? TAB_ICONS_FOCUSED.profile : TAB_ICONS.profile} size={22} color={focused ? activeColor : inactiveColor} />
          ),
        }}
      />
      <Tabs.Screen name="_fallback" options={{ href: null }} />
    </Tabs>
  );
}

export default function HqLayout() {
  // 2026-07-19 SECURITY: only 'customer_hq' role reaches HQ screens.
  return (
    <RoleGuard allowed={['customer_hq']}>
      <HqLayoutInner />
    </RoleGuard>
  );
}
