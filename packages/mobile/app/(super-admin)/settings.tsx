import { useState, useCallback } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { useAuthStore } from '../../src/stores/authStore';
import { Card, Badge, Button, EmptyState } from '../../src/components/ui';
import { DeleteAccountButton } from '../../src/components/DeleteAccountButton';
import { useTheme } from '../../src/theme';

// ── Sub-tab types ────────────────────────────────────────────────────────────

type SubTab = 'general' | 'gst' | 'thresholds' | 'licenses';

const SUB_TABS: { label: string; value: SubTab }[] = [
  { label: 'General', value: 'general' },
  { label: 'GST', value: 'gst' },
  { label: 'Thresholds', value: 'thresholds' },
  { label: 'Licenses', value: 'licenses' },
];

// ── Pill component ───────────────────────────────────────────────────────────

function Pill({
  label,
  active,
  activeColor,
  inactiveBg,
  inactiveText,
  onPress,
}: {
  label: string;
  active: boolean;
  activeColor: string;
  inactiveBg: string;
  inactiveText: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{
        height: 36,
        paddingHorizontal: 16,
        paddingVertical: 0,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: active ? activeColor : inactiveBg,
      }}
    >
      <Text style={{ fontSize: 13, fontWeight: '600', color: active ? '#fff' : inactiveText }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

type SettingItem = {
  key: string;
  value: string;
  label?: string;
  category?: string;
};

type GstCredentials = {
  gstMode?: string;
  gstEnabled?: boolean;
  hasCredentials?: boolean;
  gstin?: string;
  status?: string;
};

type CylinderThreshold = {
  id?: string;
  cylinderType?: string;
  type?: string;
  minStock?: number;
  maxStock?: number;
  reorderLevel?: number;
  warningLevel?: number;
  criticalLevel?: number;
};

type License = {
  id?: string;
  licenseType?: string;
  type?: string;
  licenseNumber?: string;
  number?: string;
  issuedDate?: string;
  expiryDate?: string;
  status?: string;
};

// ── Main Screen ──────────────────────────────────────────────────────────────

export default function SettingsScreen() {
  const router = useRouter();
  const { dark, colors, accent } = useTheme();
  const logout = useAuthStore((s) => s.logout);
  const [tab, setTab] = useState<SubTab>('general');

  // Match the (driver)/profile.tsx logout pattern exactly so the super-admin
  // has the same affordance every other role does. Prior to this the super-
  // admin had no way to sign out in the app — the only escape was clearing
  // app data, which also wiped the DPDP consent flag and the TanStack cache.
  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Logout',
        style: 'destructive',
        onPress: async () => {
          await logout();
          router.replace('/(auth)/login');
        },
      },
    ]);
  };

  // ─ General settings
  const { data: settingsRaw, isLoading: settingsLoading, refetch: refetchSettings } = useApiQuery<
    SettingItem[] | { settings: SettingItem[] }
  >(
    ['sa-settings'],
    '/settings',
    {},
    { enabled: tab === 'general' },
  );
  const settings: SettingItem[] = Array.isArray(settingsRaw)
    ? settingsRaw
    : settingsRaw?.settings ?? [];

  // ─ GST credentials
  const { data: gstRaw, isLoading: gstLoading, refetch: refetchGst } = useApiQuery<
    GstCredentials | { credentials: GstCredentials }
  >(
    ['sa-settings-gst'],
    '/settings/gst/credentials',
    {},
    { enabled: tab === 'gst' },
  );
  const gst: Partial<GstCredentials> =
    (gstRaw && 'credentials' in gstRaw ? gstRaw.credentials : gstRaw) ?? {};

  // ─ Cylinder thresholds
  const { data: thresholdsRaw, isLoading: thresholdsLoading, refetch: refetchThresholds } = useApiQuery<
    CylinderThreshold[] | { thresholds: CylinderThreshold[] }
  >(
    ['sa-settings-thresholds'],
    '/settings/cylinder-thresholds/list',
    {},
    { enabled: tab === 'thresholds' },
  );
  const thresholds: CylinderThreshold[] = Array.isArray(thresholdsRaw)
    ? thresholdsRaw
    : thresholdsRaw?.thresholds ?? [];

  // ─ Licenses
  const { data: licensesRaw, isLoading: licensesLoading, refetch: refetchLicenses } = useApiQuery<
    License[] | { licenses: License[] }
  >(
    ['sa-settings-licenses'],
    '/settings/licenses/list',
    {},
    { enabled: tab === 'licenses' },
  );
  const licenses: License[] = Array.isArray(licensesRaw)
    ? licensesRaw
    : licensesRaw?.licenses ?? [];

  const handleRefresh = useCallback(() => {
    if (tab === 'general') refetchSettings();
    if (tab === 'gst') refetchGst();
    if (tab === 'thresholds') refetchThresholds();
    if (tab === 'licenses') refetchLicenses();
  }, [tab, refetchSettings, refetchGst, refetchThresholds, refetchLicenses]);

  const isLoading =
    tab === 'general' ? settingsLoading
    : tab === 'gst' ? gstLoading
    : tab === 'thresholds' ? thresholdsLoading
    : licensesLoading;

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Back header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.cardBorder }}>
        <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>Settings</Text>
      </View>
      {/* ── Sub-tab pills ────────────────────────────────────────────────── */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}
      >
        {SUB_TABS.map((t) => (
          <Pill
            key={t.value}
            label={t.label}
            active={tab === t.value}
            activeColor={accent.red}
            inactiveBg={dark ? colors.cardBg : colors.inputBg}
            inactiveText={colors.textSecondary}
            onPress={() => setTab(t.value)}
          />
        ))}
      </ScrollView>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={handleRefresh} />}
      >
        {/* ════ GENERAL TAB ════ */}
        {tab === 'general' && (
          <>
            <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
              General Settings
            </Text>

            {settingsLoading ? (
              <ActivityIndicator size="large" color={accent.red} style={{ marginTop: 40 }} />
            ) : settings.length === 0 ? (
              <EmptyState title="No settings" description="No system settings found" />
            ) : (
              settings.map((s, i) => (
                <Card key={s.key ?? i} style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <View style={{ flex: 1, marginRight: 12 }}>
                      <Text style={{ fontWeight: '700', fontSize: 14, color: colors.text }} numberOfLines={1}>
                        {s.label ?? formatKey(s.key)}
                      </Text>
                      {s.category ? (
                        <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                          {s.category}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={{ fontWeight: '600', fontSize: 14, color: accent.blue, flexShrink: 0 }} numberOfLines={1}>
                      {s.value}
                    </Text>
                  </View>
                </Card>
              ))
            )}
          </>
        )}

        {/* ════ GST TAB ════ */}
        {tab === 'gst' && (
          <>
            <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
              GST Configuration
            </Text>

            {gstLoading ? (
              <ActivityIndicator size="large" color={accent.red} style={{ marginTop: 40 }} />
            ) : !gstRaw ? (
              <EmptyState title="No GST data" description="GST configuration not available" />
            ) : (
              <>
                <Card style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
                  <View style={{ gap: 12 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>GST Mode</Text>
                      <Badge
                        label={gst.gstEnabled ? 'Enabled' : (gst.gstMode ?? 'N/A')}
                        variant={gst.gstEnabled ? 'success' : 'neutral'}
                      />
                    </View>

                    <View style={{ height: 1, backgroundColor: colors.divider }} />

                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>Credentials</Text>
                      <Badge
                        label={gst.hasCredentials ? 'Configured' : 'Not Set'}
                        variant={gst.hasCredentials ? 'success' : 'warning'}
                      />
                    </View>

                    {gst.gstin ? (
                      <>
                        <View style={{ height: 1, backgroundColor: colors.divider }} />
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text style={{ fontWeight: '600', fontSize: 14, color: colors.textSecondary }}>GSTIN</Text>
                          <Text style={{ fontWeight: '600', fontSize: 14, color: colors.text }}>{gst.gstin}</Text>
                        </View>
                      </>
                    ) : null}

                    {gst.status ? (
                      <>
                        <View style={{ height: 1, backgroundColor: colors.divider }} />
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text style={{ fontWeight: '600', fontSize: 14, color: colors.textSecondary }}>Status</Text>
                          <Badge
                            label={gst.status}
                            variant={gst.status === 'active' ? 'success' : 'neutral'}
                          />
                        </View>
                      </>
                    ) : null}
                  </View>
                </Card>
              </>
            )}
          </>
        )}

        {/* ════ THRESHOLDS TAB ════ */}
        {tab === 'thresholds' && (
          <>
            <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
              Cylinder Thresholds
            </Text>

            {thresholdsLoading ? (
              <ActivityIndicator size="large" color={accent.red} style={{ marginTop: 40 }} />
            ) : thresholds.length === 0 ? (
              <EmptyState title="No thresholds" description="No cylinder thresholds configured" />
            ) : (
              thresholds.map((t, i) => (
                <Card key={t.id ?? i} style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
                  <View style={{ marginBottom: 8 }}>
                    <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>
                      {t.cylinderType ?? t.type ?? `Type ${i + 1}`}
                    </Text>
                  </View>

                  <View style={{ gap: 6 }}>
                    {t.minStock != null && (
                      <ThresholdRow label="Min Stock" value={t.minStock} color={accent.red} textColor={colors.textSecondary} />
                    )}
                    {t.maxStock != null && (
                      <ThresholdRow label="Max Stock" value={t.maxStock} color={accent.green} textColor={colors.textSecondary} />
                    )}
                    {t.reorderLevel != null && (
                      <ThresholdRow label="Reorder Level" value={t.reorderLevel} color={accent.orange} textColor={colors.textSecondary} />
                    )}
                    {t.warningLevel != null && (
                      <ThresholdRow label="Warning Level" value={t.warningLevel} color={accent.orange} textColor={colors.textSecondary} />
                    )}
                    {t.criticalLevel != null && (
                      <ThresholdRow label="Critical Level" value={t.criticalLevel} color={accent.red} textColor={colors.textSecondary} />
                    )}
                  </View>
                </Card>
              ))
            )}
          </>
        )}

        {/* ════ LICENSES TAB ════ */}
        {tab === 'licenses' && (
          <>
            <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
              Licenses
            </Text>

            {licensesLoading ? (
              <ActivityIndicator size="large" color={accent.red} style={{ marginTop: 40 }} />
            ) : licenses.length === 0 ? (
              <EmptyState title="No licenses" description="No licenses found" />
            ) : (
              licenses.map((l, i) => (
                <Card key={l.id ?? i} style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text, flex: 1 }} numberOfLines={1}>
                      {l.licenseType ?? l.type ?? `License ${i + 1}`}
                    </Text>
                    {l.status ? (
                      <Badge
                        label={l.status}
                        variant={l.status === 'active' ? 'success' : l.status === 'expired' ? 'danger' : 'warning'}
                      />
                    ) : null}
                  </View>

                  <View style={{ gap: 4 }}>
                    {(l.licenseNumber ?? l.number) ? (
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: 13, color: colors.textSecondary }}>Number</Text>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>
                          {l.licenseNumber ?? l.number}
                        </Text>
                      </View>
                    ) : null}
                    {l.issuedDate ? (
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: 13, color: colors.textSecondary }}>Issued</Text>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>
                          {formatDate(l.issuedDate)}
                        </Text>
                      </View>
                    ) : null}
                    {l.expiryDate ? (
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: 13, color: colors.textSecondary }}>Expires</Text>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: isExpiringSoon(l.expiryDate) ? accent.red : colors.text }}>
                          {formatDate(l.expiryDate)}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </Card>
              ))
            )}
          </>
        )}
        <View style={{ marginTop: 24, gap: 12 }}>
          <Button title="Sign Out" variant="danger" onPress={handleLogout} />
          <DeleteAccountButton />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ThresholdRow({
  label,
  value,
  color,
  textColor,
}: {
  label: string;
  value: number;
  color: string;
  textColor: string;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <Text style={{ fontSize: 13, color: textColor }}>{label}</Text>
      <Text style={{ fontSize: 13, fontWeight: '700', color }}>{value}</Text>
    </View>
  );
}

function formatKey(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

function isExpiringSoon(dateStr: string): boolean {
  try {
    const expiry = new Date(dateStr);
    const now = new Date();
    const diffDays = (expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    return diffDays < 30;
  } catch {
    return false;
  }
}
