import { View, Text, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuthStore } from '../../src/stores/authStore';
import { Card, Button } from '../../src/components/ui';
import { DeleteAccountButton } from '../../src/components/DeleteAccountButton';
import { useTheme, ACCENT } from '../../src/theme';

export default function DriverProfileScreen() {
  const { dark, colors } = useTheme();
  const router = useRouter();
  const { user, logout } = useAuthStore();

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Logout', style: 'destructive', onPress: async () => { await logout(); router.replace('/(auth)/login'); } },
    ]);
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <Card>
          <View style={{ alignItems: 'center', paddingVertical: 12 }}>
            <View style={{
              width: 72, height: 72, borderRadius: 36,
              backgroundColor: dark ? 'rgba(59,130,246,0.15)' : '#eef7ff',
              alignItems: 'center', justifyContent: 'center', marginBottom: 8,
            }}>
              <Text style={{ fontSize: 32, fontWeight: '700', color: ACCENT.blue }}>
                {user?.firstName?.[0]?.toUpperCase() || 'D'}
              </Text>
            </View>
            <Text style={{ fontSize: 20, fontWeight: '700', color: colors.text }}>
              {user?.firstName} {user?.lastName}
            </Text>
            <Text style={{ fontSize: 14, color: colors.textSecondary, marginTop: 2 }}>{user?.email}</Text>
            <View style={{
              marginTop: 8,
              backgroundColor: dark ? 'rgba(16,185,129,0.15)' : '#ecfdf5',
              paddingHorizontal: 12, height: 24, borderRadius: 12, justifyContent: 'center',
            }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: dark ? ACCENT.green : '#059669' }}>DRIVER</Text>
            </View>
          </View>
        </Card>

        <Card>
          <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: 12 }}>Quick Info</Text>
          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ color: colors.textSecondary }}>Phone</Text>
              <Text style={{ fontWeight: '500', color: colors.text }}>{user?.phone || '—'}</Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ color: colors.textSecondary }}>Role</Text>
              <Text style={{ fontWeight: '500', color: colors.text }}>{user?.role?.replace(/_/g, ' ')}</Text>
            </View>
          </View>
        </Card>

        <Button title="Sign Out" variant="danger" onPress={handleLogout} />
        <DeleteAccountButton />
      </ScrollView>
    </SafeAreaView>
  );
}
