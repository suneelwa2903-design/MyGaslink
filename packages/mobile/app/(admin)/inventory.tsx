import { useState, useCallback, useMemo } from 'react';
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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { useTheme, ACCENT } from '../../src/theme';

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

// ─── Tab Definitions ────────────────────────────────────────────────────────

type TabKey = 'summary' | 'history' | 'cancelled' | 'forecast' | 'balances' | 'reconcile';

const TABS: { key: TabKey; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'summary', label: 'Summary', icon: 'cube-outline' },
  { key: 'history', label: 'History', icon: 'time-outline' },
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
      {activeTab === 'cancelled' && <CancelledTab selectedDate={selectedDate} />}
      {activeTab === 'forecast' && <ForecastTab />}
      {activeTab === 'balances' && <BalancesTab />}
      {activeTab === 'reconcile' && <ReconcileTab />}
    </SafeAreaView>
  );
}

// ─── SUMMARY TAB ────────────────────────────────────────────────────────────

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

  const handleLockToggle = () => {
    if (isLocked) {
      Alert.alert('Unlock Day', `Unlock inventory for ${formatDate(selectedDate)}?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Unlock', onPress: () => unlockMutation.mutate({ date: selectedDate }) },
      ]);
    } else {
      Alert.alert('Lock Day', `Lock inventory for ${formatDate(selectedDate)}? This prevents further edits.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Lock', style: 'destructive', onPress: () => lockMutation.mutate({ date: selectedDate }) },
      ]);
    }
  };

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 12 }}
      refreshControl={
        <RefreshControl refreshing={isLoading} onRefresh={refetch} tintColor={t.accent} />
      }
    >
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
        <EmptyCard icon="cube-outline" title="No inventory data" subtitle="No records for this date" />
      )}

      {/* Cylinder Cards */}
      {!isLoading &&
        inventory?.map((item) => {
          const isWarning =
            item.thresholdWarning !== null && item.closingFulls <= (item.thresholdWarning ?? 0);
          const isCritical =
            item.thresholdCritical !== null && item.closingFulls <= (item.thresholdCritical ?? 0);

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
                  {item.isLocked && <StatusBadge label="Locked" color={t.green} bg={t.greenBg} />}
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
  } = useApiQuery<{ events: InventoryEvent[]; meta?: any }>(
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
          <View style={{ flexDirection: 'row', gap: 16 }}>
            {item.vehicleNumber && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Ionicons name="car-outline" size={13} color={t.textMuted} />
                <Text style={{ fontSize: 12, color: t.textSecondary }}>{item.vehicleNumber}</Text>
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
          </View>
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
                <Ionicons name={trendIcon as any} size={16} color={trendColor} />
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

  const confirmMutation = useApiMutation<
    any,
    { vehicleId: string; data: { physicalStockConfirmed: boolean; notes: string } }
  >('post', (vars) => `/delivery/reconciliation/confirm/${vars.vehicleId}`, {
    invalidateKeys: [['reconciliation-pending']],
    successMessage: 'Reconciliation completed',
  });

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
    Alert.alert(
      'Report Mismatch',
      `Report stock mismatch for ${vehicle.vehicleNumber}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Report',
          style: 'destructive',
          onPress: () =>
            confirmMutation.mutate({
              vehicleId: vehicle.vehicleId,
              data: { physicalStockConfirmed: false, notes: 'Stock mismatch detected' },
            }),
        },
      ],
    );
  };

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
