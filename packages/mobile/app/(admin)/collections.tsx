/**
 * STEP-3C — Admin mobile Collections full screen.
 *
 * Mirrors packages/web/src/pages/CollectionsPage.tsx with React Native
 * idioms. Reached from More → Collections (the legacy CollectionsModal
 * was removed in this step).
 *
 * Three sub-tabs:
 *  - Call list   → GET /analytics/overdue-call-list
 *  - All         → GET /analytics/collections
 *  - Blocked     → GET /pending-actions?module=collections&status=open
 *                  filtered client-side to actionType === 'OVERDUE_ORDER_OVERRIDE'
 *
 * Role gating:
 *  - The Approve button on Blocked rows hits the admin-only
 *    `PUT /pending-actions/:id/approve` route (tightened in STEP-1A —
 *    super_admin + distributor_admin only). canApprove gates the button
 *    so finance/inventory don't get a 403 when this screen is opened by
 *    those roles in a future phase. The (admin) route group is
 *    admin-only today.
 *
 * Excel export:
 *  - The web "Export to Excel" button is broken on both ends per the
 *    apiContract audit (wrong path + raw fetch bypassing axios + the
 *    endpoint returns JSON, not xlsx). Mobile OMITS the button rather
 *    than reproducing the broken pattern.
 */

import { useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Alert,
  Linking,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { UserRole, type PendingAction } from '@gaslink/shared';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { useTheme, formatINR } from '../../src/theme';
import { useAuthStore } from '../../src/stores/authStore';
import { Badge, EmptyState, MetricCard } from '../../src/components/ui';

const ACCENT = '#dc2626';

// ─── Wire shapes (match apiContract.responseShapes verbatim) ────────────────

interface CollectionsDashboardEntry {
  customerId: string;
  customerName: string;
  totalDue: number;
  overdueDue: number;
  overdueDays: number;
  missingCylinders: number;
  missingCylinderValue: number;
  excessEmptyCylinders: number;
  lastPaymentDate: string | null;
  lastPaymentAmount: number | null;
  creditPeriodDays: number;
  latestCommitment: {
    promisedDate: string | null;
    overdueAmountSnapshot: number;
    status: string;
    escalationLevel: number;
    createdAt: string;
  } | null;
}

interface OverdueCallListEntry {
  customerId: string;
  customerName: string;
  phone: string;
  totalOutstanding: number;
  overdueInvoiceCount: number;
  daysOverdue: number;
}

// ─── Visual helpers ─────────────────────────────────────────────────────────

function getColors(dark: boolean) {
  return {
    bg: dark ? '#0f172a' : '#ffffff',
    card: dark ? '#1e293b' : '#f8fafc',
    cardBorder: dark ? '#334155' : '#e2e8f0',
    text: dark ? '#f8fafc' : '#0f172a',
    textSecondary: dark ? '#cbd5e1' : '#64748b',
    textMuted: dark ? '#94a3b8' : '#94a3b8',
    tabBg: dark ? '#334155' : '#f1f5f9',
    tabText: dark ? '#cbd5e1' : '#475569',
    divider: dark ? '#334155' : '#e2e8f0',
    inputBorder: dark ? '#475569' : '#cbd5e1',
  };
}

type TabValue = 'call-list' | 'all' | 'blocked';

interface PillOption {
  label: string;
  value: TabValue;
  count?: number;
}

function PillRow({
  options,
  value,
  onChange,
  dark,
}: {
  options: PillOption[];
  value: TabValue;
  onChange: (v: TabValue) => void;
  dark: boolean;
}) {
  const C = getColors(dark);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0 }}
      contentContainerStyle={styles.pillRow}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const label =
          opt.count !== undefined && opt.count > 0
            ? `${opt.label} (${opt.count})`
            : opt.label;
        return (
          <TouchableOpacity
            key={opt.value}
            onPress={() => onChange(opt.value)}
            style={[styles.pill, { backgroundColor: active ? ACCENT : C.tabBg }]}
          >
            <Text
              style={[
                styles.pillText,
                { color: active ? '#ffffff' : C.tabText },
              ]}
            >
              {label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

// ─── Main screen ────────────────────────────────────────────────────────────

export default function AdminCollectionsScreen() {
  const router = useRouter();
  const { dark } = useTheme();
  const C = getColors(dark);

  const user = useAuthStore((s) => s.user);
  const role = user?.role;
  // STEP-1A tightened the approve route to admin-only.
  const canApprove =
    role === UserRole.SUPER_ADMIN || role === UserRole.DISTRIBUTOR_ADMIN;

  const [tab, setTab] = useState<TabValue>('call-list');

  // ─── Queries ──────────────────────────────────────────────────────────────

  const {
    data: collections,
    isLoading: collectionsLoading,
    isRefetching: collectionsRefetching,
    refetch: refetchCollections,
  } = useApiQuery<CollectionsDashboardEntry[]>(
    ['admin-collections'],
    '/analytics/collections',
  );

  const {
    data: callList,
    isLoading: callListLoading,
    isRefetching: callListRefetching,
    refetch: refetchCallList,
  } = useApiQuery<OverdueCallListEntry[]>(
    ['admin-collections-call-list'],
    '/analytics/overdue-call-list',
  );

  const {
    data: blockedResp,
    isLoading: blockedLoading,
    isRefetching: blockedRefetching,
    refetch: refetchBlocked,
  } = useApiQuery<{ actions: PendingAction[] }>(
    ['admin-collections-blocked'],
    '/pending-actions',
    { module: 'collections', status: 'open' },
  );

  // Filter to OVERDUE_ORDER_OVERRIDE per apiContract.
  const overrideActions = useMemo(
    () =>
      (blockedResp?.actions ?? []).filter(
        (a) => a.actionType === 'OVERDUE_ORDER_OVERRIDE',
      ),
    [blockedResp],
  );

  // Summary metrics — client-side reduce, exactly like the web page.
  const summary = useMemo(() => {
    const list = collections ?? [];
    return {
      totalDue: list.reduce((s, c) => s + c.totalDue, 0),
      totalOverdue: list.reduce((s, c) => s + c.overdueDue, 0),
      missingCylinders: list.reduce((s, c) => s + c.missingCylinders, 0),
    };
  }, [collections]);

  // ─── Mutations ────────────────────────────────────────────────────────────

  const approveOverride = useApiMutation<unknown, { actionId: string }>(
    'put',
    (vars) => `/pending-actions/${vars.actionId}/approve`,
    {
      invalidateKeys: [
        ['admin-collections'],
        ['admin-collections-blocked'],
      ],
      successMessage:
        'Override approved — the customer may place one order.',
    },
  );

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const onCall = useCallback((phone: string) => {
    Linking.openURL(`tel:${phone}`).catch(() =>
      Alert.alert('Could not place call', 'Please dial manually.'),
    );
  }, []);

  // STEP-3E: route to the new (admin)/customer-detail full screen.
  const onViewAccount = useCallback(
    (customerId: string) => {
      router.push({
        pathname: '/(admin)/customer-detail',
        params: { customerId },
      });
    },
    [router],
  );

  // ─── Tab options ──────────────────────────────────────────────────────────

  const tabOptions: PillOption[] = useMemo(
    () => [
      { label: 'Call list', value: 'call-list', count: callList?.length ?? 0 },
      { label: 'All collections', value: 'all' },
      { label: 'Blocked', value: 'blocked', count: overrideActions.length },
    ],
    [callList, overrideActions],
  );

  // ─── Renderers per tab ────────────────────────────────────────────────────

  // CALL LIST ROW
  const renderCallListRow = ({ item }: { item: OverdueCallListEntry }) => {
    const badgeVariant = item.daysOverdue >= 30 ? 'danger' : 'warning';
    return (
      <View
        style={[
          styles.card,
          { backgroundColor: C.card, borderColor: C.cardBorder },
        ]}
      >
        <View style={styles.rowBetween}>
          <View style={{ flex: 1, paddingRight: 8 }}>
            <Text style={[styles.customerName, { color: C.text }]}>
              {item.customerName}
            </Text>
            <Text style={[styles.metaLine, { color: C.textMuted }]}>
              {item.overdueInvoiceCount} overdue invoice
              {item.overdueInvoiceCount === 1 ? '' : 's'}
            </Text>
          </View>
          <Badge variant={badgeVariant} label={`${item.daysOverdue}d overdue`} />
        </View>

        <View style={styles.outstandingRow}>
          <Text style={[styles.outstandingLabel, { color: C.textMuted }]}>
            Outstanding
          </Text>
          <Text style={[styles.outstandingValue, { color: '#dc2626' }]}>
            {formatINR(item.totalOutstanding)}
          </Text>
        </View>

        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: ACCENT }]}
            onPress={() => onCall(item.phone)}
          >
            <Ionicons name="call-outline" size={14} color="#fff" />
            <Text style={styles.actionBtnText}>Call {item.phone}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.actionBtn,
              {
                backgroundColor: C.tabBg,
                borderWidth: 1,
                borderColor: C.inputBorder,
              },
            ]}
            onPress={() => onViewAccount(item.customerId)}
          >
            <Ionicons name="person-outline" size={14} color={C.text} />
            <Text style={[styles.actionBtnText, { color: C.text }]}>
              Account
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ALL COLLECTIONS ROW
  const renderAllRow = ({ item }: { item: CollectionsDashboardEntry }) => {
    const hasOverdue = item.overdueDue > 0;
    return (
      <View
        style={[
          styles.card,
          { backgroundColor: C.card, borderColor: C.cardBorder },
        ]}
      >
        <View style={styles.rowBetween}>
          <View style={{ flex: 1, paddingRight: 8 }}>
            <Text style={[styles.customerName, { color: C.text }]}>
              {item.customerName}
            </Text>
            <Text style={[styles.metaLine, { color: C.textMuted }]}>
              Credit period: {item.creditPeriodDays}d
              {item.lastPaymentDate
                ? ` · Last paid ${new Date(item.lastPaymentDate).toLocaleDateString('en-IN')}`
                : ''}
            </Text>
          </View>
          {item.latestCommitment && (
            <Badge
              variant={
                item.latestCommitment.status === 'broken'
                  ? 'danger'
                  : 'warning'
              }
              label={`L${item.latestCommitment.escalationLevel}`}
            />
          )}
        </View>

        <View style={styles.statGrid}>
          <View style={styles.statCell}>
            <Text style={[styles.statLabel, { color: C.textMuted }]}>
              Total Due
            </Text>
            <Text style={[styles.statValue, { color: C.text }]}>
              {formatINR(item.totalDue)}
            </Text>
          </View>
          <View style={styles.statCell}>
            <Text style={[styles.statLabel, { color: C.textMuted }]}>
              Overdue
            </Text>
            <Text
              style={[
                styles.statValue,
                { color: hasOverdue ? '#dc2626' : C.text },
              ]}
            >
              {formatINR(item.overdueDue)}
            </Text>
          </View>
          <View style={styles.statCell}>
            <Text style={[styles.statLabel, { color: C.textMuted }]}>
              Missing
            </Text>
            <Text
              style={[
                styles.statValue,
                {
                  color: item.missingCylinders > 0 ? '#f59e0b' : C.text,
                },
              ]}
            >
              {item.missingCylinders}
            </Text>
          </View>
        </View>
      </View>
    );
  };

  // BLOCKED ROW
  const renderBlockedRow = ({ item }: { item: PendingAction }) => (
    <View
      style={[
        styles.card,
        { backgroundColor: C.card, borderColor: C.cardBorder },
      ]}
    >
      <Text style={[styles.description, { color: C.text }]}>
        {item.description}
      </Text>
      <Text style={[styles.metaLine, { color: C.textMuted }]}>
        Requested {new Date(item.createdAt).toLocaleString('en-IN')}
      </Text>
      {canApprove && (
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: '#059669' }]}
            onPress={() =>
              approveOverride.mutate({ actionId: item.actionId })
            }
            disabled={approveOverride.isPending}
          >
            <Ionicons
              name="checkmark-circle-outline"
              size={14}
              color="#fff"
            />
            <Text style={styles.actionBtnText}>Approve Override</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );

  // ─── Per-tab loading/empty + list selection ──────────────────────────────

  const isLoadingActive =
    (tab === 'call-list' && callListLoading) ||
    (tab === 'all' && collectionsLoading) ||
    (tab === 'blocked' && blockedLoading);

  const isRefetchingActive =
    (tab === 'call-list' && callListRefetching) ||
    (tab === 'all' && collectionsRefetching) ||
    (tab === 'blocked' && blockedRefetching);

  const refetchActive = useCallback(() => {
    if (tab === 'call-list') refetchCallList();
    else if (tab === 'all') refetchCollections();
    else refetchBlocked();
  }, [tab, refetchCallList, refetchCollections, refetchBlocked]);

  const renderListBody = () => {
    if (isLoadingActive) {
      return (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      );
    }

    if (tab === 'call-list') {
      const data = callList ?? [];
      if (data.length === 0) {
        return (
          <View style={styles.centered}>
            <EmptyState
              title="No customers to call"
              description="All collections are up to date."
            />
          </View>
        );
      }
      return (
        <FlatList
          data={data}
          keyExtractor={(c) => c.customerId}
          renderItem={renderCallListRow}
          refreshing={isRefetchingActive}
          onRefresh={refetchActive}
          contentContainerStyle={styles.listContent}
        />
      );
    }

    if (tab === 'all') {
      const data = collections ?? [];
      if (data.length === 0) {
        return (
          <View style={styles.centered}>
            <EmptyState
              title="No collection data"
              description="Collection data will appear as invoices are generated."
            />
          </View>
        );
      }
      return (
        <FlatList
          data={data}
          keyExtractor={(c) => c.customerId}
          renderItem={renderAllRow}
          refreshing={isRefetchingActive}
          onRefresh={refetchActive}
          contentContainerStyle={styles.listContent}
        />
      );
    }

    // blocked
    if (overrideActions.length === 0) {
      return (
        <View style={styles.centered}>
          <EmptyState
            title="No blocked customers"
            description="No customers are currently blocked pending an override."
          />
        </View>
      );
    }
    return (
      <FlatList
        data={overrideActions}
        keyExtractor={(a) => a.actionId}
        renderItem={renderBlockedRow}
        refreshing={isRefetchingActive}
        onRefresh={refetchActive}
        contentContainerStyle={styles.listContent}
      />
    );
  };

  return (
    <SafeAreaView
      edges={['left', 'right']}
      style={[styles.container, { backgroundColor: C.bg }]}
    >
      {/* Back header */}
      <View style={[styles.header, { borderBottomColor: C.divider }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="chevron-back" size={26} color={C.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: C.text }]}>Collections</Text>
        {/* Export omitted — see file header. */}
        <View style={{ width: 26 }} />
      </View>

      {/* Summary metrics (from /analytics/collections, regardless of tab).
          Missing Cylinders was the third card here until 2026-06-01; it
          was hard to size consistently against the two currency cards
          and the per-customer view already surfaces it. Stripped to two
          equal-width cards — flex:1 in styles.metricCell already covers
          the layout. */}
      <View style={styles.metricRow}>
        <View style={styles.metricCell}>
          <MetricCard
            title="Total Due"
            value={formatINR(summary.totalDue)}
            color="#3b82f6"
            minHeight={88}
          />
        </View>
        <View style={styles.metricCell}>
          <MetricCard
            title="Total Overdue"
            value={formatINR(summary.totalOverdue)}
            color="#dc2626"
            minHeight={88}
          />
        </View>
      </View>

      {/* Tabs */}
      <View style={[styles.filterSection, { borderBottomColor: C.divider }]}>
        <PillRow
          options={tabOptions}
          value={tab}
          onChange={setTab}
          dark={dark}
        />
      </View>

      {renderListBody()}
    </SafeAreaView>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 17, fontWeight: '700' },

  metricRow: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingTop: 10,
    paddingBottom: 4,
    gap: 6,
  },
  metricCell: { flex: 1 },

  filterSection: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  // STAGE-A A1: pinned pill height + alignItems on container so the
  // horizontal ScrollView can't be vertically inflated by the parent flex.
  pillRow: { gap: 8, paddingVertical: 4, alignItems: 'center' },
  pill: { height: 36, paddingHorizontal: 12, borderRadius: 18, flexShrink: 0, justifyContent: 'center' },
  pillText: { fontSize: 12, fontWeight: '600' },

  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  listContent: { padding: 12, paddingBottom: 24 },

  card: { borderRadius: 12, borderWidth: 1, padding: 12, marginBottom: 8 },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  customerName: { fontSize: 15, fontWeight: '700', marginBottom: 2 },
  description: { fontSize: 14, fontWeight: '600', marginBottom: 4 },
  metaLine: { fontSize: 11 },

  outstandingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  outstandingLabel: { fontSize: 12, fontWeight: '600' },
  outstandingValue: { fontSize: 16, fontWeight: '700' },

  statGrid: {
    flexDirection: 'row',
    marginTop: 8,
    gap: 8,
  },
  statCell: { flex: 1 },
  statLabel: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase' },
  statValue: { fontSize: 14, fontWeight: '700', marginTop: 2 },

  actionRow: { flexDirection: 'row', gap: 6, marginTop: 10, flexWrap: 'wrap' },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 4,
  },
  actionBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
