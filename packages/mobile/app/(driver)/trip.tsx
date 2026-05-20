import { useEffect, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, Alert, Linking, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
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
}

export default function DriverTripScreen() {
  const { dark, colors } = useTheme();
  const user = useAuthStore((s) => s.user);

  const [downloadingPdf, setDownloadingPdf] = useState(false);

  const { data: assignment, isLoading, refetch } = useApiQuery<DriverVehicleAssignment | null>(
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
  const { data: ewbsResponse } = useApiQuery<{ items: TripEwb[] }>(
    ['driver-trip-ewbs'],
    '/drivers/me/trip-ewbs',
    undefined,
    { enabled: gstEnabled },
  );
  const ewbs: TripEwb[] = ewbsResponse?.items ?? [];

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

  const currentStepIndex = statusSteps.findIndex((s) => s.status === assignment?.status);
  const nextStep = currentStepIndex < statusSteps.length - 1 ? statusSteps[currentStepIndex + 1] : null;

  // WI-064: hide the "Download Trip Sheet" button once every order on
  // the trip has been delivered (or modified-delivered). The trip-sheet
  // PDF service requires at least one `pending_delivery` order so it
  // can pin the row set to the current trip — without any in-flight
  // orders the endpoint 400s with a confusing "No EWB available"
  // message. The doc is a transit document anyway, so post-delivery
  // there's nothing to print.
  const hasInFlightOrder = !!assignment?.orders?.some(
    (o: any) => o.status === 'pending_delivery',
  );

  // True when the next step is "returned_inventory" — i.e. the driver is
  // currently dispatched and needs to mark the vehicle back at the depot.
  // For this specific transition we call the delivery workflow endpoint
  // (POST /delivery/driver/vehicle-returned) which handles vehicle status,
  // inventory events, and the DVA transition atomically. All other
  // status advances use the generic DVA status PUT.
  const isReturnTransition =
    assignment?.status === 'loaded_and_dispatched' && nextStep?.status === 'returned_inventory';

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
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
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
                  <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>{assignment.assignmentDate}</Text>
                </View>
                <Badge
                  label={(assignment.status || '').replace(/_/g, ' ')}
                  variant={assignment.status === 'reconciled' ? 'success' : assignment.status === 'loaded_and_dispatched' ? 'warning' : 'info'}
                />
              </View>
            </Card>

            {/* Vehicle */}
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <MetricCard title="Vehicle" value={assignment.vehicleNumber} color={colors.text} />
              </View>
              <View style={{ flex: 1 }}>
                <MetricCard title="Orders" value={assignment.orders?.length ?? 0} color={ACCENT.blue} />
              </View>
            </View>

            {/* Status Pipeline */}
            <Card>
              <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: 12 }}>Trip Progress</Text>
              <View style={{ gap: 8 }}>
                {statusSteps.map((step, i) => (
                  <View key={step.status} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <View style={{
                      width: 28, height: 28, borderRadius: 14,
                      backgroundColor: i <= currentStepIndex ? step.color : (dark ? colors.cardBorder : '#e2e8f0'),
                      alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Text style={{
                        color: i <= currentStepIndex ? '#fff' : colors.textMuted,
                        fontSize: 12, fontWeight: '700',
                      }}>
                        {i <= currentStepIndex ? '✓' : i + 1}
                      </Text>
                    </View>
                    <Text style={{
                      fontSize: 14,
                      fontWeight: i === currentStepIndex ? '700' : '400',
                      color: i <= currentStepIndex ? colors.text : colors.textMuted,
                    }}>
                      {step.label}
                    </Text>
                  </View>
                ))}
              </View>
            </Card>

            {/* Next Action */}
            {nextStep && (
              <Button
                title={isReturnTransition ? 'Mark Vehicle Returned' : `Move to: ${nextStep.label}`}
                onPress={handleAdvance}
                loading={isReturnTransition ? markReturned.isPending : updateStatus.isPending}
              />
            )}

            {/* Orders in Trip */}
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>Orders in Trip</Text>
            {assignment.orders?.map((order) => (
              <Card key={order.orderId}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <View>
                    <Text style={{ fontWeight: '600', color: colors.text }}>{order.orderNumber}</Text>
                    <Text style={{ fontSize: 13, color: ACCENT.blue, marginTop: 2 }}>{order.customerName}</Text>
                  </View>
                  <Badge label={(order.status || '').replace(/_/g, ' ')} variant={order.status === 'delivered' ? 'success' : 'warning'} />
                </View>
                <View style={{ marginTop: 8, gap: 2 }}>
                  {order.items?.map((item, i) => (
                    <Text key={i} style={{ fontSize: 12, color: colors.textSecondary }}>
                      {item.cylinderTypeName} x {item.quantity}
                    </Text>
                  ))}
                </View>
              </Card>
            ))}

            {/* Compliance Docs — only rendered when this distributor has
                GST enabled (sandbox / live). For GST-disabled tenants
                (e.g. dist-001 in dev) there's nothing to show. */}
            {gstEnabled && (
              <>
                <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 8 }}>
                  Compliance Docs
                </Text>

                {/* Trip Sheet PDF — single button. Saves to cache then
                    opens the OS share sheet so the driver can WhatsApp /
                    save / print it. WI-064: hidden after all orders are
                    delivered — the underlying endpoint can't generate
                    a useful sheet once nothing is in transit. */}
                {hasInFlightOrder && (
                  <Button
                    title={downloadingPdf ? 'Preparing trip sheet…' : 'Download Trip Sheet (PDF)'}
                    onPress={handleDownloadTripSheet}
                    loading={downloadingPdf}
                    variant="secondary"
                  />
                )}

                {/* Per-order EWB list. Each row shows the 12-digit NIC
                    number, customer, valid-till, and a Share button that
                    opens the official NIC public lookup for verification. */}
                {ewbs.length === 0 ? (
                  <Card>
                    <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: 'center' }}>
                      No EWB documents yet — they appear here once dispatch preflight completes.
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
