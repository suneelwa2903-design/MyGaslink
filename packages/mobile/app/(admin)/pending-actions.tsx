/**
 * STEP-3B — Admin mobile Pending Actions full screen.
 *
 * Mirrors packages/web/src/pages/PendingActionsPage.tsx with React Native
 * idioms. Wired from (admin)/dashboard.tsx "View All" (was a dead end
 * routed to /(admin)/more before this step).
 *
 * Role gating:
 *  - Approve / Reject buttons are admin-only at the API (pendingActions.ts:57,99
 *    — STEP-1B). canApprove gate hides them for finance + inventory; only
 *    super_admin + distributor_admin see them. The (admin) route group is
 *    admin-only anyway, but the gate is kept inline so the pattern is
 *    explicit and ready when this screen is reused by finance/inventory in
 *    future phases.
 *  - Resolve is open to every ops role at the API (pendingActions.ts:74),
 *    so we keep it visible whenever the action is OPEN or IN_PROGRESS.
 *
 * API endpoints:
 *  - GET  /pending-actions?module=&status=&offset=
 *  - PUT  /pending-actions/:id/approve
 *  - PUT  /pending-actions/:id/reject
 *  - PUT  /pending-actions/:id/resolve   body: { notes?: string }
 *
 * NOTE on body shape: the API's Zod validator expects `notes` (not
 * `resolutionNotes` — see pendingActions.ts:75). The web page sends
 * `resolutionNotes` which silently drops the field via Zod's default
 * pass-through. Mobile uses the correct key `notes`. A web-side fix is
 * tracked separately.
 */

import { useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  Modal,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  PendingActionModule,
  PendingActionStatus,
  PendingActionSeverity,
  UserRole,
  type PendingAction,
  type StatusVariant,
} from '@gaslink/shared';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { useTheme } from '../../src/theme';
import { useAuthStore } from '../../src/stores/authStore';
import { Badge, EmptyState } from '../../src/components/ui';

const ACCENT = '#dc2626';
const PAGE_SIZE = 50;

// ─── Visual helpers ─────────────────────────────────────────────────────────
// Severity isn't in @gaslink/shared's labels module yet — this is the first
// surface that displays it. If/when a second surface needs it, lift to shared.

function severityVariant(severity: string): StatusVariant {
  switch (severity) {
    case PendingActionSeverity.CRITICAL:
    case PendingActionSeverity.HIGH:
      return 'danger';
    case PendingActionSeverity.MEDIUM:
      return 'warning';
    case PendingActionSeverity.LOW:
      return 'info';
    default:
      return 'neutral';
  }
}

function paStatusVariant(status: string): StatusVariant {
  switch (status) {
    case PendingActionStatus.OPEN:
      return 'warning';
    case PendingActionStatus.IN_PROGRESS:
      return 'info';
    case PendingActionStatus.RESOLVED:
      return 'success';
    case PendingActionStatus.FAILED:
      return 'danger';
    case PendingActionStatus.SKIPPED:
      return 'neutral';
    default:
      return 'neutral';
  }
}

// SLA badge — same thresholds the web uses (computed from slaDeadline).
function getSlaStatus(
  slaDeadline: string | null,
): { label: string; variant: StatusVariant } | null {
  if (!slaDeadline) return null;
  const hoursLeft = (new Date(slaDeadline).getTime() - Date.now()) / 3_600_000;
  if (hoursLeft < 0) return { label: 'Overdue', variant: 'danger' };
  if (hoursLeft < 4) return { label: `${Math.floor(hoursLeft)}h left`, variant: 'danger' };
  if (hoursLeft < 24) return { label: `${Math.floor(hoursLeft)}h left`, variant: 'warning' };
  return { label: `${Math.floor(hoursLeft / 24)}d left`, variant: 'info' };
}

// Dynamic action label per errorCode / actionType — verbatim from web
// PendingActionsPage.getActionLabel (lines 103-110). Drives the Resolve
// button's text so admins see "Look Up IRN" / "Fix GSTIN" / "Retry" etc.
// instead of a generic "Resolve" wherever the failure is specifically
// recoverable.
function getActionLabel(action: PendingAction): string {
  if (action.errorCode === 'DUPLICATE_IRN') return 'Look Up IRN';
  if (action.errorCode === 'GSTIN_INVALID') return 'Fix GSTIN';
  if (action.actionType === 'IRN_CANCEL_BLOCKED') return 'Manual Action Required';
  if (action.actionType === 'MODIFIED_DELIVERY_REVIEW') return 'Review & Approve';
  if (action.actionType === 'IRN_GENERATION' || action.actionType === 'EWB_GENERATION') return 'Retry';
  return 'Resolve';
}

