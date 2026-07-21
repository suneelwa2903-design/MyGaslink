import { useState, useMemo, useCallback, useEffect } from 'react';
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
  StyleSheet,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { useTheme } from '../../src/theme';
import { useAuthStore } from '../../src/stores/authStore';
import { api, getErrorMessage } from '../../src/lib/api';
import { Badge, DateInput } from '../../src/components/ui';
import { LoadListDispatchModal } from '../../src/components/LoadListDispatchModal';
import { orderStatusLabel, orderStatusVariant, localTodayISO, localDateISO } from '@gaslink/shared';

// ─── Types ──────────────────────────────────────────────────────────────────

interface OrderItem {
  orderItemId: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  quantity: number;
  // API returns both deliveredQuantity and emptiesCollected when the
  // driver has confirmed delivery. Missing fields here previously hid
  // the modified-delivery numbers and the empties collected per stop.
  deliveredQuantity?: number | null;
  emptiesCollected?: number | null;
  unitPrice: number;
  totalPrice: number;
}

interface Order {
  orderId: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  // Flat alias surfaced by mapOrder. Used to gate the B2B-only PO Number
  // input in the edit modal.
  customerType?: 'B2B' | 'B2C' | null;
  deliveryDate: string;
  status: string;
  totalAmount: number;
  driverName?: string;
  driverId?: string;
  vehicleId?: string;
  specialInstructions?: string;
  // Buyer's PO snapshot. Null/undefined when the order has no PO.
  poNumber?: string | null;
  // Customer self-collected from godown — no driver/vehicle/EWB.
  isGodownPickup?: boolean;
  // Brief 3: on-demand backdated paper-trail entry. Display-only on mobile.
  isBackdated?: boolean;
  // Q2 (2026-07-09) — when set, the backdated banner reads "Inventory
  // adjusted" (green) instead of "Inventory not auto-updated" (amber).
  inventoryAdjustedAt?: string | null;
  createdAt?: string;
  items: OrderItem[];
}

interface Customer {
  customerId: string;
  customerName: string;
  phone?: string;
  // 'B2B' (gstin present) vs 'B2C' (no gstin). Drives B2B-only UI fields.
  customerType?: 'B2B' | 'B2C' | null;
}

interface Driver {
  driverId: string;
  driverName: string;
  phone?: string;
  // STAGE-B: vehicleNumber is the plate of the vehicle mapped to this
  // driver for TODAY (set by the daily Vehicle Mapping flow). The server
  // returns `null` for drivers without a mapping today. The Assign Driver
  // modal filters on this — only drivers with a mapping are selectable
  // because dispatch needs a vehicle, and the server resolves the
  // vehicle from this mapping (mobile no longer sends vehicleId).
  vehicleNumber?: string | null;
}

// STAGE-B: the `Vehicle` interface was used only by the Assign Driver +
// Bulk Assign vehicle pickers, both removed. Deleted to silence the
// no-unused-vars rule.

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
  { label: orderStatusLabel('pending_driver_assignment'), value: 'pending_driver_assignment' },
  { label: orderStatusLabel('pending_dispatch'), value: 'pending_dispatch' },
  // STAGE-A A5: 'preflight_in_progress' tab removed — Suneel found the
  // "Dispatching…" status confusing because it's a brief (~10-30s) NIC
  // preflight window, not a state operators need to filter by. Orders in
  // that state still appear under the "All" tab.
  { label: orderStatusLabel('pending_delivery'), value: 'pending_delivery' },
  { label: orderStatusLabel('delivered'), value: 'delivered' },
  { label: orderStatusLabel('modified_delivered'), value: 'modified_delivered' },
  { label: orderStatusLabel('cancelled'), value: 'cancelled' },
] as const;

// Mini-Operator (2026-07-17): reseller flow skips driver-assignment +
// dispatch (mini-op orders land directly in pending_delivery). Trim the
// filter strip so the tabs match the reachable statuses.
const MINI_OP_STATUS_TABS = [
  { label: 'All', value: 'all' },
  { label: orderStatusLabel('pending_delivery'), value: 'pending_delivery' },
  { label: orderStatusLabel('delivered'), value: 'delivered' },
  { label: orderStatusLabel('cancelled'), value: 'cancelled' },
] as const;

// STEP-3A: default date range = last 30 days, matches web OrdersPage default.
function getDateNDaysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return localDateISO(d);
}

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
    // STAGE-A A2: bumped from 0.6 → 0.85 so bottom-sheet backdrop fully
    // obscures the tab bar (was visible at ~40% through the dim layer).
    overlay: 'rgba(0,0,0,0.85)',
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
  return localTodayISO();
}

// ─── Main Screen ────────────────────────────────────────────────────────────

