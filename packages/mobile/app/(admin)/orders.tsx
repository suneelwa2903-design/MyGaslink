import { useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  Modal,
  ScrollView,
  Alert,
  RefreshControl,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Dimensions,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { useTheme } from '../../src/theme';
import { api, getErrorMessage } from '../../src/lib/api';

// ─── Types ──────────────────────────────────────────────────────────────────

interface OrderItem {
  orderItemId: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

interface Order {
  orderId: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  deliveryDate: string;
  status: string;
  totalAmount: number;
  driverName?: string;
  driverId?: string;
  vehicleId?: string;
  specialInstructions?: string;
  items: OrderItem[];
}

interface Customer {
  customerId: string;
  customerName: string;
  phone?: string;
}

interface Driver {
  driverId: string;
  driverName: string;
  phone?: string;
}

interface Vehicle {
  vehicleId: string;
  vehicleNumber: string;
  vehicleType?: string;
}

interface CylinderType {
  cylinderTypeId: string;
  typeName: string;
  capacity: number;
  unit: string;
}

// ─── GST Dispatch Types ─────────────────────────────────────────────────────

interface DispatchResult {
  orderId: string;
  orderNumber: string;
  customerName: string;
  mode: 'B2B' | 'B2C' | 'GST_DISABLED';
  success: boolean;
  irn?: string | null;
  ackNo?: string | null;
  ewbNo?: string | null;
  ewbValidTill?: string | null;
  errorCode?: string;
  errorMessage?: string;
}

interface DispatchResponse {
  summary: { total: number; succeeded: number; failed: number };
  results: DispatchResult[];
  dispatched: boolean;
}

interface InTransitDriver {
  driverId: string;
  driverName: string;
  vehicleId: string;
  vehicleNumber: string;
  assignmentId: string;
  tripNumber: string;
  tripSheetNo?: string;
  inTransitCount: number;
  deliveredCount: number;
}

// Group of pending_dispatch orders for one driver
interface ReadyToDispatchGroup {
  driverId: string;
  driverName: string;
  orderCount: number;
  assignmentDate: string; // YYYY-MM-DD
}

// ─── Constants ──────────────────────────────────────────────────────────────

const STATUS_TABS = [
  { label: 'All', value: 'all' },
  { label: 'Pending Assignment', value: 'pending_driver_assignment' },
  { label: 'Pending Dispatch', value: 'pending_dispatch' },
  { label: 'Pending Delivery', value: 'pending_delivery' },
  { label: 'Delivered', value: 'delivered' },
  { label: 'Cancelled', value: 'cancelled' },
] as const;

const STATUS_BADGE_COLORS: Record<string, { bg: string; text: string }> = {
  pending_driver_assignment: { bg: '#f97316', text: '#ffffff' },
  pending_dispatch: { bg: '#3b82f6', text: '#ffffff' },
  pending_delivery: { bg: '#a855f7', text: '#ffffff' },
  delivered: { bg: '#22c55e', text: '#ffffff' },
  modified_delivered: { bg: '#14b8a6', text: '#ffffff' },
  cancelled: { bg: '#ef4444', text: '#ffffff' },
};

const STATUS_LABELS: Record<string, string> = {
  pending_driver_assignment: 'Pending Assignment',
  pending_dispatch: 'Pending Dispatch',
  pending_delivery: 'Pending Delivery',
  delivered: 'Delivered',
  modified_delivered: 'Modified Delivered',
  cancelled: 'Cancelled',
};

const ACCENT = '#dc2626';

function getColors(dark: boolean) {
  return {
    bg: dark ? '#0f172a' : '#ffffff',
    card: dark ? '#1e293b' : '#f8fafc',
    cardBorder: dark ? '#334155' : '#e2e8f0',
    text: dark ? '#f8fafc' : '#0f172a',
    textSecondary: dark ? '#cbd5e1' : '#64748b',
    textMuted: dark ? '#94a3b8' : '#94a3b8',
    inputBg: dark ? '#0f172a' : '#ffffff',
    inputBorder: dark ? '#475569' : '#cbd5e1',
    tabBg: dark ? '#334155' : '#f1f5f9',
    tabText: dark ? '#cbd5e1' : '#475569',
    modalBg: dark ? '#0f172a' : '#ffffff',
    overlay: 'rgba(0,0,0,0.6)',
    itemBg: dark ? '#334155' : '#f1f5f9',
    divider: dark ? '#334155' : '#e2e8f0',
  };
}

function formatCurrency(amount: number): string {
  return '\u20B9' + (amount ?? 0).toLocaleString('en-IN');
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function getTodayISO(): string {
  return new Date().toISOString().split('T')[0];
}

// ─── Main Screen ────────────────────────────────────────────────────────────

export default function AdminOrdersScreen() {
  const { dark } = useTheme();
  const C = getColors(dark);

  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);

  // Modal state
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [assignOrder, setAssignOrder] = useState<Order | null>(null);
  const [bulkAssignVisible, setBulkAssignVisible] = useState(false);
  const [deliverOrder, setDeliverOrder] = useState<Order | null>(null);

  // GST dispatch state
  const [dispatchingDriverId, setDispatchingDriverId] = useState<string | null>(null);
  const [dispatchResult, setDispatchResult] = useState<DispatchResponse | null>(null);
  const [dispatchResultVisible, setDispatchResultVisible] = useState(false);

  // In-transit trip sheet download
  const [downloadingAssignmentId, setDownloadingAssignmentId] = useState<string | null>(null);

  // ─── Queries ────────────────────────────────────────────────────────────

  const queryParams: Record<string, unknown> = { pageSize: 50, page: 1 };
  if (statusFilter !== 'all') queryParams.status = statusFilter;

  const {
    data: ordersData,
    isLoading,
    refetch,
    isRefetching,
  } = useApiQuery<{ orders: Order[]; total: number }>(
    ['admin-orders', statusFilter],
    '/orders',
    queryParams,
  );

  const { data: customersData } = useApiQuery<{ customers: Customer[] }>(
    ['customers-list'],
    '/customers',
    { limit: 200 },
    { staleTime: 5 * 60 * 1000 },
  );

  const { data: driversData } = useApiQuery<{ drivers: Driver[] }>(
    ['drivers-list'],
    '/drivers',
    {},
    { staleTime: 5 * 60 * 1000 },
  );

  const { data: vehiclesData } = useApiQuery<{ vehicles: Vehicle[] }>(
    ['vehicles-list'],
    '/vehicles',
    {},
    { staleTime: 5 * 60 * 1000 },
  );

  const { data: cylinderTypesData } = useApiQuery<{ cylinderTypes: CylinderType[] }>(
    ['cylinder-types'],
    '/inventory/cylinder-types',
    {},
    { staleTime: 10 * 60 * 1000 },
  );

  const { data: inTransitData } = useApiQuery<{ drivers: InTransitDriver[] }>(
    ['admin-in-transit'],
    '/orders/in-transit',
    { date: getTodayISO() },
  );

  // ─── Mutations ──────────────────────────────────────────────────────────

  const cancelMutation = useApiMutation<unknown, { orderId: string }>(
    'post',
    (vars) => `/orders/${vars.orderId}/cancel`,
    {
      invalidateKeys: [['admin-orders']],
      successMessage: 'Order cancelled successfully',
    },
  );

  // ─── Derived data ──────────────────────────────────────────────────────

  const orders = ordersData?.orders ?? [];
  const customers = customersData?.customers ?? [];
  const drivers = driversData?.drivers ?? [];
  const vehicles = vehiclesData?.vehicles ?? [];
  const cylinderTypes = cylinderTypesData?.cylinderTypes ?? [];

  const filteredOrders = useMemo(() => {
    if (!search.trim()) return orders;
    const q = search.toLowerCase();
    return orders.filter(
      (o) =>
        o.orderNumber?.toLowerCase().includes(q) ||
        o.customerName?.toLowerCase().includes(q) ||
        o.driverName?.toLowerCase().includes(q),
    );
  }, [orders, search]);

  // Derive ready-to-dispatch groups from the currently loaded order list.
  // Only orders with status===pending_dispatch AND a driverId qualify.
  const readyToDispatchGroups = useMemo<ReadyToDispatchGroup[]>(() => {
    const map = new Map<string, ReadyToDispatchGroup>();
    for (const o of orders) {
      if (o.status !== 'pending_dispatch' || !o.driverId) continue;
      const existing = map.get(o.driverId);
      const dateStr = String(o.deliveryDate).split('T')[0];
      if (existing) {
        existing.orderCount += 1;
      } else {
        map.set(o.driverId, {
          driverId: o.driverId,
          driverName: o.driverName ?? o.driverId,
          orderCount: 1,
          assignmentDate: dateStr,
        });
      }
    }
    return Array.from(map.values());
  }, [orders]);

  const inTransitDrivers = inTransitData?.drivers ?? [];

  // ─── Handlers ──────────────────────────────────────────────────────────

  const toggleExpand = useCallback((orderId: string) => {
    setExpandedOrderId((prev) => (prev === orderId ? null : orderId));
  }, []);

  const toggleSelect = useCallback((orderId: string) => {
    setSelectedOrderIds((prev) =>
      prev.includes(orderId) ? prev.filter((id) => id !== orderId) : [...prev, orderId],
    );
  }, []);

  const handleCancel = useCallback(
    (order: Order) => {
      Alert.alert(
        'Cancel Order',
        `Are you sure you want to cancel order ${order.orderNumber}?`,
        [
          { text: 'No', style: 'cancel' },
          {
            text: 'Yes, Cancel',
            style: 'destructive',
            onPress: () => cancelMutation.mutate({ orderId: order.orderId }),
          },
        ],
      );
    },
    [cancelMutation],
  );

  const handleDispatch = useCallback(
    async (group: ReadyToDispatchGroup) => {
      setDispatchingDriverId(group.driverId);
      try {
        const result = await api.post<{ success: boolean; data: DispatchResponse }>(
          '/orders/preflight-dispatch',
          { driverId: group.driverId, assignmentDate: group.assignmentDate },
        );
        setDispatchResult(result.data.data);
        setDispatchResultVisible(true);
      } catch (err: unknown) {
        const axiosErr = err as { response?: { data?: { code?: string; error?: string }; status?: number } };
        const code = axiosErr?.response?.data?.code;
        if (code === 'NIC_SESSION_DOWN') {
          Alert.alert('NIC unavailable', 'NIC is temporarily unavailable. Wait a few minutes and retry.');
        } else if (code === 'SESSION_EXPIRED') {
          Alert.alert('NIC session expired', 'NIC session expired. Go to Settings → GST → Test Connection, then retry.');
        } else {
          Alert.alert('Dispatch failed', getErrorMessage(err));
        }
      } finally {
        setDispatchingDriverId(null);
      }
    },
    [],
  );

  const handleDownloadTripSheet = useCallback(
    async (assignmentId: string) => {
      setDownloadingAssignmentId(assignmentId);
      try {
        const res = await api.get(`/orders/trip-sheet/${assignmentId}`, {
          responseType: 'arraybuffer',
        });
        const bytes = new Uint8Array(res.data as ArrayBuffer);
        const file = new File(Paths.cache, `trip-sheet-${assignmentId}-${Date.now()}.pdf`);
        try { file.create(); } catch { /* already exists */ }
        file.write(bytes);

        if (!(await Sharing.isAvailableAsync())) {
          Alert.alert('Sharing unavailable', 'This device does not support sharing.');
          return;
        }
        await Sharing.shareAsync(file.uri, {
          mimeType: 'application/pdf',
          dialogTitle: 'Trip Sheet',
          UTI: 'com.adobe.pdf',
        });
      } catch (err) {
        Alert.alert('Could not load trip sheet', getErrorMessage(err));
      } finally {
        setDownloadingAssignmentId(null);
      }
    },
    [],
  );

  // ─── Render helpers ────────────────────────────────────────────────────

  const renderStatusBadge = (status: string) => {
    const colors = STATUS_BADGE_COLORS[status] ?? { bg: '#6b7280', text: '#ffffff' };
    return (
      <View style={[styles.badge, { backgroundColor: colors.bg }]}>
        <Text style={[styles.badgeText, { color: colors.text }]}>
          {STATUS_LABELS[status] ?? status.replace(/_/g, ' ')}
        </Text>
      </View>
    );
  };

  const renderOrderCard = useCallback(
    ({ item: order }: { item: Order }) => {
      const isExpanded = expandedOrderId === order.orderId;
      const isSelected = selectedOrderIds.includes(order.orderId);
      const canAssign = order.status === 'pending_driver_assignment';
      const canDeliver =
        order.status === 'pending_delivery' || order.status === 'pending_dispatch';
      const canCancel =
        order.status !== 'delivered' &&
        order.status !== 'modified_delivered' &&
        order.status !== 'cancelled';

      return (
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => toggleExpand(order.orderId)}
          onLongPress={() => {
            if (canAssign) toggleSelect(order.orderId);
          }}
          style={[
            styles.card,
            {
              backgroundColor: C.card,
              borderColor: isSelected ? ACCENT : C.cardBorder,
              borderWidth: isSelected ? 2 : 1,
            },
          ]}
        >
          {/* Header row */}
          <View style={styles.cardHeader}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.orderNumber, { color: C.text }]}>{order.orderNumber}</Text>
              <Text style={[styles.customerName, { color: ACCENT }]}>{order.customerName}</Text>
            </View>
            {renderStatusBadge(order.status)}
          </View>

          {/* Info row */}
          <View style={styles.cardInfoRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.infoText, { color: C.textSecondary }]}>
                <Ionicons name="calendar-outline" size={12} color={C.textSecondary} />{' '}
                {formatDate(order.deliveryDate)}
              </Text>
              <Text style={[styles.infoText, { color: C.textSecondary, marginTop: 2 }]}>
                <Ionicons name="person-outline" size={12} color={C.textSecondary} />{' '}
                {order.driverName || 'Unassigned'}
              </Text>
            </View>
            <Text style={[styles.amountText, { color: C.text }]}>
              {formatCurrency(order.totalAmount)}
            </Text>
          </View>

          {/* Items summary chips */}
          <View style={styles.chipRow}>
            {order.items?.map((item, i) => (
              <View key={i} style={[styles.chip, { backgroundColor: C.itemBg }]}>
                <Text style={[styles.chipText, { color: C.textSecondary }]}>
                  {item.cylinderTypeName} x{item.quantity}
                </Text>
              </View>
            ))}
          </View>

          {/* Expanded section */}
          {isExpanded && (
            <View style={[styles.expandedSection, { borderTopColor: C.divider }]}>
              {/* Detailed items */}
              {order.items?.map((item, i) => (
                <View key={i} style={styles.itemDetailRow}>
                  <Text style={[styles.itemDetailName, { color: C.text }]}>
                    {item.cylinderTypeName}
                  </Text>
                  <Text style={[styles.itemDetailQty, { color: C.textSecondary }]}>
                    Qty: {item.quantity}
                  </Text>
                  <Text style={[styles.itemDetailPrice, { color: C.text }]}>
                    {formatCurrency(item.totalPrice)}
                  </Text>
                </View>
              ))}

              {order.specialInstructions ? (
                <Text style={[styles.specialInstructions, { color: C.textSecondary }]}>
                  Note: {order.specialInstructions}
                </Text>
              ) : null}

              {/* Action buttons */}
              <View style={styles.actionRow}>
                {canAssign && (
                  <TouchableOpacity
                    style={[styles.actionBtn, { backgroundColor: '#3b82f6' }]}
                    onPress={() => setAssignOrder(order)}
                  >
                    <Ionicons name="car-outline" size={16} color="#fff" />
                    <Text style={styles.actionBtnText}>Assign Driver</Text>
                  </TouchableOpacity>
                )}
                {canDeliver && (
                  <TouchableOpacity
                    style={[styles.actionBtn, { backgroundColor: '#22c55e' }]}
                    onPress={() => setDeliverOrder(order)}
                  >
                    <Ionicons name="checkmark-circle-outline" size={16} color="#fff" />
                    <Text style={styles.actionBtnText}>Confirm Delivery</Text>
                  </TouchableOpacity>
                )}
                {canCancel && (
                  <TouchableOpacity
                    style={[styles.actionBtn, { backgroundColor: '#ef4444' }]}
                    onPress={() => handleCancel(order)}
                  >
                    <Ionicons name="close-circle-outline" size={16} color="#fff" />
                    <Text style={styles.actionBtnText}>Cancel</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}
        </TouchableOpacity>
      );
    },
    [expandedOrderId, selectedOrderIds, C, toggleExpand, toggleSelect, handleCancel],
  );

  const keyExtractor = useCallback((item: Order) => item.orderId, []);

  // ─── Main render ───────────────────────────────────────────────────────

  return (
    <SafeAreaView edges={['left', 'right']} style={[styles.container, { backgroundColor: C.bg }]}>
      {/* Status Filter Tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabBar}
      >
        {STATUS_TABS.map((tab) => {
          const active = statusFilter === tab.value;
          return (
            <TouchableOpacity
              key={tab.value}
              onPress={() => setStatusFilter(tab.value)}
              style={[
                styles.tab,
                { backgroundColor: active ? ACCENT : C.tabBg },
              ]}
            >
              <Text
                style={[
                  styles.tabText,
                  { color: active ? '#ffffff' : C.tabText },
                ]}
              >
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Search bar */}
      <View style={[styles.searchContainer, { borderBottomColor: C.divider }]}>
        <View style={[styles.searchInputWrapper, { backgroundColor: C.card, borderColor: C.inputBorder }]}>
          <Ionicons name="search-outline" size={18} color={C.textMuted} />
          <TextInput
            style={[styles.searchInput, { color: C.text }]}
            placeholder="Search orders..."
            placeholderTextColor={C.textMuted}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')}>
              <Ionicons name="close-circle" size={18} color={C.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Bulk assign bar */}
      {selectedOrderIds.length > 0 && (
        <View style={[styles.bulkBar, { backgroundColor: ACCENT }]}>
          <Text style={styles.bulkBarText}>
            {selectedOrderIds.length} order{selectedOrderIds.length > 1 ? 's' : ''} selected
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity
              style={styles.bulkBarBtn}
              onPress={() => setBulkAssignVisible(true)}
            >
              <Ionicons name="car-outline" size={16} color="#fff" />
              <Text style={styles.bulkBarBtnText}>Assign</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.bulkBarBtn}
              onPress={() => setSelectedOrderIds([])}
            >
              <Ionicons name="close" size={16} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Order list */}
      {isLoading && !isRefetching ? (
        <View style={styles.loaderContainer}>
          <ActivityIndicator size="large" color={ACCENT} />
          <Text style={[styles.loaderText, { color: C.textSecondary }]}>Loading orders...</Text>
        </View>
      ) : (
        <FlatList
          data={filteredOrders}
          keyExtractor={keyExtractor}
          renderItem={renderOrderCard}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor={ACCENT}
              colors={[ACCENT]}
            />
          }
          ListHeaderComponent={
            readyToDispatchGroups.length > 0 ? (
              <View style={[styles.sectionBox, { backgroundColor: C.card, borderColor: C.cardBorder }]}>
                <View style={styles.sectionHeader}>
                  <Ionicons name="flash-outline" size={16} color={ACCENT} />
                  <Text style={[styles.sectionTitle, { color: C.text }]}>Ready to Dispatch</Text>
                </View>
                {readyToDispatchGroups.map((group) => {
                  const isDispatching = dispatchingDriverId === group.driverId;
                  return (
                    <View
                      key={group.driverId}
                      style={[styles.dispatchRow, { borderTopColor: C.divider }]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.dispatchDriverName, { color: C.text }]}>
                          {group.driverName}
                        </Text>
                        <Text style={[styles.dispatchSubtext, { color: C.textSecondary }]}>
                          {group.orderCount} order{group.orderCount !== 1 ? 's' : ''} · {group.assignmentDate}
                        </Text>
                      </View>
                      <TouchableOpacity
                        style={[
                          styles.dispatchBtn,
                          { opacity: isDispatching || dispatchingDriverId !== null ? 0.6 : 1 },
                        ]}
                        onPress={() => handleDispatch(group)}
                        disabled={isDispatching || dispatchingDriverId !== null}
                      >
                        {isDispatching ? (
                          <>
                            <ActivityIndicator size="small" color="#fff" />
                            <Text style={styles.dispatchBtnText}>Generating IRN & EWB…</Text>
                          </>
                        ) : (
                          <>
                            <Ionicons name="rocket-outline" size={14} color="#fff" />
                            <Text style={styles.dispatchBtnText}>Dispatch</Text>
                          </>
                        )}
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            ) : null
          }
          ListFooterComponent={
            inTransitDrivers.length > 0 ? (
              <View style={[styles.sectionBox, { backgroundColor: C.card, borderColor: C.cardBorder, marginTop: 10 }]}>
                <View style={styles.sectionHeader}>
                  <Ionicons name="car-outline" size={16} color="#a855f7" />
                  <Text style={[styles.sectionTitle, { color: C.text }]}>In Transit</Text>
                </View>
                {inTransitDrivers.map((driver) => {
                  const isDownloading = downloadingAssignmentId === driver.assignmentId;
                  return (
                    <View
                      key={driver.assignmentId}
                      style={[styles.inTransitRow, { borderTopColor: C.divider }]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.dispatchDriverName, { color: C.text }]}>
                          {driver.driverName}
                        </Text>
                        <Text style={[styles.dispatchSubtext, { color: C.textSecondary }]}>
                          {driver.vehicleNumber} · {driver.inTransitCount} in transit · {driver.deliveredCount} delivered
                        </Text>
                      </View>
                      <TouchableOpacity
                        style={[
                          styles.tripSheetBtn,
                          { opacity: isDownloading ? 0.6 : 1 },
                        ]}
                        onPress={() => handleDownloadTripSheet(driver.assignmentId)}
                        disabled={isDownloading}
                      >
                        {isDownloading ? (
                          <ActivityIndicator size="small" color={ACCENT} />
                        ) : (
                          <>
                            <Ionicons name="document-text-outline" size={14} color={ACCENT} />
                            <Text style={[styles.tripSheetBtnText, { color: ACCENT }]}>Trip Sheet</Text>
                          </>
                        )}
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons name="receipt-outline" size={48} color={C.textMuted} />
              <Text style={[styles.emptyTitle, { color: C.text }]}>No orders found</Text>
              <Text style={[styles.emptyDesc, { color: C.textSecondary }]}>
                {search ? 'Try a different search term' : 'No orders match the selected filter'}
              </Text>
            </View>
          }
        />
      )}

      {/* Floating Action Button */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => setCreateModalVisible(true)}
        activeOpacity={0.8}
      >
        <Ionicons name="add" size={28} color="#ffffff" />
      </TouchableOpacity>

      {/* Modals */}
      {createModalVisible && (
        <CreateOrderModal
          visible={createModalVisible}
          onClose={() => setCreateModalVisible(false)}
          customers={customers}
          cylinderTypes={cylinderTypes}
          dark={dark}
        />
      )}

      {assignOrder && (
        <AssignDriverModal
          visible={!!assignOrder}
          onClose={() => setAssignOrder(null)}
          order={assignOrder}
          drivers={drivers}
          vehicles={vehicles}
          dark={dark}
        />
      )}

      {bulkAssignVisible && (
        <BulkAssignModal
          visible={bulkAssignVisible}
          onClose={() => {
            setBulkAssignVisible(false);
            setSelectedOrderIds([]);
          }}
          orderIds={selectedOrderIds}
          drivers={drivers}
          vehicles={vehicles}
          dark={dark}
        />
      )}

      {deliverOrder && (
        <DeliveryConfirmationModal
          visible={!!deliverOrder}
          onClose={() => setDeliverOrder(null)}
          order={deliverOrder}
          dark={dark}
        />
      )}

      {dispatchResultVisible && dispatchResult && (
        <DispatchResultModal
          visible={dispatchResultVisible}
          result={dispatchResult}
          dark={dark}
          onClose={() => {
            setDispatchResultVisible(false);
            setDispatchResult(null);
            refetch();
          }}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Create Order Modal ─────────────────────────────────────────────────────

function CreateOrderModal({
  visible,
  onClose,
  customers,
  cylinderTypes,
  dark,
}: {
  visible: boolean;
  onClose: () => void;
  customers: Customer[];
  cylinderTypes: CylinderType[];
  dark: boolean;
}) {
  const C = getColors(dark);

  const [customerId, setCustomerId] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [showCustomerPicker, setShowCustomerPicker] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState(getTodayISO());
  const [specialInstructions, setSpecialInstructions] = useState('');
  const [items, setItems] = useState([{ cylinderTypeId: '', quantity: '1' }]);

  const createMutation = useApiMutation<unknown, unknown>(
    'post',
    '/orders',
    {
      invalidateKeys: [['admin-orders']],
      successMessage: 'Order created successfully',
      onSuccess: () => onClose(),
    },
  );

  const selectedCustomer = customers.find((c) => c.customerId === customerId);

  const filteredCustomers = useMemo(() => {
    if (!customerSearch.trim()) return customers;
    const q = customerSearch.toLowerCase();
    return customers.filter((c) => c.customerName.toLowerCase().includes(q));
  }, [customers, customerSearch]);

  const addItem = () => setItems([...items, { cylinderTypeId: '', quantity: '1' }]);

  const removeItem = (index: number) => {
    if (items.length <= 1) return;
    setItems(items.filter((_, i) => i !== index));
  };

  const updateItem = (index: number, field: 'cylinderTypeId' | 'quantity', value: string) => {
    const updated = [...items];
    updated[index] = { ...updated[index], [field]: value };
    setItems(updated);
  };

  const handleSubmit = () => {
    if (!customerId) {
      Alert.alert('Validation', 'Please select a customer');
      return;
    }
    if (!deliveryDate) {
      Alert.alert('Validation', 'Please enter a delivery date');
      return;
    }
    const validItems = items.filter((it) => it.cylinderTypeId && parseInt(it.quantity, 10) > 0);
    if (validItems.length === 0) {
      Alert.alert('Validation', 'Please add at least one item');
      return;
    }
    createMutation.mutate({
      customerId,
      deliveryDate,
      specialInstructions: specialInstructions || undefined,
      items: validItems.map((it) => ({
        cylinderTypeId: it.cylinderTypeId,
        quantity: parseInt(it.quantity, 10),
      })),
    });
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaView style={[styles.modalContainer, { backgroundColor: C.modalBg }]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
          {/* Header */}
          <View style={[styles.modalHeader, { borderBottomColor: C.divider }]}>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={24} color={C.text} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: C.text }]}>Create Order</Text>
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? (
                <ActivityIndicator size="small" color={ACCENT} />
              ) : (
                <Text style={[styles.modalSaveText, { color: ACCENT }]}>Create</Text>
              )}
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
            {/* Customer picker */}
            <Text style={[styles.fieldLabel, { color: C.text }]}>Customer *</Text>
            <TouchableOpacity
              style={[styles.pickerBtn, { backgroundColor: C.card, borderColor: C.inputBorder }]}
              onPress={() => setShowCustomerPicker(true)}
            >
              <Text
                style={{
                  color: selectedCustomer ? C.text : C.textMuted,
                  fontSize: 15,
                }}
              >
                {selectedCustomer?.customerName ?? 'Select customer'}
              </Text>
              <Ionicons name="chevron-down" size={18} color={C.textMuted} />
            </TouchableOpacity>

            {/* Customer picker modal */}
            <Modal visible={showCustomerPicker} animationType="slide" transparent>
              <View style={[styles.pickerOverlay, { backgroundColor: C.overlay }]}>
                <View style={[styles.pickerSheet, { backgroundColor: C.modalBg }]}>
                  <View style={[styles.pickerSheetHeader, { borderBottomColor: C.divider }]}>
                    <Text style={[styles.pickerSheetTitle, { color: C.text }]}>Select Customer</Text>
                    <TouchableOpacity onPress={() => setShowCustomerPicker(false)}>
                      <Ionicons name="close" size={24} color={C.text} />
                    </TouchableOpacity>
                  </View>
                  <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                    <View
                      style={[
                        styles.searchInputWrapper,
                        { backgroundColor: C.card, borderColor: C.inputBorder },
                      ]}
                    >
                      <Ionicons name="search-outline" size={16} color={C.textMuted} />
                      <TextInput
                        style={[styles.searchInput, { color: C.text }]}
                        placeholder="Search customers..."
                        placeholderTextColor={C.textMuted}
                        value={customerSearch}
                        onChangeText={setCustomerSearch}
                        autoFocus
                      />
                    </View>
                  </View>
                  <FlatList
                    data={filteredCustomers}
                    keyExtractor={(c) => c.customerId}
                    renderItem={({ item: c }) => (
                      <TouchableOpacity
                        style={[
                          styles.pickerItem,
                          {
                            backgroundColor:
                              c.customerId === customerId ? (dark ? '#334155' : '#eff6ff') : 'transparent',
                          },
                        ]}
                        onPress={() => {
                          setCustomerId(c.customerId);
                          setShowCustomerPicker(false);
                          setCustomerSearch('');
                        }}
                      >
                        <Text style={[styles.pickerItemText, { color: C.text }]}>
                          {c.customerName}
                        </Text>
                        {c.phone && (
                          <Text style={[styles.pickerItemSub, { color: C.textSecondary }]}>
                            {c.phone}
                          </Text>
                        )}
                      </TouchableOpacity>
                    )}
                    ListEmptyComponent={
                      <Text style={[styles.pickerEmpty, { color: C.textMuted }]}>
                        No customers found
                      </Text>
                    }
                  />
                </View>
              </View>
            </Modal>

            {/* Delivery date */}
            <Text style={[styles.fieldLabel, { color: C.text, marginTop: 16 }]}>
              Delivery Date *
            </Text>
            <TextInput
              style={[styles.textInput, { backgroundColor: C.card, borderColor: C.inputBorder, color: C.text }]}
              value={deliveryDate}
              onChangeText={setDeliveryDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={C.textMuted}
            />

            {/* Order items */}
            <View style={styles.itemsHeader}>
              <Text style={[styles.fieldLabel, { color: C.text }]}>Order Items *</Text>
              <TouchableOpacity onPress={addItem} style={styles.addItemBtn}>
                <Ionicons name="add-circle" size={20} color={ACCENT} />
                <Text style={{ color: ACCENT, fontSize: 13, fontWeight: '600' }}>Add Item</Text>
              </TouchableOpacity>
            </View>

            {items.map((item, index) => (
              <View key={index} style={[styles.itemRow, { backgroundColor: C.card, borderColor: C.cardBorder }]}>
                {/* Cylinder type picker */}
                <View style={{ flex: 1 }}>
                  <Text style={[styles.itemFieldLabel, { color: C.textSecondary }]}>Cylinder Type</Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ gap: 6, paddingVertical: 4 }}
                  >
                    {cylinderTypes.map((ct) => (
                      <TouchableOpacity
                        key={ct.cylinderTypeId}
                        style={[
                          styles.cylinderChip,
                          {
                            backgroundColor:
                              item.cylinderTypeId === ct.cylinderTypeId
                                ? ACCENT
                                : dark
                                  ? '#475569'
                                  : '#e2e8f0',
                          },
                        ]}
                        onPress={() => updateItem(index, 'cylinderTypeId', ct.cylinderTypeId)}
                      >
                        <Text
                          style={{
                            fontSize: 12,
                            fontWeight: '600',
                            color:
                              item.cylinderTypeId === ct.cylinderTypeId
                                ? '#fff'
                                : C.text,
                          }}
                        >
                          {ct.typeName} ({ct.capacity}{ct.unit})
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>

                <View style={styles.qtyContainer}>
                  <Text style={[styles.itemFieldLabel, { color: C.textSecondary }]}>Qty</Text>
                  <View style={styles.qtyRow}>
                    <TouchableOpacity
                      onPress={() => {
                        const val = Math.max(1, parseInt(item.quantity, 10) - 1);
                        updateItem(index, 'quantity', String(val));
                      }}
                      style={[styles.qtyBtn, { backgroundColor: dark ? '#475569' : '#e2e8f0' }]}
                    >
                      <Ionicons name="remove" size={16} color={C.text} />
                    </TouchableOpacity>
                    <TextInput
                      style={[styles.qtyInput, { color: C.text, borderColor: C.inputBorder }]}
                      value={item.quantity}
                      onChangeText={(v) => updateItem(index, 'quantity', v.replace(/[^0-9]/g, ''))}
                      keyboardType="number-pad"
                      textAlign="center"
                    />
                    <TouchableOpacity
                      onPress={() => {
                        const val = parseInt(item.quantity, 10) + 1;
                        updateItem(index, 'quantity', String(val));
                      }}
                      style={[styles.qtyBtn, { backgroundColor: dark ? '#475569' : '#e2e8f0' }]}
                    >
                      <Ionicons name="add" size={16} color={C.text} />
                    </TouchableOpacity>
                  </View>
                </View>

                {items.length > 1 && (
                  <TouchableOpacity
                    onPress={() => removeItem(index)}
                    style={styles.removeItemBtn}
                  >
                    <Ionicons name="trash-outline" size={18} color="#ef4444" />
                  </TouchableOpacity>
                )}
              </View>
            ))}

            {/* Special instructions */}
            <Text style={[styles.fieldLabel, { color: C.text, marginTop: 16 }]}>
              Special Instructions
            </Text>
            <TextInput
              style={[
                styles.textInput,
                styles.textArea,
                { backgroundColor: C.card, borderColor: C.inputBorder, color: C.text },
              ]}
              value={specialInstructions}
              onChangeText={setSpecialInstructions}
              placeholder="Optional notes..."
              placeholderTextColor={C.textMuted}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />

            {/* Submit button */}
            <TouchableOpacity
              style={[styles.submitBtn, { opacity: createMutation.isPending ? 0.6 : 1 }]}
              onPress={handleSubmit}
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="checkmark-circle" size={20} color="#fff" />
                  <Text style={styles.submitBtnText}>Create Order</Text>
                </>
              )}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Assign Driver Modal ────────────────────────────────────────────────────

function AssignDriverModal({
  visible,
  onClose,
  order,
  drivers,
  vehicles,
  dark,
}: {
  visible: boolean;
  onClose: () => void;
  order: Order;
  drivers: Driver[];
  vehicles: Vehicle[];
  dark: boolean;
}) {
  const C = getColors(dark);
  const [driverId, setDriverId] = useState(order.driverId ?? '');
  const [vehicleId, setVehicleId] = useState(order.vehicleId ?? '');

  const assignMutation = useApiMutation<unknown, { driverId: string; vehicleId?: string }>(
    'post',
    `/orders/${order.orderId}/assign-driver`,
    {
      invalidateKeys: [['admin-orders']],
      successMessage: 'Driver assigned successfully',
      onSuccess: () => onClose(),
    },
  );

  const handleAssign = () => {
    if (!driverId) {
      Alert.alert('Validation', 'Please select a driver');
      return;
    }
    assignMutation.mutate({ driverId, vehicleId: vehicleId || undefined });
  };

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={[styles.pickerOverlay, { backgroundColor: C.overlay }]}>
        <View style={[styles.bottomSheet, { backgroundColor: C.modalBg }]}>
          <View style={styles.bottomSheetHandle} />
          <Text style={[styles.bottomSheetTitle, { color: C.text }]}>
            Assign Driver - {order.orderNumber}
          </Text>

          <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}>
            {/* Driver picker */}
            <Text style={[styles.fieldLabel, { color: C.text }]}>Driver *</Text>
            {drivers.map((d) => (
              <TouchableOpacity
                key={d.driverId}
                style={[
                  styles.selectOption,
                  {
                    backgroundColor: driverId === d.driverId ? ACCENT : C.card,
                    borderColor: driverId === d.driverId ? ACCENT : C.cardBorder,
                  },
                ]}
                onPress={() => setDriverId(d.driverId)}
              >
                <Ionicons
                  name={driverId === d.driverId ? 'radio-button-on' : 'radio-button-off'}
                  size={18}
                  color={driverId === d.driverId ? '#fff' : C.textSecondary}
                />
                <View style={{ marginLeft: 10, flex: 1 }}>
                  <Text
                    style={{
                      color: driverId === d.driverId ? '#fff' : C.text,
                      fontWeight: '600',
                      fontSize: 14,
                    }}
                  >
                    {d.driverName}
                  </Text>
                  {d.phone && (
                    <Text
                      style={{
                        color: driverId === d.driverId ? 'rgba(255,255,255,0.7)' : C.textSecondary,
                        fontSize: 12,
                      }}
                    >
                      {d.phone}
                    </Text>
                  )}
                </View>
              </TouchableOpacity>
            ))}

            {/* Vehicle picker */}
            <Text style={[styles.fieldLabel, { color: C.text, marginTop: 16 }]}>Vehicle</Text>
            <TouchableOpacity
              style={[
                styles.selectOption,
                {
                  backgroundColor: vehicleId === '' ? (dark ? '#334155' : '#eff6ff') : C.card,
                  borderColor: C.cardBorder,
                },
              ]}
              onPress={() => setVehicleId('')}
            >
              <Text style={{ color: C.textSecondary, fontSize: 14 }}>None</Text>
            </TouchableOpacity>
            {vehicles.map((v) => (
              <TouchableOpacity
                key={v.vehicleId}
                style={[
                  styles.selectOption,
                  {
                    backgroundColor: vehicleId === v.vehicleId ? ACCENT : C.card,
                    borderColor: vehicleId === v.vehicleId ? ACCENT : C.cardBorder,
                  },
                ]}
                onPress={() => setVehicleId(v.vehicleId)}
              >
                <Ionicons
                  name={vehicleId === v.vehicleId ? 'radio-button-on' : 'radio-button-off'}
                  size={18}
                  color={vehicleId === v.vehicleId ? '#fff' : C.textSecondary}
                />
                <Text
                  style={{
                    color: vehicleId === v.vehicleId ? '#fff' : C.text,
                    fontWeight: '600',
                    fontSize: 14,
                    marginLeft: 10,
                  }}
                >
                  {v.vehicleNumber} {v.vehicleType ? `(${v.vehicleType})` : ''}
                </Text>
              </TouchableOpacity>
            ))}

            {/* Buttons */}
            <View style={styles.bottomSheetButtons}>
              <TouchableOpacity
                style={[styles.secondaryBtn, { borderColor: C.cardBorder }]}
                onPress={onClose}
              >
                <Text style={{ color: C.text, fontWeight: '600' }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryBtn, { opacity: assignMutation.isPending ? 0.6 : 1 }]}
                onPress={handleAssign}
                disabled={assignMutation.isPending}
              >
                {assignMutation.isPending ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.primaryBtnText}>Assign Driver</Text>
                )}
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ─── Bulk Assign Modal ──────────────────────────────────────────────────────

function BulkAssignModal({
  visible,
  onClose,
  orderIds,
  drivers,
  vehicles,
  dark,
}: {
  visible: boolean;
  onClose: () => void;
  orderIds: string[];
  drivers: Driver[];
  vehicles: Vehicle[];
  dark: boolean;
}) {
  const C = getColors(dark);
  const [driverId, setDriverId] = useState('');
  const [vehicleId, setVehicleId] = useState('');

  const bulkMutation = useApiMutation<unknown, unknown>(
    'post',
    '/orders/bulk-assign-driver',
    {
      invalidateKeys: [['admin-orders']],
      successMessage: `Driver assigned to ${orderIds.length} orders`,
      onSuccess: () => onClose(),
    },
  );

  const handleAssign = () => {
    if (!driverId) {
      Alert.alert('Validation', 'Please select a driver');
      return;
    }
    bulkMutation.mutate({
      orderIds,
      driverId,
      vehicleId: vehicleId || undefined,
    });
  };

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={[styles.pickerOverlay, { backgroundColor: C.overlay }]}>
        <View style={[styles.bottomSheet, { backgroundColor: C.modalBg }]}>
          <View style={styles.bottomSheetHandle} />
          <Text style={[styles.bottomSheetTitle, { color: C.text }]}>
            Bulk Assign ({orderIds.length} orders)
          </Text>

          <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}>
            <Text style={[styles.fieldLabel, { color: C.text }]}>Driver *</Text>
            {drivers.map((d) => (
              <TouchableOpacity
                key={d.driverId}
                style={[
                  styles.selectOption,
                  {
                    backgroundColor: driverId === d.driverId ? ACCENT : C.card,
                    borderColor: driverId === d.driverId ? ACCENT : C.cardBorder,
                  },
                ]}
                onPress={() => setDriverId(d.driverId)}
              >
                <Ionicons
                  name={driverId === d.driverId ? 'radio-button-on' : 'radio-button-off'}
                  size={18}
                  color={driverId === d.driverId ? '#fff' : C.textSecondary}
                />
                <Text
                  style={{
                    color: driverId === d.driverId ? '#fff' : C.text,
                    fontWeight: '600',
                    fontSize: 14,
                    marginLeft: 10,
                  }}
                >
                  {d.driverName}
                </Text>
              </TouchableOpacity>
            ))}

            <Text style={[styles.fieldLabel, { color: C.text, marginTop: 16 }]}>Vehicle</Text>
            <TouchableOpacity
              style={[
                styles.selectOption,
                {
                  backgroundColor: vehicleId === '' ? (dark ? '#334155' : '#eff6ff') : C.card,
                  borderColor: C.cardBorder,
                },
              ]}
              onPress={() => setVehicleId('')}
            >
              <Text style={{ color: C.textSecondary, fontSize: 14 }}>None</Text>
            </TouchableOpacity>
            {vehicles.map((v) => (
              <TouchableOpacity
                key={v.vehicleId}
                style={[
                  styles.selectOption,
                  {
                    backgroundColor: vehicleId === v.vehicleId ? ACCENT : C.card,
                    borderColor: vehicleId === v.vehicleId ? ACCENT : C.cardBorder,
                  },
                ]}
                onPress={() => setVehicleId(v.vehicleId)}
              >
                <Ionicons
                  name={vehicleId === v.vehicleId ? 'radio-button-on' : 'radio-button-off'}
                  size={18}
                  color={vehicleId === v.vehicleId ? '#fff' : C.textSecondary}
                />
                <Text
                  style={{
                    color: vehicleId === v.vehicleId ? '#fff' : C.text,
                    fontWeight: '600',
                    fontSize: 14,
                    marginLeft: 10,
                  }}
                >
                  {v.vehicleNumber}
                </Text>
              </TouchableOpacity>
            ))}

            <View style={styles.bottomSheetButtons}>
              <TouchableOpacity
                style={[styles.secondaryBtn, { borderColor: C.cardBorder }]}
                onPress={onClose}
              >
                <Text style={{ color: C.text, fontWeight: '600' }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryBtn, { opacity: bulkMutation.isPending ? 0.6 : 1 }]}
                onPress={handleAssign}
                disabled={bulkMutation.isPending}
              >
                {bulkMutation.isPending ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.primaryBtnText}>Assign to All</Text>
                )}
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ─── Delivery Confirmation Modal ────────────────────────────────────────────

function DeliveryConfirmationModal({
  visible,
  onClose,
  order,
  dark,
}: {
  visible: boolean;
  onClose: () => void;
  order: Order;
  dark: boolean;
}) {
  const C = getColors(dark);

  const [itemDeliveries, setItemDeliveries] = useState(
    order.items.map((item) => ({
      cylinderTypeId: item.cylinderTypeId,
      deliveredQuantity: String(item.quantity),
      emptiesCollected: '0',
    })),
  );
  const [notes, setNotes] = useState('');

  const deliverMutation = useApiMutation<unknown, unknown>(
    'post',
    `/orders/${order.orderId}/confirm-delivery`,
    {
      invalidateKeys: [['admin-orders']],
      successMessage: 'Delivery confirmed',
      onSuccess: () => onClose(),
    },
  );

  const updateDelivery = (
    index: number,
    field: 'deliveredQuantity' | 'emptiesCollected',
    value: string,
  ) => {
    const updated = [...itemDeliveries];
    updated[index] = { ...updated[index], [field]: value };
    setItemDeliveries(updated);
  };

  const handleConfirm = () => {
    deliverMutation.mutate({
      items: itemDeliveries.map((d) => ({
        cylinderTypeId: d.cylinderTypeId,
        deliveredQuantity: parseInt(d.deliveredQuantity, 10) || 0,
        emptiesCollected: parseInt(d.emptiesCollected, 10) || 0,
      })),
      notes: notes || undefined,
    });
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaView style={[styles.modalContainer, { backgroundColor: C.modalBg }]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
          {/* Header */}
          <View style={[styles.modalHeader, { borderBottomColor: C.divider }]}>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={24} color={C.text} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: C.text }]}>Confirm Delivery</Text>
            <TouchableOpacity
              onPress={handleConfirm}
              disabled={deliverMutation.isPending}
            >
              {deliverMutation.isPending ? (
                <ActivityIndicator size="small" color={ACCENT} />
              ) : (
                <Text style={[styles.modalSaveText, { color: '#22c55e' }]}>Confirm</Text>
              )}
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
            <View
              style={[
                styles.orderSummaryCard,
                { backgroundColor: C.card, borderColor: C.cardBorder },
              ]}
            >
              <Text style={[styles.orderNumber, { color: C.text }]}>{order.orderNumber}</Text>
              <Text style={[styles.customerName, { color: ACCENT }]}>{order.customerName}</Text>
              <Text style={[styles.infoText, { color: C.textSecondary, marginTop: 4 }]}>
                Delivery: {formatDate(order.deliveryDate)}
              </Text>
            </View>

            {order.items.map((item, index) => (
              <View
                key={item.orderItemId}
                style={[
                  styles.deliveryItemCard,
                  { backgroundColor: C.card, borderColor: C.cardBorder },
                ]}
              >
                <Text style={[styles.deliveryItemTitle, { color: C.text }]}>
                  {item.cylinderTypeName}
                </Text>
                <Text style={[styles.deliveryItemOrdered, { color: C.textSecondary }]}>
                  Ordered: {item.quantity}
                </Text>

                <View style={styles.deliveryFieldsRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.itemFieldLabel, { color: C.textSecondary }]}>
                      Delivered Qty
                    </Text>
                    <TextInput
                      style={[
                        styles.textInput,
                        { backgroundColor: C.inputBg, borderColor: C.inputBorder, color: C.text },
                      ]}
                      value={itemDeliveries[index].deliveredQuantity}
                      onChangeText={(v) =>
                        updateDelivery(index, 'deliveredQuantity', v.replace(/[^0-9]/g, ''))
                      }
                      keyboardType="number-pad"
                    />
                  </View>
                  <View style={{ width: 12 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.itemFieldLabel, { color: C.textSecondary }]}>
                      Empties Collected
                    </Text>
                    <TextInput
                      style={[
                        styles.textInput,
                        { backgroundColor: C.inputBg, borderColor: C.inputBorder, color: C.text },
                      ]}
                      value={itemDeliveries[index].emptiesCollected}
                      onChangeText={(v) =>
                        updateDelivery(index, 'emptiesCollected', v.replace(/[^0-9]/g, ''))
                      }
                      keyboardType="number-pad"
                    />
                  </View>
                </View>
              </View>
            ))}

            {/* Delivery notes */}
            <Text style={[styles.fieldLabel, { color: C.text, marginTop: 16 }]}>
              Delivery Notes
            </Text>
            <TextInput
              style={[
                styles.textInput,
                styles.textArea,
                { backgroundColor: C.card, borderColor: C.inputBorder, color: C.text },
              ]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Optional notes..."
              placeholderTextColor={C.textMuted}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />

            {/* Submit button */}
            <TouchableOpacity
              style={[
                styles.submitBtn,
                { backgroundColor: '#22c55e', opacity: deliverMutation.isPending ? 0.6 : 1 },
              ]}
              onPress={handleConfirm}
              disabled={deliverMutation.isPending}
            >
              {deliverMutation.isPending ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="checkmark-circle" size={20} color="#fff" />
                  <Text style={styles.submitBtnText}>Confirm Delivery</Text>
                </>
              )}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Dispatch Result Modal ───────────────────────────────────────────────────

function DispatchResultModal({
  visible,
  result,
  dark,
  onClose,
}: {
  visible: boolean;
  result: DispatchResponse;
  dark: boolean;
  onClose: () => void;
}) {
  const C = getColors(dark);
  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={[styles.pickerOverlay, { backgroundColor: C.overlay }]}>
        <View style={[styles.bottomSheet, { backgroundColor: C.modalBg, maxHeight: '85%' }]}>
          <View style={styles.bottomSheetHandle} />
          {/* Header */}
          <View style={[styles.modalHeader, { borderBottomColor: C.divider }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.modalTitle, { color: C.text }]}>Dispatch Results</Text>
              <Text style={[{ fontSize: 13, color: C.textSecondary, marginTop: 2 }]}>
                {result.summary.succeeded}/{result.summary.total} dispatched
                {result.summary.failed > 0 ? ` · ${result.summary.failed} failed` : ''}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={24} color={C.text} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24, gap: 10 }}>
            {result.results.map((r) => (
              <View
                key={r.orderId}
                style={[
                  styles.resultRow,
                  {
                    backgroundColor: r.success
                      ? dark ? 'rgba(34,197,94,0.12)' : '#f0fdf4'
                      : dark ? 'rgba(239,68,68,0.12)' : '#fef2f2',
                    borderColor: r.success ? '#22c55e' : '#ef4444',
                  },
                ]}
              >
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                  <Ionicons
                    name={r.success ? 'checkmark-circle' : 'close-circle'}
                    size={20}
                    color={r.success ? '#22c55e' : '#ef4444'}
                    style={{ marginTop: 1 }}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.resultOrderNum, { color: C.text }]}>{r.orderNumber}</Text>
                    <Text style={[{ fontSize: 12, color: C.textSecondary, marginTop: 1 }]}>
                      {r.customerName} · {r.mode}
                    </Text>
                    {r.success && r.mode !== 'GST_DISABLED' && (
                      <Text style={[{ fontSize: 12, color: C.textSecondary, marginTop: 4 }]}>
                        {r.mode === 'B2C'
                          ? `EWB: ${r.ewbNo ?? '—'}`
                          : `IRN: ${r.irn ? r.irn.substring(0, 20) + '…' : '—'}`}
                        {r.ewbValidTill ? `  ·  Valid till ${String(r.ewbValidTill).split('T')[0]}` : ''}
                      </Text>
                    )}
                    {!r.success && r.errorMessage && (
                      <Text style={[{ fontSize: 12, color: '#ef4444', marginTop: 4 }]}>
                        {r.errorMessage}
                      </Text>
                    )}
                  </View>
                </View>
              </View>
            ))}
          </ScrollView>

          <View style={{ paddingHorizontal: 16, paddingBottom: 20 }}>
            <TouchableOpacity style={styles.primaryBtn} onPress={onClose}>
              <Text style={styles.primaryBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  // Tab bar
  tabBar: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  tab: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 99,
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
  },

  // Search
  searchContainer: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  searchInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 40,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 0,
  },

  // Bulk bar
  bulkBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  bulkBarText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
  bulkBarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  bulkBarBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 13,
  },

  // List
  listContent: {
    padding: 16,
    paddingBottom: 100,
    gap: 10,
  },

  // Card
  card: {
    borderRadius: 14,
    padding: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  orderNumber: {
    fontWeight: '700',
    fontSize: 15,
  },
  customerName: {
    fontSize: 14,
    fontWeight: '500',
    marginTop: 2,
  },
  cardInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginTop: 10,
  },
  infoText: {
    fontSize: 12,
  },
  amountText: {
    fontWeight: '700',
    fontSize: 16,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 4,
    marginTop: 8,
    flexWrap: 'wrap',
  },
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  chipText: {
    fontSize: 11,
  },

  // Badge
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },

  // Expanded section
  expandedSection: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
  },
  itemDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  itemDetailName: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
  },
  itemDetailQty: {
    fontSize: 13,
    marginHorizontal: 12,
  },
  itemDetailPrice: {
    fontSize: 13,
    fontWeight: '600',
  },
  specialInstructions: {
    fontSize: 12,
    fontStyle: 'italic',
    marginTop: 8,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
    flexWrap: 'wrap',
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  actionBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 13,
  },

  // Empty state
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    marginTop: 12,
  },
  emptyDesc: {
    fontSize: 14,
    marginTop: 4,
  },

  // Loader
  loaderContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loaderText: {
    fontSize: 14,
  },

  // FAB
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },

  // Modal
  modalContainer: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  modalSaveText: {
    fontSize: 16,
    fontWeight: '700',
  },
  modalBody: {
    padding: 16,
    paddingBottom: 40,
  },

  // Fields
  fieldLabel: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  textInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  textArea: {
    minHeight: 80,
  },

  // Picker
  pickerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  pickerOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  pickerSheet: {
    maxHeight: '80%',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  pickerSheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  pickerSheetTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  pickerItem: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  pickerItemText: {
    fontSize: 15,
    fontWeight: '500',
  },
  pickerItemSub: {
    fontSize: 12,
    marginTop: 2,
  },
  pickerEmpty: {
    textAlign: 'center',
    paddingVertical: 24,
    fontSize: 14,
  },

  // Items section
  itemsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
    marginBottom: 6,
  },
  addItemBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
  },
  itemFieldLabel: {
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  cylinderChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  qtyContainer: {
    width: 100,
  },
  qtyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  qtyBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyInput: {
    width: 36,
    height: 28,
    borderWidth: 1,
    borderRadius: 6,
    fontSize: 14,
    fontWeight: '600',
    padding: 0,
  },
  removeItemBtn: {
    padding: 6,
  },

  // Submit
  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: ACCENT,
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 24,
  },
  submitBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 16,
  },

  // Bottom sheet
  bottomSheet: {
    maxHeight: '80%',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
  },
  bottomSheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#94a3b8',
    alignSelf: 'center',
    marginBottom: 12,
  },
  bottomSheetTitle: {
    fontSize: 17,
    fontWeight: '700',
    paddingHorizontal: 20,
    marginBottom: 16,
  },
  selectOption: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  bottomSheetButtons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 20,
  },
  secondaryBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  primaryBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: ACCENT,
  },
  primaryBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
  },

  // Delivery confirmation
  orderSummaryCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  deliveryItemCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  deliveryItemTitle: {
    fontWeight: '700',
    fontSize: 15,
  },
  deliveryItemOrdered: {
    fontSize: 12,
    marginTop: 2,
    marginBottom: 10,
  },
  deliveryFieldsRow: {
    flexDirection: 'row',
  },

  // Ready-to-dispatch / in-transit sections
  sectionBox: {
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 10,
    overflow: 'hidden',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  dispatchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: 1,
    gap: 10,
  },
  dispatchDriverName: {
    fontSize: 14,
    fontWeight: '600',
  },
  dispatchSubtext: {
    fontSize: 12,
    marginTop: 2,
  },
  dispatchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: ACCENT,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  dispatchBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  inTransitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: 1,
    gap: 10,
  },
  tripSheetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: ACCENT,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
  },
  tripSheetBtnText: {
    fontSize: 12,
    fontWeight: '700',
  },

  // Dispatch result modal
  resultRow: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  resultOrderNum: {
    fontWeight: '700',
    fontSize: 14,
  },
});
