import { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuthStore } from '../../src/stores/authStore';
import { useThemeStore } from '../../src/stores/themeStore';
import { useTheme, ACCENT } from '../../src/theme';
import { ChangePasswordModal } from '../../src/components/ChangePasswordModal';

interface MenuItem {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  onPress: () => void;
  destructive?: boolean;
}

export default function DriverMoreScreen() {
  const { dark, colors } = useTheme();
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const toggleMode = useThemeStore((s) => s.toggleMode);
  // Item 3 (2026-07-09) — voluntary change-password entry for drivers.
  const [showChangePassword, setShowChangePassword] = useState(false);

  const handleLogout = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
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
    {
      label: 'Profile',
      icon: 'person-outline',
      color: ACCENT.blue,
      onPress: () => router.push('/(driver)/profile'),
    },
    {
      // WI-PENDING-PAYMENTS: driver's read-only history of self-reported
      // payments. Submit affordance lives per-order on the deliveries
      // list — this screen is for reviewing status / rejection reasons.
      label: 'My Payment Submissions',
      icon: 'cash-outline',
      color: ACCENT.green,
      onPress: () => router.push('/(driver)/my-submissions'),
    },
    {
      // Item 3 (2026-07-09) — voluntary change password.
      label: 'Change Password',
      icon: 'key-outline',
      color: ACCENT.orange,
      onPress: () => setShowChangePassword(true),
    },
    {
      label: 'Sign Out',
      icon: 'log-out-outline',
      color: ACCENT.red,
      onPress: handleLogout,
      destructive: true,
    },
  ];

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        {/* User Card */}
        <View style={{
          backgroundColor: colors.cardBg,
          borderRadius: 14,
          padding: 20,
          borderWidth: 1,
          borderColor: colors.cardBorder,
          alignItems: 'center',
        }}>
          <View style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            backgroundColor: dark ? 'rgba(59,130,246,0.15)' : '#eef7ff',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 10,
          }}>
            <Text style={{ fontSize: 28, fontWeight: '700', color: ACCENT.blue }}>
              {user?.firstName?.[0]?.toUpperCase() || 'D'}
            </Text>
          </View>
          <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>
            {user?.firstName} {user?.lastName}
          </Text>
          <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
            {user?.email}
          </Text>
          <View style={{
            marginTop: 8,
            height: 24,
            borderRadius: 12,
            paddingHorizontal: 12,
            backgroundColor: dark ? 'rgba(16,185,129,0.15)' : '#ecfdf5',
            justifyContent: 'center',
          }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: dark ? ACCENT.green : '#059669', letterSpacing: 0.5 }}>
              DRIVER
            </Text>
          </View>
        </View>

        {/* Appearance */}
        <View style={{
          backgroundColor: colors.cardBg,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: colors.cardBorder,
          padding: 16,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 14,
        }}>
          <View style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: dark ? `${ACCENT.purple}22` : `${ACCENT.purple}15`,
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <Ionicons name={dark ? 'moon' : 'sunny'} size={20} color={ACCENT.purple} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>Appearance</Text>
            <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
              {dark ? 'Dark mode' : 'Light mode'}
            </Text>
          </View>
          <Switch
            value={dark}
            onValueChange={toggleMode}
            trackColor={{ false: '#cbd5e1', true: ACCENT.purple }}
            thumbColor="#ffffff"
          />
        </View>

        {/* Menu Items */}
        <View style={{
          backgroundColor: colors.cardBg,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: colors.cardBorder,
          overflow: 'hidden',
        }}>
          {menuItems.map((item, index) => (
            <TouchableOpacity
              key={item.label}
              onPress={item.onPress}
              activeOpacity={0.6}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                padding: 16,
                gap: 14,
                borderBottomWidth: index < menuItems.length - 1 ? 1 : 0,
                borderBottomColor: colors.divider,
              }}
            >
              <View style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: dark ? `${item.color}22` : `${item.color}15`,
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <Ionicons name={item.icon} size={20} color={item.color} />
              </View>
              <Text style={{
                flex: 1,
                fontSize: 15,
                fontWeight: '600',
                color: item.destructive ? ACCENT.red : colors.text,
              }}>
                {item.label}
              </Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>

      {/* Item 3 (2026-07-09) — shared change-password modal. */}
      <ChangePasswordModal
        visible={showChangePassword}
        onClose={() => setShowChangePassword(false)}
      />
    </SafeAreaView>
  );
}
