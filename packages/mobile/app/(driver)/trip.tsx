import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, Alert, Linking, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { Card, MetricCard, Button, Badge } from '../../src/components/ui';
import { startLocationTracking, stopLocationTracking } from '../../src/services/location';
import { useAuthStore } from '../../src/stores/authStore';
import { useTheme, ACCENT, formatDate } from '../../src/theme';
import { api, getErrorMessage } from '../../src/lib/api';
import type { DriverVehicleAssignment } from '@gaslink/shared';

/**
 * Distributor settings response — minimal slice we read here. The full
 * shape lives in @gaslink/shared `DistributorSettings`. We only need
 * gstMode to know whether the EWB section should render.
 */
interface DistributorSettings {
  gstMode: 'disabled' | 'sandbox' | 'live' | null;
}

/**
 * Extended assignment shape that includes fields the backend now returns
 * but the shared package type has not yet been updated to reflect.
 * The flat `vehicleNumber` is kept for backward compat; the nested
 * `vehicle` object is the canonical source going forward (Fix 3).
 */
interface ExtendedAssignment extends DriverVehicleAssignment {
  vehicle?: { vehicleNumber: string; status?: string } | null;
  dispatchedAt?: string | null;
  returnedAt?: string | null;
  reconciledAt?: string | null;
  tripSheetNo?: string | null;
  tripSheetNo2?: string | null;
}

/**
 * One row of the /me/trip-ewbs response. Mirrors the columns we project
 * server-side. `ewbNo` is the 12-digit NIC EWB number the driver reads
 * out at the customer site / shows the road inspector.
 */
interface TripEwb {
  orderId: string;
  orderNumber: string | null;
  customerName: string | null;
  invoiceNumber: string | null;
  ewbNo: string | null;
  ewbDate: string | null;
  ewbValidTill: string | null;
  ewbStatus: 'not_attempted' | 'pending' | 'active' | 'failed' | 'cancelled';
  // WI-094c: cylinder type + total quantity now travel with each EWB so the
  // merged Compliance Docs list can show "<type> × <qty>" at a glance.
  cylinderType: string | null;
  quantity: number;
}

/**
 * WI-094c: the trip-ewbs endpoint now returns the consolidated trip-sheet
 * numbers alongside the per-order EWB list, so a single "Compliance Docs"
 * section can offer both the trip-sheet PDF download and the EWB references.
 */
interface TripEwbsResponse {
  tripNumber: number | null;
  tripSheetNo: string | null;
  tripSheetNo2: string | null;
  items: TripEwb[];
}

