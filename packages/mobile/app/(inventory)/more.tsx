import { View, Text, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuthStore } from '../../src/stores/authStore';
import { Card, Badge } from '../../src/components/ui';
import { useTheme } from '../../src/theme';

// ─── Menu items ─────────────────────────────────────────────────────────────

interface MenuItem {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  subtitle?: string;
  action: 'profile' | 'settings' | 'logout';
  color?: string;
  danger?: boolean;
}

const MENU_ITEMS: MenuItem[] = [
  { icon: 'person-outline', label: 'Profile', subtitle: 'View your account details', action: 'profile' },
  { icon: 'settings-outline', label: 'Settings', subtitle: 'App preferences & notifications', action: 'settings' },
  { icon: 'log-out-outline', label: 'Sign Out', subtitle: 'Log out of your account', action: 'logout', danger: true, color: '#ef4444' },
];

// ─── Main Screen ────────────────────────────────────────────────────────────

export default function MoreScreen() {
  const { dark, colors, accent } = useTheme();
  const router = useRouter();
  const { user, logout } = useAuthStore();

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: async () => { await logout(); router.replace('/(auth)/login'); } },
    ]);
  };

  const handleMenuPress = (action: MenuItem['action']) => {
    switch (action) {
      case 'profile':
        // STAGE-E: Profile is now an editable self-service screen at
        // (inventory)/profile.tsx — route there instead of leaving the row
        // as a no-op that displays the (already visible) user card.
        router.push('/(inventory)/profile');
        break;
      case 'settings':
        // Settings - future implementation
        break;
      case 'logout':
        handleLogout();
        break;
    }
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>More</Text>

        {/* User Card */}
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View style={{
              width: 56, height: 56, borderRadius: 16,
              backgroundColor: dark ? 'rgba(16,185,129,0.15)' : '#ecfdf5',
              alignItems: 'center', justifyContent: 'center',
            }}>
              <Text style={{ fontSize: 24, fontWeight: '700', color: '#10b981' }}>
                {user?.firstName?.[0]?.toUpperCase() || '?'}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text }}>
                {user?.firstName} {user?.lastName}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <Badge label="INVENTORY" variant="success" />
                {user?.status === 'active' && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: accent.green }} />
                    <Text style={{ fontSize: 11, color: accent.green, fontWeight: '600' }}>Active</Text>
                  </View>
                )}
              </View>
              <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 4 }}>{user?.email}</Text>
              {user?.phone && (
                <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>{user?.phone}</Text>
              )}
            </View>
          </View>
        </Card>

        {/* Menu Items */}
        <View style={{ gap: 2, marginTop: 4 }}>
          {MENU_ITEMS.map((item) => (
            <TouchableOpacity
              key={item.action}
              onPress={() => handleMenuPress(item.action)}
              activeOpacity={0.6}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 14,
                backgroundColor: colors.cardBg, padding: 16,
                borderWidth: 1, borderColor: colors.cardBorder, borderRadius: 14,
                marginBottom: 8,
              }}
            >
              <View style={{
                width: 40, height: 40, borderRadius: 12,
                backgroundColor: item.danger
                  ? (dark ? 'rgba(239,68,68,0.12)' : '#fef2f2')
                  : (dark ? 'rgba(100,116,139,0.12)' : '#f1f5f9'),
                alignItems: 'center', justifyContent: 'center',
              }}>
                <Ionicons
                  name={item.icon}
                  size={20}
                  color={item.color || (item.danger ? '#ef4444' : colors.textSecondary)}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{
                  fontSize: 15, fontWeight: '600',
                  color: item.danger ? '#ef4444' : colors.text,
                }}>
                  {item.label}
                </Text>
                {item.subtitle && (
                  <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 1 }}>{item.subtitle}</Text>
                )}
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          ))}
        </View>

        {/* Version */}
        <Text style={{ textAlign: 'center', fontSize: 11, color: colors.textMuted, marginTop: 12 }}>
          MyGasLink v1.0.0
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
