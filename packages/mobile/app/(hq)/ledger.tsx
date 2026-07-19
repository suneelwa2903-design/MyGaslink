/**
 * HQ Ledger (2026-07-19) — consolidated merged-chronological ledger
 * across every property in the group, with a Share PDF action for the
 * whole group. Web parity: packages/web/src/pages/hq/LedgerPage.tsx.
 *
 * Security: GET /api/customer-group-portal/ledger + /ledger/pdf. Both
 * routes call getGroupLedger with req.visibleCustomerIds, which is
 * tenant-scoped by requireGroupAccess. The `customerId` filter (if the
 * user picks a specific property) is validated against visibleCustomerIds
 * server-side before any DB query fires — see resolveCustomerIdFilter.
 */
import { useMemo, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useApiQuery } from '../../src/hooks/useApi';
import { Card, EmptyState, ScreenSkeleton, SelectField } from '../../src/components/ui';
import { useTheme, formatINR } from '../../src/theme';
import { api, getErrorMessage } from '../../src/lib/api';

interface LedgerRow {
  customerId: string;
  customerName: string;
  orderDate: string;
  cylinderType: string;
  fullCylsDelivered: number;
  amount: number;
  emptyCylsCollected: number;
  pendingEmptyCyls: number;
  emptyCylsCost: number;
  totalAmount: number;
  receivedAmount: number;
  dueAmount: number;
  creditDays: number;
  overDueAmount: number;
  narration: string | null;
  kind: string | null;
}
interface LedgerResponse {
  rows: LedgerRow[];
  totals: { totalDebited: number; totalReceived: number; netOutstanding: number };
}
interface ProfileMember {
  customerId: string;
  customerName: string;
}
interface ProfileResponse {
  members: ProfileMember[];
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

export default function HqLedgerScreen() {
  const { colors } = useTheme();
  const [customerFilter, setCustomerFilter] = useState('');
  const [downloading, setDownloading] = useState(false);

  // Property picker options come from the profile endpoint — same source
  // as visibleCustomerIds on the server (both derive from the group's
  // member set) so the two stay in sync automatically.
  const { data: profile } = useApiQuery<ProfileResponse>(
    ['hq-profile'],
    '/customer-group-portal/profile',
  );

  const propertyOptions = useMemo(() => {
    const opts = [{ label: 'All properties', value: '' }];
    for (const m of profile?.members ?? []) {
      opts.push({ label: m.customerName, value: m.customerId });
    }
    return opts;
  }, [profile?.members]);

  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (customerFilter) p.customerId = customerFilter;
    return p;
  }, [customerFilter]);

  const { data, isLoading, refetch, isRefetching } = useApiQuery<LedgerResponse>(
    ['hq-ledger', JSON.stringify(params)],
    '/customer-group-portal/ledger',
    params,
  );

  const rows = data?.rows ?? [];

  const handleShare = async () => {
    setDownloading(true);
    try {
      // Server enforces tenant + group scope for the PDF — see
      // customerGroupPortal.ts:189 → getGroupLedger + generateGroupLedgerPdf.
      const res = await api.get('/customer-group-portal/ledger/pdf', {
        params,
        responseType: 'arraybuffer',
      });
      const bytes = new Uint8Array(res.data);
      // 2026-07-19: stable filename with the filter so a re-share of the
      // "same" ledger overwrites the cached file rather than piling up.
      const key = customerFilter || 'all';
      const file = new File(Paths.cache, `group-ledger-${key}.pdf`);
      try { file.create(); } catch { /* already exists */ }
      file.write(bytes);
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'This device does not support sharing.');
        return;
      }
      await Sharing.shareAsync(file.uri, {
        mimeType: 'application/pdf',
        dialogTitle: 'Group Ledger',
      });
    } catch (err) {
      Alert.alert('Download failed', getErrorMessage(err) || 'Please try again.');
    } finally {
      setDownloading(false);
    }
  };

  if (isLoading && !data) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScreenSkeleton />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => { void refetch(); }} />}
      >
        <Card>
          <SelectField
            label="Property"
            options={propertyOptions}
            value={customerFilter}
            onChange={setCustomerFilter}
          />
        </Card>

        {/* Totals summary */}
        <Card>
          <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary, letterSpacing: 0.4, marginBottom: 12 }}>
            SUMMARY
          </Text>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            {[
              { label: 'Debited', value: data?.totals.totalDebited ?? 0 },
              { label: 'Received', value: data?.totals.totalReceived ?? 0 },
              { label: 'Net Outstanding', value: data?.totals.netOutstanding ?? 0, danger: true },
            ].map((s, i) => (
              <View
                key={i}
                style={{
                  flex: 1,
                  backgroundColor: colors.inputBg,
                  borderRadius: 10,
                  padding: 12,
                  minHeight: 74,
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>{s.label}</Text>
                <Text
                  style={{
                    fontSize: 15,
                    fontWeight: '700',
                    color: s.danger && s.value > 0 ? '#dc2626' : colors.text,
                  }}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.6}
                >
                  {formatINR(s.value)}
                </Text>
              </View>
            ))}
          </View>
        </Card>

        <TouchableOpacity
          onPress={() => { void handleShare(); }}
          disabled={downloading || rows.length === 0}
          style={{
            paddingVertical: 12,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.cardBorder,
            backgroundColor: colors.inputBg,
            alignItems: 'center',
            flexDirection: 'row',
            justifyContent: 'center',
            gap: 8,
            opacity: (downloading || rows.length === 0) ? 0.5 : 1,
          }}
        >
          {downloading && <ActivityIndicator size="small" color={colors.text} />}
          <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }}>
            {downloading ? 'Preparing PDF…' : 'Share Ledger PDF'}
          </Text>
        </TouchableOpacity>

        {rows.length === 0 ? (
          <Card>
            <EmptyState
              title="No ledger entries"
              description={customerFilter ? 'No entries for the selected property.' : 'No ledger activity across your group properties yet.'}
            />
          </Card>
        ) : (
          <Card>
            <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary, letterSpacing: 0.4, marginBottom: 8 }}>
              ENTRIES ({rows.length})
            </Text>
            {rows.map((r, idx) => (
              <View
                key={idx}
                style={{
                  paddingVertical: 12,
                  borderBottomWidth: idx === rows.length - 1 ? 0 : 1,
                  borderBottomColor: colors.divider,
                  gap: 4,
                }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.text, fontWeight: '600', fontSize: 13 }} numberOfLines={1}>
                      {r.customerName}
                    </Text>
                    <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 2 }} numberOfLines={1}>
                      {fmtDate(r.orderDate)}
                      {r.cylinderType && ` · ${r.cylinderType}`}
                      {r.fullCylsDelivered > 0 && ` (×${r.fullCylsDelivered})`}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>
                      {formatINR(r.totalAmount)}
                    </Text>
                    {r.dueAmount > 0 && (
                      <Text style={{ color: r.overDueAmount > 0 ? '#dc2626' : colors.textSecondary, fontSize: 10, fontWeight: '600', marginTop: 2 }}>
                        {r.overDueAmount > 0 ? 'OVERDUE' : `Due ${formatINR(r.dueAmount)}`}
                      </Text>
                    )}
                  </View>
                </View>
                {r.narration && (
                  <Text style={{ color: colors.textSecondary, fontSize: 11, fontStyle: 'italic' }} numberOfLines={2}>
                    {r.narration}
                  </Text>
                )}
              </View>
            ))}
          </Card>
        )}

        <View style={{ height: 8 }} />
      </ScrollView>
    </SafeAreaView>
  );
}
