import { useState, useCallback, useMemo, type ComponentProps } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Alert,
  StyleSheet,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { apiGet, apiPost, getErrorMessage } from '../../src/lib/api';
import { useTheme, ACCENT } from '../../src/theme';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

interface DepotHistoryMeta {
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface InventorySummary {
  cylinderTypeId: string;
  cylinderTypeName: string;
  capacity?: number;
  openingFulls: number;
  incomingFulls: number;
  deliveredQty: number;
  cancelledStockQty: number;
  manualAdjustment: number;
  closingFulls: number;
  openingEmpties: number;
  collectedEmpties: number;
  outgoingEmpties: number;
  closingEmpties: number;
  thresholdWarning: number | null;
  thresholdCritical: number | null;
  isLocked: boolean;
}

interface InventoryEvent {
  eventId: string;
  eventDate: string;
  eventType: string;
  cylinderTypeName: string;
  quantity: number;
  vehicleNumber?: string;
  driverName?: string;
  documentType?: string;
  documentNumber?: string;
  documentDate?: string;
  notes?: string;
}

interface CancelledStock {
  eventId: string;
  cylinderTypeName: string;
  quantity: number;
  driverName: string;
  vehicleNumber: string;
  status: string;
}

interface InventoryForecast {
  cylinderTypeId: string;
  cylinderTypeName: string;
  currentStock: number;
  averageDailyDemand: number;
  daysOfStockRemaining: number;
  recommendedReorderQty: number;
  forecastedDemand7Days: number;
  forecastedDemand30Days: number;
  trendDirection: 'increasing' | 'decreasing' | 'stable';
}

interface CustomerBalance {
  customerId: string;
  cylinderTypeId: string;
  customerName: string;
  cylinderTypeName: string;
  withCustomerQty: number;
  pendingReturns: number;
  missingQty: number;
  lastUpdated: string;
}

interface ReconciliationVehicle {
  vehicleId: string;
  vehicleNumber: string;
  pendingCancelledStock: number;
  pendingUndeliveredOrders: number;
}

interface OnboardingStockRow {
  cylinderTypeId: string;
  cylinderTypeName: string;
  openingFulls: number;
  openingEmpties: number;
  dateSet: string;
}

interface AdjustmentHistoryRow {
  eventId: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  bucket: 'fulls' | 'empties';
  quantity: number;
  reason: string;
  eventDate: string;
  createdAt: string;
  enteredByUserId: string;
  enteredByName: string;
}

interface AdjustmentHistoryResponse {
  data: AdjustmentHistoryRow[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

interface CylinderTypeOption {
  cylinderTypeId: string;
  typeName: string;
  emptyDepositPrice?: number | null;
  latestPrice?: number | null;
}

interface DriverOption {
  driverId: string;
  driverName: string;
}

interface CustomerOption {
  customerId: string;
  customerName: string;
}

// ─── Tab Definitions ────────────────────────────────────────────────────────

type TabKey =
  | 'summary'
  | 'history'
  | 'onboarding'
  | 'cancelled'
  | 'forecast'
  | 'balances'
  | 'reconcile';

const TABS: { key: TabKey; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'summary', label: 'Summary', icon: 'cube-outline' },
  { key: 'history', label: 'History', icon: 'time-outline' },
  { key: 'onboarding', label: 'Stock at Onboarding', icon: 'archive-outline' },
  { key: 'cancelled', label: 'Cancelled', icon: 'close-circle-outline' },
  { key: 'forecast', label: 'Forecast', icon: 'trending-up-outline' },
  { key: 'balances', label: 'Balances', icon: 'people-outline' },
  { key: 'reconcile', label: 'Reconcile', icon: 'checkmark-done-outline' },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function todayString(): string {
  return new Date().toISOString().split('T')[0];
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

// ─── Theme ──────────────────────────────────────────────────────────────────

function useInventoryTheme() {
  const { dark, colors } = useTheme();
  return {
    dark,
    bg: colors.bg,
    card: colors.cardBg,
    cardBorder: colors.cardBorder,
    text: colors.text,
    textSecondary: colors.textSecondary,
    textMuted: colors.textMuted,
    accent: ACCENT.red,
    accentBg: dark ? 'rgba(220, 38, 38, 0.15)' : '#fef2f2',
    green: ACCENT.green,
    greenBg: dark ? 'rgba(16, 185, 129, 0.15)' : '#ecfdf5',
    blue: ACCENT.blue,
    blueBg: dark ? 'rgba(59, 130, 246, 0.15)' : '#eff6ff',
    orange: ACCENT.orange,
    orangeBg: dark ? 'rgba(249, 115, 22, 0.15)' : '#fff7ed',
    red: '#ef4444',
    redBg: dark ? 'rgba(239, 68, 68, 0.15)' : '#fef2f2',
    yellow: '#eab308',
    yellowBg: dark ? 'rgba(234, 179, 8, 0.15)' : '#fefce8',
    tabActive: ACCENT.red,
    tabInactive: dark ? '#475569' : '#94a3b8',
    divider: colors.divider,
    inputBg: colors.inputBg,
    metricBg: dark ? '#0f172a' : '#f1f5f9',
  };
}

// ─── Main Screen ────────────────────────────────────────────────────────────

export default function AdminInventoryScreen() {
  const t = useInventoryTheme();
  const [activeTab, setActiveTab] = useState<TabKey>('summary');
  const [selectedDate, setSelectedDate] = useState(todayString());

  // History date range
  const [historyDateFrom, setHistoryDateFrom] = useState(() => addDays(todayString(), -30));
  const [historyDateTo, setHistoryDateTo] = useState(todayString());

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: t.bg }}>
      {/* Header */}
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>
        <Text style={{ fontSize: 22, fontWeight: '800', color: t.text }}>Inventory</Text>
        <Text style={{ fontSize: 13, color: t.textSecondary, marginTop: 2 }}>
          Track cylinder stock levels
        </Text>
      </View>

      {/* Tab Bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, borderBottomWidth: 1, borderBottomColor: t.divider }}
        contentContainerStyle={{ paddingHorizontal: 12, gap: 4 }}
      >
        {TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              onPress={() => setActiveTab(tab.key)}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 10,
                borderBottomWidth: 2,
                borderBottomColor: isActive ? t.tabActive : 'transparent',
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Ionicons
                  name={tab.icon}
                  size={15}
                  color={isActive ? t.tabActive : t.tabInactive}
                />
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: isActive ? '700' : '500',
                    color: isActive ? t.tabActive : t.tabInactive,
                  }}
                >
                  {tab.label}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Tab Content */}
      {activeTab === 'summary' && (
        <SummaryTab selectedDate={selectedDate} setSelectedDate={setSelectedDate} />
      )}
      {activeTab === 'history' && (
        <HistoryTab
          dateFrom={historyDateFrom}
          dateTo={historyDateTo}
          setDateFrom={setHistoryDateFrom}
          setDateTo={setHistoryDateTo}
        />
      )}
      {activeTab === 'onboarding' && <OnboardingStockTab />}
      {activeTab === 'cancelled' && <CancelledTab selectedDate={selectedDate} />}
      {activeTab === 'forecast' && <ForecastTab />}
      {activeTab === 'balances' && <BalancesTab />}
      {activeTab === 'reconcile' && <ReconcileTab />}
    </SafeAreaView>
  );
}

// ─── SUMMARY TAB ────────────────────────────────────────────────────────────

type StockModalType = 'incoming' | 'outgoing' | 'adjust' | null;

interface StockMovementForm {
  cylinderTypeId: string;
  quantity: string;
  documentType: string;
  documentNumber: string;
  documentDate: string;
  vehicleNumber: string;
  driverName: string;
  notes: string;
}

interface AdjustForm {
  cylinderTypeId: string;
  adjustmentType: 'add' | 'subtract';
  quantity: string;
  reason: string;
  adjustmentDate: string;
}

function emptyMovementForm(defaultDate: string): StockMovementForm {
  return {
    cylinderTypeId: '',
    quantity: '',
    documentType: '',
    documentNumber: '',
    documentDate: defaultDate,
    vehicleNumber: '',
    driverName: '',
    notes: '',
  };
}

function emptyAdjustForm(defaultDate: string): AdjustForm {
  return {
    cylinderTypeId: '',
    adjustmentType: 'add',
    quantity: '',
    reason: '',
    adjustmentDate: defaultDate,
  };
}

function SummaryTab({
  selectedDate,
  setSelectedDate,
}: {
  selectedDate: string;
  setSelectedDate: (d: string) => void;
}) {
  const t = useInventoryTheme();
  const isToday = selectedDate === todayString();

  const {
    data: inventory,
    isLoading,
    refetch,
  } = useApiQuery<InventorySummary[]>(
    ['inventory', selectedDate],
    `/inventory/summary/${selectedDate}`,
  );

  const lockMutation = useApiMutation<unknown, { date: string }>('put', '/inventory/lock-summary', {
    invalidateKeys: [['inventory', selectedDate]],
    successMessage: 'Day locked successfully',
  });

  const unlockMutation = useApiMutation<unknown, { date: string }>('post', '/inventory/unlock', {
    invalidateKeys: [['inventory', selectedDate]],
    successMessage: 'Day unlocked successfully',
  });

  const isLocked = inventory?.[0]?.isLocked ?? false;

  // ── Modal state ────────────────────────────────────────────────────────────
  const [activeModal, setActiveModal] = useState<StockModalType>(null);
  const [adjustTab, setAdjustTab] = useState<'new' | 'history'>('new');
  const [movementForm, setMovementForm] = useState<StockMovementForm>(() =>
    emptyMovementForm(selectedDate),
  );
  const [adjustForm, setAdjustForm] = useState<AdjustForm>(() => emptyAdjustForm(selectedDate));

  // Cylinder type options derived from loaded inventory
  const cylinderOptions = useMemo(
    () => (inventory ?? []).map((i) => ({ id: i.cylinderTypeId, name: i.cylinderTypeName })),
    [inventory],
  );

  // ── Mutations ──────────────────────────────────────────────────────────────
  const incomingMutation = useApiMutation<
    unknown,
    {
      cylinderTypeId: string;
      quantity: number;
      documentType: string;
      documentNumber: string;
      documentDate: string;
      vehicleNumber?: string;
      driverName?: string;
      notes?: string;
    }
  >('post', '/inventory/incoming-fulls', {
    invalidateKeys: [['inventory', selectedDate]],
    successMessage: 'Incoming fulls recorded',
    onSuccess: () => {
      setActiveModal(null);
      setMovementForm(emptyMovementForm(selectedDate));
    },
  });

  const outgoingMutation = useApiMutation<
    unknown,
    {
      cylinderTypeId: string;
      quantity: number;
      documentType: string;
      documentNumber: string;
      documentDate: string;
      vehicleNumber?: string;
      driverName?: string;
      notes?: string;
    }
  >('post', '/inventory/outgoing-empties', {
    invalidateKeys: [['inventory', selectedDate]],
    successMessage: 'Outgoing empties recorded',
    onSuccess: () => {
      setActiveModal(null);
      setMovementForm(emptyMovementForm(selectedDate));
    },
  });

  const adjustMutation = useApiMutation<
    unknown,
    {
      cylinderTypeId: string;
      adjustmentType: 'add' | 'subtract';
      quantity: number;
      reason: string;
      adjustmentDate: string;
    }
  >('post', '/inventory/manual-adjustment', {
    invalidateKeys: [['inventory', selectedDate]],
    successMessage: 'Stock adjustment saved',
    onSuccess: () => {
      setActiveModal(null);
      setAdjustForm(emptyAdjustForm(selectedDate));
    },
  });

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleLockToggle = () => {
    if (isLocked) {
      Alert.alert('Unlock Day', `Unlock inventory for ${formatDate(selectedDate)}?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Unlock', onPress: () => unlockMutation.mutate({ date: selectedDate }) },
      ]);
    } else {
      Alert.alert(
        'Lock Day',
        `Lock inventory for ${selectedDate}? All summaries for this day will be frozen and can only be changed after an admin unlocks the day.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Lock',
            style: 'destructive',
            onPress: () => lockMutation.mutate({ date: selectedDate }),
          },
        ],
      );
    }
  };

  const openModal = (type: StockModalType) => {
    if (isLocked) {
      Alert.alert(
        'Day is locked',
        'Day is locked — unlock first to make adjustments.',
      );
      return;
    }
    if (type === 'adjust') {
      setAdjustForm(emptyAdjustForm(selectedDate));
      setAdjustTab('new');
    } else {
      setMovementForm(emptyMovementForm(selectedDate));
    }
    setActiveModal(type);
  };

  const handleMovementSubmit = () => {
    const qty = parseInt(movementForm.quantity, 10);
    if (!movementForm.cylinderTypeId) {
      Alert.alert('Required', 'Please select a cylinder type.');
      return;
    }
    if (isNaN(qty) || qty <= 0) {
      Alert.alert('Required', 'Quantity must be a whole number greater than 0.');
      return;
    }
    if (!movementForm.documentType.trim()) {
      Alert.alert('Required', 'Document Type is required.');
      return;
    }
    if (!movementForm.documentNumber.trim()) {
      Alert.alert('Required', 'Document Number is required.');
      return;
    }

    const payload = {
      cylinderTypeId: movementForm.cylinderTypeId,
      quantity: qty,
      documentType: movementForm.documentType.trim(),
      documentNumber: movementForm.documentNumber.trim(),
      documentDate: movementForm.documentDate,
      ...(movementForm.vehicleNumber.trim() ? { vehicleNumber: movementForm.vehicleNumber.trim() } : {}),
      ...(movementForm.driverName.trim() ? { driverName: movementForm.driverName.trim() } : {}),
      ...(movementForm.notes.trim() ? { notes: movementForm.notes.trim() } : {}),
    };

    if (activeModal === 'incoming') {
      incomingMutation.mutate(payload);
    } else {
      outgoingMutation.mutate(payload);
    }
  };

  const handleAdjustSubmit = () => {
    const qty = parseInt(adjustForm.quantity, 10);
    if (!adjustForm.cylinderTypeId) {
      Alert.alert('Required', 'Please select a cylinder type.');
      return;
    }
    if (isNaN(qty) || qty <= 0) {
      Alert.alert('Required', 'Quantity must be a whole number greater than 0.');
      return;
    }
    if (!adjustForm.reason.trim()) {
      Alert.alert('Required', 'Reason is required.');
      return;
    }

    adjustMutation.mutate({
      cylinderTypeId: adjustForm.cylinderTypeId,
      adjustmentType: adjustForm.adjustmentType,
      quantity: qty,
      reason: adjustForm.reason.trim(),
      adjustmentDate: adjustForm.adjustmentDate,
    });
  };

  const isMovementPending = incomingMutation.isPending || outgoingMutation.isPending;

  return (
    <>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 12 }}
        refreshControl={
          <RefreshControl refreshing={isLoading} onRefresh={refetch} tintColor={t.accent} />
        }
      >
        {/* ── Action Buttons Row ─────────────────────────────────────── */}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity
            onPress={() => openModal('incoming')}
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              backgroundColor: t.greenBg,
              borderRadius: 10,
              paddingVertical: 10,
              borderWidth: 1,
              borderColor: t.green + '40',
            }}
          >
            <Ionicons name="arrow-down-circle-outline" size={16} color={t.green} />
            <Text style={{ fontSize: 12, fontWeight: '700', color: t.green }}>Incoming Fulls</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => openModal('outgoing')}
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              backgroundColor: t.orangeBg,
              borderRadius: 10,
              paddingVertical: 10,
              borderWidth: 1,
              borderColor: t.orange + '40',
            }}
          >
            <Ionicons name="arrow-up-circle-outline" size={16} color={t.orange} />
            <Text style={{ fontSize: 12, fontWeight: '700', color: t.orange }}>Outgoing Empties</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => openModal('adjust')}
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              backgroundColor: t.blueBg,
              borderRadius: 10,
              paddingVertical: 10,
              borderWidth: 1,
              borderColor: t.blue + '40',
            }}
          >
            <Ionicons name="create-outline" size={16} color={t.blue} />
            <Text style={{ fontSize: 12, fontWeight: '700', color: t.blue }}>Adjust Stock</Text>
          </TouchableOpacity>
        </View>

        {/* Date Navigation */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: t.card,
            borderRadius: 12,
            padding: 12,
            borderWidth: 1,
            borderColor: t.cardBorder,
          }}
        >
          <TouchableOpacity
            onPress={() => setSelectedDate(addDays(selectedDate, -1))}
            style={{ padding: 6, borderRadius: 8, backgroundColor: t.metricBg }}
          >
            <Ionicons name="chevron-back" size={20} color={t.text} />
          </TouchableOpacity>

          <View style={{ alignItems: 'center', flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: t.text }}>
              {formatDate(selectedDate)}
            </Text>
            {isToday && (
              <Text style={{ fontSize: 11, color: t.green, fontWeight: '600', marginTop: 1 }}>
                Today
              </Text>
            )}
          </View>

          <TouchableOpacity
            onPress={() => setSelectedDate(addDays(selectedDate, 1))}
            style={{ padding: 6, borderRadius: 8, backgroundColor: t.metricBg }}
          >
            <Ionicons name="chevron-forward" size={20} color={t.text} />
          </TouchableOpacity>

          {!isToday && (
            <TouchableOpacity
              onPress={() => setSelectedDate(todayString())}
              style={{
                marginLeft: 8,
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 8,
                backgroundColor: t.accentBg,
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: '700', color: t.accent }}>Today</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            onPress={handleLockToggle}
            disabled={lockMutation.isPending || unlockMutation.isPending}
            style={{
              marginLeft: 8,
              padding: 6,
              borderRadius: 8,
              backgroundColor: isLocked ? t.greenBg : t.metricBg,
            }}
          >
            <Ionicons
              name={isLocked ? 'lock-closed' : 'lock-open-outline'}
              size={18}
              color={isLocked ? t.green : t.textSecondary}
            />
          </TouchableOpacity>
        </View>

        {/* Loading State */}
        {isLoading && (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <ActivityIndicator size="large" color={t.accent} />
          </View>
        )}

        {/* Empty State */}
        {!isLoading && (!inventory || inventory.length === 0) && (
          <EmptyCard
            icon="cube-outline"
            title="No inventory data"
            subtitle="No records for this date"
          />
        )}

        {/* Cylinder Cards */}
        {!isLoading &&
          inventory?.map((item) => {
            const isWarning =
              item.thresholdWarning !== null && item.closingFulls <= (item.thresholdWarning ?? 0);
            const isCritical =
              item.thresholdCritical !== null &&
              item.closingFulls <= (item.thresholdCritical ?? 0);

            return (
              <View
                key={item.cylinderTypeId}
                style={{
                  backgroundColor: t.card,
                  borderRadius: 12,
                  padding: 16,
                  borderWidth: isCritical ? 2 : isWarning ? 2 : 1,
                  borderColor: isCritical
                    ? 'rgba(239, 68, 68, 0.5)'
                    : isWarning
                      ? 'rgba(249, 115, 22, 0.5)'
                      : t.cardBorder,
                }}
              >
                {/* Header */}
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 12,
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                    <Text style={{ fontSize: 16, fontWeight: '700', color: t.text }}>
                      {item.cylinderTypeName}
                    </Text>
                    {item.capacity && (
                      <View
                        style={{
                          backgroundColor: t.blueBg,
                          paddingHorizontal: 8,
                          paddingVertical: 2,
                          borderRadius: 10,
                        }}
                      >
                        <Text style={{ fontSize: 11, fontWeight: '600', color: t.blue }}>
                          {item.capacity}kg
                        </Text>
                      </View>
                    )}
                  </View>
                  <View style={{ flexDirection: 'row', gap: 4 }}>
                    {isCritical && <StatusBadge label="Critical" color={t.red} bg={t.redBg} />}
                    {isWarning && !isCritical && (
                      <StatusBadge label="Warning" color={t.orange} bg={t.orangeBg} />
                    )}
                    {item.isLocked && (
                      <StatusBadge label="Locked" color={t.green} bg={t.greenBg} />
                    )}
                  </View>
                </View>

                {/* 2-Column Flow Metrics */}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                  <MetricCell
                    label="Opening Fulls"
                    value={item.openingFulls}
                    bg={t.metricBg}
                    color={t.text}
                  />
                  <MetricCell
                    label="Incoming"
                    value={item.incomingFulls}
                    prefix="+"
                    bg={t.greenBg}
                    color={t.green}
                  />
                  <MetricCell
                    label="Delivered"
                    value={item.deliveredQty}
                    prefix="-"
                    bg={t.blueBg}
                    color={t.blue}
                  />
                  <MetricCell
                    label="Cancelled"
                    value={item.cancelledStockQty}
                    bg={t.orangeBg}
                    color={t.orange}
                  />
                  <MetricCell
                    label="Outgoing Empties"
                    value={item.outgoingEmpties}
                    bg={t.metricBg}
                    color={t.text}
                  />
                  <MetricCell
                    label="Collected Empties"
                    value={item.collectedEmpties}
                    bg={t.metricBg}
                    color={t.text}
                  />
                </View>

                {/* Closing row */}
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    borderTopWidth: 1,
                    borderTopColor: t.divider,
                    paddingTop: 12,
                  }}
                >
                  <View>
                    <Text style={{ fontSize: 11, color: t.textSecondary }}>Closing Fulls</Text>
                    <Text
                      style={{
                        fontSize: 22,
                        fontWeight: '800',
                        color: isCritical ? t.red : t.text,
                      }}
                    >
                      {item.closingFulls}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ fontSize: 11, color: t.textSecondary }}>Closing Empties</Text>
                    <Text style={{ fontSize: 22, fontWeight: '800', color: t.text }}>
                      {item.closingEmpties}
                    </Text>
                  </View>
                </View>
              </View>
            );
          })}
      </ScrollView>

      {/* ── Incoming Fulls / Outgoing Empties Modal ───────────────────────── */}
      <Modal
        visible={activeModal === 'incoming' || activeModal === 'outgoing'}
        animationType="slide"
        transparent
        onRequestClose={() => setActiveModal(null)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1, justifyContent: 'flex-end' }}
        >
          <View
            style={{
              backgroundColor: t.card,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              padding: 20,
              maxHeight: '90%',
            }}
          >
            {/* Modal Header */}
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 16,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons
                  name={
                    activeModal === 'incoming'
                      ? 'arrow-down-circle-outline'
                      : 'arrow-up-circle-outline'
                  }
                  size={22}
                  color={activeModal === 'incoming' ? t.green : t.orange}
                />
                <Text style={{ fontSize: 17, fontWeight: '800', color: t.text }}>
                  {activeModal === 'incoming' ? '+ Incoming Fulls' : '+ Outgoing Empties'}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setActiveModal(null)} style={{ padding: 4 }}>
                <Ionicons name="close" size={22} color={t.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {/* Cylinder Type Picker */}
              <Text style={[modalStyles.label, { color: t.textSecondary }]}>
                Cylinder Type <Text style={{ color: t.red }}>*</Text>
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ marginBottom: 14 }}
                contentContainerStyle={{ gap: 8, paddingVertical: 4 }}
              >
                {cylinderOptions.map((opt) => {
                  const selected = movementForm.cylinderTypeId === opt.id;
                  const chipColor = activeModal === 'incoming' ? t.green : t.orange;
                  return (
                    <TouchableOpacity
                      key={opt.id}
                      onPress={() =>
                        setMovementForm((f) => ({ ...f, cylinderTypeId: opt.id }))
                      }
                      style={{
                        paddingHorizontal: 14,
                        paddingVertical: 8,
                        borderRadius: 20,
                        backgroundColor: selected ? chipColor : t.metricBg,
                        borderWidth: 1,
                        borderColor: selected ? chipColor : t.cardBorder,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 13,
                          fontWeight: '600',
                          color: selected ? '#fff' : t.text,
                        }}
                      >
                        {opt.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
                {cylinderOptions.length === 0 && (
                  <Text style={{ fontSize: 13, color: t.textMuted, paddingVertical: 8 }}>
                    Load summary first
                  </Text>
                )}
              </ScrollView>

              {/* Quantity */}
              <Text style={[modalStyles.label, { color: t.textSecondary }]}>
                Quantity <Text style={{ color: t.red }}>*</Text>
              </Text>
              <TextInput
                style={[
                  modalStyles.input,
                  { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder },
                ]}
                placeholder="e.g. 50"
                placeholderTextColor={t.textMuted}
                keyboardType="number-pad"
                value={movementForm.quantity}
                onChangeText={(v) => setMovementForm((f) => ({ ...f, quantity: v }))}
              />

              {/* Date */}
              <Text style={[modalStyles.label, { color: t.textSecondary }]}>Date (YYYY-MM-DD)</Text>
              <TextInput
                style={[
                  modalStyles.input,
                  { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder },
                ]}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={t.textMuted}
                value={movementForm.documentDate}
                onChangeText={(v) => setMovementForm((f) => ({ ...f, documentDate: v }))}
              />

              {/* Document Type */}
              <Text style={[modalStyles.label, { color: t.textSecondary }]}>
                Document Type <Text style={{ color: t.red }}>*</Text>
              </Text>
              <TextInput
                style={[
                  modalStyles.input,
                  { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder },
                ]}
                placeholder="e.g. Invoice, DC"
                placeholderTextColor={t.textMuted}
                value={movementForm.documentType}
                onChangeText={(v) => setMovementForm((f) => ({ ...f, documentType: v }))}
              />

              {/* Document Number */}
              <Text style={[modalStyles.label, { color: t.textSecondary }]}>
                Document Number <Text style={{ color: t.red }}>*</Text>
              </Text>
              <TextInput
                style={[
                  modalStyles.input,
                  { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder },
                ]}
                placeholder="e.g. INV-2026-001"
                placeholderTextColor={t.textMuted}
                value={movementForm.documentNumber}
                onChangeText={(v) => setMovementForm((f) => ({ ...f, documentNumber: v }))}
              />

              {/* Vehicle Number (optional) */}
              <Text style={[modalStyles.label, { color: t.textSecondary }]}>
                Vehicle Number{' '}
                <Text style={{ fontSize: 11, color: t.textMuted }}>(optional)</Text>
              </Text>
              <TextInput
                style={[
                  modalStyles.input,
                  { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder },
                ]}
                placeholder="e.g. AP09AB1234"
                placeholderTextColor={t.textMuted}
                value={movementForm.vehicleNumber}
                onChangeText={(v) => setMovementForm((f) => ({ ...f, vehicleNumber: v }))}
              />

              {/* Driver Name (optional) */}
              <Text style={[modalStyles.label, { color: t.textSecondary }]}>
                Driver Name{' '}
                <Text style={{ fontSize: 11, color: t.textMuted }}>(optional)</Text>
              </Text>
              <TextInput
                style={[
                  modalStyles.input,
                  { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder },
                ]}
                placeholder="Driver name"
                placeholderTextColor={t.textMuted}
                value={movementForm.driverName}
                onChangeText={(v) => setMovementForm((f) => ({ ...f, driverName: v }))}
              />

              {/* Notes (optional) */}
              <Text style={[modalStyles.label, { color: t.textSecondary }]}>
                Notes <Text style={{ fontSize: 11, color: t.textMuted }}>(optional)</Text>
              </Text>
              <TextInput
                style={[
                  modalStyles.input,
                  modalStyles.textarea,
                  { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder },
                ]}
                placeholder="Additional notes..."
                placeholderTextColor={t.textMuted}
                multiline
                numberOfLines={3}
                value={movementForm.notes}
                onChangeText={(v) => setMovementForm((f) => ({ ...f, notes: v }))}
              />

              {/* Submit */}
              <TouchableOpacity
                onPress={handleMovementSubmit}
                disabled={isMovementPending}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  backgroundColor:
                    activeModal === 'incoming' ? t.green : t.orange,
                  borderRadius: 12,
                  paddingVertical: 14,
                  marginTop: 8,
                  marginBottom: 8,
                  opacity: isMovementPending ? 0.6 : 1,
                }}
              >
                {isMovementPending ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons
                    name={
                      activeModal === 'incoming'
                        ? 'arrow-down-circle-outline'
                        : 'arrow-up-circle-outline'
                    }
                    size={18}
                    color="#fff"
                  />
                )}
                <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>
                  {isMovementPending
                    ? 'Saving...'
                    : activeModal === 'incoming'
                      ? 'Record Incoming Fulls'
                      : 'Record Outgoing Empties'}
                </Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Adjust Stock Modal ─────────────────────────────────────────────── */}
      <Modal
        visible={activeModal === 'adjust'}
        animationType="slide"
        transparent
        onRequestClose={() => setActiveModal(null)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1, justifyContent: 'flex-end' }}
        >
          <View
            style={{
              backgroundColor: t.card,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              padding: 20,
              maxHeight: '85%',
            }}
          >
            {/* Modal Header */}
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 12,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="create-outline" size={22} color={t.blue} />
                <Text style={{ fontSize: 17, fontWeight: '800', color: t.text }}>
                  Adjust Stock
                </Text>
              </View>
              <TouchableOpacity onPress={() => setActiveModal(null)} style={{ padding: 4 }}>
                <Ionicons name="close" size={22} color={t.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* New / History sub-tabs */}
            <View
              style={{
                flexDirection: 'row',
                borderBottomWidth: 1,
                borderBottomColor: t.divider,
                marginBottom: 14,
              }}
            >
              {(['new', 'history'] as const).map((key) => {
                const isActive = adjustTab === key;
                return (
                  <TouchableOpacity
                    key={key}
                    onPress={() => setAdjustTab(key)}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      borderBottomWidth: 2,
                      borderBottomColor: isActive ? t.blue : 'transparent',
                      marginRight: 8,
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 13,
                        fontWeight: isActive ? '700' : '500',
                        color: isActive ? t.blue : t.textSecondary,
                      }}
                    >
                      {key === 'new' ? 'New Adjustment' : 'Adjustment History'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {adjustTab === 'history' ? (
              <AdjustmentHistoryPanel
                cylinderOptions={cylinderOptions}
                onClose={() => setActiveModal(null)}
              />
            ) : (
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {/* Cylinder Type Picker */}
              <Text style={[modalStyles.label, { color: t.textSecondary }]}>
                Cylinder Type <Text style={{ color: t.red }}>*</Text>
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ marginBottom: 14 }}
                contentContainerStyle={{ gap: 8, paddingVertical: 4 }}
              >
                {cylinderOptions.map((opt) => {
                  const selected = adjustForm.cylinderTypeId === opt.id;
                  return (
                    <TouchableOpacity
                      key={opt.id}
                      onPress={() =>
                        setAdjustForm((f) => ({ ...f, cylinderTypeId: opt.id }))
                      }
                      style={{
                        paddingHorizontal: 14,
                        paddingVertical: 8,
                        borderRadius: 20,
                        backgroundColor: selected ? t.blue : t.metricBg,
                        borderWidth: 1,
                        borderColor: selected ? t.blue : t.cardBorder,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 13,
                          fontWeight: '600',
                          color: selected ? '#fff' : t.text,
                        }}
                      >
                        {opt.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
                {cylinderOptions.length === 0 && (
                  <Text style={{ fontSize: 13, color: t.textMuted, paddingVertical: 8 }}>
                    Load summary first
                  </Text>
                )}
              </ScrollView>

              {/* Adjustment Type Toggle */}
              <Text style={[modalStyles.label, { color: t.textSecondary }]}>
                Adjustment Type <Text style={{ color: t.red }}>*</Text>
              </Text>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                {(['add', 'subtract'] as const).map((type) => {
                  const isSelected = adjustForm.adjustmentType === type;
                  const color = type === 'add' ? t.green : t.red;
                  return (
                    <TouchableOpacity
                      key={type}
                      onPress={() => setAdjustForm((f) => ({ ...f, adjustmentType: type }))}
                      style={{
                        flex: 1,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                        paddingVertical: 10,
                        borderRadius: 10,
                        backgroundColor: isSelected ? color : t.metricBg,
                        borderWidth: 1,
                        borderColor: isSelected ? color : t.cardBorder,
                      }}
                    >
                      <Ionicons
                        name={type === 'add' ? 'add-circle-outline' : 'remove-circle-outline'}
                        size={16}
                        color={isSelected ? '#fff' : color}
                      />
                      <Text
                        style={{
                          fontSize: 13,
                          fontWeight: '700',
                          color: isSelected ? '#fff' : color,
                          textTransform: 'capitalize',
                        }}
                      >
                        {type}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Quantity */}
              <Text style={[modalStyles.label, { color: t.textSecondary }]}>
                Quantity <Text style={{ color: t.red }}>*</Text>
              </Text>
              <TextInput
                style={[
                  modalStyles.input,
                  { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder },
                ]}
                placeholder="e.g. 10"
                placeholderTextColor={t.textMuted}
                keyboardType="number-pad"
                value={adjustForm.quantity}
                onChangeText={(v) => setAdjustForm((f) => ({ ...f, quantity: v }))}
              />

              {/* Adjustment Date */}
              <Text style={[modalStyles.label, { color: t.textSecondary }]}>
                Adjustment Date (YYYY-MM-DD)
              </Text>
              <TextInput
                style={[
                  modalStyles.input,
                  { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder },
                ]}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={t.textMuted}
                value={adjustForm.adjustmentDate}
                onChangeText={(v) => setAdjustForm((f) => ({ ...f, adjustmentDate: v }))}
              />

              {/* Reason */}
              <Text style={[modalStyles.label, { color: t.textSecondary }]}>
                Reason <Text style={{ color: t.red }}>*</Text>
              </Text>
              <TextInput
                style={[
                  modalStyles.input,
                  modalStyles.textarea,
                  { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder },
                ]}
                placeholder="Reason for adjustment..."
                placeholderTextColor={t.textMuted}
                multiline
                numberOfLines={3}
                value={adjustForm.reason}
                onChangeText={(v) => setAdjustForm((f) => ({ ...f, reason: v }))}
              />

              {/* Submit */}
              <TouchableOpacity
                onPress={handleAdjustSubmit}
                disabled={adjustMutation.isPending}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  backgroundColor: t.blue,
                  borderRadius: 12,
                  paddingVertical: 14,
                  marginTop: 8,
                  marginBottom: 8,
                  opacity: adjustMutation.isPending ? 0.6 : 1,
                }}
              >
                {adjustMutation.isPending ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons name="create-outline" size={18} color="#fff" />
                )}
                <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>
                  {adjustMutation.isPending ? 'Saving...' : 'Save Adjustment'}
                </Text>
              </TouchableOpacity>
            </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

// ─── Modal Styles ────────────────────────────────────────────────────────────

const modalStyles = StyleSheet.create({
  label: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 14,
  },
  textarea: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
});

// ─── ADJUSTMENT HISTORY PANEL (inside Adjust Stock modal) ───────────────────

function AdjustmentHistoryPanel({
  cylinderOptions,
  onClose,
}: {
  cylinderOptions: { id: string; name: string }[];
  onClose: () => void;
}) {
  const t = useInventoryTheme();
  const [page, setPage] = useState(1);
  const [bucketFilter, setBucketFilter] = useState<'all' | 'fulls' | 'empties'>('all');
  const [cylinderTypeId, setCylinderTypeId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [downloading, setDownloading] = useState(false);

  const PAGE_SIZE = 50;

  const queryParams: Record<string, unknown> = { page, pageSize: PAGE_SIZE };
  if (bucketFilter !== 'all') queryParams.bucket = bucketFilter;
  if (cylinderTypeId) queryParams.cylinderTypeId = cylinderTypeId;
  if (dateFrom) queryParams.dateFrom = dateFrom;
  if (dateTo) queryParams.dateTo = dateTo;

  const { data, isLoading } = useApiQuery<AdjustmentHistoryResponse>(
    ['manual-adjustments', String(page), bucketFilter, cylinderTypeId, dateFrom, dateTo],
    '/inventory/manual-adjustments',
    queryParams,
  );

  const rows = useMemo<AdjustmentHistoryRow[]>(() => data?.data ?? [], [data]);
  const meta = data?.meta;

  const handleDownloadCsv = useCallback(async () => {
    if (rows.length === 0) return;
    setDownloading(true);
    try {
      // Build CSV client-side from the in-memory rows — matches the web's
      // downloadCsv intent (same field set, same export name pattern). On
      // mobile we avoid a Blob round-trip by serialising what we already
      // have in memory.
      const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
      const header = ['Date', 'Cylinder Type', 'Bucket', 'Quantity', 'Reason', 'Entered By'];
      const lines = rows.map((r) =>
        [
          r.eventDate.slice(0, 10),
          r.cylinderTypeName,
          r.bucket,
          String(r.quantity),
          r.reason ?? '',
          r.enteredByName ?? '',
        ]
          .map(escape)
          .join(','),
      );
      const csv = [header.join(','), ...lines].join('\n');
      const fileName = `adjustment-history-${todayString()}.csv`;
      const file = new File(Paths.cache, fileName);
      try {
        file.create();
      } catch {
        /* already exists */
      }
      file.write(csv);
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'This device does not support sharing.');
        return;
      }
      await Sharing.shareAsync(file.uri, {
        mimeType: 'text/csv',
        dialogTitle: 'Adjustment History',
        UTI: 'public.comma-separated-values-text',
      });
    } catch (err) {
      Alert.alert('Could not export CSV', getErrorMessage(err));
    } finally {
      setDownloading(false);
    }
  }, [rows]);

  return (
    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      {/* Filters */}
      <Text style={[modalStyles.label, { color: t.textSecondary }]}>Bucket</Text>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
        {(['all', 'fulls', 'empties'] as const).map((b) => {
          const selected = bucketFilter === b;
          return (
            <TouchableOpacity
              key={b}
              onPress={() => {
                setBucketFilter(b);
                setPage(1);
              }}
              style={{
                flex: 1,
                paddingVertical: 8,
                borderRadius: 8,
                backgroundColor: selected ? t.blue : t.metricBg,
                borderWidth: 1,
                borderColor: selected ? t.blue : t.cardBorder,
                alignItems: 'center',
              }}
            >
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: '700',
                  color: selected ? '#fff' : t.text,
                  textTransform: 'capitalize',
                }}
              >
                {b}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <Text style={[modalStyles.label, { color: t.textSecondary }]}>Cylinder Type</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginBottom: 14 }}
        contentContainerStyle={{ gap: 8, paddingVertical: 4 }}
      >
        <TouchableOpacity
          onPress={() => {
            setCylinderTypeId('');
            setPage(1);
          }}
          style={{
            paddingHorizontal: 14,
            paddingVertical: 8,
            borderRadius: 20,
            backgroundColor: cylinderTypeId === '' ? t.blue : t.metricBg,
            borderWidth: 1,
            borderColor: cylinderTypeId === '' ? t.blue : t.cardBorder,
          }}
        >
          <Text
            style={{
              fontSize: 13,
              fontWeight: '600',
              color: cylinderTypeId === '' ? '#fff' : t.text,
            }}
          >
            All
          </Text>
        </TouchableOpacity>
        {cylinderOptions.map((opt) => {
          const selected = cylinderTypeId === opt.id;
          return (
            <TouchableOpacity
              key={opt.id}
              onPress={() => {
                setCylinderTypeId(opt.id);
                setPage(1);
              }}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: 20,
                backgroundColor: selected ? t.blue : t.metricBg,
                borderWidth: 1,
                borderColor: selected ? t.blue : t.cardBorder,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: '600', color: selected ? '#fff' : t.text }}>
                {opt.name}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
        <View style={{ flex: 1 }}>
          <Text style={[modalStyles.label, { color: t.textSecondary }]}>From (YYYY-MM-DD)</Text>
          <TextInput
            style={[
              modalStyles.input,
              { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder, marginBottom: 0 },
            ]}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={t.textMuted}
            value={dateFrom}
            onChangeText={(v) => {
              setDateFrom(v);
              setPage(1);
            }}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[modalStyles.label, { color: t.textSecondary }]}>To (YYYY-MM-DD)</Text>
          <TextInput
            style={[
              modalStyles.input,
              { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder, marginBottom: 0 },
            ]}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={t.textMuted}
            value={dateTo}
            onChangeText={(v) => {
              setDateTo(v);
              setPage(1);
            }}
          />
        </View>
      </View>

      {/* Rows */}
      {isLoading ? (
        <View style={{ paddingVertical: 30, alignItems: 'center' }}>
          <ActivityIndicator size="small" color={t.accent} />
        </View>
      ) : rows.length === 0 ? (
        <View style={{ paddingVertical: 30, alignItems: 'center' }}>
          <Text style={{ fontSize: 13, color: t.textMuted }}>
            No adjustments match these filters.
          </Text>
        </View>
      ) : (
        <View style={{ gap: 8, marginBottom: 12 }}>
          {rows.map((r) => {
            const isAdd = r.quantity >= 0;
            return (
              <View
                key={r.eventId}
                style={{
                  backgroundColor: t.metricBg,
                  borderRadius: 10,
                  padding: 12,
                  borderWidth: 1,
                  borderColor: t.cardBorder,
                }}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 6,
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: '700', color: t.text }}>
                    {r.cylinderTypeName}
                  </Text>
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: '700',
                      color: isAdd ? t.green : t.red,
                    }}
                  >
                    {isAdd ? `+${r.quantity}` : r.quantity}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 12, marginBottom: 4 }}>
                  <Text style={{ fontSize: 11, color: t.textSecondary, textTransform: 'capitalize' }}>
                    {r.bucket}
                  </Text>
                  <Text style={{ fontSize: 11, color: t.textSecondary }}>
                    {formatDate(r.eventDate)}
                  </Text>
                  {r.enteredByName ? (
                    <Text style={{ fontSize: 11, color: t.textMuted }}>by {r.enteredByName}</Text>
                  ) : null}
                </View>
                {r.reason ? (
                  <Text style={{ fontSize: 12, color: t.text }}>{r.reason}</Text>
                ) : null}
              </View>
            );
          })}
        </View>
      )}

      {/* Pagination + CSV */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginTop: 4,
          marginBottom: 12,
        }}
      >
        <TouchableOpacity
          onPress={handleDownloadCsv}
          disabled={rows.length === 0 || downloading}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingHorizontal: 12,
            paddingVertical: 10,
            borderRadius: 8,
            backgroundColor: t.metricBg,
            borderWidth: 1,
            borderColor: t.cardBorder,
            opacity: rows.length === 0 || downloading ? 0.5 : 1,
          }}
        >
          {downloading ? (
            <ActivityIndicator size="small" color={t.text} />
          ) : (
            <Ionicons name="download-outline" size={14} color={t.text} />
          )}
          <Text style={{ fontSize: 12, fontWeight: '700', color: t.text }}>Download CSV</Text>
        </TouchableOpacity>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <TouchableOpacity
            onPress={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 8,
              borderRadius: 8,
              backgroundColor: t.metricBg,
              borderWidth: 1,
              borderColor: t.cardBorder,
              opacity: page <= 1 ? 0.5 : 1,
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: '600', color: t.text }}>Prev</Text>
          </TouchableOpacity>
          <Text style={{ fontSize: 12, color: t.textSecondary }}>
            {meta?.page ?? 1} / {meta?.totalPages ?? 1}
          </Text>
          <TouchableOpacity
            onPress={() => setPage((p) => p + 1)}
            disabled={(meta?.totalPages ?? 1) <= page}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 8,
              borderRadius: 8,
              backgroundColor: t.metricBg,
              borderWidth: 1,
              borderColor: t.cardBorder,
              opacity: (meta?.totalPages ?? 1) <= page ? 0.5 : 1,
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: '600', color: t.text }}>Next</Text>
          </TouchableOpacity>
        </View>
      </View>

      <TouchableOpacity
        onPress={onClose}
        style={{
          paddingVertical: 12,
          borderRadius: 12,
          backgroundColor: t.metricBg,
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <Text style={{ fontSize: 14, fontWeight: '700', color: t.text }}>Close</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ─── STOCK AT ONBOARDING TAB ────────────────────────────────────────────────

function OnboardingStockTab() {
  const t = useInventoryTheme();
  const {
    data: rows,
    isLoading,
    refetch,
  } = useApiQuery<OnboardingStockRow[]>(['onboarding-stock'], '/inventory/onboarding-stock');

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 8 }}
      refreshControl={
        <RefreshControl refreshing={isLoading} onRefresh={refetch} tintColor={t.accent} />
      }
    >
      {isLoading && (
        <View style={{ paddingVertical: 40, alignItems: 'center' }}>
          <ActivityIndicator size="large" color={t.accent} />
        </View>
      )}

      {!isLoading && (!rows || rows.length === 0) && (
        <EmptyCard
          icon="archive-outline"
          title="No opening stock recorded at onboarding."
          subtitle="Opening balances entered during onboarding will appear here."
        />
      )}

      {!isLoading &&
        rows?.map((s) => (
          <View
            key={s.cylinderTypeId}
            style={{
              backgroundColor: t.card,
              borderRadius: 12,
              padding: 14,
              borderWidth: 1,
              borderColor: t.cardBorder,
            }}
          >
            <Text style={{ fontSize: 15, fontWeight: '700', color: t.text, marginBottom: 10 }}>
              {s.cylinderTypeName}
            </Text>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View
                style={{
                  flex: 1,
                  backgroundColor: t.greenBg,
                  borderRadius: 8,
                  padding: 10,
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 11, color: t.textSecondary }}>Opening Fulls</Text>
                <Text style={{ fontSize: 18, fontWeight: '700', color: t.green }}>
                  {s.openingFulls}
                </Text>
              </View>
              <View
                style={{
                  flex: 1,
                  backgroundColor: t.orangeBg,
                  borderRadius: 8,
                  padding: 10,
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 11, color: t.textSecondary }}>Opening Empties</Text>
                <Text style={{ fontSize: 18, fontWeight: '700', color: t.orange }}>
                  {s.openingEmpties}
                </Text>
              </View>
            </View>
            <Text style={{ fontSize: 11, color: t.textMuted, marginTop: 8 }}>
              Date Set: {formatDate(s.dateSet)}
            </Text>
          </View>
        ))}
    </ScrollView>
  );
}

