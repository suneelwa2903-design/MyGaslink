import { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  Alert,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useApiQuery } from '../../src/hooks/useApi';
import { Button, Badge, EmptyState } from '../../src/components/ui';
import { useTheme, ACCENT, formatINR, formatDate } from '../../src/theme';
import type { Order } from '@gaslink/shared';
import { orderStatusLabel, orderStatusVariant } from '@gaslink/shared';
import { apiPost, apiDelete, getErrorMessage } from '../../src/lib/api';
import {
  enqueueDelivery,
  isNetworkError,
  subscribePendingDeliveries,
  syncPendingDeliveries,
  type QueuedDelivery,
} from '../../src/services/deliveryQueue';
// Proof-of-collection Phase 1 (2026-07-15) — signature capture wiring.
import { captureDeliveryLocation } from '../../src/services/location';
import { uploadToPresignedUrl } from '../../src/services/s3Upload';
import { SignaturePad } from '../../src/components/SignaturePad';

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
  const router = useRouter();
  // NEW-4 + NEW-5 (2026-06-09): root-SafeAreaProvider insets feed both edges
  // of the Confirm Delivery modal sheet — top to clear the iOS status bar /
  // Android notch on tall sheets (long item lists push the sheet upward),
  // bottom to clear the iOS home indicator / Android gesture pill. Same
  // pattern as the customer modal sweep in P0-3 / P0-4 / P0-3b. The
  // modal's own SafeAreaProvider wrap at line ~316 is iOS UIWindow
  // insurance, not the inset reader for this sheet (per the P0-3 fix's
  // commit body — root SAP wins).
  const insets = useSafeAreaInsets();
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [deliveryNotes, setDeliveryNotes] = useState('');
  // FLOAT-001 (2026-06-17): walk-in order modal visibility.
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pendingQueue, setPendingQueue] = useState<QueuedDelivery[]>([]);
  const [deliveryItems, setDeliveryItems] = useState<Record<string, DeliveryItemEntry>>({});
  // Proof-of-collection Phase 1 (2026-07-15) — proof-capture state.
  // Lives on the parent so the "Confirm Delivery" gate can read
  // proofCaptured directly (avoids a state-lifting round trip).
  const [proofCaptured, setProofCaptured] = useState(false);
  const [proofS3Key, setProofS3Key] = useState<string | null>(null);
  const [signingPartyPhone, setSigningPartyPhone] = useState('');
  const [signatureBase64, setSignatureBase64] = useState<string | null>(null);
  const [proofUploading, setProofUploading] = useState(false);
  const [proofError, setProofError] = useState<string | null>(null);
  const [proofLat, setProofLat] = useState<number | null>(null);
  const [proofLng, setProofLng] = useState<number | null>(null);

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
      // Reset proof state when the modal closes so state from order A
      // can't leak into a fresh order B open.
      setProofCaptured(false);
      setProofS3Key(null);
      setSigningPartyPhone('');
      setSignatureBase64(null);
      setProofUploading(false);
      setProofError(null);
      setProofLat(null);
      setProofLng(null);
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
    } catch (err) {
      if (isNetworkError(err)) {
        // Proof-of-collection Phase 1: if we captured proof metadata on
        // this attempt, ride it into the offline queue so the sync flush
        // can POST /delivery-proof before /confirm-delivery on retry.
        // Only the S3 KEY is queued — the signature PNG bytes were
        // already uploaded to S3 successfully by handleUploadProof.
        await enqueueDelivery({
          orderId,
          items,
          notes: deliveryNotes || undefined,
          ...(proofS3Key && proofCaptured
            ? {
                proofType: 'signature',
                proofS3Key,
                proofSigningPartyPhone: signingPartyPhone,
                proofCapturedLat: proofLat ?? undefined,
                proofCapturedLng: proofLng ?? undefined,
              }
            : {}),
        });
        Alert.alert('Saved offline', 'No network. Delivery will sync automatically when you\'re back online.');
        setSelectedOrder(null);
        setDeliveryNotes('');
      } else {
        Alert.alert('Error', getErrorMessage(err));
      }
    } finally {
      setConfirming(false);
    }
  };

  // D3 (2026-07-10) — driver can cancel their own walk-in orders that
  // haven't yet been delivered. Confirmation dialog + DELETE call. Cache
  // invalidations mirror submitDelivery so the Trip + Stock + EWB tabs
  // refresh at the same time.
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const handleCancelWalkIn = (order: Order) => {
    Alert.alert(
      'Cancel walk-in order',
      `Cancel order ${order.orderNumber} for ${order.customerName ?? 'customer'}? This cannot be undone.`,
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Cancel order',
          style: 'destructive',
          onPress: async () => {
            setCancellingId(order.orderId as unknown as string);
            try {
              await apiDelete(`/drivers/me/orders/${order.orderId}`);
              Alert.alert('Cancelled', `${order.orderNumber} cancelled.`);
              queryClient.invalidateQueries({ queryKey: ['driver-orders'] });
              queryClient.invalidateQueries({ queryKey: ['driver-active-trip'] });
              queryClient.invalidateQueries({ queryKey: ['driver-trip-stock'] });
              queryClient.invalidateQueries({ queryKey: ['driver-trip-ewbs'] });
            } catch (err) {
              Alert.alert('Could not cancel', getErrorMessage(err));
            } finally {
              setCancellingId(null);
            }
          },
        },
      ],
    );
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
  /**
   * Proof-of-collection Phase 1 (2026-07-15): upload the captured
   * signature to S3, capture GPS, then POST proof metadata to the
   * server. Runs BEFORE confirm-delivery so proof-idempotency stays
   * decoupled from delivery-idempotency (plan §R1). GPS failure returns
   * null and is stored as null — proof is not blocked by GPS.
   */
  const handleUploadProof = async () => {
    if (!selectedOrder || !signatureBase64) return;
    if (!signingPartyPhone || signingPartyPhone.length < 10) {
      setProofError('Phone number required (min 10 digits)');
      return;
    }
    setProofUploading(true);
    setProofError(null);
    try {
      // 1. Get presigned URL from server (validates driver + order + flag).
      const { uploadUrl, s3Key } = await apiPost<{ uploadUrl: string; finalUrl: string; s3Key: string }>(
        `/orders/${selectedOrder.orderId}/delivery-proof-upload-url`,
        { proofType: 'signature' },
      );

      // 2. Convert bare base64 to a Blob for PUT.
      const dataUri = `data:image/png;base64,${signatureBase64}`;
      const response = await fetch(dataUri);
      const blob = await response.blob();

      // 3. Upload to S3.
      await uploadToPresignedUrl(uploadUrl, blob, 'image/png');

      // 4. Capture GPS (best-effort, never blocks).
      const location = await captureDeliveryLocation();
      setProofLat(location?.lat ?? null);
      setProofLng(location?.lng ?? null);

      // 5. POST proof metadata to server (upsert-by-orderId).
      await apiPost(`/orders/${selectedOrder.orderId}/delivery-proof`, {
        proofType: 'signature',
        proofS3Key: s3Key,
        proofSigningPartyPhone: signingPartyPhone,
        capturedLat: location?.lat,
        capturedLng: location?.lng,
      });

      setProofS3Key(s3Key);
      setProofCaptured(true);
    } catch (err) {
      setProofError(getErrorMessage(err) || 'Failed to upload proof. Please try again.');
    } finally {
      setProofUploading(false);
    }
  };

  const handleConfirmFromModal = () => {
    if (!selectedOrder) return;
    // Proof-of-collection Phase 1: if the customer requires verification,
    // block submit until proof was captured (button gate already renders
    // as disabled, but defense-in-depth here in case something else
    // triggers this handler).
    if (selectedOrder.customerRequiresVerification && !proofCaptured) {
      Alert.alert(
        'Proof required',
        'This customer requires delivery verification. Please capture a signature above before confirming.',
      );
      return;
    }
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
                {/* D3 (2026-07-10) — driver-side cancel for own walk-in orders,
                    only when still cancellable. Not shown for regular orders
                    (those go through office cancel), delivered walk-ins (already
                    completed), or when a delivery sync is pending for this row. */}
                {order.orderSource === 'walk_in'
                  && ['pending_dispatch', 'pending_delivery'].includes(order.status ?? '')
                  && !pendingOrderIds.has(order.orderId) && (
                  <View style={{ flex: 1 }}>
                    <Button
                      title={cancellingId === order.orderId ? 'Cancelling…' : 'Cancel'}
                      variant="danger"
                      size="sm"
                      disabled={cancellingId === order.orderId}
                      onPress={() => handleCancelWalkIn(order)}
                    />
                  </View>
                )}
              </View>
              {/* WI-PENDING-PAYMENTS post-smoke FIX-B: the per-row Submit
                  Payment button was removed. Payment submission now lives
                  INSIDE the View Details modal (search for "Submit Payment"
                  in the modal block below) so the driver always reviews
                  the order before reporting a payment against it. */}
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
      {/* KAV wrap on iOS so the keyboard doesn't obscure the multiline
          "Delivery Notes" TextInput + the "Confirm Delivery" button at the
          bottom of the sheet. behavior={undefined} on Android is a no-op;
          AndroidManifest's default adjustResize (Expo's default for unset
          softwareKeyboardLayoutMode) keeps Android working as before. See
          docs/IOS-KOF-AUDIT.md. */}
      <Modal
        visible={!!selectedOrder}
        animationType="slide"
        transparent
        presentationStyle="overFullScreen"
        statusBarTranslucent
        onRequestClose={() => { setSelectedOrder(null); setDeliveryNotes(''); }}
      >
        <SafeAreaProvider>
        {/* Item 2 (2026-07-09) — Android KAV behavior must be 'height'
            (was undefined = no-op). keyboardVerticalOffset compensates
            for the modal chrome. Without this the Delivered Qty / Empties
            / Notes inputs sit under the keyboard on smaller Android
            phones. See docs/INVESTIGATION-JUL09-B.md item 2. */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
          style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}
        >
          <View style={{
            backgroundColor: colors.cardBg,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            // NEW-4: the sheet had no maxHeight and no inner ScrollView, so
            // a multi-item delivery (Suneel's dist-002 tests use 4 cylinder
            // types: 5kg + 19kg + 47.5kg + 425kg) made the sheet taller
            // than the screen. With justifyContent: 'flex-end' that pushed
            // the sheet's TOP edge above the iOS status bar / Android
            // notch — Suneel reported "Items" overlapping the time display
            // on iPhone, and the top items were unreachable.
            // NEW-5: paddingBottom: 24 + insets.bottom matches P0-3 / P0-4
            // / P0-3b — Confirm Delivery button + Delivery Notes input row
            // sit above the home indicator / gesture pill.
            // STRUCTURAL: maxHeight: '88%' caps the sheet so it never
            // crosses the safe area top, and the inner ScrollView (added
            // below) lets the driver reach every cylinder row regardless
            // of order size. The title and the button row stay PINNED at
            // the top + bottom edges of the sheet — only the middle
            // (info, items, photo, notes) scrolls. flexShrink: 1 on the
            // ScrollView is required so it actually compresses + scrolls
            // when content height exceeds the available middle space; by
            // default RN ScrollView is flexShrink: 0 and would render its
            // full natural height past the parent's maxHeight clip.
            paddingTop: 24 + insets.top,
            paddingHorizontal: 24,
            paddingBottom: 24 + insets.bottom,
            maxHeight: '88%',
          }}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 16 }}>
              Order: {selectedOrder?.orderNumber}
            </Text>

            <ScrollView
              style={{ flexShrink: 1 }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator
            >
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

            {/* Proof-of-collection Phase 1 (2026-07-15): signature capture
                gated on customer.requireDeliveryVerification. Phase 1
                exposes signature only; photo (Phase 2) and OTP (Phase 3)
                will add tabs here later. When the customer's flag is
                false (or missing — most legacy customers), this block
                renders nothing and the modal behaves exactly as before. */}
            {selectedOrder?.customerRequiresVerification && selectedOrder.status === 'pending_delivery' && (
              <View style={{ marginTop: 16, gap: 10 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>
                  Verification Required
                </Text>
                <Text style={{ fontSize: 12, color: colors.textSecondary }}>
                  Capture the customer&apos;s signature and mobile number to complete this delivery.
                </Text>
                <SignaturePad
                  onCapture={(base64) => {
                    setSignatureBase64(base64);
                    setProofError(null);
                  }}
                  onClear={() => {
                    setSignatureBase64(null);
                    setProofS3Key(null);
                    setProofCaptured(false);
                    setProofError(null);
                  }}
                  signingPartyPhone={signingPartyPhone}
                  onPhoneChange={setSigningPartyPhone}
                  phoneError={proofError && proofError.toLowerCase().includes('phone') ? proofError : undefined}
                />
                {signatureBase64 && signingPartyPhone.length >= 10 && !proofCaptured && (
                  <Button
                    title={proofUploading ? 'Uploading…' : 'Upload signature'}
                    variant="accent"
                    onPress={handleUploadProof}
                    loading={proofUploading}
                  />
                )}
                {proofCaptured && (
                  <Text style={{ fontSize: 13, fontWeight: '600', color: '#059669' }}>
                    ✓ Signature captured — ready to confirm delivery
                  </Text>
                )}
                {proofError && !proofError.toLowerCase().includes('phone') && (
                  <Text style={{ fontSize: 12, color: '#dc2626' }}>{proofError}</Text>
                )}
              </View>
            )}

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
            </ScrollView>

            <View style={{ flexDirection: 'row', gap: 12, marginTop: 16 }}>
              <View style={{ flex: 1 }}>
                <Button title="Close" variant="secondary" onPress={() => { setSelectedOrder(null); setDeliveryNotes(''); }} />
              </View>
              {selectedOrder?.status === 'pending_delivery' && (
                <View style={{ flex: 1 }}>
                  <Button
                    title={confirming ? 'Confirming…' : 'Confirm Delivery'}
                    variant="accent"
                    onPress={handleConfirmFromModal}
                    loading={confirming}
                    disabled={
                      confirming
                      || (!!selectedOrder?.customerRequiresVerification && !proofCaptured)
                    }
                  />
                  {!!selectedOrder?.customerRequiresVerification && !proofCaptured && (
                    <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 4, textAlign: 'center' }}>
                      Capture signature above to enable
                    </Text>
                  )}
                </View>
              )}
            </View>
            {/* WI-PENDING-PAYMENTS post-smoke FIX-B: Submit Payment moved
                here from the order row. Visible when there's an amount
                worth collecting and the order is in a status where the
                driver might be holding cash (pending_delivery, delivered,
                modified_delivered). Tapping closes this modal and routes
                to submit-payment with the order + customer context
                pre-filled. */}
            {selectedOrder
              && (selectedOrder.totalAmount ?? 0) > 0
              && (selectedOrder.status === 'pending_delivery'
                || selectedOrder.status === 'delivered'
                || selectedOrder.status === 'modified_delivered') && (
              <View style={{ marginTop: 10 }}>
                <Button
                  title="Submit Payment"
                  variant="secondary"
                  onPress={() => {
                    const order = selectedOrder;
                    setSelectedOrder(null);
                    setDeliveryNotes('');
                    router.push({
                      pathname: '/(driver)/submit-payment',
                      params: {
                        orderId: order.orderId,
                        customerId: order.customerId,
                        customerName: order.customerName ?? '',
                        prefillAmount: order.totalAmount?.toFixed(2) ?? '',
                      },
                    });
                  }}
                />
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
        </SafeAreaProvider>
      </Modal>

      {/* FLOAT-001 (2026-06-17): walk-in order FAB + modal */}
      <TouchableOpacity
        onPress={() => setWalkInOpen(true)}
        activeOpacity={0.85}
        style={{
          position: 'absolute',
          right: 16,
          bottom: 24,
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: ACCENT.red,
          alignItems: 'center',
          justifyContent: 'center',
          shadowColor: '#000',
          shadowOpacity: 0.25,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 3 },
          elevation: 6,
        }}
      >
        <Text style={{ color: '#fff', fontSize: 28, fontWeight: '700', lineHeight: 30 }}>+</Text>
      </TouchableOpacity>
      <WalkInOrderModal
        visible={walkInOpen}
        onClose={() => setWalkInOpen(false)}
        onCreated={() => {
          setWalkInOpen(false);
          queryClient.invalidateQueries({ queryKey: ['driver-orders'] });
          queryClient.invalidateQueries({ queryKey: ['driver-trip-stock'] });
        }}
      />
    </SafeAreaView>
  );
}

