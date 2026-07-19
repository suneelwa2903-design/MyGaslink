/**
 * HQ Profile (2026-07-19) — group + distributor metadata + logout.
 * Web parity: packages/web/src/pages/hq/ProfilePage.tsx.
 *
 * Security: GET /api/customer-group-portal/profile — server reads
 * req.user.groupId (already tenant-verified by requireGroupAccess) and
 * returns only the caller's own group's data.
 *
 * 2026-07-19 visual refresh — Suneel flagged that the customer_hq
 * profile screen looked "less beautiful than others" and was missing
 * dark-mode toggle + Delete Account. Now mirrors the driver `more.tsx`
 * pattern (avatar card, Appearance switch, Change Password, Sign Out,
 * Delete Account), tuned with GROUP-HQ colour cues so the identity of
 * the surface still reads at a glance.
 */
import { useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, Alert, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useApiQuery } from '../../src/hooks/useApi';
import { Card, ScreenSkeleton } from '../../src/components/ui';
import { DeleteAccountButton } from '../../src/components/DeleteAccountButton';
import { ChangePasswordModal } from '../../src/components/ChangePasswordModal';
import { useTheme, ACCENT } from '../../src/theme';
import { useAuthStore } from '../../src/stores/authStore';
import { useThemeStore } from '../../src/stores/themeStore';

interface ProfileResponse {
  group: { id: string; name: string; createdAt: string };
  distributor: { businessName: string; phone: string | null; email: string | null };
  members: Array<{
    customerId: string;
    customerName: string;
    businessName: string | null;
    gstin: string | null;
    customerType: string;
  }>;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function Row({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.divider,
        gap: 12,
      }}
    >
      <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{label}</Text>
      <Text
        style={{ color: colors.text, fontSize: 13, fontWeight: '500', flexShrink: 1, textAlign: 'right' }}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}

export default function HqProfileScreen() {
  const { colors, dark } = useTheme();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const toggleMode = useThemeStore((s) => s.toggleMode);
  const [showChangePassword, setShowChangePassword] = useState(false);

  const { data, isLoading, refetch, isRefetching } = useApiQuery<ProfileResponse>(
    ['hq-profile'],
    '/customer-group-portal/profile',
  );

  const handleLogout = () => {
    Alert.alert(
      'Sign out',
      'Are you sure you want to sign out of the group portal?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: async () => {
            await logout();
            router.replace('/(auth)/login');
          },
        },
      ],
    );
  };

  if (isLoading && !data) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScreenSkeleton />
      </SafeAreaView>
    );
  }

  // Group HQ avatar accent — HQ tabs already use red as the active tint
  // (see (hq)/_layout.tsx). Match here so a returning user reads the
  // same colour identity across nav → profile.
  const AVATAR_TINT = ACCENT.red;
  const displayName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || '—';
  const initial = (user?.firstName || user?.email || 'G').charAt(0).toUpperCase();

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 16 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => { void refetch(); }} />}
      >
        {/* Avatar card — matches driver/customer template so cross-role
            users see a consistent identity band. */}
        <View style={{
          backgroundColor: colors.cardBg,
          borderRadius: 14,
          padding: 20,
          borderWidth: 1,
          borderColor: colors.cardBorder,
          alignItems: 'center',
        }}>
          <View style={{
            width: 72,
            height: 72,
            borderRadius: 36,
            backgroundColor: dark ? `${AVATAR_TINT}22` : `${AVATAR_TINT}15`,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 10,
          }}>
            <Text style={{ fontSize: 32, fontWeight: '700', color: AVATAR_TINT }}>
              {initial}
            </Text>
          </View>
          <Text style={{ fontSize: 20, fontWeight: '700', color: colors.text }}>
            {displayName}
          </Text>
          {user?.email && (
            <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
              {user.email}
            </Text>
          )}
          <View style={{
            marginTop: 8,
            backgroundColor: dark ? `${AVATAR_TINT}22` : `${AVATAR_TINT}15`,
            paddingHorizontal: 12,
            height: 24,
            borderRadius: 12,
            justifyContent: 'center',
          }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: AVATAR_TINT, letterSpacing: 0.5 }}>
              GROUP HQ
            </Text>
          </View>
        </View>

        {/* Appearance / dark-mode toggle — parity with driver & admin. */}
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

        {data && (
          <Card>
            <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary, letterSpacing: 0.4, marginBottom: 8 }}>
              GROUP
            </Text>
            <Row label="Name" value={data.group.name} />
            <Row label="Created" value={fmtDate(data.group.createdAt)} />
            <Row label="Members" value={String(data.members.length)} />
          </Card>
        )}

        {data && (
          <Card>
            <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary, letterSpacing: 0.4, marginBottom: 8 }}>
              DISTRIBUTOR
            </Text>
            <Row label="Business" value={data.distributor.businessName} />
            <Row label="Phone" value={data.distributor.phone ?? '—'} />
            <Row label="Email" value={data.distributor.email ?? '—'} />
          </Card>
        )}

        {data && data.members.length > 0 && (
          <Card>
            <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary, letterSpacing: 0.4, marginBottom: 8 }}>
              PROPERTIES ({data.members.length})
            </Text>
            {data.members.map((m, idx) => (
              <View
                key={m.customerId}
                style={{
                  paddingVertical: 10,
                  borderBottomWidth: idx === data.members.length - 1 ? 0 : 1,
                  borderBottomColor: colors.divider,
                }}
              >
                <Text style={{ color: colors.text, fontWeight: '600', fontSize: 13 }} numberOfLines={1}>
                  {m.customerName}
                </Text>
                {m.businessName && (
                  <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 2 }} numberOfLines={1}>
                    {m.businessName}
                  </Text>
                )}
                {m.gstin && (
                  <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 2 }}>
                    GSTIN: {m.gstin}
                  </Text>
                )}
              </View>
            ))}
          </Card>
        )}

        {/* Change Password — matches driver more.tsx pattern. */}
        <TouchableOpacity
          onPress={() => setShowChangePassword(true)}
          activeOpacity={0.7}
          style={{
            backgroundColor: colors.cardBg,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: colors.cardBorder,
            padding: 16,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 14,
          }}
        >
          <View style={{
            width: 36, height: 36, borderRadius: 18,
            backgroundColor: dark ? `${ACCENT.orange}22` : `${ACCENT.orange}15`,
            alignItems: 'center', justifyContent: 'center',
          }}>
            <Ionicons name="key-outline" size={20} color={ACCENT.orange} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>
              Change Password
            </Text>
            <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
              Update your password
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>

        {/* Sign Out */}
        <TouchableOpacity
          onPress={handleLogout}
          activeOpacity={0.7}
          style={{
            backgroundColor: colors.cardBg,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: colors.cardBorder,
            padding: 16,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 14,
          }}
        >
          <View style={{
            width: 36, height: 36, borderRadius: 18,
            backgroundColor: dark ? `${ACCENT.red}22` : `${ACCENT.red}15`,
            alignItems: 'center', justifyContent: 'center',
          }}>
            <Ionicons name="log-out-outline" size={20} color={ACCENT.red} />
          </View>
          <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: ACCENT.red }}>
            Sign Out
          </Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>

        {/* Delete Account — DPDP §12 / Apple 5.1.1(v) requirement. */}
        <DeleteAccountButton />

        <View style={{ height: 8 }} />
      </ScrollView>

      <ChangePasswordModal
        visible={showChangePassword}
        onClose={() => setShowChangePassword(false)}
      />
    </SafeAreaView>
  );
}
