import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  Modal,
  FlatList,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  KeyboardAvoidingView,
  Platform,
  Switch,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { useAuthStore } from '../../src/stores/authStore';
// STAGE-A A7: dark-mode toggle parity with (driver)/more.tsx — themeStore
// already exists end-to-end (Zustand + SecureStore persistence). Admin
// just lacked the toggle UI.
import { useThemeStore, useIsDark } from '../../src/stores/themeStore';
import { DeleteAccountButton } from '../../src/components/DeleteAccountButton';
import { DateInput } from '../../src/components/ui';
import { useTheme, ACCENT as ACCENT_COLORS } from '../../src/theme';
// STAGE-H: Customers, Fleet, and Reports have been promoted out of this file
// into their own (admin) tab screens. The remaining modals here are the
// Settings/Analytics/Account ones.

const ACCENT = ACCENT_COLORS.red;

// ─── Types ──────────────────────────────────────────────────────────────────
// STAGE-H: Customer / Driver / Vehicle / VehicleMappingRow / VehicleMappingsResponse
// shapes moved with their owning modals to (admin)/customers.tsx + (admin)/fleet.tsx.

interface GstSettings {
  gstMode: 'disabled' | 'sandbox' | 'live' | null;
  gstCredentials?: {
    gstin?: string;
    clientId?: string;
    clientSecret?: string;
    username?: string;
  } | null;
}

interface UserRecord {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  status?: string;
}

// Wire shape ACTUALLY returned by GET /analytics/header-metrics
// (analyticsService.getHeaderMetrics + getAdvancedMetrics). The
// historical HeaderMetrics interface here described fields the route
// never returned — every card in the Overview modal resolved to 0
// (CLAUDE.md anti-pattern #9). Aligned 2026-06-01.
interface HeaderMetrics {
  amountInMarket?: number;
  collectedAmount?: number;
  dueAmount?: number;
  overdueAmount?: number;
  totalCapital?: number;
  unrecoveredAmount?: number;
  cylinderUtilizationRate?: number;
  averageTurnaroundDays?: number;
  inventoryShrinkage?: number;
  deliveryEfficiency?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type Theme = {
  bg: string;
  cardBg: string;
  cardBorder: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  divider: string;
  inputBg: string;
  inputBorder: string;
};

function useMoreTheme(): Theme {
  const { colors } = useTheme();
  return colors;
}

const fmt = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

function formatCurrency(n: number): string {
  return fmt.format(n);
}

// ─── Reusable: Modal Header ─────────────────────────────────────────────────

function ModalHeader({
  title,
  onClose,
  theme,
}: {
  title: string;
  onClose: () => void;
  theme: Theme;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingVertical: 16,
        borderBottomWidth: 1,
        borderBottomColor: theme.divider,
      }}
    >
      <Text style={{ fontSize: 18, fontWeight: '700', color: theme.text }}>{title}</Text>
      <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
        <Ionicons name="close" size={24} color={theme.textSecondary} />
      </TouchableOpacity>
    </View>
  );
}

// ─── Reusable: Form Input ───────────────────────────────────────────────────

function FormInput({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  secureTextEntry,
  theme,
  autoCapitalize,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'phone-pad' | 'email-address' | 'numeric';
  secureTextEntry?: boolean;
  theme: Theme;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={{ fontSize: 13, fontWeight: '600', color: theme.textSecondary, marginBottom: 6 }}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.textMuted}
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize ?? 'sentences'}
        style={{
          backgroundColor: theme.inputBg,
          borderWidth: 1,
          borderColor: theme.inputBorder,
          borderRadius: 10,
          paddingHorizontal: 14,
          paddingVertical: 12,
          fontSize: 15,
          color: theme.text,
        }}
      />
    </View>
  );
}

// ─── Reusable: Status / Role Badge ──────────────────────────────────────────

function StatusBadge({ label, color }: { label: string; color: string }) {
  return (
    <View
      style={{
        backgroundColor: color + '18',
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: '700', color, textTransform: 'uppercase' }}>
        {label}
      </Text>
    </View>
  );
}

// ─── Reusable: Section Row ──────────────────────────────────────────────────

function MenuRow({
  icon,
  label,
  subtitle,
  onPress,
  theme,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  subtitle?: string;
  onPress: () => void;
  theme: Theme;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 14,
        paddingHorizontal: 16,
        gap: 14,
      }}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          backgroundColor: ACCENT + '12',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name={icon} size={18} color={ACCENT} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontWeight: '600', color: theme.text }}>{label}</Text>
        {subtitle ? (
          <Text style={{ fontSize: 12, color: theme.textMuted, marginTop: 1 }}>{subtitle}</Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
    </TouchableOpacity>
  );
}

// ─── Reusable: Section Card ─────────────────────────────────────────────────

function SectionCard({
  title,
  children,
  theme,
}: {
  title: string;
  children: React.ReactNode;
  theme: Theme;
}) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text
        style={{
          fontSize: 13,
          fontWeight: '700',
          color: theme.textMuted,
          textTransform: 'uppercase',
          letterSpacing: 0.8,
          marginBottom: 8,
          marginLeft: 4,
        }}
      >
        {title}
      </Text>
      <View
        style={{
          backgroundColor: theme.cardBg,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: theme.cardBorder,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}

function Divider({ theme }: { theme: Theme }) {
  return <View style={{ height: 1, backgroundColor: theme.divider, marginLeft: 64 }} />;
}

// ─── Reusable: FAB ──────────────────────────────────────────────────────────

function FAB({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      style={{
        position: 'absolute',
        bottom: 24,
        right: 24,
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: ACCENT,
        alignItems: 'center',
        justifyContent: 'center',
        elevation: 6,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.25,
        shadowRadius: 6,
      }}
    >
      <Ionicons name="add" size={28} color="#fff" />
    </TouchableOpacity>
  );
}

// STAGE-H: TabBar helper removed — FleetModal / ReportsModal / CustomersModal
// (the three consumers) moved out of this file.

// ─── Reusable: Empty State ──────────────────────────────────────────────────

function EmptyList({ message, theme }: { message: string; theme: Theme }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 48 }}>
      <Ionicons name="file-tray-outline" size={48} color={theme.textMuted} />
      <Text style={{ fontSize: 14, color: theme.textMuted, marginTop: 12 }}>{message}</Text>
    </View>
  );
}

// ─── Reusable: Loading ──────────────────────────────────────────────────────

function Loading({ theme: _theme }: { theme: Theme }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator size="large" color={ACCENT} />
    </View>
  );
}

// STAGE-H: CUSTOMERS MODAL + EditCustomerInlineModal extracted into the
// standalone (admin)/customers.tsx tab screen. The same shared CustomerForm
// body still backs both the inline edit modal there and the Create route at
// (admin)/customer-create.tsx, so STAGE-F parity is preserved.

// STAGE-H: DetailRow helper removed — was used by CustomersModal +
// ReportsModal, both extracted to their own screens.


// STEP-3C: CollectionsModal removed. Collections is now a full screen at
// app/(admin)/collections.tsx, reached via More → Collections → router.push.

// STEP-3C: MetricBox helper removed alongside CollectionsModal — it was its
// only consumer. AnalyticsOverviewModal uses its own card layout.

// ═══════════════════════════════════════════════════════════════════════════
// ANALYTICS OVERVIEW MODAL
// ═══════════════════════════════════════════════════════════════════════════

function AnalyticsOverviewModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useMoreTheme();

  const { data: metrics, isLoading, refetch } = useApiQuery<HeaderMetrics>(
    ['header-metrics'],
    '/analytics/header-metrics',
    undefined,
    { enabled: visible },
  );

  const metricItems = [
    { label: 'Amount in Market', value: formatCurrency(metrics?.amountInMarket || 0), icon: 'cash-outline' as const, color: '#10b981' },
    { label: 'Collected', value: formatCurrency(metrics?.collectedAmount || 0), icon: 'checkmark-circle-outline' as const, color: '#10b981' },
    { label: 'Due', value: formatCurrency(metrics?.dueAmount || 0), icon: 'time-outline' as const, color: '#f59e0b' },
    { label: 'Overdue', value: formatCurrency(metrics?.overdueAmount || 0), icon: 'warning-outline' as const, color: '#ef4444' },
    { label: 'Total Capital', value: formatCurrency(metrics?.totalCapital || 0), icon: 'wallet-outline' as const, color: '#3b82f6' },
    { label: 'Unrecovered', value: formatCurrency(metrics?.unrecoveredAmount || 0), icon: 'alert-circle-outline' as const, color: '#ef4444' },
    { label: 'Cylinder Utilization', value: `${(metrics?.cylinderUtilizationRate || 0).toFixed(1)}%`, icon: 'cube-outline' as const, color: '#8b5cf6' },
    { label: 'Avg Turnaround', value: `${(metrics?.averageTurnaroundDays || 0).toFixed(1)} d`, icon: 'sync-outline' as const, color: '#3b82f6' },
    { label: 'Delivery Efficiency', value: `${(metrics?.deliveryEfficiency || 0).toFixed(1)}%`, icon: 'trending-up-outline' as const, color: '#10b981' },
    { label: 'Inventory Shrinkage', value: `${(metrics?.inventoryShrinkage || 0).toFixed(1)}%`, icon: 'stats-chart-outline' as const, color: '#f59e0b' },
  ];

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaProvider>
      <SafeAreaView edges={['top','bottom','left','right']} style={{ flex: 1, backgroundColor: theme.bg }}>
        <ModalHeader title="Overview" onClose={onClose} theme={theme} />
        {isLoading ? (
          <Loading theme={theme} />
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: 16, gap: 12 }}
            refreshControl={<RefreshControl refreshing={false} onRefresh={refetch} tintColor={ACCENT} />}
          >
            {/* 2-column grid */}
            {Array.from({ length: Math.ceil(metricItems.length / 2) }).map((_, rowIdx) => (
              <View key={rowIdx} style={{ flexDirection: 'row', gap: 12 }}>
                {metricItems.slice(rowIdx * 2, rowIdx * 2 + 2).map((m) => (
                  <View
                    key={m.label}
                    style={{
                      flex: 1,
                      backgroundColor: theme.cardBg,
                      borderRadius: 14,
                      padding: 16,
                      borderWidth: 1,
                      borderColor: theme.cardBorder,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <View
                        style={{
                          width: 32, height: 32, borderRadius: 8,
                          backgroundColor: m.color + '14', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <Ionicons name={m.icon} size={16} color={m.color} />
                      </View>
                    </View>
                    <Text style={{ fontSize: 22, fontWeight: '800', color: theme.text }}>{m.value}</Text>
                    <Text style={{ fontSize: 12, color: theme.textMuted, marginTop: 4 }}>{m.label}</Text>
                  </View>
                ))}
              </View>
            ))}
          </ScrollView>
        )}
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// GST CONFIGURATION MODAL
// ═══════════════════════════════════════════════════════════════════════════

function GstConfigModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useMoreTheme();

  const { data: gstSettings, isLoading } = useApiQuery<GstSettings>(
    ['gst-settings'],
    '/settings',
    undefined,
    { enabled: visible },
  );

  // Group A Step 9: GST writes are super-admin only and live on the
  // dedicated web activation screen. Mobile renders the current mode
  // read-only; the form / test-connection state was removed.
  const currentMode = gstSettings?.gstMode || 'disabled';

  const modeColors: Record<string, string> = {
    disabled: '#94a3b8',
    sandbox: '#f59e0b',
    live: '#10b981',
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaProvider>
      <SafeAreaView edges={['top','bottom','left','right']} style={{ flex: 1, backgroundColor: theme.bg }}>
        <ModalHeader title="GST Configuration" onClose={onClose} theme={theme} />
        {isLoading ? (
          <Loading theme={theme} />
        ) : (
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={{ flex: 1 }}
          >
            <ScrollView contentContainerStyle={{ padding: 20, gap: 20 }}>
              {/* Current Mode */}
              <View style={{ alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 13, color: theme.textMuted }}>Current Mode</Text>
                <StatusBadge label={currentMode} color={modeColors[currentMode]} />
              </View>

              {/* Group A Step 9: GST writes are super-admin only and live on
                  the web activation screen. Mobile shows the current state
                  read-only with a pointer to the canonical path. */}
              <View
                style={{
                  marginTop: 8,
                  padding: 16,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: theme.inputBorder,
                  backgroundColor: theme.inputBg,
                  gap: 8,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Ionicons name="information-circle-outline" size={20} color={theme.textSecondary} />
                  <Text style={{ fontSize: 14, fontWeight: '700', color: theme.text }}>
                    Managed on web
                  </Text>
                </View>
                <Text style={{ fontSize: 13, lineHeight: 19, color: theme.textSecondary }}>
                  GST mode and WhiteBooks credentials are configured through
                  the dedicated activation screen on the web app. Sign in as
                  super-admin → Distributors → select tenant → Configure GST.
                  Contact your platform administrator if you need a change.
                </Text>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        )}
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CYLINDER PRICES MODAL
// ═══════════════════════════════════════════════════════════════════════════

// Wire shape returned by GET /cylinder-types/prices/list. Originally typed
// as { cylinderType?: string } — but the API returns the nested object
// { cylinderType: { typeName } } (Prisma include), which made the
// fallback render `{p.cylinderType || ...}` resolve to a non-null object
// and crash with "Objects are not valid as a React child". Combined with
// the missing onError on useApiQuery, real failures silently showed the
// "No prices configured" empty state on seeded distributors. Fixed
// 2026-06-01 (CLAUDE.md anti-pattern #9).
interface CylinderPriceRow {
  id: string;
  cylinderTypeId: string;
  cylinderType?: { typeName: string };
  price?: number | string;
  effectiveDate?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// CYLINDER TYPES MODAL  (STEP-3F)
// ═══════════════════════════════════════════════════════════════════════════
//
// Mirrors the web Settings → Cylinder Types tab: list / create / edit / delete.
// API: GET /cylinder-types → { cylinderTypes: CylinderType[] }
//      POST /cylinder-types { typeName, capacity, unit }
//      PUT  /cylinder-types/:id { typeName?, capacity?, unit? }
//      DELETE /cylinder-types/:id  (soft-delete; service marks isActive=false)
//
// Role gates were widened by STEP-1A: all four routes accept
// super_admin | distributor_admin | finance | inventory.

interface CylinderTypeRow {
  cylinderTypeId: string;
  typeName: string;
  capacity: number;
  unit: string;
}

function CylinderTypeFormModal({
  visible,
  mode,
  initial,
  theme,
  onClose,
  onSubmit,
  submitting,
}: {
  visible: boolean;
  mode: 'create' | 'edit';
  initial: { typeName: string; capacity: string; unit: string };
  theme: Theme;
  onClose: () => void;
  onSubmit: (values: { typeName: string; capacity: number; unit: string }) => void;
  submitting: boolean;
}) {
  const [typeName, setTypeName] = useState(initial.typeName);
  const [capacity, setCapacity] = useState(initial.capacity);
  const [unit, setUnit] = useState(initial.unit);
  const [initializedFor, setInitializedFor] = useState<string | null>(null);

  // Re-sync form fields with `initial` each time the modal opens for a
  // (potentially) different row. Keyed off a coarse "open snapshot" string.
  const openKey = visible ? `${mode}:${initial.typeName}:${initial.capacity}:${initial.unit}` : null;
  if (openKey && initializedFor !== openKey) {
    setInitializedFor(openKey);
    setTypeName(initial.typeName);
    setCapacity(initial.capacity);
    setUnit(initial.unit);
  }
  if (!visible && initializedFor !== null) {
    setInitializedFor(null);
  }

  const handleSave = () => {
    const trimmedName = typeName.trim();
    const capacityNum = Number(capacity);
    const trimmedUnit = unit.trim() || 'kg';
    if (!trimmedName) {
      Alert.alert('Validation', 'Type name is required.');
      return;
    }
    if (!Number.isFinite(capacityNum) || capacityNum <= 0) {
      Alert.alert('Validation', 'Capacity must be a positive number.');
      return;
    }
    onSubmit({ typeName: trimmedName, capacity: capacityNum, unit: trimmedUnit });
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet">
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
        <ModalHeader title={mode === 'create' ? 'Add Cylinder Type' : 'Edit Cylinder Type'} onClose={onClose} theme={theme} />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
          <ScrollView contentContainerStyle={{ padding: 20 }}>
            <FormInput
              label="Type Name *"
              value={typeName}
              onChangeText={setTypeName}
              placeholder="e.g. 14.2 kg Domestic"
              theme={theme}
            />
            <FormInput
              label="Capacity *"
              value={capacity}
              onChangeText={setCapacity}
              placeholder="e.g. 14.2"
              keyboardType="numeric"
              theme={theme}
            />
            <FormInput
              label="Unit"
              value={unit}
              onChangeText={setUnit}
              placeholder="kg"
              autoCapitalize="none"
              theme={theme}
            />
            <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
              <TouchableOpacity
                onPress={onClose}
                disabled={submitting}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 10,
                  backgroundColor: theme.cardBg, borderWidth: 1, borderColor: theme.cardBorder,
                  alignItems: 'center',
                  opacity: submitting ? 0.6 : 1,
                }}
              >
                <Text style={{ fontSize: 15, fontWeight: '600', color: theme.textSecondary }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSave}
                disabled={submitting}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 10,
                  backgroundColor: ACCENT, alignItems: 'center',
                  opacity: submitting ? 0.6 : 1,
                }}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>
                    {mode === 'create' ? 'Create' : 'Save'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function CylinderTypesModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useMoreTheme();
  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<CylinderTypeRow | null>(null);

  const { data, isLoading, refetch, isRefetching } = useApiQuery<{ cylinderTypes: CylinderTypeRow[] }>(
    ['cylinder-types'],
    '/cylinder-types',
    undefined,
    { enabled: visible },
  );
  const cylinderTypes: CylinderTypeRow[] = data?.cylinderTypes ?? [];

  const createMutation = useApiMutation<
    CylinderTypeRow,
    { typeName: string; capacity: number; unit: string }
  >('post', '/cylinder-types', {
    invalidateKeys: [['cylinder-types']],
    successMessage: 'Cylinder type created',
    onSuccess: () => {
      setFormMode(null);
      setEditing(null);
    },
  });

  const updateMutation = useApiMutation<
    CylinderTypeRow,
    { typeName: string; capacity: number; unit: string }
  >('put', () => `/cylinder-types/${editing?.cylinderTypeId ?? ''}`, {
    invalidateKeys: [['cylinder-types']],
    successMessage: 'Cylinder type updated',
    onSuccess: () => {
      setFormMode(null);
      setEditing(null);
    },
  });

  const deleteMutation = useApiMutation<{ message: string }, void>(
    'delete',
    (_vars) => `/cylinder-types/${pendingDeleteId.current ?? ''}`,
    {
      invalidateKeys: [['cylinder-types']],
      successMessage: 'Cylinder type deleted',
    },
  );
  // Tiny ref-style holder so the delete URL can resolve at call time without
  // making it part of the mutation variables.
  const pendingDeleteId = React.useRef<string | null>(null);

  const handleDelete = (row: CylinderTypeRow) => {
    Alert.alert(
      'Delete cylinder type',
      `Delete "${row.typeName}"? This cannot be undone if it has no historical inventory.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            pendingDeleteId.current = row.cylinderTypeId;
            deleteMutation.mutate(undefined);
          },
        },
      ],
    );
  };

  const handleSubmit = (values: { typeName: string; capacity: number; unit: string }) => {
    if (formMode === 'create') {
      createMutation.mutate(values);
    } else if (formMode === 'edit' && editing) {
      updateMutation.mutate(values);
    }
  };

  const formInitial = useMemo(() => {
    if (formMode === 'edit' && editing) {
      return {
        typeName: editing.typeName,
        capacity: String(editing.capacity),
        unit: editing.unit || 'kg',
      };
    }
    return { typeName: '', capacity: '', unit: 'kg' };
  }, [formMode, editing]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaProvider>
      <SafeAreaView edges={['top','bottom','left','right']} style={{ flex: 1, backgroundColor: theme.bg }}>
        <ModalHeader title="Cylinder Types" onClose={onClose} theme={theme} />
        {isLoading ? (
          <Loading theme={theme} />
        ) : (
          <View style={{ flex: 1 }}>
            <FlatList
              data={cylinderTypes}
              keyExtractor={(item) => item.cylinderTypeId}
              // UBB C2 U5 — FAB clearance on the non-empty case (FAB at line ~1046).
              contentContainerStyle={
                cylinderTypes.length === 0
                  ? { flex: 1 }
                  : { paddingVertical: 8, paddingBottom: 96 }
              }
              renderItem={({ item }) => (
                <View
                  style={{
                    flexDirection: 'row', alignItems: 'center',
                    paddingHorizontal: 16, paddingVertical: 14, gap: 12,
                  }}
                >
                  <View
                    style={{
                      width: 40, height: 40, borderRadius: 10,
                      backgroundColor: ACCENT + '14',
                      alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <Ionicons name="cube" size={18} color={ACCENT} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: theme.text }}>
                      {item.typeName}
                    </Text>
                    <Text style={{ fontSize: 12, color: theme.textMuted, marginTop: 2 }}>
                      {item.capacity} {item.unit || 'kg'}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => { setEditing(item); setFormMode('edit'); }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={{
                      paddingHorizontal: 10, paddingVertical: 6,
                      borderRadius: 8, backgroundColor: ACCENT + '14',
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '700', color: ACCENT }}>Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => handleDelete(item)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={{
                      paddingHorizontal: 10, paddingVertical: 6,
                      borderRadius: 8, backgroundColor: '#dc262614',
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '700', color: '#dc2626' }}>Delete</Text>
                  </TouchableOpacity>
                </View>
              )}
              ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: theme.divider }} />}
              ListEmptyComponent={
                <EmptyList
                  message="No cylinder types defined. Add one to get started."
                  theme={theme}
                />
              }
              refreshControl={
                <RefreshControl
                  refreshing={isRefetching}
                  onRefresh={refetch}
                  tintColor={ACCENT}
                />
              }
            />
            <FAB onPress={() => { setEditing(null); setFormMode('create'); }} />
          </View>
        )}

        <CylinderTypeFormModal
          visible={formMode !== null}
          mode={formMode ?? 'create'}
          initial={formInitial}
          theme={theme}
          onClose={() => { setFormMode(null); setEditing(null); }}
          onSubmit={handleSubmit}
          submitting={createMutation.isPending || updateMutation.isPending}
        />
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CYLINDER PRICES MODAL
// ═══════════════════════════════════════════════════════════════════════════

function CylinderPricesModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useMoreTheme();

  const { data: prices, isLoading, isRefetching, refetch, error } = useApiQuery<CylinderPriceRow[]>(
    ['cylinder-prices'],
    '/cylinder-types/prices/list',
    undefined,
    { enabled: visible },
  );

  // Cylinder types — needed to populate the "Add Price" picker. The
  // /cylinder-types endpoint returns { cylinderTypes: ... }.
  const { data: typesResp } = useApiQuery<{ cylinderTypes: Array<{ id: string; typeName: string }> }>(
    ['cylinder-types-for-prices'],
    '/cylinder-types',
    undefined,
    { enabled: visible },
  );
  const cylinderTypes = typesResp?.cylinderTypes ?? [];

  // The API is append-only (POST /cylinder-types/prices creates a new
  // CylinderPrice row; the latest effectiveDate wins on read). So
  // "edit" is implemented as "add a new entry for the same type with
  // today's effectiveDate and the new price". DELETE is also exposed
  // for cleanup.
  const [addOpen, setAddOpen] = useState(false);
  const [addCylinderTypeId, setAddCylinderTypeId] = useState('');
  const [addPrice, setAddPrice] = useState('');
  const [addEffectiveDate, setAddEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10));

  const createMutation = useApiMutation<unknown, { cylinderTypeId: string; price: number; effectiveDate: string }>(
    'post',
    '/cylinder-types/prices',
    {
      invalidateKeys: [['cylinder-prices']],
      successMessage: 'Price added',
      onSuccess: () => {
        setAddOpen(false);
        setAddCylinderTypeId('');
        setAddPrice('');
        setAddEffectiveDate(new Date().toISOString().slice(0, 10));
      },
      onError: (err: unknown) => {
        Alert.alert('Could not add price', (err as Error)?.message ?? 'Unknown error');
      },
    },
  );

  const deleteMutation = useApiMutation<unknown, { id: string }>(
    'delete',
    (vars) => `/cylinder-types/prices/${vars.id}`,
    {
      invalidateKeys: [['cylinder-prices']],
      successMessage: 'Price removed',
    },
  );

  const handleAdd = () => {
    if (!addCylinderTypeId) {
      Alert.alert('Required', 'Pick a cylinder type.');
      return;
    }
    const numeric = Number(addPrice);
    if (Number.isNaN(numeric) || numeric <= 0) {
      Alert.alert('Required', 'Price must be a positive number.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(addEffectiveDate)) {
      Alert.alert('Required', 'Pick an effective date.');
      return;
    }
    createMutation.mutate({
      cylinderTypeId: addCylinderTypeId,
      price: numeric,
      effectiveDate: addEffectiveDate,
    });
  };

  const handleDelete = (row: CylinderPriceRow) => {
    Alert.alert(
      'Remove price?',
      `Delete this price entry for ${row.cylinderType?.typeName ?? 'this cylinder type'}? The previous entry (if any) becomes the latest.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteMutation.mutate({ id: row.id }),
        },
      ],
    );
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaProvider>
      <SafeAreaView edges={['top','bottom','left','right']} style={{ flex: 1, backgroundColor: theme.bg }}>
        <ModalHeader title="Cylinder Prices" onClose={onClose} theme={theme} />
        {isLoading ? (
          <Loading theme={theme} />
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: 20 }}
            refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={ACCENT} />}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 12 }}>
              <TouchableOpacity
                onPress={() => setAddOpen(true)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  backgroundColor: ACCENT,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderRadius: 8,
                }}
              >
                <Ionicons name="add" size={16} color="#fff" />
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>Add Price</Text>
              </TouchableOpacity>
            </View>
            <View
              style={{
                backgroundColor: theme.cardBg, borderRadius: 14,
                borderWidth: 1, borderColor: theme.cardBorder, overflow: 'hidden',
              }}
            >
              {/* Table Header */}
              <View
                style={{
                  flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 10,
                  borderBottomWidth: 1, borderBottomColor: theme.divider,
                }}
              >
                <Text style={{ flex: 1.4, fontSize: 11, fontWeight: '700', color: theme.textMuted, textTransform: 'uppercase' }}>
                  Cylinder Type
                </Text>
                <Text style={{ flex: 1, fontSize: 11, fontWeight: '700', color: theme.textMuted, textTransform: 'uppercase', textAlign: 'right' }}>
                  Price
                </Text>
                <Text style={{ flex: 1, fontSize: 11, fontWeight: '700', color: theme.textMuted, textTransform: 'uppercase', textAlign: 'right' }}>
                  Effective
                </Text>
                <View style={{ width: 32 }} />
              </View>
              {error && (
                <View style={{ padding: 20, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, color: '#ef4444', textAlign: 'center' }}>
                    Failed to load prices. Pull to retry.
                  </Text>
                  <Text style={{ fontSize: 11, color: theme.textMuted, marginTop: 4, textAlign: 'center' }}>
                    {(error as Error).message}
                  </Text>
                </View>
              )}
              {!error && (!prices || prices.length === 0) && (
                <View style={{ padding: 20, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, color: theme.textMuted }}>No prices configured</Text>
                </View>
              )}
              {prices?.map((p: CylinderPriceRow, i: number) => (
                <View key={p.id}>
                  {i > 0 && <View style={{ height: 1, backgroundColor: theme.divider }} />}
                  <View style={{ flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 14, alignItems: 'center' }}>
                    <View style={{ flex: 1.4 }}>
                      <Text style={{ fontSize: 14, fontWeight: '600', color: theme.text }}>
                        {p.cylinderType?.typeName ?? `Type ${i + 1}`}
                      </Text>
                    </View>
                    <Text style={{ flex: 1, fontSize: 15, fontWeight: '700', color: theme.text, textAlign: 'right' }}>
                      {formatCurrency(Number(p.price ?? 0))}
                    </Text>
                    <Text style={{ flex: 1, fontSize: 11, color: theme.textMuted, textAlign: 'right' }}>
                      {p.effectiveDate ? new Date(p.effectiveDate).toISOString().slice(0, 10) : '—'}
                    </Text>
                    <TouchableOpacity
                      onPress={() => handleDelete(p)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={{ width: 32, alignItems: 'flex-end' }}
                    >
                      <Ionicons name="trash-outline" size={18} color="#ef4444" />
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          </ScrollView>
        )}

        {/* Add Price modal — bottom-sheet style */}
        <Modal visible={addOpen} animationType="slide" transparent onRequestClose={() => setAddOpen(false)}>
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
            <View style={{ backgroundColor: theme.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <Text style={{ fontSize: 17, fontWeight: '700', color: theme.text }}>Add Price</Text>
                <TouchableOpacity onPress={() => setAddOpen(false)}>
                  <Ionicons name="close" size={24} color={theme.text} />
                </TouchableOpacity>
              </View>

              <Text style={{ fontSize: 11, fontWeight: '700', color: theme.textMuted, marginBottom: 4 }}>CYLINDER TYPE</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, marginBottom: 14 }}>
                {cylinderTypes.map((ct) => {
                  const selected = addCylinderTypeId === ct.id;
                  return (
                    <TouchableOpacity
                      key={ct.id}
                      onPress={() => setAddCylinderTypeId(ct.id)}
                      style={{
                        paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16,
                        backgroundColor: selected ? ACCENT : theme.cardBg,
                        borderWidth: 1, borderColor: selected ? ACCENT : theme.cardBorder,
                      }}
                    >
                      <Text style={{ fontSize: 12, fontWeight: '600', color: selected ? '#fff' : theme.text }}>
                        {ct.typeName}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              <Text style={{ fontSize: 11, fontWeight: '700', color: theme.textMuted, marginBottom: 4 }}>PRICE (₹)</Text>
              <TextInput
                value={addPrice}
                onChangeText={(v) => setAddPrice(v.replace(/[^0-9.]/g, ''))}
                placeholder="e.g. 1200"
                placeholderTextColor={theme.textMuted}
                keyboardType="decimal-pad"
                style={{
                  borderWidth: 1, borderColor: theme.cardBorder, borderRadius: 10,
                  paddingHorizontal: 12, paddingVertical: 10, fontSize: 15,
                  color: theme.text, backgroundColor: theme.cardBg, marginBottom: 14,
                }}
              />

              <Text style={{ fontSize: 11, fontWeight: '700', color: theme.textMuted, marginBottom: 4 }}>EFFECTIVE DATE</Text>
              <View style={{ marginBottom: 18 }}>
                <DateInput value={addEffectiveDate || null} onChange={setAddEffectiveDate} />
              </View>

              <TouchableOpacity
                onPress={handleAdd}
                disabled={createMutation.isPending}
                style={{
                  backgroundColor: ACCENT, borderRadius: 10, paddingVertical: 12,
                  alignItems: 'center', marginBottom: 16,
                  opacity: createMutation.isPending ? 0.6 : 1,
                }}
              >
                {createMutation.isPending ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>Save Price</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// INVENTORY THRESHOLDS MODAL
// ═══════════════════════════════════════════════════════════════════════════

// Wire shape returned by GET /settings/cylinder-thresholds/list. The
// Prisma include nests cylinderType under {typeName}. WarningLevel /
// criticalLevel field names match the schema; the prior "warning" /
// "critical" / "cylinderType?: string" guesses never matched the API
// (anti-pattern #9). Fixed 2026-06-01 alongside making the row editable.
interface ThresholdRow {
  id: string;
  cylinderTypeId: string;
  cylinderType?: { typeName: string };
  warningLevel: number;
  criticalLevel: number;
  alertEnabled: boolean;
}

function InventoryThresholdsModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useMoreTheme();

  const { data: thresholds, isLoading, isRefetching, refetch } = useApiQuery<ThresholdRow[]>(
    ['inventory-thresholds'],
    '/settings/cylinder-thresholds/list',
    undefined,
    { enabled: visible },
  );

  // Per-row inline edit state. Stored as strings to keep the TextInput
  // controlled without int-coercion noise. Only one row edits at a time.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [warningInput, setWarningInput] = useState('');
  const [criticalInput, setCriticalInput] = useState('');

  const upsertMutation = useApiMutation<
    unknown,
    { cylinderTypeId: string; warningLevel: number; criticalLevel: number; alertEnabled: boolean }
  >('put', '/cylinder-types/thresholds', {
    invalidateKeys: [['inventory-thresholds']],
    successMessage: 'Threshold updated',
    onSuccess: () => setEditingId(null),
    onError: (err: unknown) => {
      Alert.alert('Could not save threshold', (err as Error)?.message ?? 'Unknown error');
    },
  });

  const beginEdit = (row: ThresholdRow) => {
    setEditingId(row.id);
    setWarningInput(String(row.warningLevel));
    setCriticalInput(String(row.criticalLevel));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setWarningInput('');
    setCriticalInput('');
  };

  const saveEdit = (row: ThresholdRow) => {
    const warning = Number(warningInput);
    const critical = Number(criticalInput);
    if (!Number.isFinite(warning) || warning < 0) {
      Alert.alert('Invalid value', 'Warning must be a whole number ≥ 0.');
      return;
    }
    if (!Number.isFinite(critical) || critical < 0) {
      Alert.alert('Invalid value', 'Critical must be a whole number ≥ 0.');
      return;
    }
    if (critical > warning) {
      Alert.alert('Invalid value', 'Critical must be less than or equal to Warning.');
      return;
    }
    upsertMutation.mutate({
      cylinderTypeId: row.cylinderTypeId,
      warningLevel: Math.floor(warning),
      criticalLevel: Math.floor(critical),
      alertEnabled: row.alertEnabled,
    });
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaProvider>
      <SafeAreaView edges={['top','bottom','left','right']} style={{ flex: 1, backgroundColor: theme.bg }}>
        <ModalHeader title="Inventory Thresholds" onClose={onClose} theme={theme} />
        {isLoading ? (
          <Loading theme={theme} />
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: 20 }}
            refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={ACCENT} />}
          >
            <View
              style={{
                backgroundColor: theme.cardBg, borderRadius: 14,
                borderWidth: 1, borderColor: theme.cardBorder, overflow: 'hidden',
              }}
            >
              {/* Header */}
              <View
                style={{
                  flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 10,
                  borderBottomWidth: 1, borderBottomColor: theme.divider,
                }}
              >
                <Text style={{ flex: 1, fontSize: 11, fontWeight: '700', color: theme.textMuted, textTransform: 'uppercase' }}>
                  Type
                </Text>
                <Text style={{ width: 70, fontSize: 11, fontWeight: '700', color: theme.textMuted, textTransform: 'uppercase', textAlign: 'center' }}>
                  Warning
                </Text>
                <Text style={{ width: 70, fontSize: 11, fontWeight: '700', color: theme.textMuted, textTransform: 'uppercase', textAlign: 'center' }}>
                  Critical
                </Text>
                <View style={{ width: 60 }} />
              </View>
              {(!thresholds || thresholds.length === 0) && (
                <View style={{ padding: 20, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, color: theme.textMuted }}>No thresholds configured</Text>
                </View>
              )}
              {thresholds?.map((t: ThresholdRow, i: number) => {
                const isEditing = editingId === t.id;
                return (
                  <View key={t.id}>
                    {i > 0 && <View style={{ height: 1, backgroundColor: theme.divider }} />}
                    <View style={{ flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 14, alignItems: 'center' }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: '600', color: theme.text }}>
                          {t.cylinderType?.typeName ?? `Type ${i + 1}`}
                        </Text>
                      </View>
                      {isEditing ? (
                        <>
                          <TextInput
                            value={warningInput}
                            onChangeText={(v) => setWarningInput(v.replace(/[^0-9]/g, ''))}
                            keyboardType="number-pad"
                            style={{
                              width: 64, marginHorizontal: 3, paddingHorizontal: 6, paddingVertical: 6,
                              borderWidth: 1, borderColor: '#f59e0b', borderRadius: 6,
                              textAlign: 'center', fontSize: 13, color: theme.text, backgroundColor: theme.cardBg,
                            }}
                          />
                          <TextInput
                            value={criticalInput}
                            onChangeText={(v) => setCriticalInput(v.replace(/[^0-9]/g, ''))}
                            keyboardType="number-pad"
                            style={{
                              width: 64, marginHorizontal: 3, paddingHorizontal: 6, paddingVertical: 6,
                              borderWidth: 1, borderColor: '#ef4444', borderRadius: 6,
                              textAlign: 'center', fontSize: 13, color: theme.text, backgroundColor: theme.cardBg,
                            }}
                          />
                          <View style={{ width: 60, flexDirection: 'row', justifyContent: 'flex-end', gap: 4 }}>
                            <TouchableOpacity
                              onPress={() => saveEdit(t)}
                              disabled={upsertMutation.isPending}
                              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            >
                              {upsertMutation.isPending ? (
                                <ActivityIndicator size="small" color={ACCENT} />
                              ) : (
                                <Ionicons name="checkmark" size={20} color="#10b981" />
                              )}
                            </TouchableOpacity>
                            <TouchableOpacity onPress={cancelEdit} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                              <Ionicons name="close" size={20} color={theme.textMuted} />
                            </TouchableOpacity>
                          </View>
                        </>
                      ) : (
                        <>
                          <View style={{ width: 70, alignItems: 'center' }}>
                            <View style={{ backgroundColor: '#f59e0b' + '18', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
                              <Text style={{ fontSize: 13, fontWeight: '700', color: '#f59e0b' }}>
                                {t.warningLevel}
                              </Text>
                            </View>
                          </View>
                          <View style={{ width: 70, alignItems: 'center' }}>
                            <View style={{ backgroundColor: '#ef4444' + '18', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
                              <Text style={{ fontSize: 13, fontWeight: '700', color: '#ef4444' }}>
                                {t.criticalLevel}
                              </Text>
                            </View>
                          </View>
                          <TouchableOpacity
                            onPress={() => beginEdit(t)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            style={{ width: 60, alignItems: 'flex-end' }}
                          >
                            <Ionicons name="create-outline" size={18} color={ACCENT} />
                          </TouchableOpacity>
                        </>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          </ScrollView>
        )}
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// USER MANAGEMENT MODAL
// ═══════════════════════════════════════════════════════════════════════════

function UserManagementModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useMoreTheme();
  const [showCreate, setShowCreate] = useState(false);
  // Edit-role state. When set, we render the edit modal instead of the
  // list / create sheet.
  const [editingUser, setEditingUser] = useState<UserRecord | null>(null);
  const [editRole, setEditRole] = useState('distributor_admin');

  const [formFirst, setFormFirst] = useState('');
  const [formLast, setFormLast] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formRole, setFormRole] = useState('distributor_admin');

  // Identity of the logged-in user — we must NOT let them deactivate
  // themselves (the server also blocks self-delete, but a friendly
  // client check beats a 400 and prevents the destructive Alert opening).
  const authUser = useAuthStore((s) => s.user);
  const selfUserId = authUser?.userId ?? null;

  const ROLES = ['distributor_admin', 'finance', 'inventory', 'driver', 'customer'];

  const { data: usersResponse, isLoading, isRefetching, refetch } = useApiQuery<{ users: UserRecord[] }>(
    ['users'],
    '/users',
    undefined,
    { enabled: visible },
  );
  const users: UserRecord[] = usersResponse?.users ?? [];

  // Group B Part 2 — POST /api/users now returns `{ user, tempPassword }`.
  // Mobile admin doesn't yet surface the temp password (the web Add User
  // modal does — copyable banner + WhatsApp share). For mobile, the admin
  // still has to communicate the password they typed; tempPassword is
  // captured here only to keep the type accurate, not displayed.
  const createMutation = useApiMutation<
    { user: UserRecord; tempPassword: string },
    {
      firstName: string;
      lastName: string;
      email: string;
      password: string;
      role: string;
    }
  >('post', '/users', {
    invalidateKeys: [['users']],
    successMessage: 'User created successfully',
    onSuccess: () => {
      resetForm();
      setShowCreate(false);
    },
  });

  const updateMutation = useApiMutation<UserRecord, { role: string }>(
    'put',
    () => `/users/${editingUser?.userId}`,
    {
      invalidateKeys: [['users']],
      successMessage: 'User updated',
      onSuccess: () => setEditingUser(null),
      onError: (err: unknown) => {
        Alert.alert('Could not update user', (err as Error)?.message ?? 'Unknown error');
      },
    },
  );

  const deleteMutation = useApiMutation<unknown, { userId: string }>(
    'delete',
    (vars) => `/users/${vars.userId}`,
    {
      invalidateKeys: [['users']],
      successMessage: 'User deactivated',
      onError: (err: unknown) => {
        Alert.alert('Could not deactivate user', (err as Error)?.message ?? 'Unknown error');
      },
    },
  );

  // Phase 6b (2026-06-12): bring the L3 Suspend / Reactivate web action
  // to the admin mobile app. Web added these in commit 912a68e but mobile
  // still showed only the legacy Deactivate (DELETE) button. Suspend +
  // Reactivate are softer + reversible — Suspend flips status to
  // 'suspended' so login shows a clear support message; Reactivate flips
  // back to 'active'. The DELETE button remains for permanent removal.
  const suspendMutation = useApiMutation<unknown, { userId: string }>(
    'post',
    (vars) => `/users/${vars.userId}/suspend`,
    {
      invalidateKeys: [['users']],
      successMessage: 'User suspended',
      onError: (err: unknown) => {
        Alert.alert('Could not suspend user', (err as Error)?.message ?? 'Unknown error');
      },
    },
  );

  const reactivateMutation = useApiMutation<unknown, { userId: string }>(
    'post',
    (vars) => `/users/${vars.userId}/reactivate`,
    {
      invalidateKeys: [['users']],
      successMessage: 'User reactivated',
      onError: (err: unknown) => {
        Alert.alert('Could not reactivate user', (err as Error)?.message ?? 'Unknown error');
      },
    },
  );

  const resetForm = () => {
    setFormFirst('');
    setFormLast('');
    setFormEmail('');
    setFormPassword('');
    setFormRole('distributor_admin');
  };

  const handleCreate = () => {
    if (!formFirst.trim() || !formLast.trim() || !formEmail.trim() || !formPassword.trim()) {
      Alert.alert('Validation', 'First name, last name, email, and password are required.');
      return;
    }
    createMutation.mutate({
      firstName: formFirst.trim(),
      lastName: formLast.trim(),
      email: formEmail.trim(),
      password: formPassword,
      role: formRole,
    });
  };

  const beginEdit = (u: UserRecord) => {
    setEditingUser(u);
    setEditRole(u.role || 'distributor_admin');
  };

  const handleSaveEdit = () => {
    if (!editingUser) return;
    if (!ROLES.includes(editRole) && editRole !== 'super_admin') {
      Alert.alert('Validation', 'Pick a valid role.');
      return;
    }
    updateMutation.mutate({ role: editRole });
  };

  const handleDeactivate = (u: UserRecord) => {
    if (u.userId === selfUserId) {
      Alert.alert('Not allowed', 'You cannot deactivate your own account.');
      return;
    }
    Alert.alert(
      'Deactivate user?',
      `Deactivate ${u.firstName} ${u.lastName}? They will lose access immediately. This can be undone by re-creating their account.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Deactivate',
          style: 'destructive',
          onPress: () => deleteMutation.mutate({ userId: u.userId }),
        },
      ],
    );
  };

  // Phase 6b: confirmation dialogs for the Suspend / Reactivate buttons.
  // Same self-action guard as Deactivate so an admin can't lock themselves
  // out of the app.
  const handleSuspend = (u: UserRecord) => {
    if (u.userId === selfUserId) {
      Alert.alert('Not allowed', 'You cannot suspend your own account.');
      return;
    }
    if (u.role === 'super_admin') {
      Alert.alert('Not allowed', 'Super-admin accounts cannot be suspended.');
      return;
    }
    Alert.alert(
      'Suspend user?',
      `Suspend ${u.firstName} ${u.lastName}? They will be unable to log in until you reactivate them. Their data is preserved.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Suspend',
          style: 'destructive',
          onPress: () => suspendMutation.mutate({ userId: u.userId }),
        },
      ],
    );
  };

  const handleReactivate = (u: UserRecord) => {
    Alert.alert(
      'Reactivate user?',
      `Reactivate ${u.firstName} ${u.lastName}? They will be able to log in again immediately.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reactivate',
          onPress: () => reactivateMutation.mutate({ userId: u.userId }),
        },
      ],
    );
  };

  const roleColors: Record<string, string> = {
    super_admin: '#dc2626',
    distributor_admin: '#3b82f6',
    finance: '#8b5cf6',
    inventory: '#06b6d4',
    driver: '#f59e0b',
    customer: '#10b981',
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaProvider>
      <SafeAreaView edges={['top','bottom','left','right']} style={{ flex: 1, backgroundColor: theme.bg }}>
        <ModalHeader title="User Management" onClose={onClose} theme={theme} />

        {showCreate ? (
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={{ flex: 1 }}
          >
            <ScrollView contentContainerStyle={{ padding: 20 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: theme.text, marginBottom: 16 }}>
                Add User
              </Text>
              <FormInput label="First Name *" value={formFirst} onChangeText={setFormFirst} placeholder="First name" theme={theme} />
              <FormInput label="Last Name *" value={formLast} onChangeText={setFormLast} placeholder="Last name" theme={theme} />
              <FormInput label="Email *" value={formEmail} onChangeText={setFormEmail} placeholder="Email address" keyboardType="email-address" autoCapitalize="none" theme={theme} />
              <FormInput label="Password *" value={formPassword} onChangeText={setFormPassword} placeholder="Minimum 8 characters" secureTextEntry autoCapitalize="none" theme={theme} />

              <Text style={{ fontSize: 13, fontWeight: '600', color: theme.textSecondary, marginBottom: 8 }}>
                Role
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
                {ROLES.map((r) => (
                  <TouchableOpacity
                    key={r}
                    onPress={() => setFormRole(r)}
                    style={{
                      paddingHorizontal: 14,
                      paddingVertical: 8,
                      borderRadius: 8,
                      borderWidth: 2,
                      borderColor: formRole === r ? (roleColors[r] || '#3b82f6') : theme.inputBorder,
                      backgroundColor: formRole === r ? (roleColors[r] || '#3b82f6') + '14' : theme.inputBg,
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 13,
                        fontWeight: '700',
                        color: formRole === r ? (roleColors[r] || '#3b82f6') : theme.textSecondary,
                        textTransform: 'capitalize',
                      }}
                    >
                      {r}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
                <TouchableOpacity
                  onPress={() => { resetForm(); setShowCreate(false); }}
                  style={{
                    flex: 1, paddingVertical: 14, borderRadius: 10,
                    backgroundColor: theme.cardBg, borderWidth: 1, borderColor: theme.cardBorder,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ fontSize: 15, fontWeight: '600', color: theme.textSecondary }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleCreate}
                  disabled={createMutation.isPending}
                  style={{
                    flex: 1, paddingVertical: 14, borderRadius: 10,
                    backgroundColor: ACCENT, alignItems: 'center',
                    opacity: createMutation.isPending ? 0.6 : 1,
                  }}
                >
                  {createMutation.isPending ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>Create User</Text>
                  )}
                </TouchableOpacity>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        ) : (
          <View style={{ flex: 1 }}>
            {isLoading ? (
              <Loading theme={theme} />
            ) : (
              <FlatList
                data={users || []}
                keyExtractor={(item) => item.userId}
                /* UBB C2 U5 — FAB clearance (FAB at line ~1822). */
                contentContainerStyle={{ paddingBottom: 96 }}
                renderItem={({ item }) => {
                  const isSelf = item.userId === selfUserId;
                  return (
                    <View
                      style={{
                        flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
                        paddingVertical: 14, gap: 12,
                      }}
                    >
                      <View
                        style={{
                          width: 40, height: 40, borderRadius: 20,
                          backgroundColor: (roleColors[item.role] || '#3b82f6') + '14',
                          alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <Text style={{ fontSize: 16, fontWeight: '700', color: roleColors[item.role] || '#3b82f6' }}>
                          {item.firstName?.[0]?.toUpperCase() || '?'}
                        </Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 15, fontWeight: '600', color: theme.text }}>
                          {item.firstName} {item.lastName}
                          {isSelf && <Text style={{ fontSize: 11, color: theme.textMuted }}>  (you)</Text>}
                        </Text>
                        <Text style={{ fontSize: 12, color: theme.textMuted }}>{item.email}</Text>
                      </View>
                      <StatusBadge label={item.role?.replace(/_/g, ' ')} color={roleColors[item.role] || '#3b82f6'} />
                      {/* Phase 6b: explicit Suspended badge so admins
                          spot the locked-out accounts at a glance — the
                          earlier check (status === 'active') treated
                          everything else as a generic "Inactive". */}
                      {item.status === 'suspended' && (
                        <StatusBadge label="Suspended" color="#f97316" />
                      )}
                      <TouchableOpacity
                        onPress={() => beginEdit(item)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        style={{ padding: 4 }}
                      >
                        <Ionicons name="create-outline" size={18} color={ACCENT} />
                      </TouchableOpacity>
                      {/* Phase 6b: Suspend / Reactivate toggle. The two
                          icons swap based on item.status so an admin
                          can flip the same row in either direction
                          without opening a menu. The legacy DELETE
                          (trash) button stays as the permanent-removal
                          escape hatch. */}
                      {item.status === 'suspended' ? (
                        <TouchableOpacity
                          onPress={() => handleReactivate(item)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          style={{ padding: 4 }}
                          accessibilityLabel="Reactivate user"
                        >
                          <Ionicons name="play-circle-outline" size={20} color="#16a34a" />
                        </TouchableOpacity>
                      ) : (
                        <TouchableOpacity
                          onPress={() => handleSuspend(item)}
                          disabled={isSelf || item.role === 'super_admin'}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          style={{ padding: 4, opacity: (isSelf || item.role === 'super_admin') ? 0.3 : 1 }}
                          accessibilityLabel="Suspend user"
                        >
                          <Ionicons name="pause-circle-outline" size={20} color="#f97316" />
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity
                        onPress={() => handleDeactivate(item)}
                        disabled={isSelf}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        style={{ padding: 4, opacity: isSelf ? 0.3 : 1 }}
                      >
                        <Ionicons name="trash-outline" size={18} color="#ef4444" />
                      </TouchableOpacity>
                    </View>
                  );
                }}
                ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: theme.divider }} />}
                ListEmptyComponent={<EmptyList message="No users found" theme={theme} />}
                refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={ACCENT} />}
              />
            )}
            <FAB onPress={() => setShowCreate(true)} />
          </View>
        )}

        {/* Edit User modal — role-only (the server already blocks
            email / distributor / customer changes via updateUserSchema). */}
        <Modal
          visible={!!editingUser}
          animationType="slide"
          transparent
          onRequestClose={() => setEditingUser(null)}
        >
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
            <View style={{ backgroundColor: theme.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16, maxHeight: '85%' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <Text style={{ fontSize: 17, fontWeight: '700', color: theme.text }}>Edit user</Text>
                <TouchableOpacity onPress={() => setEditingUser(null)}>
                  <Ionicons name="close" size={24} color={theme.text} />
                </TouchableOpacity>
              </View>
              {editingUser && (
                <>
                  <Text style={{ fontSize: 13, color: theme.textMuted, marginBottom: 4 }}>
                    {editingUser.firstName} {editingUser.lastName}
                  </Text>
                  <Text style={{ fontSize: 12, color: theme.textMuted, marginBottom: 16 }}>{editingUser.email}</Text>

                  <Text style={{ fontSize: 11, fontWeight: '700', color: theme.textMuted, marginBottom: 8 }}>ROLE</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
                    {ROLES.map((r) => {
                      const selected = editRole === r;
                      return (
                        <TouchableOpacity
                          key={r}
                          onPress={() => setEditRole(r)}
                          style={{
                            paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8,
                            borderWidth: 1.5,
                            borderColor: selected ? (roleColors[r] || ACCENT) : theme.inputBorder,
                            backgroundColor: selected ? (roleColors[r] || ACCENT) + '14' : theme.inputBg,
                          }}
                        >
                          <Text style={{
                            fontSize: 12, fontWeight: '700',
                            color: selected ? (roleColors[r] || ACCENT) : theme.textSecondary,
                            textTransform: 'capitalize',
                          }}>
                            {r.replace(/_/g, ' ')}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <TouchableOpacity
                    onPress={handleSaveEdit}
                    disabled={updateMutation.isPending}
                    style={{
                      backgroundColor: ACCENT, borderRadius: 10, paddingVertical: 12,
                      alignItems: 'center', marginBottom: 12,
                      opacity: updateMutation.isPending ? 0.6 : 1,
                    }}
                  >
                    {updateMutation.isPending ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>Save</Text>
                    )}
                  </TouchableOpacity>
                </>
              )}
            </View>
          </View>
        </Modal>
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SCREEN
// ═══════════════════════════════════════════════════════════════════════════

export default function AdminMoreScreen() {
  const router = useRouter();
  const theme = useMoreTheme();
  const { user, logout } = useAuthStore();
  // STAGE-A A7: dark-mode toggle wiring (matches driver/more.tsx pattern).
  const dark = useIsDark();
  const toggleMode = useThemeStore((s) => s.toggleMode);

  // Modal visibility state. STAGE-H: Customers, Fleet, and Reports are now
  // top-level tabs (app/(admin)/customers.tsx, fleet.tsx, reports.tsx), so
  // their open-modal toggles are gone. The Analytics → Overview tile is the
  // only Analytics row that still opens a modal here.
  const [showOverview, setShowOverview] = useState(false);
  const [showGst, setShowGst] = useState(false);
  const [showCylinderTypes, setShowCylinderTypes] = useState(false);
  const [showPrices, setShowPrices] = useState(false);
  const [showThresholds, setShowThresholds] = useState(false);
  const [showUsers, setShowUsers] = useState(false);

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to sign out?', [
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

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* STAGE-H: Operations section removed. Customers, Fleet, and
            Collections are first-class tabs in the bottom bar (see
            (admin)/_layout.tsx). Reports also moved to a tab — Analytics now
            only contains the Overview tile, which still belongs here because
            it's a snapshot/dashboard surface, not its own destination. */}

        {/* ── Section: Analytics ─────────────────────────────────── */}
        <SectionCard title="Analytics" theme={theme}>
          <MenuRow icon="stats-chart" label="Overview" subtitle="Key business metrics" onPress={() => setShowOverview(true)} theme={theme} />
          <Divider theme={theme} />
          {/* WI-PENDING-PAYMENTS: pending approval queue. Stack-pushed
              from here — finance/admin can review driver+customer
              self-reported payments. */}
          <MenuRow
            icon="time-outline"
            label="Pending Payment Approvals"
            subtitle="Verify or reject self-reported payments"
            onPress={() => router.push('/(admin)/pending-payments')}
            theme={theme}
          />
        </SectionCard>

        {/* ── STAGE-A A7: Appearance ──────────────────────────────── */}
        {/* Dark-mode toggle parity with (driver)/more.tsx. The themeStore
            handles persistence via SecureStore so the choice survives
            cold launches without showing a flash of the wrong theme. */}
        <SectionCard title="Appearance" theme={theme}>
          <View
            style={{
              padding: 16,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 14,
            }}
          >
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: dark ? `${ACCENT_COLORS.purple}22` : `${ACCENT_COLORS.purple}15`,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name={dark ? 'moon' : 'sunny'} size={20} color={ACCENT_COLORS.purple} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: theme.text }}>
                Dark Mode
              </Text>
              <Text style={{ fontSize: 12, color: theme.textSecondary, marginTop: 2 }}>
                {dark ? 'Dark mode' : 'Light mode'}
              </Text>
            </View>
            <Switch
              value={dark}
              onValueChange={toggleMode}
              trackColor={{ false: '#cbd5e1', true: ACCENT_COLORS.purple }}
              thumbColor="#ffffff"
            />
          </View>
        </SectionCard>

        {/* ── Section 3: Settings ──────────────────────────────────── */}
        <SectionCard title="Settings" theme={theme}>
          <MenuRow icon="document-text" label="GST" subtitle="Mode, credentials & GSP setup" onPress={() => setShowGst(true)} theme={theme} />
          <Divider theme={theme} />
          <MenuRow icon="cube" label="Cylinder Types" subtitle="Add, edit & remove cylinder types" onPress={() => setShowCylinderTypes(true)} theme={theme} />
          <Divider theme={theme} />
          <MenuRow icon="pricetag" label="Cylinder Prices" subtitle="Price list per cylinder type" onPress={() => setShowPrices(true)} theme={theme} />
          <Divider theme={theme} />
          <MenuRow icon="alert-circle" label="Thresholds" subtitle="Warning & critical levels" onPress={() => setShowThresholds(true)} theme={theme} />
          <Divider theme={theme} />
          <MenuRow icon="person-add" label="Users" subtitle="Users, roles & access" onPress={() => setShowUsers(true)} theme={theme} />
        </SectionCard>

        {/* ── Section 4: Account ───────────────────────────────────── */}
        <SectionCard title="Account" theme={theme}>
          {/* STAGE-E: Self-service profile edit (firstName/lastName/phone).
              Placed at the top of the Account section above the user card. */}
          <MenuRow
            icon="person-outline"
            label="My Profile"
            subtitle="Edit name and phone"
            onPress={() => router.push('/profile')}
            theme={theme}
          />
          <Divider theme={theme} />
          <View style={{ padding: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <View
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  backgroundColor: ACCENT + '14',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 22, fontWeight: '800', color: ACCENT }}>
                  {user?.firstName?.[0]?.toUpperCase() || 'A'}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 17, fontWeight: '700', color: theme.text }}>
                  {user?.firstName} {user?.lastName}
                </Text>
                <Text style={{ fontSize: 13, color: theme.textSecondary, marginTop: 2 }}>
                  {user?.email}
                </Text>
                <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
                  <StatusBadge
                    label={user?.role?.replace(/_/g, ' ') || 'user'}
                    color="#3b82f6"
                  />
                  {user?.distributorName && (
                    <StatusBadge label={user.distributorName} color="#8b5cf6" />
                  )}
                </View>
              </View>
            </View>
          </View>
          <Divider theme={theme} />
          <DeleteAccountButton variant="inline" />
        </SectionCard>

        {/* ── Logout ──────────────────────────────────────────────── */}
        <TouchableOpacity
          onPress={handleLogout}
          activeOpacity={0.7}
          style={{
            backgroundColor: ACCENT + '10',
            borderRadius: 14,
            borderWidth: 1,
            borderColor: ACCENT + '30',
            paddingVertical: 16,
            alignItems: 'center',
            flexDirection: 'row',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <Ionicons name="log-out-outline" size={20} color={ACCENT} />
          <Text style={{ fontSize: 16, fontWeight: '700', color: ACCENT }}>Sign Out</Text>
        </TouchableOpacity>

        {/* ── Version ─────────────────────────────────────────────── */}
        <Text
          style={{
            textAlign: 'center',
            fontSize: 11,
            color: theme.textMuted,
            marginTop: 16,
          }}
        >
          MyGasLink v1.0.0
        </Text>
      </ScrollView>

      {/* ── Remaining Modals ──────────────────────────────────────
          STAGE-H: CustomersModal / FleetModal / ReportsModal moved to
          dedicated tab screens. */}
      <AnalyticsOverviewModal visible={showOverview} onClose={() => setShowOverview(false)} />
      <GstConfigModal visible={showGst} onClose={() => setShowGst(false)} />
      <CylinderTypesModal visible={showCylinderTypes} onClose={() => setShowCylinderTypes(false)} />
      <CylinderPricesModal visible={showPrices} onClose={() => setShowPrices(false)} />
      <InventoryThresholdsModal visible={showThresholds} onClose={() => setShowThresholds(false)} />
      <UserManagementModal visible={showUsers} onClose={() => setShowUsers(false)} />
    </SafeAreaView>
  );
}