// ─── FLOAT-001: Walk-In Order Modal ─────────────────────────────────────────
// Compact 1-screen flow. Customer picker (search by name/phone) + cylinder
// type + quantity. POSTs /api/drivers/me/orders. Surfaces server errors
// (INSUFFICIENT_VEHICLE_STOCK, NO_ACTIVE_TRIP, etc.) inline.

interface CustomerRow {
  customerId: string;
  customerName: string;
  phone?: string | null;
  customerType?: string;
}
interface CylinderTypeRow {
  // FLOAT-001 (2026-06-18) — field is `cylinderTypeId` not `id` in the
  // /api/cylinder-types response. Using `t.id` (undefined) caused the
  // React "missing key" warning, the type picker selection to silently
  // fail (cylinderTypeId stayed null), and availableFulls lookup against
  // undefined → driver couldn't enter quantity.
  cylinderTypeId: string;
  typeName: string;
}
interface TripStockRow {
  cylinderTypeId: string;
  cylinderTypeName: string;
  availableFulls?: number;
}

function WalkInOrderModal({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { colors } = useTheme();
  const [customerQuery, setCustomerQuery] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerRow | null>(null);
  const [cylinderTypeId, setCylinderTypeId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [submitting, setSubmitting] = useState(false);

  const { data: customersResp } = useApiQuery<{ customers: CustomerRow[] }>(
    ['driver-customers-list', customerQuery],
    '/customers',
    { search: customerQuery || undefined, limit: 20 },
    { enabled: visible, staleTime: 60_000 },
  );
  const customers = customersResp?.customers ?? [];

  const { data: typesResp } = useApiQuery<{ cylinderTypes: CylinderTypeRow[] }>(
    ['driver-cylinder-types'],
    '/cylinder-types',
    undefined,
    { enabled: visible, staleTime: 5 * 60_000 },
  );
  const types = typesResp?.cylinderTypes ?? [];

  const { data: stockResp } = useApiQuery<{ items: TripStockRow[] }>(
    ['driver-trip-stock'],
    '/drivers/me/trip-stock',
    undefined,
    { enabled: visible },
  );
  const stock = stockResp?.items ?? [];
  const availableForType = (cylinderTypeId
    ? stock.find((s) => s.cylinderTypeId === cylinderTypeId)?.availableFulls
    : 0) ?? 0;

  const reset = () => {
    setCustomerQuery('');
    setSelectedCustomer(null);
    setCylinderTypeId(null);
    setQuantity('1');
    setSubmitting(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    if (!selectedCustomer || !cylinderTypeId) {
      Alert.alert('Missing details', 'Select a customer and cylinder type.');
      return;
    }
    const qty = Math.max(1, Math.floor(Number(quantity) || 0));
    if (qty > availableForType) {
      Alert.alert('Insufficient stock', `Only ${availableForType} available on vehicle for this cylinder type.`);
      return;
    }
    setSubmitting(true);
    try {
      const today = new Date();
      const todayStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
      const res = await apiPost<{ orderId: string; preflightStatus: string }>('/drivers/me/orders', {
        customerId: selectedCustomer.customerId,
        cylinderTypeId,
        quantity: qty,
        deliveryDate: todayStr,
      });
      if (res.preflightStatus === 'success') {
        Alert.alert('Order created', `${selectedCustomer.customerName} — ${qty} × cylinder. Preflight OK.`);
      } else {
        Alert.alert('Order created (GST pending)', 'Order saved on the truck. Contact office to complete GST docs.');
      }
      reset();
      onCreated();
    } catch (err) {
      const msg = getErrorMessage(err) ?? 'Failed to create order';
      Alert.alert('Cannot create order', msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent presentationStyle="overFullScreen" statusBarTranslucent>
      {/* D6 (2026-07-10) — walk-in modal keyboard overlap fix. Same pattern
          as the Item 2 confirm-delivery modal above (see line 386): wrap
          the sheet in KeyboardAvoidingView with behavior='padding' on iOS
          and 'height' on Android + a small keyboardVerticalOffset. Without
          this, the qty TextInput sat under the keyboard on smaller Android
          phones during walk-in order entry, and the driver couldn't see
          what they were typing. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}
      >
        <View style={{ backgroundColor: colors.bg, borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '90%' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: colors.divider }}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>New Walk-in Order</Text>
            <TouchableOpacity onPress={handleClose}>
              <Text style={{ fontSize: 22, color: colors.textSecondary }}>×</Text>
            </TouchableOpacity>
          </View>
          <ScrollView
            style={{ padding: 16 }}
            contentContainerStyle={{ paddingBottom: 32 }}
            keyboardShouldPersistTaps="handled"
          >
            {/* 1. Customer search */}
            <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 6 }}>Customer</Text>
            {selectedCustomer ? (
              <View style={{ padding: 12, backgroundColor: colors.cardBg, borderRadius: 8, marginBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View>
                  <Text style={{ color: colors.text, fontWeight: '600' }}>{selectedCustomer.customerName}</Text>
                  <Text style={{ color: colors.textMuted, fontSize: 12 }}>{selectedCustomer.phone ?? '—'}</Text>
                </View>
                <TouchableOpacity onPress={() => setSelectedCustomer(null)}>
                  <Text style={{ color: ACCENT.red, fontSize: 12 }}>Change</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <TextInput
                  placeholder="Search by name or phone"
                  placeholderTextColor={colors.textMuted}
                  value={customerQuery}
                  onChangeText={setCustomerQuery}
                  style={{ borderWidth: 1, borderColor: colors.cardBorder, borderRadius: 8, padding: 10, marginBottom: 8, color: colors.text }}
                />
                {/* FLOAT-001 (2026-06-18): maxHeight on a plain View does NOT
                    clip overflow in React Native — rows bled down on top of
                    the Cylinder Type section. ScrollView + overflow:'hidden'
                    + nestedScrollEnabled is the reliable combo (the modal's
                    outer ScrollView also pans without locking this inner
                    list). User repro: see screenshot 2026-06-18 ~08:25 IST. */}
                <ScrollView
                  style={{ maxHeight: 200, marginBottom: 12, overflow: 'hidden' }}
                  nestedScrollEnabled
                  keyboardShouldPersistTaps="handled"
                >
                  {customers.slice(0, 8).map((c) => (
                    <TouchableOpacity key={c.customerId} onPress={() => setSelectedCustomer(c)} style={{ padding: 10, borderBottomWidth: 1, borderBottomColor: colors.divider }}>
                      <Text style={{ color: colors.text }}>{c.customerName}</Text>
                      <Text style={{ color: colors.textMuted, fontSize: 11 }}>{c.phone ?? '—'}</Text>
                    </TouchableOpacity>
                  ))}
                  {customers.length === 0 && customerQuery.length > 0 && (
                    <Text style={{ color: colors.textMuted, fontSize: 12, padding: 8 }}>No matches. Customer not found? Call office to register.</Text>
                  )}
                </ScrollView>
              </>
            )}

            {/* 2. Cylinder type */}
            <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 6 }}>Cylinder Type</Text>
            <View style={{ marginBottom: 12 }}>
              {types.map((t) => {
                const avail = stock.find((s) => s.cylinderTypeId === t.cylinderTypeId)?.availableFulls ?? 0;
                const selected = cylinderTypeId === t.cylinderTypeId;
                return (
                  <TouchableOpacity
                    key={t.cylinderTypeId}
                    onPress={() => setCylinderTypeId(t.cylinderTypeId)}
                    style={{
                      padding: 12,
                      borderWidth: selected ? 2 : 1,
                      borderColor: selected ? ACCENT.red : colors.cardBorder,
                      borderRadius: 8,
                      marginBottom: 6,
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <Text style={{ color: colors.text, fontWeight: selected ? '700' : '500' }}>{t.typeName}</Text>
                    <Text style={{ color: avail > 0 ? ACCENT.green : ACCENT.red, fontSize: 12 }}>{avail} avail</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* 3. Quantity */}
            <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 6 }}>Quantity</Text>
            <TextInput
              value={quantity}
              onChangeText={(v) => setQuantity(v.replace(/[^0-9]/g, ''))}
              keyboardType="number-pad"
              style={{ borderWidth: 1, borderColor: colors.cardBorder, borderRadius: 8, padding: 10, marginBottom: 8, color: colors.text }}
            />
            {cylinderTypeId && (
              <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 20 }}>
                Available on vehicle: {availableForType}
              </Text>
            )}

            <Button
              title={submitting ? 'Creating…' : 'Create Order & Dispatch'}
              onPress={submit}
              disabled={submitting || !selectedCustomer || !cylinderTypeId}
            />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
