import { View, Text, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/stores/authStore';
import { useDistributorStore } from '../../src/stores/distributorStore';
import { Badge } from '../../src/components/ui';
import { useTheme } from '../../src/theme';

// ── Menu items ───────────────────────────────────────────────────────────────

type MenuItem = {
  label: string;
  description: string;
  icon: keyof typeof Ionicons.glyphMap;
  route?: string;
  action?: 'logout';
  separator?: boolean;
};

const MENU_ITEMS: MenuItem[] = [
  { label: 'Billing & Payments', description: 'Billing cycles, invoices, payments', icon: 'card-outline', route: '/(super-admin)/billing' },
  { label: 'Fleet', description: 'Drivers & vehicles management', icon: 'car-outline', route: '/(super-admin)/fleet' },
  { label: 'Settings', description: 'System configuration', icon: 'settings-outline', route: '/(super-admin)/settings' },
  { label: 'Distributors', description: 'Manage distributor accounts', icon: 'business-outline', route: '/(super-admin)/distributors' },
  { label: 'Provider Catalog', description: 'Cylinder types & pricing catalog', icon: 'pricetag-outline', route: '/(super-admin)/provider-catalog' },
  { label: 'Health Monitoring', description: 'System health & diagnostics', icon: 'pulse-outline', route: '/(super-admin)/health' },
  { label: 'Users', description: 'User accounts & roles', icon: 'person-outline', route: '/(super-admin)/users', separator: true },
  { label: 'Sign Out', description: 'Log out of your account', icon: 'log-out-outline', action: 'logout' },
];

// ── Main Screen ──────────────────────────────────────────────────────────────

export default function MoreScreen() {
  const router = useRouter();
  const { dark, colors, accent } = useTheme();
  const { user, logout } = useAuthStore();
  const { selectedDistributorName } = useDistributorStore();

  const handleLogout = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: async () => { await logout(); router.replace('/(auth)/login'); } },
    ]);
  };

  const handlePress = (item: MenuItem) => {
    if (item.action === 'logout') {
      handleLogout();
      return;
    }
    if (item.route) {
      router.push(item.route as any);
      return;
    }
    // Placeholder for screens not yet implemented
    Alert.alert('Coming Soon', `${item.label} will be available in a future update.`);
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 32 }}>
        {/* ── User Card ─────────────────────────────────────────────────── */}
        <View style={{
          backgroundColor: dark ? colors.cardBg : '#fff',
          borderRadius: 16,
          padding: 16,
          borderWidth: 1,
          borderColor: colors.cardBorder,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
        }}>
          <View style={{
            width: 52,
            height: 52,
            borderRadius: 26,
            backgroundColor: dark ? 'rgba(220, 38, 38, 0.15)' : '#fef2f2',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <Text style={{ fontSize: 22, fontWeight: '700', color: accent.red }}>
              {user?.firstName?.[0]?.toUpperCase() || 'S'}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>
              {user?.firstName} {user?.lastName}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
              <Badge label="SUPER ADMIN" variant="danger" />
            </View>
            {selectedDistributorName && (
              <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 4 }}>
                Operating as: {selectedDistributorName}
              </Text>
            )}
          </View>
        </View>

        {/* ── Menu Section ──────────────────────────────────────────────── */}
        <Text style={{
          fontSize: 14,
          fontWeight: '600',
          color: colors.textSecondary,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          marginTop: 4,
        }}>
          Management
        </Text>

        {MENU_ITEMS.map((item) => (
          <View key={item.label}>
            {item.separator && (
              <View style={{ height: 1, backgroundColor: colors.divider, marginVertical: 4 }} />
            )}
            <TouchableOpacity
              onPress={() => handlePress(item)}
              style={{
                backgroundColor: item.action === 'logout'
                  ? (dark ? 'rgba(220, 38, 38, 0.1)' : '#fef2f2')
                  : (dark ? colors.cardBg : '#fff'),
                borderRadius: 14,
                padding: 16,
                borderWidth: 1,
                borderColor: item.action === 'logout'
                  ? (dark ? 'rgba(220, 38, 38, 0.3)' : '#fecaca')
                  : colors.cardBorder,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
              }}
              activeOpacity={0.7}
            >
              <View style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                backgroundColor: item.action === 'logout'
                  ? (dark ? 'rgba(220, 38, 38, 0.2)' : '#fee2e2')
                  : (dark ? colors.inputBg : colors.cardBg),
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <Ionicons
                  name={item.icon}
                  size={20}
                  color={item.action === 'logout' ? accent.red : accent.red}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{
                  fontWeight: '600',
                  fontSize: 15,
                  color: item.action === 'logout' ? accent.red : colors.text,
                }}>
                  {item.label}
                </Text>
                <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 1 }}>
                  {item.description}
                </Text>
              </View>
              {item.action !== 'logout' && (
                <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
              )}
            </TouchableOpacity>
          </View>
        ))}

        <Text style={{ textAlign: 'center', fontSize: 11, color: colors.textMuted, marginTop: 12 }}>
          MyGasLink v1.0.0 — Super Admin
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
