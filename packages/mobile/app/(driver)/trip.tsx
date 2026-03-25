import { useEffect } from 'react';
import { View, Text, ScrollView, RefreshControl, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { Card, MetricCard, Button, Badge } from '../../src/components/ui';
import { startLocationTracking, stopLocationTracking } from '../../src/services/location';
import { useAuthStore } from '../../src/stores/authStore';
import { useTheme, ACCENT } from '../../src/theme';
import type { DriverVehicleAssignment } from '@gaslink/shared';

export default function DriverTripScreen() {
  const { dark, colors } = useTheme();
  const user = useAuthStore((s) => s.user);

  const { data: assignment, isLoading, refetch } = useApiQuery<DriverVehicleAssignment | null>(
    ['driver-active-trip'],
    '/drivers-vehicles/my-assignment',
  );

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

  const updateStatus = useApiMutation<unknown, { status: string }>('patch',
    () => `/drivers-vehicles/assignments/${assignment?.assignmentId}/status`,
    {
      invalidateKeys: [['driver-active-trip'], ['driver-orders']],
      successMessage: 'Trip status updated!',
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

  const handleAdvance = () => {
    if (!nextStep) return;
    Alert.alert(
      'Update Trip Status',
      `Move trip to "${nextStep.label}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Confirm', onPress: () => updateStatus.mutate({ status: nextStep.status }) },
      ],
    );
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
                title={`Move to: ${nextStep.label}`}
                onPress={handleAdvance}
                loading={updateStatus.isPending}
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
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