export default function DriverTripScreen() {
  const { dark, colors } = useTheme();
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();

  const [downloadingPdf, setDownloadingPdf] = useState(false);

  const { data: assignment, isLoading, refetch } = useApiQuery<ExtendedAssignment | null>(
    ['driver-active-trip'],
    '/drivers/me/assignment',
  );

  // Distributor settings drive the conditional EWB section. For GST-disabled
  // tenants gstMode === 'disabled' and we hide the entire compliance block.
  const { data: settings } = useApiQuery<DistributorSettings>(
    ['distributor-settings'],
    '/settings',
  );
  const gstEnabled = !!settings?.gstMode && settings.gstMode !== 'disabled';

  // Only fetch EWBs when GST is on. TanStack's `enabled` skips the call
  // entirely otherwise — no wasted round-trip, no 200 + [] spinner flash.
  const { data: ewbsResponse, refetch: refetchEwbs } = useApiQuery<TripEwbsResponse>(
    ['driver-trip-ewbs'],
    '/drivers/me/trip-ewbs',
    undefined,
    // WI-101: poll every 30s so Compliance Docs picks up EWBs generated at
    // dispatch without waiting for the first delivery confirm to invalidate.
    { enabled: gstEnabled, refetchInterval: 30_000 },
  );
  const ewbs: TripEwb[] = ewbsResponse?.items ?? [];
  // WI-094c: trip-sheet numbers now come from the trip-ewbs response (so the
  // merged Compliance Docs section can offer the PDF download) rather than the
  // assignment row.
  const tripSheetNo = ewbsResponse?.tripSheetNo ?? null;
  const tripSheetNo2 = ewbsResponse?.tripSheetNo2 ?? null;

  // WI-101: pull-to-refresh must refresh ALL trip data, not just the
  // assignment — previously the EWB list and Vehicle Stock stayed stale.
  const onRefresh = useCallback(() => {
    refetch();
    refetchEwbs();
    queryClient.invalidateQueries({ queryKey: ['driver-trip-stock'] });
  }, [refetch, refetchEwbs, queryClient]);

  /**
   * Download the consolidated trip-sheet PDF, save to the app's cache
   * directory, then hand to the OS share sheet (WhatsApp / Save to Files
   * / etc.). Uses the shared axios instance per CLAUDE.md mobile rule —
   * raw fetch() would drop the Authorization header and 401.
   *
   * expo-file-system v55 dropped the legacy `writeAsStringAsync` +
   * `cacheDirectory` API in favour of `new File(Paths.cache, name).write(bytes)`.
   * The new API takes a Uint8Array directly so we skip the base64 detour
   * the old API needed.
   */
  const handleDownloadTripSheet = async () => {
    setDownloadingPdf(true);
    try {
      const res = await api.get('/drivers/me/trip-sheet-pdf', {
        responseType: 'arraybuffer',
      });
      const bytes = new Uint8Array(res.data);

      const file = new File(Paths.cache, `trip-sheet-${Date.now()}.pdf`);
      // `create()` is a no-op if the file exists; `write()` overwrites.
      try { file.create(); } catch { /* already exists, fine */ }
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
      setDownloadingPdf(false);
    }
  };

  /**
   * Open the NIC e-Way Bill public lookup for a given EWB number. This is
   * the official portal; the driver / inspector can verify validity here.
   */
  const handleShareEwb = (ewb: TripEwb) => {
    if (!ewb.ewbNo) return;
    const url = `https://docs.ewaybillgst.gov.in/ewbnatval.aspx?ewbno=${encodeURIComponent(ewb.ewbNo)}`;
    Linking.openURL(url).catch(() =>
      Alert.alert('Could not open browser', 'Copy the EWB number manually if needed.'),
    );
  };

  // Auto-start location tracking when trip is dispatched
  useEffect(() => {
    if (
      assignment &&
      user?.userId &&
      (assignment.status === 'loaded_and_dispatched')
    ) {
      startLocationTracking(user.userId, assignment.assignmentId, 60_000);
    } else {
      stopLocationTracking();
    }
    return () => stopLocationTracking();
  }, [assignment?.status, assignment?.assignmentId, user?.userId]);

  // PUT (not PATCH): the API exposes /assignments/:id/status via PUT —
  // we send the full status field, not a partial diff.
  const updateStatus = useApiMutation<unknown, { status: string }>('put',
    () => `/drivers/assignments/${assignment?.assignmentId}/status`,
    {
      invalidateKeys: [['driver-active-trip'], ['driver-orders']],
      successMessage: 'Trip status updated!',
    },
  );

  // WI-085: Mark Vehicle Returned — calls the delivery workflow endpoint that
  // sets vehicle.status = 'returned', creates inventory events, and releases
  // the vehicle from the active trip. This is the correct "end of trip" action
  // for drivers; it supersedes the generic DVA status advance for the
  // loaded_and_dispatched → returned_inventory transition.
  const markReturned = useApiMutation<unknown, { vehicleId: string }>(
    'post',
    () => '/delivery/driver/vehicle-returned',
    {
      invalidateKeys: [['driver-active-trip'], ['driver-orders']],
      successMessage: 'Vehicle marked as returned!',
    },
  );

  const statusSteps = [
    { status: 'dispatch_ready', label: 'Ready', color: ACCENT.blue },
    { status: 'loaded_and_dispatched', label: 'Dispatched', color: ACCENT.orange },
    { status: 'returned_inventory', label: 'Returned', color: ACCENT.green },
    { status: 'reconciled', label: 'Reconciled', color: ACCENT.purple },
  ];

  // WI-094c Change 6: the vehicle flips to 'returned' the moment the driver
  // taps "Mark Vehicle Returned", but the DVA stays loaded_and_dispatched
  // until Inventory reconciles on the web. Advance the timeline to "Returned"
  // for that window and surface a waiting state instead of an action button.
  const vehicleReturned = assignment?.vehicle?.status === 'returned';
  const baseStepIndex = statusSteps.findIndex((s) => s.status === assignment?.status);
  const currentStepIndex = vehicleReturned && baseStepIndex === 1 ? 2 : baseStepIndex;
  const nextStep = currentStepIndex < statusSteps.length - 1 ? statusSteps[currentStepIndex + 1] : null;

  // True when the next step is "returned_inventory" — i.e. the driver is
  // currently dispatched and needs to mark the vehicle back at the depot.
  // For this specific transition we call the delivery workflow endpoint
  // (POST /delivery/driver/vehicle-returned) which handles vehicle status,
  // inventory events, and the DVA transition atomically. All other
  // status advances use the generic DVA status PUT.
  // WI-100 Gap D: also require !isReconciled — once Inventory has reconciled the
  // trip the DVA still reads loaded_and_dispatched (until the next dispatch
  // rolls it), so without this the "Mark Vehicle Returned" button reappeared
  // after reconcile (the loop). The server guard (Gap C) is the real fix; this
  // hides the button so the driver never taps it.
  const isReturnTransition =
    assignment?.status === 'loaded_and_dispatched' && nextStep?.status === 'returned_inventory'
    && !(assignment as any).isReconciled;

  // WI-094b Fix 2: only surface the "Dispatch pending" note when the DVA is
  // dispatch_ready AND there is actually an order waiting to be dispatched.
  // A fresh dispatch_ready DVA with no pending_dispatch orders (e.g. just
  // after reconciliation) showed a misleading "waiting to dispatch" card.
  const hasPendingDispatch = !!assignment?.orders?.some(
    (o: any) => o.status === 'pending_dispatch',
  );

  // WI-094c Change 5: sort the trip's orders by what the driver does next —
  // delivered most-recent-first, then pending oldest-first (the next stops),
  // then cancelled at the bottom. The final spread catches any other status
  // so no order is silently dropped.
  const tripOrders = (assignment?.orders ?? []) as any[];
  const isDeliveredStatus = (s: string) => s === 'delivered' || s === 'modified_delivered';
  const isPendingStatus = (s: string) => s === 'pending_delivery' || s === 'pending_dispatch';
  const ts = (v: any) => (v ? new Date(v).getTime() : 0);
  const sortedOrders = [
    ...tripOrders.filter((o) => isDeliveredStatus(o.status)).sort((a, b) => ts(b.deliveredAt) - ts(a.deliveredAt)),
    ...tripOrders.filter((o) => isPendingStatus(o.status)).sort((a, b) => ts(a.createdAt) - ts(b.createdAt)),
    ...tripOrders.filter((o) => o.status === 'cancelled'),
    ...tripOrders.filter((o) => !isDeliveredStatus(o.status) && !isPendingStatus(o.status) && o.status !== 'cancelled'),
  ];

  const handleAdvance = () => {
    if (!nextStep) return;
    if (isReturnTransition) {
      Alert.alert(
        'Mark Vehicle Returned',
        'Confirm that the vehicle has returned to the depot? This will update vehicle and inventory status.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Confirm',
            onPress: () => markReturned.mutate({ vehicleId: assignment!.vehicleId }),
          },
        ],
      );
    } else {
      Alert.alert(
        'Update Trip Status',
        `Move trip to "${nextStep.label}"?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Confirm', onPress: () => updateStatus.mutate({ status: nextStep.status }) },
        ],
      );
    }
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 16 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={onRefresh} />}
      >
        {!assignment ? (
          <View style={{ alignItems: 'center', paddingVertical: 60 }}>
            <Text style={{ fontSize: 48, marginBottom: 12 }}>🚛</Text>
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>No Active Trip</Text>
            <Text style={{ fontSize: 14, color: colors.textSecondary, marginTop: 4, textAlign: 'center' }}>
              Your trip will appear here once assigned by the distributor
            </Text>
          </View>
        ) : (
          <>
            {/* Trip Info */}
            <Card>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>Trip #{assignment.tripNumber}</Text>
                  {/* Fix 4: formatDate on assignmentDate */}
                  <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>{formatDate(assignment.assignmentDate)}</Text>
                </View>
                <Badge
                  label={(assignment.status || '').replace(/_/g, ' ')}
                  variant={assignment.status === 'reconciled' ? 'success' : assignment.status === 'loaded_and_dispatched' ? 'warning' : 'info'}
                />
              </View>
            </Card>

            {/* Vehicle — Fix 3: nested vehicle?.vehicleNumber with flat fallback */}
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <MetricCard title="Vehicle" value={assignment.vehicle?.vehicleNumber ?? assignment.vehicleNumber} color={colors.text} />
              </View>
              <View style={{ flex: 1 }}>
                <MetricCard title="Orders" value={assignment.orders?.length ?? 0} color={ACCENT.blue} />
              </View>
            </View>

            {/* Status Pipeline — Fix 2 + Fix 5 */}
            <Card>
              <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: 12 }}>Trip Progress</Text>
              <View style={{ gap: 8 }}>
                {statusSteps.map((step, i) => {
                  // Fix 5: timestamp per step
                  let stamp: string;
                  if (i === 0) stamp = formatDate(assignment.assignmentDate) || '—';
                  else if (i === 1) stamp = assignment.dispatchedAt ? formatDate(assignment.dispatchedAt) : '—';
                  else if (i === 2) stamp = assignment.returnedAt ? formatDate(assignment.returnedAt) : '—';
                  else stamp = assignment.reconciledAt ? formatDate(assignment.reconciledAt) : '—';

                  // Fix 2: for returned_inventory, step 4 (Reconciled) is pending with subtext
                  const isPostReturnPending =
                    assignment.status === 'returned_inventory' && step.status === 'reconciled';

                  return (
                    <View key={step.status} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                      <View style={{
                        width: 28, height: 28, borderRadius: 14,
                        backgroundColor: i <= currentStepIndex ? step.color : (dark ? colors.cardBorder : '#e2e8f0'),
                        alignItems: 'center', justifyContent: 'center',
                        marginTop: 2,
                      }}>
                        <Text style={{
                          color: i <= currentStepIndex ? '#fff' : colors.textMuted,
                          fontSize: 12, fontWeight: '700',
                        }}>
                          {i <= currentStepIndex ? '✓' : i + 1}
                        </Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{
                          fontSize: 14,
                          fontWeight: i === currentStepIndex ? '700' : '400',
                          color: i <= currentStepIndex ? colors.text : colors.textMuted,
                        }}>
                          {step.label}
                        </Text>
                        {/* Fix 2: subtext for reconciliation pending */}
                        {isPostReturnPending && (
                          <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 2 }}>
                            Inventory team needs to reconcile before next trip.
                          </Text>
                        )}
                        {/* Fix 5: timestamp stamp */}
                        <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 1 }}>
                          {stamp}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            </Card>

            {/* Next Action — WI-094c Change 6: vehicle-returned waiting state takes
                priority; then Fix 1 (dispatch_ready read-only) / Fix 2 (returned_inventory). */}
            {vehicleReturned ? (
              <Card>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Ionicons name="hourglass-outline" size={20} color={ACCENT.orange} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>Vehicle returned to depot</Text>
                    <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
                      Waiting for the Inventory team to reconcile.
                    </Text>
                    <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                      You will be notified when the next trip is ready.
                    </Text>
                  </View>
                </View>
              </Card>
            ) : assignment.status === 'dispatch_ready' && hasPendingDispatch ? (
              <Card>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Ionicons name="information-circle-outline" size={20} color={ACCENT.blue} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>Dispatch pending</Text>
                    <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
                      Inventory or Admin must dispatch from the web portal.
                    </Text>
                  </View>
                </View>
              </Card>
            ) : assignment.status === 'dispatch_ready' || assignment.status === 'returned_inventory' ? null : (
              nextStep && (
                <Button
                  title={isReturnTransition ? 'Mark Vehicle Returned' : `Move to: ${nextStep.label}`}
                  onPress={handleAdvance}
                  loading={isReturnTransition ? markReturned.isPending : updateStatus.isPending}
                />
              )
            )}

            {/* Orders in Trip — WI-094c Change 5: delivered first (recent), then
                pending (next stops), cancelled last. */}
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>Orders in Trip</Text>
            {sortedOrders.map((order) => (
              <Card key={order.orderId}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <View>
                    <Text style={{ fontWeight: '600', color: colors.text }}>{order.orderNumber}</Text>
                    <Text style={{ fontSize: 13, color: ACCENT.blue, marginTop: 2 }}>{order.customerName}</Text>
                  </View>
                  <Badge
                    label={(order.status || '').replace(/_/g, ' ')}
                    variant={
                      order.status === 'delivered' || order.status === 'modified_delivered' ? 'success'
                        : order.status === 'cancelled' ? 'danger'
                        : 'warning'
                    }
                  />
                </View>
                <View style={{ marginTop: 8, gap: 2 }}>
                  {order.items?.map((item: any, i: number) => (
                    <Text key={i} style={{ fontSize: 12, color: colors.textSecondary }}>
                      {item.cylinderTypeName} x {item.quantity}
                    </Text>
                  ))}
                </View>
              </Card>
            ))}

            {/* Compliance Docs — WI-094c Change 4: Trip Sheets merged in here.
                One section: trip-sheet PDF download (when a consolidated sheet
                exists) + the per-order EWB references for checkpoints. GST-only —
                GST-disabled tenants have neither EWBs nor consolidated sheets. */}
            {gstEnabled && (
              <>
                <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 8 }}>
                  Compliance Docs
                </Text>

                {(tripSheetNo || tripSheetNo2) && (
                  <Button
                    title={downloadingPdf ? 'Preparing trip sheet…' : 'Download Trip Sheet'}
                    onPress={handleDownloadTripSheet}
                    loading={downloadingPdf}
                    variant="secondary"
                  />
                )}

                {ewbs.length === 0 ? (
                  <Card>
                    <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: 'center' }}>
                      No EWB documents for this trip yet
                    </Text>
                  </Card>
                ) : (
                  ewbs.map((ewb) => (
                    <Card key={ewb.orderId}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontWeight: '700', color: colors.text }}>{ewb.orderNumber}</Text>
                          {ewb.customerName && (
                            <Text style={{ fontSize: 13, color: ACCENT.blue, marginTop: 2 }}>
                              {ewb.customerName}
                            </Text>
                          )}
                          {ewb.cylinderType && (
                            <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                              {ewb.cylinderType} × {ewb.quantity}
                            </Text>
                          )}
                          <Text style={{ fontSize: 13, color: colors.text, marginTop: 6 }}>
                            <Text style={{ color: colors.textSecondary }}>EWB: </Text>
                            <Text style={{ fontWeight: '700' }}>{ewb.ewbNo}</Text>
                          </Text>
                          {ewb.ewbValidTill && (
                            <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                              Valid till {formatDate(ewb.ewbValidTill)}
                            </Text>
                          )}
                        </View>
                        <View style={{ alignItems: 'flex-end', gap: 6 }}>
                          <Badge
                            label={ewb.ewbStatus}
                            variant={ewb.ewbStatus === 'active' ? 'success' : ewb.ewbStatus === 'cancelled' || ewb.ewbStatus === 'failed' ? 'danger' : 'warning'}
                          />
                          <TouchableOpacity
                            onPress={() => handleShareEwb(ewb)}
                            style={{
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: 4,
                              paddingHorizontal: 10,
                              paddingVertical: 6,
                              borderRadius: 8,
                              backgroundColor: dark ? 'rgba(59,130,246,0.15)' : '#eef7ff',
                            }}
                          >
                            <Ionicons name="open-outline" size={14} color={ACCENT.blue} />
                            <Text style={{ fontSize: 12, fontWeight: '600', color: ACCENT.blue }}>
                              Verify
                            </Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    </Card>
                  ))
                )}
              </>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