// ─── HISTORY TAB ────────────────────────────────────────────────────────────

function HistoryTab({
  dateFrom,
  dateTo,
  setDateFrom,
  setDateTo,
}: {
  dateFrom: string;
  dateTo: string;
  setDateFrom: (d: string) => void;
  setDateTo: (d: string) => void;
}) {
  const t = useInventoryTheme();

  const {
    data: historyData,
    isLoading,
    refetch,
  } = useApiQuery<{ events: InventoryEvent[]; meta?: DepotHistoryMeta }>(
    ['depot-history', dateFrom, dateTo],
    '/inventory/depot-history',
    { dateFrom, dateTo },
  );

  const events = historyData?.events ?? [];

  const renderEvent = useCallback(
    ({ item }: { item: InventoryEvent }) => {
      const isIncoming = item.eventType === 'incoming_fulls';
      return (
        <View
          style={{
            backgroundColor: t.card,
            borderRadius: 10,
            padding: 14,
            marginBottom: 8,
            borderWidth: 1,
            borderColor: t.cardBorder,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 8,
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: '600', color: t.textSecondary }}>
              {formatDate(item.eventDate)}
            </Text>
            <StatusBadge
              label={isIncoming ? 'Incoming' : 'Outgoing'}
              color={isIncoming ? t.green : t.orange}
              bg={isIncoming ? t.greenBg : t.orangeBg}
            />
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: t.text }}>
              {item.cylinderTypeName}
            </Text>
            <Text
              style={{
                fontSize: 15,
                fontWeight: '700',
                color: isIncoming ? t.green : t.orange,
              }}
            >
              {isIncoming ? '+' : '-'}{item.quantity}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, rowGap: 6 }}>
            {item.vehicleNumber && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Ionicons name="car-outline" size={13} color={t.textMuted} />
                <Text style={{ fontSize: 12, color: t.textSecondary }}>{item.vehicleNumber}</Text>
              </View>
            )}
            {item.driverName && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Ionicons name="person-outline" size={13} color={t.textMuted} />
                <Text style={{ fontSize: 12, color: t.textSecondary }}>{item.driverName}</Text>
              </View>
            )}
            {item.documentType && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Ionicons name="pricetag-outline" size={13} color={t.textMuted} />
                <Text style={{ fontSize: 12, color: t.textSecondary }}>{item.documentType}</Text>
              </View>
            )}
            {item.documentNumber && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Ionicons name="document-text-outline" size={13} color={t.textMuted} />
                <Text style={{ fontSize: 12, color: t.textSecondary }}>
                  {item.documentNumber}
                </Text>
              </View>
            )}
            {item.documentDate && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Ionicons name="calendar-outline" size={13} color={t.textMuted} />
                <Text style={{ fontSize: 12, color: t.textSecondary }}>
                  {formatDateShort(item.documentDate)}
                </Text>
              </View>
            )}
          </View>
          {item.notes ? (
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 4, marginTop: 6 }}>
              <Ionicons
                name="chatbubble-ellipses-outline"
                size={13}
                color={t.textMuted}
                style={{ marginTop: 1 }}
              />
              <Text style={{ fontSize: 12, color: t.textSecondary, flex: 1 }} numberOfLines={2}>
                {item.notes}
              </Text>
            </View>
          ) : null}
        </View>
      );
    },
    [t],
  );

  return (
    <View style={{ flex: 1 }}>
      {/* Date Range Filter */}
      <View
        style={{
          flexDirection: 'row',
          gap: 8,
          paddingHorizontal: 16,
          paddingVertical: 12,
          backgroundColor: t.card,
          borderBottomWidth: 1,
          borderBottomColor: t.divider,
          alignItems: 'center',
        }}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 11, fontWeight: '600', color: t.textSecondary, marginBottom: 4 }}>
            From
          </Text>
          <TouchableOpacity
            style={{
              backgroundColor: t.inputBg,
              borderRadius: 8,
              padding: 8,
              borderWidth: 1,
              borderColor: t.cardBorder,
            }}
          >
            <Text style={{ fontSize: 13, color: t.text }}>{formatDateShort(dateFrom)}</Text>
          </TouchableOpacity>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 11, fontWeight: '600', color: t.textSecondary, marginBottom: 4 }}>
            To
          </Text>
          <TouchableOpacity
            style={{
              backgroundColor: t.inputBg,
              borderRadius: 8,
              padding: 8,
              borderWidth: 1,
              borderColor: t.cardBorder,
            }}
          >
            <Text style={{ fontSize: 13, color: t.text }}>{formatDateShort(dateTo)}</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          onPress={() => {
            setDateFrom(addDays(todayString(), -7));
            setDateTo(todayString());
          }}
          style={{
            paddingHorizontal: 10,
            paddingVertical: 8,
            borderRadius: 8,
            backgroundColor: t.metricBg,
            marginTop: 16,
          }}
        >
          <Text style={{ fontSize: 11, fontWeight: '600', color: t.textSecondary }}>7D</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => {
            setDateFrom(addDays(todayString(), -30));
            setDateTo(todayString());
          }}
          style={{
            paddingHorizontal: 10,
            paddingVertical: 8,
            borderRadius: 8,
            backgroundColor: t.metricBg,
            marginTop: 16,
          }}
        >
          <Text style={{ fontSize: 11, fontWeight: '600', color: t.textSecondary }}>30D</Text>
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <View style={{ paddingVertical: 40, alignItems: 'center' }}>
          <ActivityIndicator size="large" color={t.accent} />
        </View>
      ) : events.length === 0 ? (
        <EmptyCard
          icon="time-outline"
          title="No depot history"
          subtitle="No incoming/outgoing transactions found"
        />
      ) : (
        <FlatList
          data={events}
          keyExtractor={(item) => item.eventId}
          renderItem={renderEvent}
          contentContainerStyle={{ padding: 16 }}
          refreshControl={
            <RefreshControl refreshing={isLoading} onRefresh={refetch} tintColor={t.accent} />
          }
        />
      )}
    </View>
  );
}