export default function AdminOrdersScreen() {
  const { dark } = useTheme();
  const C = getColors(dark);
  const user = useAuthStore((s) => s.user);
  const isMiniOperator = user?.role === 'mini_operator_admin';
  // Mini-op reseller flow never transitions through driver-assignment /
  // pending-dispatch / preflight — orders land directly in pending_delivery
  // then jump to delivered on Mark as Delivered. Hide those irrelevant
  // filter chips.
  const statusTabs = isMiniOperator ? MINI_OP_STATUS_TABS : STATUS_TABS;

  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);

  // STEP-3A: date range filter (default last 30 days, matches web OrdersPage).
  const [dateFrom, setDateFrom] = useState(getDateNDaysAgoISO(30));
  const [dateTo, setDateTo] = useState(getTodayISO());

  // Modal state
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [returnsModalVisible, setReturnsModalVisible] = useState(false);
  const [assignOrder, setAssignOrder] = useState<Order | null>(null);
  const [bulkAssignVisible, setBulkAssignVisible] = useState(false);
  const [deliverOrder, setDeliverOrder] = useState<Order | null>(null);
  // STEP-3A: edit / detail / cancel-with-reason modals.
  const [editOrder, setEditOrder] = useState<Order | null>(null);
  const [detailOrder, setDetailOrder] = useState<Order | null>(null);
  const [cancelOrder, setCancelOrder] = useState<Order | null>(null);

  // GST dispatch state
  const [dispatchingDriverId, setDispatchingDriverId] = useState<string | null>(null);
  const [dispatchResult, setDispatchResult] = useState<DispatchResponse | null>(null);
  const [dispatchResultVisible, setDispatchResultVisible] = useState(false);

  // FLOAT-001 (Round 2): two-step Load List → Dispatch flow. Tapping the
  // Dispatch button on a regular dispatch group opens this modal first;
  // the modal saves the load list, then hands off to the existing
  // handleDispatch via onDispatchNow. If the vehicle mapping has not yet
  // surfaced an assignmentId (rare), fall through to direct dispatch.
  const [loadListContext, setLoadListContext] = useState<{
    group: ReadyToDispatchGroup;
    driverName: string;
    vehicleNumber: string | null;
    assignmentId: string;
    tripNumber: number;
    orderItems: Array<{ cylinderTypeId: string; quantity: number }>;
  } | null>(null);

  // In-transit trip sheet download
  const [downloadingAssignmentId, setDownloadingAssignmentId] = useState<string | null>(null);

  // ─── Queries ────────────────────────────────────────────────────────────

  const queryParams: Record<string, unknown> = { pageSize: 50, page: 1 };
  if (statusFilter !== 'all') queryParams.status = statusFilter;
  // STEP-3A: pipe date range into the query — server already supports
  // dateFrom/dateTo params on /orders (mirrors web OrdersPage usage).
  if (dateFrom) queryParams.dateFrom = dateFrom;
  if (dateTo) queryParams.dateTo = dateTo;

  const {
    data: ordersData,
    isLoading,
    refetch,
    isRefetching,
  } = useApiQuery<{ orders: Order[]; total: number }>(
    ['admin-orders', statusFilter, dateFrom, dateTo],
    '/orders',
    queryParams,
  );

  // Item 1 (2026-07-09): the parent list holds only the RECENT 20 for the
  // picker's "recent" default view. Once the user starts typing, each picker
  // modal fires its own server-side `?search=` query (min 3 chars, 300 ms
  // debounce). A previously-picked customer that isn't in the recent 20
  // survives because the modal remembers the full Customer object it saw
  // at pick time — no round-trip needed for the selected-customer display.
  const { data: customersData } = useApiQuery<{ customers: Customer[] }>(
    ['customers-recent-mobile'],
    '/customers',
    { status: 'active', limit: 20 },
    { staleTime: 5 * 60 * 1000 },
  );

  // `vehicleNumber` here is "today's confirmed vehicle for this driver" —
  // recomputed server-side per request from the driver's DVA. The old
  // 5-min staleTime cached the empty pre-mapping response: open Orders
  // BEFORE confirming a mapping in Fleet, then map, then come back to
  // Orders within 5 min and the Assign Driver modal still shows
  // "No drivers have a vehicle today" until the cache expires.
  // refetchOnMount keeps the list fresh whenever the user lands on Orders.
  const { data: driversData } = useApiQuery<{ drivers: Driver[] }>(
    ['drivers-list'],
    '/drivers',
    {},
    { staleTime: 30 * 1000, refetchOnMount: 'always' },
  );

  // STAGE-B: /vehicles query removed — Assign / Bulk Assign modals no
  // longer let the user pick a vehicle directly. The server resolves the
  // vehicle from the driver's day-mapping (returned on /drivers as
  // `vehicleNumber`). Cuts an unnecessary query on every Orders mount.

  // Endpoint is `/api/cylinder-types` — not under `/inventory`. The
  // `/inventory/cylinder-types` URL 404s and silently breaks the
  // Create Order + Returns Order pickers on every fresh admin login.
  // The rest of the app uses the correct path; this was the lone
  // straggler. Other consumers also share the `['cylinder-types']`
  // query key, so once one screen loads them they're cached for all.
  const { data: cylinderTypesData } = useApiQuery<{ cylinderTypes: CylinderType[] }>(
    ['cylinder-types'],
    '/cylinder-types',
    {},
    { staleTime: 10 * 60 * 1000 },
  );

  const { data: inTransitData } = useApiQuery<{ drivers: InTransitDriver[] }>(
    ['admin-in-transit'],
    '/orders/in-transit',
    { date: getTodayISO() },
  );

  // FLOAT-001 (Round 2): today's vehicle mappings keyed by driver. The
  // LoadList modal needs assignmentId (DVA id) and tripNumber to read/save
  // the manifest. Same endpoint the web OrdersPage uses for its dispatch
  // card mapping lookup — returned shape mirrors what's documented there.
  const { data: vehicleMappingsData } = useApiQuery<{
    recommendations: Array<{
      driverId: string;
      vehicleNumber: string | null;
      assignmentId?: string;
      tripNumber?: number;
      status: string;
    }>;
  }>(
    ['admin-vehicle-mappings', getTodayISO()],
    '/assignments/vehicle-mappings',
    { date: getTodayISO() },
    { staleTime: 60 * 1000 },
  );
  const mappingByDriver = useMemo(
    () => new Map((vehicleMappingsData?.recommendations ?? []).map((m) => [m.driverId, m])),
    [vehicleMappingsData],
  );

  // ─── Mutations ──────────────────────────────────────────────────────────

  // STEP-3A: cancelMutation now carries a `reason` field. Server's cancel
  // route accepts it as `cancellation_reason` (see web's CancelOrderModal).
  const cancelMutation = useApiMutation<unknown, { orderId: string; reason: string }>(
    'post',
    (vars) => `/orders/${vars.orderId}/cancel`,
    {
      invalidateKeys: [['admin-orders']],
      successMessage: 'Order cancelled successfully',
      onSuccess: () => setCancelOrder(null),
    },
  );

  // ─── Derived data ──────────────────────────────────────────────────────

  const orders = ordersData?.orders ?? [];
  const customers = customersData?.customers ?? [];
  const drivers = driversData?.drivers ?? [];
  // STAGE-B: `vehicles` array dropped — the AssignDriver / BulkAssign
  // modals no longer take a vehicles prop.
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

  // STEP-3A: open CancelOrderModal so user provides a required reason.
  // Replaces the prior native Alert which had no reason field and gave a
  // copy mismatch versus the web confirmation message.
  const handleCancel = useCallback((order: Order) => setCancelOrder(order), []);

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

  const renderStatusBadge = (status: string) => (
    <Badge variant={orderStatusVariant(status)} label={orderStatusLabel(status)} />
  );

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
          {/* Header row — tapping the order # opens the read-only Detail modal,
              while tapping anywhere else on the card still expands. */}
          <View style={styles.cardHeader}>
            <View style={{ flex: 1 }}>
              <TouchableOpacity
                onPress={() => setDetailOrder(order)}
                hitSlop={{ top: 4, bottom: 4, left: 4, right: 8 }}
              >
                <Text style={[styles.orderNumber, { color: C.text, textDecorationLine: 'underline' }]}>
                  {order.orderNumber}
                </Text>
              </TouchableOpacity>
              <Text style={[styles.customerName, { color: ACCENT }]}>{order.customerName}</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {order.isBackdated && (
                <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: '#fef3c7', borderWidth: 1, borderColor: '#fbbf24' }}>
                  <Text style={{ color: '#92400e', fontSize: 10, fontWeight: '700' }}>ON-DEMAND</Text>
                </View>
              )}
              {renderStatusBadge(order.status)}
            </View>
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

          {/* Items summary chips. When the order is delivered show the
              actually-delivered qty (matches web OrdersPage `showDelivered`
              rule), with a parenthetical reminder of the ordered qty if
              it differs (partial / modified delivery). */}
          <View style={styles.chipRow}>
            {order.items?.map((item, i) => {
              const showDelivered = order.status === 'delivered' || order.status === 'modified_delivered';
              const displayedQty = showDelivered ? (item.deliveredQuantity ?? item.quantity) : item.quantity;
              return (
                <View key={i} style={[styles.chip, { backgroundColor: C.itemBg }]}>
                  <Text style={[styles.chipText, { color: C.textSecondary }]}>
                    {item.cylinderTypeName} x{displayedQty}
                    {showDelivered && displayedQty !== item.quantity ? ` (of ${item.quantity})` : ''}
                  </Text>
                </View>
              );
            })}
          </View>

          {/* Expanded section */}
          {isExpanded && (
            <View style={[styles.expandedSection, { borderTopColor: C.divider }]}>
              {/* Detailed items */}
              {order.items?.map((item, i) => {
                const showDelivered = order.status === 'delivered' || order.status === 'modified_delivered';
                const displayedQty = showDelivered ? (item.deliveredQuantity ?? item.quantity) : item.quantity;
                return (
                  <View key={i} style={styles.itemDetailRow}>
                    <Text style={[styles.itemDetailName, { color: C.text }]}>
                      {item.cylinderTypeName}
                    </Text>
                    <Text style={[styles.itemDetailQty, { color: C.textSecondary }]}>
                      {showDelivered
                        ? `Delivered: ${displayedQty} / ${item.quantity}${item.emptiesCollected != null ? `  Empties: ${item.emptiesCollected}` : ''}`
                        : `Qty: ${item.quantity}`}
                    </Text>
                    <Text style={[styles.itemDetailPrice, { color: C.text }]}>
                      {formatCurrency(item.totalPrice)}
                    </Text>
                  </View>
                );
              })}

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
                {/* STEP-3A: Edit only allowed while order is still in
                    pending_driver_assignment — matches web OrdersPage rule. */}
                {canAssign && (
                  <TouchableOpacity
                    style={[styles.actionBtn, { backgroundColor: '#6366f1' }]}
                    onPress={() => setEditOrder(order)}
                  >
                    <Ionicons name="pencil-outline" size={16} color="#fff" />
                    <Text style={styles.actionBtnText}>Edit</Text>
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
      {/* Status Filter Tabs.
          STAGE-A A1: `style={{ flexGrow: 0 }}` pins the ScrollView's height
          to its content. Without it, a horizontal ScrollView placed inside
          a flex column parent (SafeAreaView with flex:1) stretched its
          main-axis (height) and inflated the pills vertically. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={styles.tabBar}
      >
        {statusTabs.map((tab) => {
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

      {/* STAGE-C: native DateInput replaces the YYYY-MM-DD text inputs. */}
      <View style={styles.dateRangeRow}>
        <View style={{ flex: 1 }}>
          <DateInput value={dateFrom || null} onChange={setDateFrom} placeholder="From" />
        </View>
        <View style={{ flex: 1 }}>
          <DateInput value={dateTo || null} onChange={setDateTo} placeholder="To" />
        </View>
        {/* Item 7 (2026-07-09): the "Returns" trigger was removed —
            replace by the lightweight Empties Return flow on the web
            Inventory page (Daily Summary → Empties Return). The
            ReturnsOrderModal component + state stay so historical
            returns_only orders keep rendering; no new returns are
            created from mobile. */}
        {/* Bulk Assign discoverability: surface a visible button when any
            orders are in pending_driver_assignment. Long-press still works
            as the row-level multi-select trigger. Tapping this button
            arms the bulk-assign mode by auto-selecting all pending rows. */}
        {orders.some((o) => o.status === 'pending_driver_assignment') && (
          <TouchableOpacity
            style={[styles.returnsBtn, { borderColor: ACCENT, marginLeft: 6 }]}
            onPress={() => {
              const pendingIds = orders
                .filter((o) => o.status === 'pending_driver_assignment')
                .map((o) => o.orderId);
              if (selectedOrderIds.length === 0) {
                setSelectedOrderIds(pendingIds);
              } else {
                setBulkAssignVisible(true);
              }
            }}
          >
            <Ionicons name="car-outline" size={14} color={ACCENT} />
            <Text style={[styles.returnsBtnText, { color: ACCENT }]}>
              {selectedOrderIds.length > 0
                ? `Assign (${selectedOrderIds.length})`
                : 'Bulk Assign'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

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
                        onPress={() => {
                          const mapping = mappingByDriver.get(group.driverId);
                          // FLOAT-001 (Round 2): open the Load List modal when
                          // we have a DVA. Fall through to direct dispatch if
                          // the day's mapping hasn't surfaced an assignmentId
                          // yet (preflight uses driverId + date, not DVA id).
                          if (mapping?.assignmentId) {
                            const driverOrders = orders.filter((o) => o.driverId === group.driverId && o.status === 'pending_dispatch');
                            const orderItems = driverOrders.flatMap((o) =>
                              (o.items ?? []).map((it) => ({
                                cylinderTypeId: it.cylinderTypeId,
                                quantity: it.quantity,
                              })),
                            );
                            setLoadListContext({
                              group,
                              driverName: group.driverName,
                              vehicleNumber: mapping.vehicleNumber ?? null,
                              assignmentId: mapping.assignmentId,
                              tripNumber: mapping.tripNumber ?? 1,
                              orderItems,
                            });
                          } else {
                            handleDispatch(group);
                          }
                        }}
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
          recentCustomers={customers}
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

      {/* STEP-3A: new modals — Returns / Edit / Detail / Cancel-with-reason */}
      {returnsModalVisible && (
        <ReturnsOrderModal
          visible={returnsModalVisible}
          onClose={() => setReturnsModalVisible(false)}
          recentCustomers={customers}
          cylinderTypes={cylinderTypes}
          dark={dark}
        />
      )}

      {editOrder && (
        <EditOrderModal
          visible={!!editOrder}
          onClose={() => setEditOrder(null)}
          order={editOrder}
          cylinderTypes={cylinderTypes}
          dark={dark}
        />
      )}

      {detailOrder && (
        <OrderDetailModal
          visible={!!detailOrder}
          onClose={() => setDetailOrder(null)}
          order={detailOrder}
          dark={dark}
        />
      )}

      {cancelOrder && (
        <CancelOrderModal
          visible={!!cancelOrder}
          onClose={() => setCancelOrder(null)}
          order={cancelOrder}
          isSubmitting={cancelMutation.isPending}
          onSubmit={(reason) => cancelMutation.mutate({ orderId: cancelOrder.orderId, reason })}
          dark={dark}
        />
      )}

      {/* FLOAT-001 (Round 2): Load List → Dispatch two-step modal. Mounts only
          when the user taps Dispatch on a regular dispatch group with a
          confirmed vehicle mapping. The modal saves the load list and then
          calls onDispatchNow, which closes the modal and fires the existing
          handleDispatch (preflight + per-order result Alert). */}
      {loadListContext && (
        <LoadListDispatchModal
          visible
          driverName={loadListContext.driverName}
          vehicleNumber={loadListContext.vehicleNumber}
          assignmentId={loadListContext.assignmentId}
          tripNumber={loadListContext.tripNumber}
          orderItems={loadListContext.orderItems}
          onClose={() => setLoadListContext(null)}
          onDispatchNow={() => {
            const ctx = loadListContext;
            setLoadListContext(null);
            // Defer to next tick so the modal's close animation can start
            // before the dispatch result alert / state changes fire.
            setTimeout(() => handleDispatch(ctx.group), 0);
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
  recentCustomers,
  cylinderTypes,
  dark,
}: {
  visible: boolean;
  onClose: () => void;
  recentCustomers: Customer[];
  cylinderTypes: CylinderType[];
  dark: boolean;
}) {
  const C = getColors(dark);

  // Item 1 (2026-07-09): the picker holds the FULL Customer object it
  // saw at pick time in local state so a subsequent search (or the
  // parent's recent-20 cache turning over) doesn't lose the display
  // name / customerType we need for B2B gating.
  const [pickedCustomer, setPickedCustomer] = useState<Customer | null>(null);
  const [customerSearch, setCustomerSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showCustomerPicker, setShowCustomerPicker] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState(getTodayISO());
  const [specialInstructions, setSpecialInstructions] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [isGodownPickup, setIsGodownPickup] = useState(false);
  const [items, setItems] = useState([{ cylinderTypeId: '', quantity: '1' }]);

  // 300 ms debounce, min 3 chars — same shape as the web CustomerSearchInput.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(customerSearch.length >= 3 ? customerSearch : '');
    }, 300);
    return () => clearTimeout(timer);
  }, [customerSearch]);

  const {
    data: searchCustomersData,
    isFetching: isSearching,
  } = useApiQuery<{ customers: Customer[] }>(
    ['customer-search-mobile', debouncedSearch],
    '/customers',
    { search: debouncedSearch, status: 'active', pageSize: 10 },
    { enabled: debouncedSearch.length >= 3, staleTime: 30_000 },
  );

  const createMutation = useApiMutation<unknown, unknown>(
    'post',
    '/orders',
    {
      invalidateKeys: [['admin-orders']],
      successMessage: 'Order created successfully',
      onSuccess: () => onClose(),
    },
  );

  const selectedCustomer = pickedCustomer;
  const customerId = pickedCustomer?.customerId ?? '';
  // PO number is B2B-only; the input hides for B2C customers. Matches the
  // IRN payload emit gate in payloadBuilders so the wire shape and the UI
  // affordance stay in lock-step.
  const isB2bCustomer = selectedCustomer?.customerType === 'B2B';

  // What the picker list shows: search results when the user has typed
  // ≥3 chars, otherwise the recent-20 from the parent.
  const displayedCustomers: Customer[] = debouncedSearch.length >= 3
    ? (searchCustomersData?.customers ?? [])
    : recentCustomers;

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
      poNumber: poNumber.trim() || undefined,
      isGodownPickup,
      items: validItems.map((it) => ({
        cylinderTypeId: it.cylinderTypeId,
        quantity: parseInt(it.quantity, 10),
      })),
    });
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <SafeAreaProvider>
      <SafeAreaView edges={['top','bottom','left','right']} style={[styles.modalContainer, { backgroundColor: C.modalBg }]}>
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

            {/* Customer picker modal — KAV wrap is required because RN renders
                nested <Modal> in its own iOS presentation context, so the outer
                KAV on the Create Order form does NOT propagate inside. iOS only
                — behavior={undefined} on Android is a no-op and Android's
                adjustResize (Expo default) keeps working. See docs/IOS-KOF-AUDIT.md.
                Item 1 (2026-07-09): onRequestClose is required for Android
                hardware back to dismiss the picker (was missing, causing back-
                trap where the outer CreateOrderModal handled back instead). */}
            <Modal
              visible={showCustomerPicker}
              animationType="slide"
              transparent
              onRequestClose={() => setShowCustomerPicker(false)}
            >
              <View style={[styles.pickerOverlay, { backgroundColor: C.overlay }]}>
                <KeyboardAvoidingView
                  behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                  style={{ flex: 1, justifyContent: 'flex-end' }}
                >
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
                          placeholder="Type to search customers..."
                          placeholderTextColor={C.textMuted}
                          value={customerSearch}
                          onChangeText={setCustomerSearch}
                          autoFocus
                        />
                        {isSearching && (
                          <ActivityIndicator size="small" color={C.textMuted} style={{ marginLeft: 8 }} />
                        )}
                      </View>
                    </View>
                    <View style={{ paddingHorizontal: 16, paddingBottom: 6 }}>
                      <Text style={[styles.pickerItemSub, { color: C.textMuted, fontSize: 11 }]}>
                        {debouncedSearch.length >= 3 ? 'Search results' : 'Recent customers'}
                      </Text>
                    </View>
                    <FlatList
                      data={displayedCustomers}
                      keyExtractor={(c) => c.customerId}
                      keyboardShouldPersistTaps="handled"
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
                            setPickedCustomer(c);
                            setShowCustomerPicker(false);
                            setCustomerSearch('');
                            setDebouncedSearch('');
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
                          {debouncedSearch.length >= 3
                            ? (isSearching ? 'Searching…' : 'No customers found')
                            : 'No recent customers yet — type to search'}
                        </Text>
                      }
                    />
                  </View>
                </KeyboardAvoidingView>
              </View>
            </Modal>

            {/* Delivery date */}
            <Text style={[styles.fieldLabel, { color: C.text, marginTop: 16 }]}>
              Delivery Date *
            </Text>
            <DateInput
              value={deliveryDate || null}
              onChange={setDeliveryDate}
              placeholder="Select delivery date"
            />

            {/* PO Number — B2B only. Mirrors the IRN PoDtls emit gate so the
                input is visible exactly where the field flows to NIC. */}
            {isB2bCustomer && (
              <>
                <Text style={[styles.fieldLabel, { color: C.text, marginTop: 16 }]}>
                  PO Number
                </Text>
                <TextInput
                  style={[
                    styles.textInput,
                    { backgroundColor: C.card, borderColor: C.inputBorder, color: C.text },
                  ]}
                  value={poNumber}
                  onChangeText={(v) => setPoNumber(v.slice(0, 16))}
                  placeholder="Buyer's PO (max 16 chars)"
                  placeholderTextColor={C.textMuted}
                  maxLength={16}
                  autoCapitalize="characters"
                />
              </>
            )}

            {/* Godown Pickup toggle — skips driver assignment + dispatch.
                Mirrors web OrdersPage create modal. */}
            <TouchableOpacity
              onPress={() => setIsGodownPickup((v) => !v)}
              activeOpacity={0.7}
              style={{
                marginTop: 16,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                paddingVertical: 4,
              }}
            >
              <View
                style={{
                  width: 22, height: 22, borderRadius: 4,
                  borderWidth: 2,
                  borderColor: isGodownPickup ? ACCENT : C.inputBorder,
                  backgroundColor: isGodownPickup ? ACCENT : 'transparent',
                  alignItems: 'center', justifyContent: 'center',
                }}
              >
                {isGodownPickup ? (
                  <Ionicons name="checkmark" size={16} color="#ffffff" />
                ) : null}
              </View>
              <Text style={{ color: C.text, fontSize: 14, fontWeight: '500', flex: 1 }}>
                Godown Pickup (customer self-collects)
              </Text>
            </TouchableOpacity>
            {isGodownPickup && (
              <View style={{
                marginTop: 8,
                padding: 10,
                borderRadius: 8,
                backgroundColor: dark ? 'rgba(245, 158, 11, 0.15)' : '#fffbeb',
                borderWidth: 1,
                borderColor: dark ? 'rgba(245, 158, 11, 0.35)' : '#fde68a',
              }}>
                <Text style={{ fontSize: 12, color: dark ? '#fbbf24' : '#92400e' }}>
                  No driver/vehicle assigned. Confirm pickup via Confirm Delivery once the customer collects. No e-Way Bill generated.
                </Text>
              </View>
            )}

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
      </SafeAreaProvider>
    </Modal>
  );
}

// ─── Assign Driver Modal ────────────────────────────────────────────────────

function AssignDriverModal({
  visible,
  onClose,
  order,
  drivers,
  dark,
}: {
  visible: boolean;
  onClose: () => void;
  order: Order;
  drivers: Driver[];
  dark: boolean;
}) {
  const C = getColors(dark);
  const [driverId, setDriverId] = useState(order.driverId ?? '');

  // STAGE-B: only drivers with TODAY's vehicle mapping are dispatchable.
  // Server-side, dispatch resolves the vehicle from the daily DVA, not
  // from the request body. Filtering client-side keeps the picker honest
  // — an "Assign" against a driver with no mapping would either 400 or
  // silently dispatch without a vehicle plate.
  const mappedDrivers = useMemo(
    () => drivers.filter((d) => !!d.vehicleNumber),
    [drivers],
  );

  // STAGE-B: vehicleId removed from the mutation body — the server now
  // resolves the vehicle from the driver's day-mapping. Sending an
  // out-of-band vehicleId would have masked vehicle-mapping mistakes.
  const assignMutation = useApiMutation<unknown, { driverId: string }>(
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
    assignMutation.mutate({ driverId });
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={[styles.pickerOverlay, { backgroundColor: C.overlay }]}>
        <View style={[styles.bottomSheet, { backgroundColor: C.modalBg }]}>
          <View style={styles.bottomSheetHandle} />
          <Text style={[styles.bottomSheetTitle, { color: C.text }]}>
            Assign Driver - {order.orderNumber}
          </Text>

          <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}>
            {/* STAGE-B: Driver picker — list pre-filtered to drivers with
                TODAY's vehicle mapping. Each row shows the driver name +
                the mapped vehicle plate (single source of truth — the
                phone sub-line was redundant). Standalone Vehicle picker
                was removed because the server resolves the vehicle from
                the driver's day-mapping. */}
            <Text style={[styles.fieldLabel, { color: C.text }]}>Driver *</Text>
            {mappedDrivers.length === 0 ? (
              <View
                style={{
                  paddingVertical: 24,
                  paddingHorizontal: 16,
                  alignItems: 'center',
                  borderRadius: 10,
                  borderWidth: 1,
                  borderStyle: 'dashed',
                  borderColor: C.cardBorder,
                  backgroundColor: C.card,
                }}
              >
                <Ionicons name="car-outline" size={32} color={C.textMuted} />
                <Text
                  style={{
                    marginTop: 8,
                    fontSize: 14,
                    fontWeight: '600',
                    color: C.text,
                    textAlign: 'center',
                  }}
                >
                  No drivers have a vehicle today
                </Text>
                <Text
                  style={{
                    marginTop: 4,
                    fontSize: 12,
                    color: C.textSecondary,
                    textAlign: 'center',
                  }}
                >
                  Map drivers to vehicles in More → Fleet → Assignments
                  before assigning orders.
                </Text>
              </View>
            ) : (
              mappedDrivers.map((d) => (
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
                    <Text
                      style={{
                        color: driverId === d.driverId ? 'rgba(255,255,255,0.85)' : C.textSecondary,
                        fontSize: 12,
                        marginTop: 2,
                      }}
                    >
                      {d.vehicleNumber}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))
            )}

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
  dark,
}: {
  visible: boolean;
  onClose: () => void;
  orderIds: string[];
  drivers: Driver[];
  dark: boolean;
}) {
  const C = getColors(dark);
  const [driverId, setDriverId] = useState('');

  // STAGE-B: same rationale as AssignDriverModal — filter to drivers
  // with today's vehicle mapping, drop the standalone vehicle picker,
  // server resolves the vehicle from the day-mapping.
  const mappedDrivers = useMemo(
    () => drivers.filter((d) => !!d.vehicleNumber),
    [drivers],
  );

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
    });
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={[styles.pickerOverlay, { backgroundColor: C.overlay }]}>
        <View style={[styles.bottomSheet, { backgroundColor: C.modalBg }]}>
          <View style={styles.bottomSheetHandle} />
          <Text style={[styles.bottomSheetTitle, { color: C.text }]}>
            Bulk Assign ({orderIds.length} orders)
          </Text>

          <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}>
            {/* STAGE-B: list filtered to drivers with TODAY's vehicle
                mapping; row shows driver name + vehicle plate. Vehicle
                picker removed — server resolves it from the day-mapping. */}
            <Text style={[styles.fieldLabel, { color: C.text }]}>Driver *</Text>
            {mappedDrivers.length === 0 ? (
              <View
                style={{
                  paddingVertical: 24,
                  paddingHorizontal: 16,
                  alignItems: 'center',
                  borderRadius: 10,
                  borderWidth: 1,
                  borderStyle: 'dashed',
                  borderColor: C.cardBorder,
                  backgroundColor: C.card,
                }}
              >
                <Ionicons name="car-outline" size={32} color={C.textMuted} />
                <Text
                  style={{
                    marginTop: 8,
                    fontSize: 14,
                    fontWeight: '600',
                    color: C.text,
                    textAlign: 'center',
                  }}
                >
                  No drivers have a vehicle today
                </Text>
                <Text
                  style={{
                    marginTop: 4,
                    fontSize: 12,
                    color: C.textSecondary,
                    textAlign: 'center',
                  }}
                >
                  Map drivers to vehicles in More → Fleet → Assignments
                  before assigning orders.
                </Text>
              </View>
            ) : (
              mappedDrivers.map((d) => (
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
                    <Text
                      style={{
                        color:
                          driverId === d.driverId
                            ? 'rgba(255,255,255,0.85)'
                            : C.textSecondary,
                        fontSize: 12,
                        marginTop: 2,
                      }}
                    >
                      {d.vehicleNumber}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))
            )}

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
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={() => onClose()}
    >
      <SafeAreaProvider>
      <SafeAreaView edges={['top','bottom','left','right']} style={[styles.modalContainer, { backgroundColor: C.modalBg }]}>
        {/* Item 2 (2026-07-09) — Android KAV behavior needs to be 'height'
            (was undefined = no-op). keyboardVerticalOffset compensates
            for the modal header. Without this, the notes + delivered-qty
            + empties inputs sit under the keyboard on smaller Android
            phones. See docs/INVESTIGATION-JUL09-B.md item 2. */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
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
      </SafeAreaProvider>
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
  // Bottom inset must cover the gesture-bar / home indicator on devices
  // that have one. The literal `paddingBottom: 20` previously used here
  // was too small on phones with a tall safe-area inset, leaving the
  // Close button half-hidden behind the navigation bar.
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <SafeAreaProvider>
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

          {/* UBB C3 — redundant red Close button removed. The header X (above)
              is the consistent close affordance across every modal in the
              app; the full-width red bottom button was a second close that
              read as a stray "red bar at the bottom of the modal" (Suneel
              reported during SAA testing — see docs/IOS-UBB-AUDIT.md U2).
              The wrapper View stays because it carries the home-indicator
              floor from SAA C2 — see docs/IOS-SAA-AUDIT.md item 6. */}
          <View style={{ paddingBottom: Math.max(34, insets.bottom + 12) }} />
        </View>
      </View>
      </SafeAreaProvider>
    </Modal>
  );
}

