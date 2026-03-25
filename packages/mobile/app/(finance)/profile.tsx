import { View, Text, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuthStore } from '../../src/stores/authStore';
import { useTheme } from '../../src/theme';
import { Card, Badge, Button } from '../../src/components/ui';

export default function FinanceProfileScreen() {
  const { dark, colors, accent } = useTheme();
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
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>Profile</Text>

        {/* User Card */}
        <Card>
          <View style={{ alignItems: 'center', paddingVertical: 8 }}>
            <View style={{
              width: 72, height: 72, borderRadius: 36,
              backgroundColor: dark ? 'rgba(217,119,6,0.15)' : '#fffbeb',
              alignItems: 'center', justifyContent: 'center',
              marginBottom: 12,
            }}>
              <Text style={{ fontSize: 32, fontWeight: '700', color: '#d97706' }}>
                {user?.firstName?.[0]?.toUpperCase() || '?'}
              </Text>
            </View>
            <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text }}>
              {user?.firstName} {user?.lastName}
            </Text>
            <Badge label="FINANCE" variant="warning" />
            <Text style={{ fontSize: 14, color: colors.textSecondary, marginTop: 6 }}>{user?.email}</Text>
          </View>
        </Card>

        {/* Info */}
        <Card>
          <View style={{ gap: 12 }}>
            <InfoRow label="Phone" value={user?.phone || 'Not set'} colors={colors} />
            <InfoRow
              label="Status"
              value={user?.status === 'active' ? 'Active' : 'Inactive'}
              valueColor={user?.status === 'active' ? accent.green : '#ef4444'}
              colors={colors}
            />
          </View>
        </Card>

        <Button title="Sign Out" variant="danger" onPress={handleLogout} style={{ marginTop: 12 }} />

        <Text style={{ textAlign: 'center', fontSize: 11, color: colors.textMuted, marginTop: 8 }}>
          MyGasLink v1.0.0
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function InfoRow({
  label,
  value,
  valueColor,
  colors,
}: {
  label: string;
  value: string;
  valueColor?: string;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 }}>
      <Text style={{ fontSize: 14, color: colors.textSecondary }}>{label}</Text>
      <Text style={{ fontSize: 14, fontWeight: '600', color: valueColor || colors.text }}>{value}</Text>
    </View>
  );
}
