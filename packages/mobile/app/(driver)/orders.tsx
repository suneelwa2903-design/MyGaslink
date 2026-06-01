import { useEffect, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, Alert, Modal, TextInput, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { useApiQuery } from '../../src/hooks/useApi';
import { Button, Badge, EmptyState } from '../../src/components/ui';
import { DeliveryProofCamera } from '../../src/components/DeliveryProofCamera';
import { useTheme, ACCENT, formatINR, formatDate } from '../../src/theme';
import type { Order } from '@gaslink/shared';
import { orderStatusLabel, orderStatusVariant } from '@gaslink/shared';
import { apiPost, getErrorMessage } from '../../src/lib/api';
import {
  enqueueDelivery,
  isNetworkError,
  subscribePendingDeliveries,
  syncPendingDeliveries,
  type QueuedDelivery,
} from '../../src/services/deliveryQueue';

/**
 * Per-item delivery state — what the driver actually entered for delivered
 * count and empties returned. Keyed by cylinderTypeId so we can look it up
 * when rendering each row. Kept as strings (not numbers) so the TextInput
 * binding doesn't fight an empty field while the driver is mid-typing —
 * we coerce to number only at submit time.
 */
type DeliveryItemEntry = { delivered: string; empties: string };

export default function DriverOrdersScreen() {
  const { dark, colors } = useTheme();
  const queryClient = useQueryClient();
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [deliveryNotes, setDeliveryNotes] = useState('');
  const [showCamera, setShowCamera] = useState(false);
  const [proofPhoto, setProofPhoto] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pendingQueue, setPendingQueue] = useState<QueuedDelivery[]>([]);
  const [deliveryItems, setDeliveryItems] = useState<Record<string, DeliveryItemEntry>>({});

  useEffect(() => {
    const unsub = subscribePendingDeliveries(setPendingQueue);
    return () => { unsub(); };
  }, []);

  // Seed editable qty state when the modal opens. We default delivered to
  // the ordered quantity (the most common case — full delivery) and empties
  // to 0 (the driver explicitly fills this in based on what the customer
  // handed back). When the modal closes (selectedOrder → null) the state
  // is wiped so a stale entry from order A can't leak into order B.
  // Done during render (React's "adjust state when a value changes" pattern)
  // instead of an effect, to avoid the extra render pass.
  const [seededFor, setSeededFor] = useState<Order | null>(null);
  if (selectedOrder !== seededFor) {
    setSeededFor(selectedOrder);
    if (!selectedOrder) {
      setDeliveryItems({});
    } else {
      const seed: Record<string, DeliveryItemEntry> = {};
      for (const item of selectedOrder.items ?? []) {
        seed[item.cylinderTypeId] = {
          delivered: String(item.quantity ?? 0),
          empties: '0',
        };
      }
      setDeliveryItems(seed);
    }
  }

  const pendingOrderIds = new Set(pendingQueue.map((p) => p.orderId));

  const { data: ordersResponse, isLoading, refetch } = useApiQuery<{ orders: Order[] }>(
    ['driver-orders'],
    '/orders',
    { status: 'pending_delivery' },
    // Polling reduced from 30s → 5min. The driver layout owns an SSE stream
    // (services/sseService.ts) that invalidates ['driver-orders'] on every
    // order_assigned / order_updated event, so the screen refetches the
    // instant the server commits. The 5-min interval is a fallback for the
    // case where the SSE socket has silently dropped (e.g. cellular handoff)
    // and reconnect hasn't kicked in yet.
    { refetchInterval: 300_000 },
  );
  const orders: Order[] = ordersResponse?.orders ?? [];

  const submitDelivery = async (orderId: string, items: { cylinderTypeId: string; deliveredQuantity: number; emptiesCollected: number }[]) => {
    setConfirming(true);
    try {
      await apiPost(`/orders/${orderId}/confirm-delivery`, { items, notes: deliveryNotes || undefined });
      Alert.alert('Success', 'Delivery confirmed!');
      queryClient.invalidateQueries({ queryKey: ['driver-orders'] });
      // WI-097: also refresh the Trip tab so the order's new status (delivered/
      // modified_delivered) and updated stock/EWBs show without a manual reload.
      queryClient.invalidateQueries({ queryKey: ['driver-active-trip'] });
      queryClient.invalidateQueries({ queryKey: ['driver-trip-stock'] });
      queryClient.invalidateQueries({ queryKey: ['driver-trip-ewbs'] });
      setSelectedOrder(null);
      setDeliveryNotes('');
      setProofPhoto(null);
    } catch (err) {
      if (isNetworkError(err)) {
        await enqueueDelivery({ orderId, items, notes: deliveryNotes || undefined });
        Alert.alert('Saved offline', 'No network. Delivery will sync automatically when you\'re back online.');
        setSelectedOrder(null);
        setDeliveryNotes('');
        setProofPhoto(null);
      } else {
        Alert.alert('Error', getErrorMessage(err));
      }
    } finally {
      setConfirming(false);
    }
  };

  const handleManualSync = async () => {
    const r = await syncPendingDeliveries();
    queryClient.invalidateQueries({ queryKey: ['driver-orders'] });
    // WI-097: queued deliveries that just synced also changed trip state.
    queryClient.invalidateQueries({ queryKey: ['driver-active-trip'] });
    queryClient.invalidateQueries({ queryKey: ['driver-trip-stock'] });
    queryClient.invalidateQueries({ queryKey: ['driver-trip-ewbs'] });
    Alert.alert(
      r.synced > 0 ? 'Synced' : 'Sync attempted',
      `${r.synced} delivery${r.synced === 1 ? '' : 'ies'} synced. ${r.remaining} still pending.`,
    );
  };


  /**
   * Open the modal for an order. The inline "Deliver" button on the card
   * used to fire a quick Alert that submitted ordered-qty + 0 empties, but
   * that path is gone now: every delivery flows through the modal so the
   * driver can correct the delivered count *and* enter empties — the
   * field the API already supports but the UI never exposed.
   */
  const handleDelivery = (order: Order) => {
    setSelectedOrder(order);
  };

  /**
   * Read the driver-entered qty/empties from state, validate, and submit.
   * Validation is intentionally light — match the API's Zod schema
   * (`min(0)`, integer) and stop there. We don't enforce
   * `delivered <= ordered`: short deliveries are legal (the service writes
   * a cancelled_stock_event for the difference, see orderService.ts).
   */
  const handleConfirmFromModal = () => {
    if (!selectedOrder) return;
    const items: { cylinderTypeId: string; deliveredQuantity: number; emptiesCollected: number }[] = [];
    let hasQtyMismatch = false;
    for (const orderItem of selectedOrder.items ?? []) {
      const entry = deliveryItems[orderItem.cylinderTypeId];
      const delivered = Number.parseInt(entry?.delivered ?? '0', 10);
      const empties = Number.parseInt(entry?.empties ?? '0', 10);
      if (Number.isNaN(delivered) || delivered < 0 || Number.isNaN(empties) || empties < 0) {
        Alert.alert('Invalid quantity', `Check "${orderItem.cylinderTypeName}" — quantities must be 0 or higher.`);
        return;
      }
      // WI-104: a delivered count that differs from the ordered qty triggers
      // a GST reissue on the invoice — warn the driver before submitting.
      if (delivered !== orderItem.quantity) hasQtyMismatch = true;
      items.push({
        cylinderTypeId: orderItem.cylinderTypeId,
        deliveredQuantity: delivered,
        emptiesCollected: empties,
      });
    }

    // WI-109: block an all-zero delivery. A delivery where nothing was handed
    // over is not a "modified delivery" — it's an order that didn't happen, and
    // must be cancelled by an admin (which voids the invoice + EWB) rather than
    // confirmed. Per-item 0 is still allowed as long as the total is > 0
    // (legitimate partial delivery: some types delivered, others refused).
    const totalDelivered = items.reduce((sum, i) => sum + i.deliveredQuantity, 0);
    if (totalDelivered === 0) {
      Alert.alert(
        'Nothing delivered',
        'Delivered quantity must be at least 1. If this delivery could not happen, ask your admin to cancel this order.',
        [{ text: 'OK' }],
      );
      return;
    }

    const orderId = selectedOrder.orderId;
    if (hasQtyMismatch) {
      Alert.alert(
        'Quantity mismatch',
        'Delivered quantity differs from ordered quantity. This will trigger a GST reissue on the invoice. Do you want to continue?',
        [
          { text: 'Review', style: 'cancel' },
          { text: 'Continue', onPress: () => submitDelivery(orderId, items) },
        ],
      );
      return;
    }

    submitDelivery(orderId, items);
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 10 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>
            {orders?.length ?? 0} deliveries pending
          </Text>
          {pendingQueue.length > 0 && (
            <TouchableOpacity onPress={handleManualSync} style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              backgroundColor: dark ? 'rgba(245,158,11,0.15)' : '#fffbeb',
              paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
            }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: dark ? '#fbbf24' : '#92400e' }}>
                {pendingQueue.length} pending sync · tap to retry
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {(!orders || orders.length === 0) ? (
          <EmptyState title="No pending deliveries" description="You're all caught up! Check back later." />
        ) : (
          orders.map((order) => (
            <View
              key={order.orderId}
              style={{
                backgroundColor: colors.cardBg, borderRadius: 14, padding: 16,
                borderWidth: 1, borderColor: colors.cardBorder,
              }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>{order.orderNumber}</Text>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: ACCENT.blue, marginTop: 2 }}>
                    {order.customerName}
                  </Text>
                </View>
                {pendingOrderIds.has(order.orderId)
                  ? <Badge label="pending sync" variant="warning" />
                  : <Badge label={orderStatusLabel(order.status || '')} variant={orderStatusVariant(order.status || '')} />}
              </View>

              <View style={{ marginTop: 10, gap: 4 }}>
                {order.items?.map((item, i) => (
                  <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 13, color: colors.textSecondary }}>{item.cylinderTypeName}</Text>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>x {item.quantity}</Text>
                  </View>
                ))}
              </View>

              {order.specialInstructions && (
                <View style={{
                  marginTop: 8,
                  backgroundColor: dark ? 'rgba(245,158,11,0.12)' : '#fffbeb',
                  padding: 8,
                  borderRadius: 8,
                }}>
                  <Text style={{ fontSize: 12, color: dark ? '#fbbf24' : '#92400e' }}>
                    Note: {order.specialInstructions}
                  </Text>
                </View>
              )}

              <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                <View style={{ flex: 1 }}>
                  <Button title="View Details" variant="secondary" size="sm" onPress={() => setSelectedOrder(order)} />
                </View>
                {order.status === 'pending_delivery' && !pendingOrderIds.has(order.orderId) && (
                  <View style={{ flex: 1 }}>
                    <Button title="Deliver" variant="accent" size="sm" onPress={() => handleDelivery(order)} />
                  </View>
                )}
              </View>
            </View>
          ))
        )}
      </ScrollView>

      {/* Delivery Detail Modal.
          Why the extra props:
          - `presentationStyle="overFullScreen"` is the iOS knob that lets a
            transparent modal cover the full window including the tab bar;
            without it the modal renders inside the screen frame and the
            bottom tab strip bleeds through under the sheet.
          - `statusBarTranslucent` is the Android equivalent for the status
            bar — needed for the dark overlay to paint edge-to-edge on
            Android 11+ edge-to-edge layouts. */}
      <Modal
        visible={!!selectedOrder}
        animationType="slide"
        transparent
        presentationStyle="overFullScreen"
        statusBarTranslucent
      >
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <View style={{
            backgroundColor: colors.cardBg,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            padding: 24,
          }}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 16 }}>
              Order: {selectedOrder?.orderNumber}
            </Text>

            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.textSecondary }}>Customer</Text>
                <Text style={{ fontWeight: '600', color: colors.text }}>{selectedOrder?.customerName}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.textSecondary }}>Delivery Date</Text>
                <Text style={{ fontWeight: '600', color: colors.text }}>{formatDate(selectedOrder?.deliveryDate)}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.textSecondary }}>Total</Text>
                <Text style={{ fontWeight: '700', color: colors.text }}>
                  {formatINR(selectedOrder?.totalAmount)}
                </Text>
              </View>
            </View>

            <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text, marginTop: 16, marginBottom: 8 }}>Items</Text>
            {selectedOrder?.status === 'pending_delivery' ? (
              // Editable rows — driver enters delivered count + empties
              // returned per cylinder type. Defaults seeded in the effect
              // above (ordered qty / 0).
              selectedOrder?.items?.map((item) => {
                const entry = deliveryItems[item.cylinderTypeId] ?? { delivered: String(item.quantity ?? 0), empties: '0' };
                return (
                  <View key={item.cylinderTypeId} style={{ marginBottom: 10 }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 6 }}>
                      {item.cylinderTypeName}
                      <Text style={{ fontWeight: '400', color: colors.textMuted }}> (ordered: {item.quantity})</Text>
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>Delivered Qty (max {item.quantity})</Text>
                        <TextInput
                          value={entry.delivered}
                          onChangeText={(v) => {
                            // Clamp to the ordered quantity on the client so a
                            // driver tap-fumble can't submit an over-delivery
                            // (the server also rejects it). Strip non-digits.
                            const digits = v.replace(/[^0-9]/g, '');
                            const max = item.quantity ?? 0;
                            const n = digits === '' ? '' : String(Math.min(Number(digits), max));
                            setDeliveryItems((prev) => ({
                              ...prev,
                              [item.cylinderTypeId]: { ...prev[item.cylinderTypeId], delivered: n },
                            }));
                          }}
                          keyboardType="number-pad"
                          selectionColor={ACCENT.red}
                          style={{
                            borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 10,
                            paddingHorizontal: 12, paddingVertical: 10, fontSize: 15,
                            backgroundColor: colors.inputBg, color: colors.text,
                          }}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>Empties Collected</Text>
                        <TextInput
                          value={entry.empties}
                          onChangeText={(v) =>
                            setDeliveryItems((prev) => ({
                              ...prev,
                              [item.cylinderTypeId]: { ...prev[item.cylinderTypeId], empties: v.replace(/[^0-9]/g, '') },
                            }))
                          }
                          keyboardType="number-pad"
                          selectionColor={ACCENT.red}
                          style={{
                            borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 10,
                            paddingHorizontal: 12, paddingVertical: 10, fontSize: 15,
                            backgroundColor: colors.inputBg, color: colors.text,
                          }}
                        />
                      </View>
                    </View>
                  </View>
                );
              })
            ) : (
              // Read-only for already-delivered / cancelled orders.
              selectedOrder?.items?.map((item, i) => (
                <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}>
                  <Text style={{ color: colors.textSecondary }}>{item.cylinderTypeName}</Text>
                  <Text style={{ fontWeight: '600', color: colors.text }}>
                    Qty: {item.quantity} | {formatINR(item.unitPrice)}/unit
                  </Text>
                </View>
              ))
            )}

            {/* Delivery Proof Photo */}
            <View style={{ marginTop: 16 }}>
              <Text style={{ fontSize: 13, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>Delivery Proof Photo</Text>
              {proofPhoto ? (
                <View>
                  <Image source={{ uri: proofPhoto }} style={{ width: '100%', height: 180, borderRadius: 12 }} resizeMode="cover" />
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                    <Button title="Retake" variant="secondary" size="sm" onPress={() => setShowCamera(true)} style={{ flex: 1 }} />
                    <Button title="Remove" variant="ghost" size="sm" onPress={() => setProofPhoto(null)} style={{ flex: 1 }} />
                  </View>
                </View>
              ) : (
                <TouchableOpacity
                  onPress={() => setShowCamera(true)}
                  style={{
                    borderWidth: 2, borderColor: colors.cardBorder, borderStyle: 'dashed',
                    borderRadius: 12, padding: 24, alignItems: 'center',
                    backgroundColor: dark ? colors.inputBg : undefined,
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={{ fontSize: 32, marginBottom: 4 }}>📸</Text>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: ACCENT.blue }}>Take Photo</Text>
                  <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>Optional proof of delivery</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={{ marginTop: 12 }}>
              <Text style={{ fontSize: 13, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>Delivery Notes</Text>
              <TextInput
                value={deliveryNotes}
                onChangeText={setDeliveryNotes}
                placeholder="Optional delivery notes..."
                placeholderTextColor={colors.textMuted}
                multiline
                numberOfLines={3}
                style={{
                  borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 12,
                  padding: 12, fontSize: 14, textAlignVertical: 'top',
                  backgroundColor: colors.inputBg, color: colors.text,
                }}
              />
            </View>

            <View style={{ flexDirection: 'row', gap: 12, marginTop: 16 }}>
              <View style={{ flex: 1 }}>
                <Button title="Close" variant="secondary" onPress={() => { setSelectedOrder(null); setDeliveryNotes(''); setProofPhoto(null); }} />
              </View>
              {selectedOrder?.status === 'pending_delivery' && (
                <View style={{ flex: 1 }}>
                  <Button
                    title={confirming ? 'Confirming…' : 'Confirm Delivery'}
                    variant="accent"
                    onPress={handleConfirmFromModal}
                    loading={confirming}
                  />
                </View>
              )}
            </View>
          </View>
        </View>
      </Modal>

      {/* Camera Modal */}
      <DeliveryProofCamera
        visible={showCamera}
        onCapture={(uri) => { setProofPhoto(uri); setShowCamera(false); }}
        onClose={() => setShowCamera(false)}
      />
    </SafeAreaView>
  );
}
