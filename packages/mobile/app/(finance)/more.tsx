import { View, Text, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuthStore } from '../../src/stores/authStore';
import { useTheme } from '../../src/theme';
import { Card, Badge } from '../../src/components/ui';

interface MenuItem {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  subtitle?: string;
  onPress: () => void;
  danger?: boolean;
}

export default function FinanceMoreScreen() {
  const { dark, colors, accent } = useTheme();
  const router = useRouter();
  const { user, logout } = useAuthStore();

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          await logout();
          router.replace('/(auth)/login');
        },
      },
    ]);
  };

  const menuItems: MenuItem[] = [
    // Phase A (2026-06-12): read-only Orders + full Customers + the same
    // 7 Reports admin has. All three live under the finance route group
    // — see _layout.tsx for the route entries (hidden via href: null so
    // the bottom tab bar stays at 5).
    {
      icon: 'clipboard-outline',
      label: 'Orders',
      subtitle: 'View order list and status (read-only)',
      onPress: () => router.push('/(finance)/orders'),
    },
    {
      icon: 'people-outline',
      label: 'Customers',
      subtitle: 'Browse customer accounts, ledgers, invoices',
      onPress: () => router.push('/(finance)/customers'),
    },
    // 2026-06-15: finance-parity additions. Re-exports of admin's
    // inventory + fleet screens. Admin's canEdit gate hides write
    // buttons; finance sees them as read-only operational views.
    {
      icon: 'cube-outline',
      label: 'Inventory',
      subtitle: 'Stock levels, movements, vehicle return',
      onPress: () => router.push('/(finance)/inventory'),
    },
    {
      icon: 'car-outline',
      label: 'Fleet',
      subtitle: 'Drivers, vehicles, and daily assignments',
      onPress: () => router.push('/(finance)/fleet'),
    },
    {
      icon: 'analytics-outline',
      label: 'Reports',
      subtitle: 'Sales, aging, GST, performance and more',
      onPress: () => router.push('/(finance)/reports'),
    },
    // WI-PENDING-PAYMENTS: pending payment approval queue. Re-exports
    // the admin canonical screen via (finance)/pending-payments.tsx.
    {
      icon: 'time-outline',
      label: 'Pending Payment Approvals',
      subtitle: 'Verify or reject self-reported payments',
      // Group-relative path so navigation stays inside (finance).
      onPress: () => router.push('/pending-payments'),
    },
    {
      icon: 'person-outline',
      label: 'Profile',
      subtitle: 'View your account details',
      onPress: () => router.push('/(finance)/profile'),
    },
    {
      icon: 'log-out-outline',
      label: 'Sign Out',
      onPress: handleLogout,
      danger: true,
    },
  ];

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {/* User Card */}
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundColor: dark ? 'rgba(217,119,6,0.15)' : '#fffbeb',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <Text style={{ fontSize: 24, fontWeight: '700', color: '#d97706' }}>
                {user?.firstName?.[0]?.toUpperCase() || '?'}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text }}>
                {user?.firstName} {user?.lastName}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <Badge label="FINANCE" variant="warning" />
              </View>
              {user?.email && (
                <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 4 }}>{user.email}</Text>
              )}
            </View>
          </View>
        </Card>

        {/* Menu Items */}
        <Card>
          {menuItems.map((item, idx) => (
            <TouchableOpacity
              key={item.label}
              onPress={item.onPress}
              activeOpacity={0.6}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: 14,
                borderTopWidth: idx > 0 ? 1 : 0,
                borderTopColor: colors.divider,
              }}
            >
              <View style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                backgroundColor: item.danger
                  ? (dark ? 'rgba(220,38,38,0.12)' : '#fef2f2')
                  : (dark ? colors.inputBg : '#f1f5f9'),
                alignItems: 'center',
                justifyContent: 'center',
                marginRight: 12,
              }}>
                <Ionicons
                  name={item.icon}
                  size={20}
                  color={item.danger ? accent.red : colors.textSecondary}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{
                  fontSize: 15,
                  fontWeight: '600',
                  color: item.danger ? accent.red : colors.text,
                }}>
                  {item.label}
                </Text>
                {item.subtitle && (
                  <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 1 }}>
                    {item.subtitle}
                  </Text>
                )}
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          ))}
        </Card>

        <Text style={{ textAlign: 'center', fontSize: 11, color: colors.textMuted, marginTop: 8 }}>
          MyGasLink v1.0.0
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