function formatLabel(value: string): string {
  return value.replace(/_/g, ' ');
}

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
    modalBg: dark ? '#0f172a' : '#ffffff',
    // STAGE-A A2: bumped from 0.6 → 0.85 so bottom-sheet backdrop fully
    // obscures the tab bar (was visible at ~40% through the dim layer).
    overlay: 'rgba(0,0,0,0.85)',
    divider: dark ? '#334155' : '#e2e8f0',
    inputBorder: dark ? '#475569' : '#cbd5e1',
  };
}

// ─── Filter pill row ───────────────────────────────────────────────────────
// Reuses the horizontal-scrollable pill pattern from (admin)/orders.tsx
// STATUS_TABS rendering — there is no Select primitive in
// packages/mobile/src/components/ui so we follow the existing canonical
// convention rather than introducing a new dropdown component.

interface PillOption {
  label: string;
  value: string;
}

function PillRow({
  options,
  value,
  onChange,
  dark,
}: {
  options: PillOption[];
  value: string;
  onChange: (v: string) => void;
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
        return (
          <TouchableOpacity
            key={opt.value || 'all'}
            onPress={() => onChange(opt.value)}
            style={[
              styles.pill,
              { backgroundColor: active ? ACCENT : C.tabBg },
            ]}
          >
            <Text
              style={[
                styles.pillText,
                { color: active ? '#ffffff' : C.tabText },
              ]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

// ─── Main screen ────────────────────────────────────────────────────────────

export default function AdminPendingActionsScreen() {
  const router = useRouter();
  const { dark } = useTheme();
  const C = getColors(dark);

  const user = useAuthStore((s) => s.user);
  const role = user?.role;
  // STEP-1B canApprove gate. Mirrors the web PendingActionsPage gate.
  const canApprove = role === UserRole.SUPER_ADMIN || role === UserRole.DISTRIBUTOR_ADMIN;

  const [moduleFilter, setModuleFilter] = useState<string>(''); // '' = All
  const [statusFilter, setStatusFilter] = useState<string>(PendingActionStatus.OPEN);
  const [offset, setOffset] = useState(0);

  const [resolveAction, setResolveAction] = useState<PendingAction | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState('');

  const moduleOptions: PillOption[] = useMemo(
    () => [
      { label: 'All Modules', value: '' },
      ...Object.values(PendingActionModule).map((m) => ({
        label: formatLabel(m),
        value: m,
      })),
    ],
    [],
  );

  const statusOptions: PillOption[] = useMemo(
    () => [
      { label: 'All Statuses', value: '' },
      ...Object.values(PendingActionStatus).map((s) => ({
        label: formatLabel(s),
        value: s,
      })),
    ],
    [],
  );

  const queryParams: Record<string, unknown> = { offset, limit: PAGE_SIZE };
  if (moduleFilter) queryParams.module = moduleFilter;
  if (statusFilter) queryParams.status = statusFilter;

  const { data, isLoading, isRefetching, refetch } = useApiQuery<{ actions: PendingAction[] }>(
    // useApiQuery types the key as string[] — stringify the offset.
    ['admin-pending-actions', moduleFilter, statusFilter, String(offset)],
    '/pending-actions',
    queryParams,
  );

  const actions = data?.actions ?? [];

  // Group by module — same pattern as the web page.
  const grouped = useMemo(() => {
    return actions.reduce<Record<string, PendingAction[]>>((acc, action) => {
      const key = action.module;
      if (!acc[key]) acc[key] = [];
      acc[key].push(action);
      return acc;
    }, {});
  }, [actions]);

  const approveMutation = useApiMutation<unknown, { actionId: string }>(
    'put',
    (vars) => `/pending-actions/${vars.actionId}/approve`,
    {
      invalidateKeys: [['admin-pending-actions']],
      successMessage: 'Action approved',
    },
  );

  const rejectMutation = useApiMutation<unknown, { actionId: string }>(
    'put',
    (vars) => `/pending-actions/${vars.actionId}/reject`,
    {
      invalidateKeys: [['admin-pending-actions']],
      successMessage: 'Action rejected',
    },
  );

  const resolveMutation = useApiMutation<unknown, { actionId: string; notes: string }>(
    'put',
    (vars) => `/pending-actions/${vars.actionId}/resolve`,
    {
      invalidateKeys: [['admin-pending-actions']],
      successMessage: 'Action resolved',
      onSuccess: () => {
        setResolveAction(null);
        setResolutionNotes('');
      },
    },
  );

  const onChangeModule = useCallback((v: string) => {
    setModuleFilter(v);
    setOffset(0);
  }, []);

  const onChangeStatus = useCallback((v: string) => {
    setStatusFilter(v);
    setOffset(0);
  }, []);

  const handleResolveSubmit = () => {
    if (!resolveAction) return;
    // notes optional at the API; web makes it required, mirror that.
    if (!resolutionNotes.trim()) {
      Alert.alert('Notes required', 'Please describe how this action was resolved.');
      return;
    }
    resolveMutation.mutate({
      actionId: resolveAction.actionId,
      notes: resolutionNotes.trim(),
    });
  };

  // Build a flat list of items where each module group's first action is
  // preceded by a section header row. Simpler than SectionList because each
  // card can have its own action affordances without fighting RN's section
  // sticky behaviour.
  type Row =
    | { type: 'header'; module: string; count: number }
    | { type: 'card'; action: PendingAction };

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const [moduleName, list] of Object.entries(grouped)) {
      out.push({ type: 'header', module: moduleName, count: list.length });
      for (const action of list) out.push({ type: 'card', action });
    }
    return out;
  }, [grouped]);

  const renderRow = ({ item }: { item: Row }) => {
    if (item.type === 'header') {
      return (
        <View style={styles.sectionHeader}>
          <View style={[styles.sectionDot, { backgroundColor: ACCENT }]} />
          <Text style={[styles.sectionTitle, { color: C.textSecondary }]}>
            {formatLabel(item.module)} ({item.count})
          </Text>
        </View>
      );
    }
    const action = item.action;
    const sla = getSlaStatus(action.slaDeadline);
    const isActionable =
      action.status === PendingActionStatus.OPEN ||
      action.status === PendingActionStatus.IN_PROGRESS;

    return (
      <View style={[styles.card, { backgroundColor: C.card, borderColor: C.cardBorder }]}>
        {/* Badge row */}
        <View style={styles.badgeRow}>
          <Badge variant={severityVariant(action.severity)} label={action.severity} />
          <Badge variant={paStatusVariant(action.status)} label={formatLabel(action.status)} />
          {sla && (
            <View style={styles.slaInline}>
              <Ionicons
                name="time-outline"
                size={11}
                color={sla.variant === 'danger' ? '#dc2626' : sla.variant === 'warning' ? '#d97706' : '#3b82f6'}
              />
              <View style={{ marginLeft: 4 }}>
                <Badge variant={sla.variant} label={sla.label} />
              </View>
            </View>
          )}
        </View>

        <Text style={[styles.description, { color: C.text }]}>{action.description}</Text>

        <Text style={[styles.metaLine, { color: C.textMuted }]}>
          {formatLabel(action.actionType)} | {new Date(action.createdAt).toLocaleString('en-IN')}
        </Text>

        {action.resolutionNotes ? (
          <Text style={[styles.resolution, { color: '#059669' }]}>
            Resolution: {action.resolutionNotes}
          </Text>
        ) : null}

        {isActionable && (
          <View style={styles.actionRow}>
            {action.requiresApproval && canApprove && (
              <>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: '#059669' }]}
                  onPress={() => approveMutation.mutate({ actionId: action.actionId })}
                  disabled={approveMutation.isPending}
                >
                  <Ionicons name="checkmark-circle-outline" size={14} color="#fff" />
                  <Text style={styles.actionBtnText}>Approve</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: '#dc2626' }]}
                  onPress={() => rejectMutation.mutate({ actionId: action.actionId })}
                  disabled={rejectMutation.isPending}
                >
                  <Ionicons name="close-circle-outline" size={14} color="#fff" />
                  <Text style={styles.actionBtnText}>Reject</Text>
                </TouchableOpacity>
              </>
            )}
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: C.tabBg, borderWidth: 1, borderColor: C.inputBorder }]}
              onPress={() => setResolveAction(action)}
            >
              <Ionicons name="construct-outline" size={14} color={C.text} />
              <Text style={[styles.actionBtnText, { color: C.text }]}>{getActionLabel(action)}</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

  const showPagination = offset > 0 || actions.length === PAGE_SIZE;

  return (
    <SafeAreaView edges={['left', 'right']} style={[styles.container, { backgroundColor: C.bg }]}>
      {/* Back header */}
      <View style={[styles.header, { borderBottomColor: C.divider }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={26} color={C.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: C.text }]}>Pending Actions</Text>
        <View style={{ width: 26 }} />
      </View>

      {/* Filters */}
      <View style={[styles.filterSection, { borderBottomColor: C.divider }]}>
        <Text style={[styles.filterLabel, { color: C.textMuted }]}>Module</Text>
        <PillRow options={moduleOptions} value={moduleFilter} onChange={onChangeModule} dark={dark} />
        <Text style={[styles.filterLabel, { color: C.textMuted, marginTop: 6 }]}>Status</Text>
        <PillRow options={statusOptions} value={statusFilter} onChange={onChangeStatus} dark={dark} />
      </View>

      {/* List body */}
      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.centered}>
          <EmptyState
            title="No pending actions"
            description="All clear! No items require your attention."
          />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item, idx) =>
            item.type === 'header' ? `h-${item.module}` : `c-${item.action.actionId}-${idx}`
          }
          renderItem={renderRow}
          refreshing={isRefetching}
          onRefresh={refetch}
          contentContainerStyle={styles.listContent}
          ListFooterComponent={
            showPagination ? (
              <View style={styles.pagination}>
                <TouchableOpacity
                  style={[
                    styles.pageBtn,
                    { backgroundColor: C.tabBg, opacity: offset === 0 ? 0.5 : 1 },
                  ]}
                  onPress={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                  disabled={offset === 0}
                >
                  <Text style={[styles.pageBtnText, { color: C.text }]}>Previous</Text>
                </TouchableOpacity>
                <Text style={{ color: C.textMuted, fontSize: 12 }}>
                  Showing {offset + 1}–{offset + actions.length}
                </Text>
                <TouchableOpacity
                  style={[
                    styles.pageBtn,
                    { backgroundColor: C.tabBg, opacity: actions.length < PAGE_SIZE ? 0.5 : 1 },
                  ]}
                  onPress={() => setOffset((o) => o + PAGE_SIZE)}
                  disabled={actions.length < PAGE_SIZE}
                >
                  <Text style={[styles.pageBtnText, { color: C.text }]}>Next</Text>
                </TouchableOpacity>
              </View>
            ) : null
          }
        />
      )}

      {/* Resolve Modal */}
      {resolveAction && (
        <Modal visible={!!resolveAction} animationType="fade" transparent>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={[styles.resolveOverlay, { backgroundColor: C.overlay }]}
          >
            <View style={[styles.resolveSheet, { backgroundColor: C.modalBg }]}>
              <Text style={[styles.resolveTitle, { color: C.text }]}>
                {getActionLabel(resolveAction)}
              </Text>
              <Text style={[styles.resolveDescription, { color: C.textSecondary }]}>
                {resolveAction.description}
              </Text>
              <Text style={[styles.fieldLabel, { color: C.text }]}>Resolution Notes *</Text>
              <TextInput
                style={[
                  styles.resolveTextarea,
                  { backgroundColor: C.card, borderColor: C.inputBorder, color: C.text },
                ]}
                placeholder="Describe how this was resolved..."
                placeholderTextColor={C.textMuted}
                value={resolutionNotes}
                onChangeText={setResolutionNotes}
                multiline
                numberOfLines={4}
                autoFocus
              />
              <View style={styles.resolveActions}>
                <TouchableOpacity
                  style={[styles.resolveBtn, { backgroundColor: C.tabBg }]}
                  onPress={() => {
                    setResolveAction(null);
                    setResolutionNotes('');
                  }}
                  disabled={resolveMutation.isPending}
                >
                  <Text style={{ color: C.text, fontWeight: '600' }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.resolveBtn, { backgroundColor: ACCENT }]}
                  onPress={handleResolveSubmit}
                  disabled={resolveMutation.isPending}
                >
                  {resolveMutation.isPending ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={{ color: '#fff', fontWeight: '700' }}>Resolve</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      )}
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

  filterSection: { paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1 },
  filterLabel: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', marginBottom: 4 },

  // STAGE-A A1: pinned pill height + alignItems on container so the
  // horizontal ScrollView can't be vertically inflated by the parent flex.
  pillRow: { gap: 8, paddingVertical: 4, alignItems: 'center' },
  pill: { height: 36, paddingHorizontal: 12, borderRadius: 18, flexShrink: 0, justifyContent: 'center' },
  pillText: { fontSize: 12, fontWeight: '600' },

  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  listContent: { padding: 12, paddingBottom: 24 },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingTop: 10,
    paddingBottom: 6,
  },
  sectionDot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  sectionTitle: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },

  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    marginBottom: 8,
  },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6, alignItems: 'center' },
  slaInline: { flexDirection: 'row', alignItems: 'center' },

  description: { fontSize: 14, fontWeight: '600', marginBottom: 4 },
  metaLine: { fontSize: 11 },
  resolution: { fontSize: 11, fontWeight: '600', marginTop: 4 },

  actionRow: { flexDirection: 'row', gap: 6, marginTop: 10, flexWrap: 'wrap' },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 4,
  },
  actionBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  pagination: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 16,
    paddingHorizontal: 4,
  },
  pageBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  pageBtnText: { fontSize: 12, fontWeight: '700' },

  // Resolve modal
  resolveOverlay: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  resolveSheet: { width: '100%', maxWidth: 440, borderRadius: 16, padding: 18 },
  resolveTitle: { fontSize: 17, fontWeight: '700', marginBottom: 4 },
  resolveDescription: { fontSize: 13, marginBottom: 12 },
  fieldLabel: { fontSize: 12, fontWeight: '600', marginBottom: 4 },
  resolveTextarea: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    minHeight: 96,
    textAlignVertical: 'top',
  },
  resolveActions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  resolveBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