// ─── STEP-3A: Returns Order Modal ───────────────────────────────────────────
// Returns-only orders carry no delivery items — just the empties the customer
// is sending back. Server flow: POST /orders with orderType='returns_only',
// items are cylinder types + quantities being returned.

function ReturnsOrderModal({
  visible,
  onClose,
  recentCustomers,
  cylinderTypes,
  dark,
}: {
  visible: boolean;
  onClose: () => void;
  recentCustomers: Customer[];
  cylinderTypes: CylinderType[];
  dark: boolean;
}) {
  const C = getColors(dark);

  // Item 1 (2026-07-09) — same server-side-search treatment as
  // CreateOrderModal above. This modal is currently unreachable from the
  // mobile admin UI (Item 7 removed the trigger button) but kept alive
  // for historical returns_only orders. Keeping the picker consistent
  // means if it's ever re-enabled it doesn't regress on the same bugs.
  const [pickedCustomer, setPickedCustomer] = useState<Customer | null>(null);
  const [customerSearch, setCustomerSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showCustomerPicker, setShowCustomerPicker] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState(getTodayISO());
  const [items, setItems] = useState([{ cylinderTypeId: '', quantity: '1' }]);
  const [specialInstructions, setSpecialInstructions] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(customerSearch.length >= 3 ? customerSearch : '');
    }, 300);
    return () => clearTimeout(timer);
  }, [customerSearch]);

  const {
    data: searchCustomersData,
    isFetching: isSearching,
  } = useApiQuery<{ customers: Customer[] }>(
    ['customer-search-mobile-returns', debouncedSearch],
    '/customers',
    { search: debouncedSearch, status: 'active', pageSize: 10 },
    { enabled: debouncedSearch.length >= 3, staleTime: 30_000 },
  );

  const mutation = useApiMutation<unknown, unknown>(
    'post',
    '/orders',
    {
      invalidateKeys: [['admin-orders']],
      successMessage: 'Returns order created',
      onSuccess: () => onClose(),
    },
  );

  const selectedCustomer = pickedCustomer;
  const customerId = pickedCustomer?.customerId ?? '';
  const displayedCustomers: Customer[] = debouncedSearch.length >= 3
    ? (searchCustomersData?.customers ?? [])
    : recentCustomers;

  const addItem = () => setItems([...items, { cylinderTypeId: '', quantity: '1' }]);
  const removeItem = (i: number) => items.length > 1 && setItems(items.filter((_, idx) => idx !== i));
  const updateItem = (i: number, field: 'cylinderTypeId' | 'quantity', value: string) => {
    const next = [...items];
    next[i] = { ...next[i], [field]: value };
    setItems(next);
  };

  const handleSubmit = () => {
    if (!customerId) return Alert.alert('Validation', 'Please select a customer');
    const validItems = items.filter((it) => it.cylinderTypeId && parseInt(it.quantity, 10) > 0);
    if (validItems.length === 0) return Alert.alert('Validation', 'Add at least one cylinder being returned');
    mutation.mutate({
      customerId,
      // OrderType enum value is `returns_only` (packages/shared enums).
      orderType: 'returns_only',
      deliveryDate,
      specialInstructions: specialInstructions || undefined,
      items: validItems.map((it) => ({
        cylinderTypeId: it.cylinderTypeId,
        quantity: parseInt(it.quantity, 10),
      })),
    });
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <SafeAreaProvider>
      <SafeAreaView edges={['top','bottom','left','right']} style={[styles.modalContainer, { backgroundColor: C.modalBg }]}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <View style={[styles.modalHeader, { borderBottomColor: C.divider }]}>
            <TouchableOpacity onPress={onClose}><Ionicons name="close" size={24} color={C.text} /></TouchableOpacity>
            <Text style={[styles.modalTitle, { color: C.text }]}>Returns Order</Text>
            <TouchableOpacity onPress={handleSubmit} disabled={mutation.isPending}>
              {mutation.isPending
                ? <ActivityIndicator size="small" color={ACCENT} />
                : <Text style={[styles.modalSaveText, { color: ACCENT }]}>Create</Text>}
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={[styles.fieldLabel, { color: C.text }]}>Customer *</Text>
            <TouchableOpacity
              style={[styles.pickerBtn, { backgroundColor: C.card, borderColor: C.inputBorder }]}
              onPress={() => setShowCustomerPicker(true)}
            >
              <Text style={{ color: selectedCustomer ? C.text : C.textMuted, fontSize: 15 }}>
                {selectedCustomer?.customerName ?? 'Select customer'}
              </Text>
              <Ionicons name="chevron-down" size={18} color={C.textMuted} />
            </TouchableOpacity>

            {/* Returns Order customer picker — same KAV-wrap rationale as the
                Create Order picker above (see comment there). Item 1
                (2026-07-09) — onRequestClose + server-side search treatment
                mirrors CreateOrderModal above. */}
            <Modal
              visible={showCustomerPicker}
              animationType="slide"
              transparent
              onRequestClose={() => setShowCustomerPicker(false)}
            >
              <View style={[styles.pickerOverlay, { backgroundColor: C.overlay }]}>
                <KeyboardAvoidingView
                  behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                  style={{ flex: 1, justifyContent: 'flex-end' }}
                >
                  <View style={[styles.pickerSheet, { backgroundColor: C.modalBg }]}>
                    <View style={[styles.pickerSheetHeader, { borderBottomColor: C.divider }]}>
                      <Text style={[styles.pickerSheetTitle, { color: C.text }]}>Select Customer</Text>
                      <TouchableOpacity onPress={() => setShowCustomerPicker(false)}>
                        <Ionicons name="close" size={24} color={C.text} />
                      </TouchableOpacity>
                    </View>
                    <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                      <View style={[styles.searchInputWrapper, { backgroundColor: C.card, borderColor: C.inputBorder }]}>
                        <Ionicons name="search-outline" size={16} color={C.textMuted} />
                        <TextInput
                          style={[styles.searchInput, { color: C.text }]}
                          placeholder="Type to search customers..."
                          placeholderTextColor={C.textMuted}
                          value={customerSearch}
                          onChangeText={setCustomerSearch}
                          autoFocus
                        />
                        {isSearching && (
                          <ActivityIndicator size="small" color={C.textMuted} style={{ marginLeft: 8 }} />
                        )}
                      </View>
                    </View>
                    <View style={{ paddingHorizontal: 16, paddingBottom: 6 }}>
                      <Text style={[styles.pickerItemSub, { color: C.textMuted, fontSize: 11 }]}>
                        {debouncedSearch.length >= 3 ? 'Search results' : 'Recent customers'}
                      </Text>
                    </View>
                    <FlatList
                      data={displayedCustomers}
                      keyExtractor={(c) => c.customerId}
                      keyboardShouldPersistTaps="handled"
                      renderItem={({ item }) => (
                        <TouchableOpacity
                          style={[styles.pickerRow, { borderBottomColor: C.divider }]}
                          onPress={() => {
                            setPickedCustomer(item);
                            setShowCustomerPicker(false);
                            setCustomerSearch('');
                            setDebouncedSearch('');
                          }}
                        >
                          <Text style={[styles.pickerRowText, { color: C.text }]}>{item.customerName}</Text>
                        </TouchableOpacity>
                      )}
                      ListEmptyComponent={
                        <Text style={[styles.pickerEmpty, { color: C.textMuted }]}>
                          {debouncedSearch.length >= 3
                            ? (isSearching ? 'Searching…' : 'No customers found')
                            : 'No recent customers yet — type to search'}
                        </Text>
                      }
                    />
                  </View>
                </KeyboardAvoidingView>
              </View>
            </Modal>

            <Text style={[styles.fieldLabel, { color: C.text }]}>Date *</Text>
            <DateInput
              value={deliveryDate || null}
              onChange={setDeliveryDate}
              placeholder="Select date"
            />

            <Text style={[styles.fieldLabel, { color: C.text }]}>Cylinders Being Returned *</Text>
            {items.map((item, i) => (
              <View key={i} style={styles.itemRow}>
                <View style={{ flex: 2 }}>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    {cylinderTypes.map((ct) => {
                      const active = item.cylinderTypeId === ct.cylinderTypeId;
                      return (
                        <TouchableOpacity
                          key={ct.cylinderTypeId}
                          style={[
                            styles.cylinderChip,
                            { backgroundColor: active ? ACCENT : C.tabBg, borderColor: active ? ACCENT : C.inputBorder },
                          ]}
                          onPress={() => updateItem(i, 'cylinderTypeId', ct.cylinderTypeId)}
                        >
                          <Text style={{ color: active ? '#fff' : C.text, fontSize: 12, fontWeight: '600' }}>
                            {ct.typeName}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
                <TextInput
                  style={[styles.qtyInput, { backgroundColor: C.card, borderColor: C.inputBorder, color: C.text }]}
                  keyboardType="numeric"
                  value={item.quantity}
                  onChangeText={(v) => updateItem(i, 'quantity', v.replace(/[^0-9]/g, ''))}
                />
                {items.length > 1 && (
                  <TouchableOpacity onPress={() => removeItem(i)} style={{ padding: 6 }}>
                    <Ionicons name="trash-outline" size={18} color="#ef4444" />
                  </TouchableOpacity>
                )}
              </View>
            ))}
            <TouchableOpacity style={[styles.addItemBtn, { borderColor: ACCENT }]} onPress={addItem}>
              <Ionicons name="add" size={16} color={ACCENT} />
              <Text style={{ color: ACCENT, fontWeight: '600', marginLeft: 4 }}>Add Cylinder Type</Text>
            </TouchableOpacity>

            <Text style={[styles.fieldLabel, { color: C.text }]}>Notes</Text>
            <TextInput
              style={[styles.textareaField, { backgroundColor: C.card, borderColor: C.inputBorder, color: C.text }]}
              placeholder="Optional notes about this return"
              placeholderTextColor={C.textMuted}
              value={specialInstructions}
              onChangeText={setSpecialInstructions}
              multiline
              numberOfLines={3}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

// ─── STEP-3A: Edit Order Modal ──────────────────────────────────────────────
// Reuses the same field structure as CreateOrderModal but pre-fills from the
// passed order and PUTs to /orders/:id. Surface only items + special
// instructions + delivery date; customer is not editable post-creation.

function EditOrderModal({
  visible,
  onClose,
  order,
  cylinderTypes,
  dark,
}: {
  visible: boolean;
  onClose: () => void;
  order: Order;
  cylinderTypes: CylinderType[];
  dark: boolean;
}) {
  const C = getColors(dark);

  const [deliveryDate, setDeliveryDate] = useState(String(order.deliveryDate).split('T')[0]);
  const [specialInstructions, setSpecialInstructions] = useState(order.specialInstructions ?? '');
  const [poNumber, setPoNumber] = useState(order.poNumber ?? '');
  const [items, setItems] = useState(
    (order.items ?? []).map((it) => ({
      cylinderTypeId: it.cylinderTypeId,
      quantity: String(it.quantity),
    })),
  );
  // PO is shown only when the order is for a B2B customer. mapOrder
  // surfaces customerType flat onto the wire shape so we can read it
  // here without traversing the nested customer relation.
  const isB2bCustomer = order.customerType === 'B2B';

  const mutation = useApiMutation<unknown, unknown>(
    'put',
    `/orders/${order.orderId}`,
    {
      invalidateKeys: [['admin-orders']],
      successMessage: 'Order updated',
      onSuccess: () => onClose(),
    },
  );

  const addItem = () => setItems([...items, { cylinderTypeId: '', quantity: '1' }]);
  const removeItem = (i: number) => items.length > 1 && setItems(items.filter((_, idx) => idx !== i));
  const updateItem = (i: number, field: 'cylinderTypeId' | 'quantity', value: string) => {
    const next = [...items];
    next[i] = { ...next[i], [field]: value };
    setItems(next);
  };

  const handleSubmit = () => {
    const validItems = items.filter((it) => it.cylinderTypeId && parseInt(it.quantity, 10) > 0);
    if (validItems.length === 0) return Alert.alert('Validation', 'Order must have at least one item');
    if (!deliveryDate) return Alert.alert('Validation', 'Please enter a delivery date');
    mutation.mutate({
      deliveryDate,
      specialInstructions: specialInstructions || undefined,
      poNumber: poNumber.trim() || undefined,
      items: validItems.map((it) => ({
        cylinderTypeId: it.cylinderTypeId,
        quantity: parseInt(it.quantity, 10),
      })),
    });
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaProvider>
      <SafeAreaView edges={['top','bottom','left','right']} style={[styles.modalContainer, { backgroundColor: C.modalBg }]}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <View style={[styles.modalHeader, { borderBottomColor: C.divider }]}>
            <TouchableOpacity onPress={onClose}><Ionicons name="close" size={24} color={C.text} /></TouchableOpacity>
            <Text style={[styles.modalTitle, { color: C.text }]}>Edit {order.orderNumber}</Text>
            <TouchableOpacity onPress={handleSubmit} disabled={mutation.isPending}>
              {mutation.isPending
                ? <ActivityIndicator size="small" color={ACCENT} />
                : <Text style={[styles.modalSaveText, { color: ACCENT }]}>Save</Text>}
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={[styles.fieldLabel, { color: C.text }]}>Customer</Text>
            <View style={[styles.readOnlyField, { backgroundColor: C.card, borderColor: C.inputBorder }]}>
              <Text style={{ color: C.text, fontSize: 15 }}>{order.customerName}</Text>
            </View>

            <Text style={[styles.fieldLabel, { color: C.text }]}>Delivery Date *</Text>
            <DateInput
              value={deliveryDate || null}
              onChange={setDeliveryDate}
              placeholder="Select delivery date"
            />

            {isB2bCustomer && (
              <>
                <Text style={[styles.fieldLabel, { color: C.text }]}>PO Number</Text>
                <TextInput
                  style={[styles.textInput, { backgroundColor: C.card, borderColor: C.inputBorder, color: C.text }]}
                  value={poNumber}
                  onChangeText={(v) => setPoNumber(v.slice(0, 16))}
                  placeholder="Buyer's PO (max 16 chars)"
                  placeholderTextColor={C.textMuted}
                  maxLength={16}
                  autoCapitalize="characters"
                />
              </>
            )}

            <Text style={[styles.fieldLabel, { color: C.text }]}>Items *</Text>
            {items.map((item, i) => (
              <View key={i} style={styles.itemRow}>
                <View style={{ flex: 2 }}>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    {cylinderTypes.map((ct) => {
                      const active = item.cylinderTypeId === ct.cylinderTypeId;
                      return (
                        <TouchableOpacity
                          key={ct.cylinderTypeId}
                          style={[
                            styles.cylinderChip,
                            { backgroundColor: active ? ACCENT : C.tabBg, borderColor: active ? ACCENT : C.inputBorder },
                          ]}
                          onPress={() => updateItem(i, 'cylinderTypeId', ct.cylinderTypeId)}
                        >
                          <Text style={{ color: active ? '#fff' : C.text, fontSize: 12, fontWeight: '600' }}>
                            {ct.typeName}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
                <TextInput
                  style={[styles.qtyInput, { backgroundColor: C.card, borderColor: C.inputBorder, color: C.text }]}
                  keyboardType="numeric"
                  value={item.quantity}
                  onChangeText={(v) => updateItem(i, 'quantity', v.replace(/[^0-9]/g, ''))}
                />
                {items.length > 1 && (
                  <TouchableOpacity onPress={() => removeItem(i)} style={{ padding: 6 }}>
                    <Ionicons name="trash-outline" size={18} color="#ef4444" />
                  </TouchableOpacity>
                )}
              </View>
            ))}
            <TouchableOpacity style={[styles.addItemBtn, { borderColor: ACCENT }]} onPress={addItem}>
              <Ionicons name="add" size={16} color={ACCENT} />
              <Text style={{ color: ACCENT, fontWeight: '600', marginLeft: 4 }}>Add Item</Text>
            </TouchableOpacity>

            <Text style={[styles.fieldLabel, { color: C.text }]}>Special Instructions</Text>
            <TextInput
              style={[styles.textareaField, { backgroundColor: C.card, borderColor: C.inputBorder, color: C.text }]}
              placeholder="Optional"
              placeholderTextColor={C.textMuted}
              value={specialInstructions}
              onChangeText={setSpecialInstructions}
              multiline
              numberOfLines={3}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

// ─── STEP-3A: Order Detail Modal (read-only) ────────────────────────────────
// Tapping the order number opens this view. No mutations — just everything
// the card already has plus line items, special instructions, status badge,
// and (if cancelled) the cancellation reason.

function OrderDetailModal({
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
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={[styles.modalContainer, { backgroundColor: C.modalBg }]}>
        <View style={[styles.modalHeader, { borderBottomColor: C.divider }]}>
          <TouchableOpacity onPress={onClose}><Ionicons name="close" size={24} color={C.text} /></TouchableOpacity>
          <Text style={[styles.modalTitle, { color: C.text }]}>{order.orderNumber}</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView contentContainerStyle={styles.modalBody}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text style={[styles.customerName, { color: ACCENT, flex: 1 }]}>{order.customerName}</Text>
            <Badge variant={orderStatusVariant(order.status)} label={orderStatusLabel(order.status)} />
          </View>

          {/* Brief 3 — backdated banner for the audit trail.
              Q2 (2026-07-09) — banner colour + copy now reflect the
              actual state via `order.inventoryAdjustedAt`. Green when
              adjusted, amber when still pending. */}
          {order.isBackdated && (
            order.inventoryAdjustedAt ? (
              <View style={{ marginBottom: 12, padding: 10, borderRadius: 6, backgroundColor: '#dcfce7', borderWidth: 1, borderColor: '#34d399' }}>
                <Text style={{ color: '#065f46', fontSize: 12, fontWeight: '700' }}>
                  On-demand order
                </Text>
                <Text style={{ color: '#065f46', fontSize: 11, marginTop: 2 }}>
                  Delivery recorded for {formatDate(order.deliveryDate)}. Inventory adjusted on {new Date(order.inventoryAdjustedAt).toLocaleDateString('en-IN')}.
                  {order.createdAt ? ` Entered on ${new Date(order.createdAt).toLocaleDateString('en-IN')}.` : ''}
                </Text>
              </View>
            ) : (
              <View style={{ marginBottom: 12, padding: 10, borderRadius: 6, backgroundColor: '#fef3c7', borderWidth: 1, borderColor: '#fbbf24' }}>
                <Text style={{ color: '#92400e', fontSize: 12, fontWeight: '700' }}>
                  On-demand order
                </Text>
                <Text style={{ color: '#92400e', fontSize: 11, marginTop: 2 }}>
                  Delivery recorded for {formatDate(order.deliveryDate)}. Inventory not yet adjusted — run it from Inventory → On-Demand Adjustments.
                  {order.createdAt ? ` Entered on ${new Date(order.createdAt).toLocaleDateString('en-IN')}.` : ''}
                </Text>
              </View>
            )
          )}

          <Text style={[styles.fieldLabel, { color: C.textSecondary, fontSize: 12 }]}>Delivery Date</Text>
          <Text style={[{ color: C.text, fontSize: 15, marginBottom: 12 }]}>{formatDate(order.deliveryDate)}</Text>

          <Text style={[styles.fieldLabel, { color: C.textSecondary, fontSize: 12 }]}>Driver</Text>
          <Text style={[{ color: C.text, fontSize: 15, marginBottom: 12 }]}>{order.driverName || 'Unassigned'}</Text>

          {order.poNumber ? (
            <>
              <Text style={[styles.fieldLabel, { color: C.textSecondary, fontSize: 12 }]}>PO No.</Text>
              <Text style={[{ color: C.text, fontSize: 15, marginBottom: 12 }]}>{order.poNumber}</Text>
            </>
          ) : null}

          <Text style={[styles.fieldLabel, { color: C.textSecondary, fontSize: 12 }]}>Total Amount</Text>
          <Text style={[{ color: C.text, fontSize: 18, fontWeight: '700', marginBottom: 16 }]}>
            {formatCurrency(order.totalAmount)}
          </Text>

          <Text style={[styles.fieldLabel, { color: C.text }]}>Items</Text>
          {order.items?.map((item, i) => {
            const showDelivered = order.status === 'delivered' || order.status === 'modified_delivered';
            const displayedQty = showDelivered ? (item.deliveredQuantity ?? item.quantity) : item.quantity;
            return (
              <View key={i} style={[styles.itemDetailRow, { borderBottomColor: C.divider, borderBottomWidth: 1, paddingVertical: 8 }]}>
                <Text style={[styles.itemDetailName, { color: C.text }]}>{item.cylinderTypeName}</Text>
                <Text style={[styles.itemDetailQty, { color: C.textSecondary }]}>
                  {showDelivered
                    ? `Delivered: ${displayedQty} / ${item.quantity}${item.emptiesCollected != null ? `  Empties: ${item.emptiesCollected}` : ''}`
                    : `Qty: ${item.quantity}`}
                </Text>
                <Text style={[styles.itemDetailPrice, { color: C.text }]}>{formatCurrency(item.totalPrice)}</Text>
              </View>
            );
          })}

          {order.specialInstructions ? (
            <>
              <Text style={[styles.fieldLabel, { color: C.text, marginTop: 16 }]}>Special Instructions</Text>
              <Text style={[{ color: C.textSecondary, fontSize: 14 }]}>{order.specialInstructions}</Text>
            </>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── STEP-3A: Cancel Order Modal (reason required) ──────────────────────────
// Replaces the prior Alert.alert flow. Reason is required and is sent to the
// server as `cancellation_reason` to match the web CancelOrderModal payload.

function CancelOrderModal({
  visible,
  onClose,
  order,
  isSubmitting,
  onSubmit,
  dark,
}: {
  visible: boolean;
  onClose: () => void;
  order: Order;
  isSubmitting: boolean;
  onSubmit: (reason: string) => void;
  dark: boolean;
}) {
  const C = getColors(dark);
  const [reason, setReason] = useState('');

  const handleSubmit = () => {
    if (!reason.trim()) {
      Alert.alert('Reason required', 'Please enter a reason for cancellation.');
      return;
    }
    onSubmit(reason.trim());
  };

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onClose}
    >
      <View style={[styles.pickerOverlay, { backgroundColor: C.overlay }]}>
        <View style={[styles.cancelSheet, { backgroundColor: C.modalBg }]}>
          <Text style={[styles.modalTitle, { color: C.text, textAlign: 'left', marginBottom: 6 }]}>
            Cancel {order.orderNumber}
          </Text>
          <Text style={{ color: C.textSecondary, fontSize: 13, marginBottom: 12 }}>
            This will cancel the order. No invoice has been generated yet. This cannot be undone.
          </Text>
          <Text style={[styles.fieldLabel, { color: C.text }]}>Reason *</Text>
          <TextInput
            style={[styles.textareaField, { backgroundColor: C.card, borderColor: C.inputBorder, color: C.text }]}
            placeholder="e.g. customer requested cancellation"
            placeholderTextColor={C.textMuted}
            value={reason}
            onChangeText={setReason}
            multiline
            numberOfLines={3}
            autoFocus
          />

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
            <TouchableOpacity
              style={[styles.cancelActionBtn, { backgroundColor: C.tabBg }]}
              onPress={onClose}
              disabled={isSubmitting}
            >
              <Text style={{ color: C.text, fontWeight: '600' }}>Go Back</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.cancelActionBtn, { backgroundColor: '#ef4444' }]}
              onPress={handleSubmit}
              disabled={isSubmitting}
            >
              {isSubmitting
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={{ color: '#fff', fontWeight: '700' }}>Cancel Order</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────


const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  // Tab bar — STAGE-A A1: pinned height + alignItems:'center' so pills
  // can't be vertically inflated by the parent flex column.
  tabBar: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    alignItems: 'center',
  },
  tab: {
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    flexShrink: 0,
    justifyContent: 'center',
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
    // UBB C2 U5 — bumped 100 → 120 for end-of-scroll FAB clearance
    // (FAB at line ~2662, 56×56 @ bottom:24 needs 80 + 16 buffer = 96
    // minimum; 120 gives extra breathing room since order cards have
    // larger heights than fleet rows).
    paddingBottom: 120,
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
    // Keep the customer list bounded. Without this, long customer lists can
    // grow taller than the viewport on Android and push the header/search
    // off-screen, making the picker look like a raw full-screen list.
    maxHeight: '82%',
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

  // STEP-3A — date-range filter row + Returns button
  dateRangeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 4,
  },
  dateInputWrapper: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 4,
  },
  dateInput: {
    flex: 1,
    fontSize: 12,
    padding: 0,
  },
  returnsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    gap: 4,
  },
  returnsBtnText: {
    fontSize: 12,
    fontWeight: '700',
  },

  // STEP-3A — generic modal fields (Edit / Returns / Cancel)
  inputField: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    marginBottom: 6,
  },
  textareaField: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 6,
    minHeight: 72,
    textAlignVertical: 'top',
  },
  readOnlyField: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 6,
  },

  // STEP-3A — Cancel Order modal (centered bottom sheet)
  cancelSheet: {
    margin: 16,
    borderRadius: 16,
    padding: 18,
    alignSelf: 'center',
    width: '90%',
    maxWidth: 420,
  },
  cancelActionBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // STEP-3A — customer picker rows (reused by Returns + Edit + Detail flows)
  pickerRow: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  pickerRowText: {
    fontSize: 15,
  },
});