// ─── CANCELLED TAB ──────────────────────────────────────────────────────────

function CancelledTab({ selectedDate }: { selectedDate: string }) {
  const t = useInventoryTheme();

  const {
    data: cancelledStock,
    isLoading,
    refetch,
  } = useApiQuery<CancelledStock[]>(
    ['cancelled-stock', selectedDate],
    '/inventory/cancelled-stock',
    { date: selectedDate },
  );

  const returnMutation = useApiMutation<unknown, { eventIds: string[]; returnDate: string }>(
    'post',
    '/inventory/cancelled-stock/return',
    {
      invalidateKeys: [['cancelled-stock'], ['inventory']],
      successMessage: 'Stock returned to depot',
    },
  );

  const handleReturn = (eventId: string) => {
    Alert.alert('Return to Depot', 'Return this cancelled stock to the depot?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Return',
        onPress: () =>
          returnMutation.mutate({ eventIds: [eventId], returnDate: todayString() }),
      },
    ]);
  };

  const renderItem = useCallback(
    ({ item }: { item: CancelledStock }) => {
      const statusColor =
        item.status === 'RETURNED_TO_DEPOT' || item.status === 'returned_to_depot'
          ? t.green
          : item.status === 'ON_VEHICLE' || item.status === 'on_vehicle'
            ? t.orange
            : t.textSecondary;
      const statusBg =
        item.status === 'RETURNED_TO_DEPOT' || item.status === 'returned_to_depot'
          ? t.greenBg
          : item.status === 'ON_VEHICLE' || item.status === 'on_vehicle'
            ? t.orangeBg
            : t.metricBg;
      const canReturn =
        item.status === 'ON_VEHICLE' ||
        item.status === 'on_vehicle' ||
        item.status === 'PENDING' ||
        item.status === 'pending';

      return (
        <View
          style={{
            backgroundColor: t.card,
            borderRadius: 10,
            padding: 14,
            marginBottom: 8,
            borderWidth: 1,
            borderColor: t.cardBorder,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 8,
            }}
          >
            <Text style={{ fontSize: 15, fontWeight: '700', color: t.text }}>
              {item.cylinderTypeName}
            </Text>
            <StatusBadge
              label={item.status.replace(/_/g, ' ')}
              color={statusColor}
              bg={statusBg}
            />
          </View>
          <View style={{ flexDirection: 'row', gap: 20, marginBottom: canReturn ? 10 : 0 }}>
            <View>
              <Text style={{ fontSize: 11, color: t.textSecondary }}>Qty</Text>
              <Text style={{ fontSize: 15, fontWeight: '700', color: t.accent }}>
                {item.quantity}
              </Text>
            </View>
            <View>
              <Text style={{ fontSize: 11, color: t.textSecondary }}>Driver</Text>
              <Text style={{ fontSize: 13, fontWeight: '600', color: t.text }}>
                {item.driverName}
              </Text>
            </View>
            <View>
              <Text style={{ fontSize: 11, color: t.textSecondary }}>Vehicle</Text>
              <Text style={{ fontSize: 13, fontWeight: '600', color: t.text }}>
                {item.vehicleNumber}
              </Text>
            </View>
          </View>
          {canReturn && (
            <TouchableOpacity
              onPress={() => handleReturn(item.eventId)}
              disabled={returnMutation.isPending}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                backgroundColor: t.accentBg,
                borderRadius: 8,
                paddingVertical: 10,
              }}
            >
              <Ionicons name="return-down-back-outline" size={16} color={t.accent} />
              <Text style={{ fontSize: 13, fontWeight: '700', color: t.accent }}>
                {returnMutation.isPending ? 'Returning...' : 'Return to Depot'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      );
    },
    [t, returnMutation],
  );

  return (
    <View style={{ flex: 1 }}>
      {isLoading ? (
        <View style={{ paddingVertical: 40, alignItems: 'center' }}>
          <ActivityIndicator size="large" color={t.accent} />
        </View>
      ) : !cancelledStock?.length ? (
        <EmptyCard
          icon="close-circle-outline"
          title="No cancelled stock"
          subtitle="No cancelled stock for this date"
        />
      ) : (
        <FlatList
          data={cancelledStock}
          keyExtractor={(item) => item.eventId}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 16 }}
          refreshControl={
            <RefreshControl refreshing={isLoading} onRefresh={refetch} tintColor={t.accent} />
          }
        />
      )}
    </View>
  );
}

// ─── FORECAST TAB ───────────────────────────────────────────────────────────

function ForecastTab() {
  const t = useInventoryTheme();

  const {
    data: forecast,
    isLoading,
    refetch,
  } = useApiQuery<InventoryForecast[]>(['inventory-forecast'], '/inventory/forecast');

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 12 }}
      refreshControl={
        <RefreshControl refreshing={isLoading} onRefresh={refetch} tintColor={t.accent} />
      }
    >
      {isLoading && (
        <View style={{ paddingVertical: 40, alignItems: 'center' }}>
          <ActivityIndicator size="large" color={t.accent} />
        </View>
      )}

      {!isLoading && !forecast?.length && (
        <EmptyCard
          icon="trending-up-outline"
          title="No forecast data"
          subtitle="Forecasts will appear once enough data is collected"
        />
      )}

      {forecast?.map((f) => {
        const daysLow = f.daysOfStockRemaining < 3;
        const daysWarn = f.daysOfStockRemaining < 7 && !daysLow;
        const trendIcon =
          f.trendDirection === 'increasing'
            ? 'trending-up'
            : f.trendDirection === 'decreasing'
              ? 'trending-down'
              : 'remove-outline';
        const trendColor =
          f.trendDirection === 'increasing'
            ? t.red
            : f.trendDirection === 'decreasing'
              ? t.green
              : t.textSecondary;

        return (
          <View
            key={f.cylinderTypeId}
            style={{
              backgroundColor: t.card,
              borderRadius: 12,
              padding: 16,
              borderWidth: daysLow ? 2 : 1,
              borderColor: daysLow ? 'rgba(239, 68, 68, 0.5)' : t.cardBorder,
            }}
          >
            {/* Header */}
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 12,
              }}
            >
              <Text style={{ fontSize: 16, fontWeight: '700', color: t.text }}>
                {f.cylinderTypeName}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Ionicons name={trendIcon as IoniconName} size={16} color={trendColor} />
                <Text style={{ fontSize: 12, fontWeight: '600', color: trendColor, textTransform: 'capitalize' }}>
                  {f.trendDirection}
                </Text>
              </View>
            </View>

            {/* Metrics Grid */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <MetricCell
                label="Current Stock"
                value={f.currentStock}
                bg={t.metricBg}
                color={t.text}
              />
              <MetricCell
                label="Avg Daily Demand"
                value={Number(f.averageDailyDemand.toFixed(1))}
                bg={t.metricBg}
                color={t.text}
              />
              <MetricCell
                label="Days Remaining"
                value={f.daysOfStockRemaining}
                bg={daysLow ? t.redBg : daysWarn ? t.orangeBg : t.greenBg}
                color={daysLow ? t.red : daysWarn ? t.orange : t.green}
              />
              <MetricCell
                label="Reorder Qty"
                value={f.recommendedReorderQty}
                bg={t.blueBg}
                color={t.blue}
              />
            </View>

            {/* Forecast row */}
            <View
              style={{
                flexDirection: 'row',
                borderTopWidth: 1,
                borderTopColor: t.divider,
                paddingTop: 10,
                gap: 16,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 11, color: t.textSecondary }}>7-Day Forecast</Text>
                <Text style={{ fontSize: 16, fontWeight: '700', color: t.text }}>
                  {f.forecastedDemand7Days}
                </Text>
              </View>
              <View style={{ flex: 1, alignItems: 'flex-end' }}>
                <Text style={{ fontSize: 11, color: t.textSecondary }}>30-Day Forecast</Text>
                <Text style={{ fontSize: 16, fontWeight: '700', color: t.text }}>
                  {f.forecastedDemand30Days}
                </Text>
              </View>
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

// ─── BALANCES TAB ───────────────────────────────────────────────────────────

function BalancesTab() {
  const t = useInventoryTheme();

  const {
    data: balances,
    isLoading,
    refetch,
  } = useApiQuery<CustomerBalance[]>(['customer-balances'], '/inventory/customer-balances');

  const renderItem = useCallback(
    ({ item }: { item: CustomerBalance }) => {
      const hasMissing = item.missingQty > 0;
      return (
        <View
          style={{
            backgroundColor: t.card,
            borderRadius: 10,
            padding: 14,
            marginBottom: 8,
            borderWidth: hasMissing ? 1.5 : 1,
            borderColor: hasMissing ? 'rgba(239, 68, 68, 0.4)' : t.cardBorder,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 8,
            }}
          >
            <Text style={{ fontSize: 15, fontWeight: '700', color: t.text, flex: 1 }}>
              {item.customerName}
            </Text>
            <View
              style={{
                backgroundColor: t.blueBg,
                paddingHorizontal: 8,
                paddingVertical: 2,
                borderRadius: 10,
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: '600', color: t.blue }}>
                {item.cylinderTypeName}
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11, color: t.textSecondary }}>With Customer</Text>
              <Text style={{ fontSize: 16, fontWeight: '700', color: t.text }}>
                {item.withCustomerQty}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11, color: t.textSecondary }}>Pending Returns</Text>
              <Text style={{ fontSize: 16, fontWeight: '700', color: t.orange }}>
                {item.pendingReturns}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11, color: t.textSecondary }}>Missing</Text>
              <Text
                style={{
                  fontSize: 16,
                  fontWeight: '700',
                  color: hasMissing ? t.red : t.text,
                }}
              >
                {item.missingQty}
              </Text>
            </View>
          </View>
          <Text style={{ fontSize: 10, color: t.textMuted, marginTop: 6 }}>
            Updated {formatDate(item.lastUpdated)}
          </Text>
        </View>
      );
    },
    [t],
  );

  return (
    <View style={{ flex: 1 }}>
      {isLoading ? (
        <View style={{ paddingVertical: 40, alignItems: 'center' }}>
          <ActivityIndicator size="large" color={t.accent} />
        </View>
      ) : !balances?.length ? (
        <EmptyCard
          icon="people-outline"
          title="No customer balances"
          subtitle="Customer cylinder balances will appear here"
        />
      ) : (
        <FlatList
          data={balances}
          keyExtractor={(item, idx) => `${item.customerId}-${item.cylinderTypeId}-${idx}`}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 16 }}
          refreshControl={
            <RefreshControl refreshing={isLoading} onRefresh={refetch} tintColor={t.accent} />
          }
        />
      )}
    </View>
  );
}

// ─── RECONCILE TAB ──────────────────────────────────────────────────────────

function ReconcileTab() {
  const t = useInventoryTheme();

  const {
    data: vehicles,
    isLoading,
    refetch,
  } = useApiQuery<ReconciliationVehicle[]>(
    ['reconciliation-pending'],
    '/delivery/reconciliation/pending',
  );

  // Cylinder types are needed by the Mismatch modal for the cylinder picker
  // and for deposit-price-driven unit-amount calculation. Match the web's
  // wire shape: { cylinderTypes: CylinderTypeOption[] }.
  const { data: cylinderTypesData } = useApiQuery<{ cylinderTypes: CylinderTypeOption[] }>(
    ['cylinder-types'],
    '/cylinder-types',
    {},
    { staleTime: 5 * 60 * 1000 },
  );
  const cylinderTypes = cylinderTypesData?.cylinderTypes ?? [];

  const confirmMutation = useApiMutation<
    void,
    { vehicleId: string; data: { physicalStockConfirmed: boolean; notes: string } }
  >('post', (vars) => `/delivery/reconciliation/confirm/${vars.vehicleId}`, {
    invalidateKeys: [['reconciliation-pending']],
    successMessage: 'Reconciliation completed',
  });

  const [mismatchVehicle, setMismatchVehicle] = useState<ReconciliationVehicle | null>(null);

  const handleConfirm = (vehicle: ReconciliationVehicle) => {
    Alert.alert(
      'Confirm Match',
      `Confirm physical stock matches system for ${vehicle.vehicleNumber}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: () =>
            confirmMutation.mutate({
              vehicleId: vehicle.vehicleId,
              data: { physicalStockConfirmed: true, notes: 'Physical stock matches system' },
            }),
        },
      ],
    );
  };

  const handleMismatch = (vehicle: ReconciliationVehicle) => {
    setMismatchVehicle(vehicle);
  };

  return (
    <>
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 12 }}
      refreshControl={
        <RefreshControl refreshing={isLoading} onRefresh={refetch} tintColor={t.accent} />
      }
    >
      {isLoading && (
        <View style={{ paddingVertical: 40, alignItems: 'center' }}>
          <ActivityIndicator size="large" color={t.accent} />
        </View>
      )}

      {!isLoading && !vehicles?.length && (
        <EmptyCard
          icon="checkmark-done-outline"
          title="No vehicles pending"
          subtitle="All returned vehicles have been reconciled"
        />
      )}

      {vehicles?.map((v) => (
        <View
          key={v.vehicleId}
          style={{
            backgroundColor: t.card,
            borderRadius: 12,
            padding: 16,
            borderWidth: 1,
            borderColor: t.cardBorder,
          }}
        >
          {/* Vehicle Header */}
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  backgroundColor: t.orangeBg,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ionicons name="car-outline" size={18} color={t.orange} />
              </View>
              <Text style={{ fontSize: 16, fontWeight: '700', color: t.text }}>
                {v.vehicleNumber}
              </Text>
            </View>
            <StatusBadge label="Pending" color={t.orange} bg={t.orangeBg} />
          </View>

          {/* Counts */}
          <View style={{ flexDirection: 'row', gap: 12, marginBottom: 14 }}>
            <View
              style={{
                flex: 1,
                backgroundColor: t.metricBg,
                borderRadius: 8,
                padding: 10,
                alignItems: 'center',
              }}
            >
              <Text style={{ fontSize: 11, color: t.textSecondary }}>Cancelled Stock</Text>
              <Text style={{ fontSize: 18, fontWeight: '700', color: t.accent }}>
                {v.pendingCancelledStock}
              </Text>
            </View>
            <View
              style={{
                flex: 1,
                backgroundColor: t.metricBg,
                borderRadius: 8,
                padding: 10,
                alignItems: 'center',
              }}
            >
              <Text style={{ fontSize: 11, color: t.textSecondary }}>Undelivered Orders</Text>
              <Text style={{ fontSize: 18, fontWeight: '700', color: t.orange }}>
                {v.pendingUndeliveredOrders}
              </Text>
            </View>
          </View>

          {/* Actions */}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity
              onPress={() => handleConfirm(v)}
              disabled={confirmMutation.isPending}
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                backgroundColor: t.greenBg,
                borderRadius: 8,
                paddingVertical: 12,
              }}
            >
              <Ionicons name="checkmark-circle-outline" size={16} color={t.green} />
              <Text style={{ fontSize: 13, fontWeight: '700', color: t.green }}>
                Confirm Match
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => handleMismatch(v)}
              disabled={confirmMutation.isPending}
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                backgroundColor: t.redBg,
                borderRadius: 8,
                paddingVertical: 12,
              }}
            >
              <Ionicons name="alert-circle-outline" size={16} color={t.red} />
              <Text style={{ fontSize: 13, fontWeight: '700', color: t.red }}>
                Report Mismatch
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}
    </ScrollView>

    {mismatchVehicle && (
      <ReportMismatchModal
        vehicle={mismatchVehicle}
        cylinderTypes={cylinderTypes}
        onClose={() => setMismatchVehicle(null)}
      />
    )}
    </>
  );
}

// ─── Report Mismatch Modal (3-step) ─────────────────────────────────────────

type MismatchStep = 1 | 2 | 3;
type MismatchTypeKey = 'empties_short' | 'fulls_short' | 'both';
type AccountableParty = 'driver' | 'customer';
type ResolutionAction = 'write_off' | 'settle_against_due';

function ReportMismatchModal({
  vehicle,
  cylinderTypes,
  onClose,
}: {
  vehicle: ReconciliationVehicle;
  cylinderTypes: CylinderTypeOption[];
  onClose: () => void;
}) {
  const t = useInventoryTheme();
  const [step, setStep] = useState<MismatchStep>(1);
  const [mismatchType, setMismatchType] = useState<MismatchTypeKey>('empties_short');
  const [cylinderTypeId, setCylinderTypeId] = useState('');
  const [qty, setQty] = useState('');
  const [accountableParty, setAccountableParty] = useState<AccountableParty>('driver');
  const [driverId, setDriverId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [resolutionAction, setResolutionAction] = useState<ResolutionAction>('write_off');
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Driver / customer pickers — lazy-load via apiGet so we don't pay the
  // cost on step 1 if the user never opens step 2.
  const [drivers, setDrivers] = useState<DriverOption[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [loadingParties, setLoadingParties] = useState(false);

  const loadParties = useCallback(async () => {
    setLoadingParties(true);
    try {
      if (accountableParty === 'driver' && drivers.length === 0) {
        const res = await apiGet<{ drivers: DriverOption[] }>('/drivers');
        setDrivers(res.drivers ?? []);
      } else if (accountableParty === 'customer' && customers.length === 0) {
        const res = await apiGet<{ customers: CustomerOption[] }>('/customers', { limit: 200 });
        setCustomers(res.customers ?? []);
      }
    } catch (err) {
      Alert.alert('Could not load options', getErrorMessage(err));
    } finally {
      setLoadingParties(false);
    }
  }, [accountableParty, drivers.length, customers.length]);

  const selectedCt = cylinderTypes.find((c) => c.cylinderTypeId === cylinderTypeId);
  const depositPrice = selectedCt?.emptyDepositPrice ?? 0;
  const cylinderUnitPrice = selectedCt?.latestPrice ?? 0;
  const qtyNum = Math.max(0, Math.floor(Number(qty) || 0));
  const unitAmount =
    mismatchType === 'empties_short'
      ? depositPrice
      : mismatchType === 'fulls_short'
        ? cylinderUnitPrice + depositPrice
        : cylinderUnitPrice + 2 * depositPrice;
  const totalAmount = Math.round(qtyNum * unitAmount * 100) / 100;

  const canSubmit =
    qtyNum > 0 &&
    !!cylinderTypeId &&
    (accountableParty === 'driver' ? !!driverId : !!customerId) &&
    !!resolutionNotes.trim();

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await apiPost('/inventory/mismatch-reports', {
        vehicleId: vehicle.vehicleId,
        tripDate: new Date().toISOString().slice(0, 10),
        accountableParty,
        driverId: accountableParty === 'driver' ? driverId : undefined,
        customerId: accountableParty === 'customer' ? customerId : undefined,
        resolutionAction,
        resolutionNotes: resolutionNotes.trim(),
        lines: [
          {
            mismatchType,
            cylinderTypeId,
            qtyUnaccounted: qtyNum,
            unitAmount,
            totalAmount,
          },
        ],
      });
      Alert.alert('Submitted', 'Mismatch report submitted.');
      onClose();
    } catch (err) {
      Alert.alert('Submit failed', getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const goNext = () => {
    if (step === 1) {
      if (!cylinderTypeId || qtyNum <= 0) return;
      setStep(2);
      loadParties();
    } else if (step === 2) {
      if (accountableParty === 'driver' ? !driverId : !customerId) return;
      setStep(3);
    }
  };

  const goBack = () => {
    if (step === 2) setStep(1);
    else if (step === 3) setStep(2);
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1, justifyContent: 'flex-end' }}
      >
        <View
          style={{
            backgroundColor: t.card,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            padding: 20,
            maxHeight: '90%',
          }}
        >
          {/* Header */}
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
              <Ionicons name="alert-circle-outline" size={22} color={t.red} />
              <Text style={{ fontSize: 16, fontWeight: '800', color: t.text }} numberOfLines={1}>
                Report Mismatch — {vehicle.vehicleNumber}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} style={{ padding: 4 }}>
              <Ionicons name="close" size={22} color={t.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Stepper */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              marginBottom: 14,
              flexWrap: 'wrap',
            }}
          >
            {([1, 2, 3] as const).map((n, idx) => {
              const label =
                n === 1 ? '1. What is short' : n === 2 ? '2. Accountability' : '3. Resolution';
              const isActive = step === n;
              return (
                <View key={n} style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text
                    style={{
                      fontSize: 11,
                      fontWeight: isActive ? '800' : '500',
                      color: isActive ? t.accent : t.textSecondary,
                    }}
                  >
                    {label}
                  </Text>
                  {idx < 2 && (
                    <Text style={{ fontSize: 11, color: t.textMuted, marginHorizontal: 4 }}>›</Text>
                  )}
                </View>
              );
            })}
          </View>

          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {step === 1 && (
              <View>
                <Text style={[modalStyles.label, { color: t.textSecondary }]}>Mismatch Type</Text>
                <View style={{ flexDirection: 'row', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
                  {(
                    [
                      { value: 'empties_short', label: 'Empties Short' },
                      { value: 'fulls_short', label: 'Fulls Short' },
                      { value: 'both', label: 'Both' },
                    ] as const
                  ).map((opt) => {
                    const selected = mismatchType === opt.value;
                    return (
                      <TouchableOpacity
                        key={opt.value}
                        onPress={() => setMismatchType(opt.value)}
                        style={{
                          paddingHorizontal: 12,
                          paddingVertical: 8,
                          borderRadius: 8,
                          backgroundColor: selected ? t.red : t.metricBg,
                          borderWidth: 1,
                          borderColor: selected ? t.red : t.cardBorder,
                        }}
                      >
                        <Text
                          style={{
                            fontSize: 12,
                            fontWeight: '700',
                            color: selected ? '#fff' : t.text,
                          }}
                        >
                          {opt.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <Text style={[modalStyles.label, { color: t.textSecondary }]}>
                  Cylinder Type <Text style={{ color: t.red }}>*</Text>
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={{ marginBottom: 14 }}
                  contentContainerStyle={{ gap: 8, paddingVertical: 4 }}
                >
                  {cylinderTypes.length === 0 ? (
                    <Text style={{ fontSize: 13, color: t.textMuted, paddingVertical: 8 }}>
                      No cylinder types available
                    </Text>
                  ) : (
                    cylinderTypes.map((ct) => {
                      const selected = cylinderTypeId === ct.cylinderTypeId;
                      return (
                        <TouchableOpacity
                          key={ct.cylinderTypeId}
                          onPress={() => setCylinderTypeId(ct.cylinderTypeId)}
                          style={{
                            paddingHorizontal: 14,
                            paddingVertical: 8,
                            borderRadius: 20,
                            backgroundColor: selected ? t.red : t.metricBg,
                            borderWidth: 1,
                            borderColor: selected ? t.red : t.cardBorder,
                          }}
                        >
                          <Text
                            style={{
                              fontSize: 13,
                              fontWeight: '600',
                              color: selected ? '#fff' : t.text,
                            }}
                          >
                            {ct.typeName}
                          </Text>
                        </TouchableOpacity>
                      );
                    })
                  )}
                </ScrollView>

                <Text style={[modalStyles.label, { color: t.textSecondary }]}>
                  Quantity Unaccounted <Text style={{ color: t.red }}>*</Text>
                </Text>
                <TextInput
                  style={[
                    modalStyles.input,
                    { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder },
                  ]}
                  placeholder="e.g. 5"
                  placeholderTextColor={t.textMuted}
                  keyboardType="number-pad"
                  value={qty}
                  onChangeText={setQty}
                />

                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
                  <TouchableOpacity
                    onPress={onClose}
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 12,
                      borderRadius: 10,
                      backgroundColor: t.metricBg,
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: '700', color: t.text }}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={goNext}
                    disabled={!cylinderTypeId || qtyNum <= 0}
                    style={{
                      paddingHorizontal: 18,
                      paddingVertical: 12,
                      borderRadius: 10,
                      backgroundColor: t.accent,
                      opacity: !cylinderTypeId || qtyNum <= 0 ? 0.5 : 1,
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>Next</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {step === 2 && (
              <View>
                <Text style={[modalStyles.label, { color: t.textSecondary }]}>
                  Accountable Party
                </Text>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                  {(['driver', 'customer'] as const).map((p) => {
                    const selected = accountableParty === p;
                    return (
                      <TouchableOpacity
                        key={p}
                        onPress={() => {
                          setAccountableParty(p);
                          // reset the OTHER side's selection so canSubmit is
                          // never confused by stale values
                          if (p === 'driver') setCustomerId('');
                          else setDriverId('');
                        }}
                        style={{
                          flex: 1,
                          paddingVertical: 10,
                          borderRadius: 8,
                          backgroundColor: selected ? t.blue : t.metricBg,
                          borderWidth: 1,
                          borderColor: selected ? t.blue : t.cardBorder,
                          alignItems: 'center',
                        }}
                      >
                        <Text
                          style={{
                            fontSize: 13,
                            fontWeight: '700',
                            color: selected ? '#fff' : t.text,
                            textTransform: 'capitalize',
                          }}
                        >
                          {p}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {accountableParty === 'driver' ? (
                  <>
                    <Text style={[modalStyles.label, { color: t.textSecondary }]}>
                      Driver <Text style={{ color: t.red }}>*</Text>
                    </Text>
                    {loadingParties ? (
                      <ActivityIndicator size="small" color={t.accent} />
                    ) : drivers.length === 0 ? (
                      <Text style={{ fontSize: 12, color: t.textMuted, marginBottom: 14 }}>
                        No drivers loaded.{' '}
                        <Text onPress={loadParties} style={{ color: t.blue, fontWeight: '700' }}>
                          Retry
                        </Text>
                      </Text>
                    ) : (
                      <ScrollView style={{ maxHeight: 180, marginBottom: 14 }}>
                        {drivers.map((d) => {
                          const selected = driverId === d.driverId;
                          return (
                            <TouchableOpacity
                              key={d.driverId}
                              onPress={() => setDriverId(d.driverId)}
                              style={{
                                paddingHorizontal: 12,
                                paddingVertical: 10,
                                borderRadius: 8,
                                backgroundColor: selected ? t.blueBg : t.metricBg,
                                borderWidth: 1,
                                borderColor: selected ? t.blue : t.cardBorder,
                                marginBottom: 6,
                              }}
                            >
                              <Text
                                style={{
                                  fontSize: 13,
                                  fontWeight: selected ? '700' : '500',
                                  color: t.text,
                                }}
                              >
                                {d.driverName}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </ScrollView>
                    )}
                  </>
                ) : (
                  <>
                    <Text style={[modalStyles.label, { color: t.textSecondary }]}>
                      Customer <Text style={{ color: t.red }}>*</Text>
                    </Text>
                    {loadingParties ? (
                      <ActivityIndicator size="small" color={t.accent} />
                    ) : customers.length === 0 ? (
                      <Text style={{ fontSize: 12, color: t.textMuted, marginBottom: 14 }}>
                        No customers loaded.{' '}
                        <Text onPress={loadParties} style={{ color: t.blue, fontWeight: '700' }}>
                          Retry
                        </Text>
                      </Text>
                    ) : (
                      <ScrollView style={{ maxHeight: 180, marginBottom: 14 }}>
                        {customers.map((c) => {
                          const selected = customerId === c.customerId;
                          return (
                            <TouchableOpacity
                              key={c.customerId}
                              onPress={() => setCustomerId(c.customerId)}
                              style={{
                                paddingHorizontal: 12,
                                paddingVertical: 10,
                                borderRadius: 8,
                                backgroundColor: selected ? t.blueBg : t.metricBg,
                                borderWidth: 1,
                                borderColor: selected ? t.blue : t.cardBorder,
                                marginBottom: 6,
                              }}
                            >
                              <Text
                                style={{
                                  fontSize: 13,
                                  fontWeight: selected ? '700' : '500',
                                  color: t.text,
                                }}
                              >
                                {c.customerName}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </ScrollView>
                    )}
                  </>
                )}

                {/* Computed amounts panel */}
                <View
                  style={{
                    backgroundColor: t.metricBg,
                    borderRadius: 10,
                    padding: 12,
                    marginBottom: 14,
                  }}
                >
                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      marginBottom: 4,
                    }}
                  >
                    <Text style={{ fontSize: 12, color: t.textSecondary }}>Unit Amount</Text>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: t.text }}>
                      ₹{unitAmount.toLocaleString('en-IN')}
                    </Text>
                  </View>
                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: '700', color: t.text }}>Total</Text>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: t.text }}>
                      ₹{totalAmount.toLocaleString('en-IN')}
                    </Text>
                  </View>
                  <Text style={{ fontSize: 10, color: t.textMuted, marginTop: 6 }}>
                    Empties Short: qty × empty deposit price. Fulls Short: qty × (cylinder unit +
                    deposit). Set the deposit in Settings → Empty Deposit Prices.
                  </Text>
                </View>

                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                  <TouchableOpacity
                    onPress={goBack}
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 12,
                      borderRadius: 10,
                      backgroundColor: t.metricBg,
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: '700', color: t.text }}>Back</Text>
                  </TouchableOpacity>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TouchableOpacity
                      onPress={onClose}
                      style={{
                        paddingHorizontal: 16,
                        paddingVertical: 12,
                        borderRadius: 10,
                        backgroundColor: t.metricBg,
                      }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: '700', color: t.text }}>
                        Cancel
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={goNext}
                      disabled={accountableParty === 'driver' ? !driverId : !customerId}
                      style={{
                        paddingHorizontal: 18,
                        paddingVertical: 12,
                        borderRadius: 10,
                        backgroundColor: t.accent,
                        opacity:
                          (accountableParty === 'driver' ? !driverId : !customerId) ? 0.5 : 1,
                      }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>Next</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            )}

            {step === 3 && (
              <View>
                <Text style={[modalStyles.label, { color: t.textSecondary }]}>
                  Resolution Action
                </Text>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                  {(
                    [
                      { value: 'write_off', label: 'Write off' },
                      { value: 'settle_against_due', label: 'Settle against due' },
                    ] as const
                  ).map((opt) => {
                    const selected = resolutionAction === opt.value;
                    return (
                      <TouchableOpacity
                        key={opt.value}
                        onPress={() => setResolutionAction(opt.value)}
                        style={{
                          flex: 1,
                          paddingVertical: 10,
                          borderRadius: 8,
                          backgroundColor: selected ? t.blue : t.metricBg,
                          borderWidth: 1,
                          borderColor: selected ? t.blue : t.cardBorder,
                          alignItems: 'center',
                        }}
                      >
                        <Text
                          style={{
                            fontSize: 12,
                            fontWeight: '700',
                            color: selected ? '#fff' : t.text,
                          }}
                        >
                          {opt.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <Text style={[modalStyles.label, { color: t.textSecondary }]}>
                  Resolution Notes <Text style={{ color: t.red }}>*</Text>
                </Text>
                <TextInput
                  style={[
                    modalStyles.input,
                    modalStyles.textarea,
                    { backgroundColor: t.inputBg, color: t.text, borderColor: t.cardBorder },
                  ]}
                  placeholder="Reason / investigation outcome (required)"
                  placeholderTextColor={t.textMuted}
                  multiline
                  numberOfLines={4}
                  value={resolutionNotes}
                  onChangeText={setResolutionNotes}
                />

                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                  <TouchableOpacity
                    onPress={goBack}
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 12,
                      borderRadius: 10,
                      backgroundColor: t.metricBg,
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: '700', color: t.text }}>Back</Text>
                  </TouchableOpacity>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TouchableOpacity
                      onPress={onClose}
                      style={{
                        paddingHorizontal: 16,
                        paddingVertical: 12,
                        borderRadius: 10,
                        backgroundColor: t.metricBg,
                      }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: '700', color: t.text }}>
                        Cancel
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={submit}
                      disabled={!canSubmit || submitting}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        paddingHorizontal: 18,
                        paddingVertical: 12,
                        borderRadius: 10,
                        backgroundColor: t.red,
                        opacity: !canSubmit || submitting ? 0.5 : 1,
                      }}
                    >
                      {submitting && <ActivityIndicator size="small" color="#fff" />}
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>
                        {submitting ? 'Submitting...' : 'Submit'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── Shared Components ──────────────────────────────────────────────────────

function StatusBadge({
  label,
  color,
  bg,
}: {
  label: string;
  color: string;
  bg: string;
}) {
  return (
    <View
      style={{
        backgroundColor: bg,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 10,
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: '700', color, textTransform: 'uppercase' }}>
        {label}
      </Text>
    </View>
  );
}

function MetricCell({
  label,
  value,
  prefix,
  bg,
  color,
}: {
  label: string;
  value: number;
  prefix?: string;
  bg: string;
  color: string;
}) {
  const t = useInventoryTheme();
  return (
    <View
      style={{
        width: '48%',
        backgroundColor: bg,
        borderRadius: 8,
        padding: 10,
      }}
    >
      <Text style={{ fontSize: 11, color: t.textSecondary, marginBottom: 2 }}>{label}</Text>
      <Text style={{ fontSize: 17, fontWeight: '700', color }}>
        {prefix ?? ''}{value ?? 0}
      </Text>
    </View>
  );
}

function EmptyCard({
  icon,
  title,
  subtitle,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
}) {
  const t = useInventoryTheme();
  return (
    <View
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 60,
        paddingHorizontal: 24,
      }}
    >
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: t.metricBg,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 12,
        }}
      >
        <Ionicons name={icon} size={28} color={t.textMuted} />
      </View>
      <Text style={{ fontSize: 16, fontWeight: '700', color: t.text, textAlign: 'center' }}>
        {title}
      </Text>
      {subtitle && (
        <Text
          style={{
            fontSize: 13,
            color: t.textSecondary,
            textAlign: 'center',
            marginTop: 4,
          }}
        >
          {subtitle}
        </Text>
      )}
    </View>
  );
}
