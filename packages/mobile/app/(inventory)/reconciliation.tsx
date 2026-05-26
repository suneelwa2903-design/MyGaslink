import { View, Text, ScrollView, RefreshControl, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { Card, Badge, Button, MetricCard } from '../../src/components/ui';
import { useTheme } from '../../src/theme';
import type { CancelledStock } from '@gaslink/shared';

interface PendingReconItem {
  cylinderTypeName?: string;
  fullCount?: number;
  emptyCount?: number;
}

interface PendingReconVehicle {
  vehicleId: string;
  assignmentId?: string;
  vehicleNumber?: string;
  vehicleName?: string;
  driverName?: string;
  pendingItems?: PendingReconItem[];
}

export default function ReconciliationScreen() {
  const { dark, colors, accent } = useTheme();

  // Pending reconciliation vehicles
  const { data: pendingVehicles, isLoading: pendingLoading, refetch: refetchPending } = useApiQuery<PendingReconVehicle[]>(
    ['pending-reconciliation'],
    '/delivery/reconciliation/pending',
  );

  // Cancelled stock
  const { data: cancelledStock, isLoading: cancelledLoading, refetch: refetchCancelled } = useApiQuery<CancelledStock[]>(
    ['cancelled-stock-pending'],
    '/inventory/cancelled-stock',
    { status: 'pending' },
  );

  const confirmReconciliation = useApiMutation<void, { vehicleId: string }>(
    'post',
    (vars) => `/delivery/reconciliation/confirm/${vars.vehicleId}`,
    { invalidateKeys: [['pending-reconciliation'], ['inv-summary']], successMessage: 'Reconciliation confirmed' },
  );

  const returnCancelled = useApiMutation<void, { eventId: string }>(
    'post', '/inventory/cancelled-stock/return',
    { invalidateKeys: [['cancelled-stock-pending'], ['inv-summary']], successMessage: 'Stock returned to depot' },
  );

  const isLoading = pendingLoading || cancelledLoading;
  const handleRefresh = () => { refetchPending(); refetchCancelled(); };

  const pendingCount = pendingVehicles?.length ?? 0;
  const cancelledCount = cancelledStock?.length ?? 0;
  const cancelledTotal = cancelledStock?.reduce((s, c) => s + (c.quantity ?? 0), 0) ?? 0;

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={handleRefresh} />}
      >
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>Reconciliation</Text>

        {/* Summary Metrics */}
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard title="Vehicles Pending" value={pendingCount} color={pendingCount > 0 ? accent.orange : accent.green} />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard title="Cancelled Stock" value={cancelledTotal} color={cancelledTotal > 0 ? '#ef4444' : accent.green} subtitle={`${cancelledCount} items`} />
          </View>
        </View>

        {/* Pending Vehicle Reconciliation */}
        <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8 }}>
          Vehicle Returns
        </Text>

        {pendingCount === 0 ? (
          <Card>
            <View style={{ alignItems: 'center', paddingVertical: 16 }}>
              <Ionicons name="checkmark-circle" size={36} color={accent.green} style={{ marginBottom: 8 }} />
              <Text style={{ fontSize: 14, fontWeight: '600', color: accent.green }}>All vehicles reconciled</Text>
              <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>No pending returns</Text>
            </View>
          </Card>
        ) : (
          pendingVehicles?.map((vehicle: PendingReconVehicle) => {
            // Compute totals for summary row
            const totalFulls = vehicle.pendingItems?.reduce((s: number, item: PendingReconItem) => s + (item.fullCount ?? 0), 0) ?? 0;
            const totalEmpties = vehicle.pendingItems?.reduce((s: number, item: PendingReconItem) => s + (item.emptyCount ?? 0), 0) ?? 0;

            return (
              <Card key={vehicle.vehicleId || vehicle.assignmentId}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontWeight: '700', fontSize: 16, color: colors.text }}>
                      {vehicle.vehicleNumber || vehicle.vehicleName || 'Vehicle'}
                    </Text>
                    <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
                      Driver: {vehicle.driverName || 'Unknown'}
                    </Text>
                  </View>
                  <Badge label="Pending" variant="warning" />
                </View>

                {/* Summary Row - Total fulls / empties */}
                {vehicle.pendingItems && vehicle.pendingItems.length > 0 && (
                  <View style={{
                    flexDirection: 'row', gap: 12, marginBottom: 8,
                    backgroundColor: dark ? 'rgba(59,130,246,0.08)' : '#eff6ff',
                    borderRadius: 10, padding: 10,
                  }}>
                    <View style={{ flex: 1, alignItems: 'center' }}>
                      <Text style={{ fontSize: 11, color: colors.textSecondary }}>Total Fulls</Text>
                      <Text style={{ fontSize: 18, fontWeight: '800', color: accent.green }}>{totalFulls}</Text>
                    </View>
                    <View style={{ width: 1, backgroundColor: colors.divider }} />
                    <View style={{ flex: 1, alignItems: 'center' }}>
                      <Text style={{ fontSize: 11, color: colors.textSecondary }}>Total Empties</Text>
                      <Text style={{ fontSize: 18, fontWeight: '800', color: accent.blue }}>{totalEmpties}</Text>
                    </View>
                  </View>
                )}

                {/* Stock Detail */}
                {vehicle.pendingItems && (
                  <View style={{ backgroundColor: dark ? colors.inputBg : '#f8fafc', borderRadius: 10, padding: 12, gap: 4, marginBottom: 10 }}>
                    {vehicle.pendingItems.map((item: PendingReconItem, i: number) => (
                      <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: 13, color: colors.textSecondary }}>{item.cylinderTypeName}</Text>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>
                          {item.fullCount} full / {item.emptyCount} empty
                        </Text>
                      </View>
                    ))}
                  </View>
                )}

                <Button
                  title="Confirm Reconciliation"
                  variant="accent"
                  size="sm"
                  onPress={() => {
                    Alert.alert(
                      'Confirm',
                      `Confirm physical stock matches for ${vehicle.vehicleNumber || 'this vehicle'}?`,
                      [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Confirm', onPress: () => confirmReconciliation.mutate({ vehicleId: vehicle.vehicleId }) },
                      ],
                    );
                  }}
                  loading={confirmReconciliation.isPending}
                />
              </Card>
            );
          })
        )}

        {/* Cancelled Stock */}
        <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8 }}>
          Cancelled Stock Returns
        </Text>

        {cancelledCount === 0 ? (
          <Card>
            <View style={{ alignItems: 'center', paddingVertical: 16 }}>
              <Ionicons name="cube-outline" size={36} color={accent.green} style={{ marginBottom: 8 }} />
              <Text style={{ fontSize: 14, fontWeight: '600', color: accent.green }}>No pending returns</Text>
              <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>All cancelled stock returned</Text>
            </View>
          </Card>
        ) : (
          cancelledStock?.map((item) => (
            <Card key={item.eventId}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>{item.cylinderTypeName}</Text>
                  <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
                    Driver: {item.driverName} | Vehicle: {item.vehicleNumber}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={{ fontWeight: '800', fontSize: 20, color: '#ef4444' }}>{item.quantity}</Text>
                  <Badge label={(item.status || '').replace(/_/g, ' ')} variant={item.status === 'returned_to_depot' ? 'success' : 'warning'} />
                </View>
              </View>

              {item.status !== 'returned_to_depot' && (
                <Button
                  title="Return to Depot"
                  variant="accent"
                  size="sm"
                  onPress={() => {
                    Alert.alert(
                      'Return Stock',
                      `Return ${item.quantity} ${item.cylinderTypeName} to depot?`,
                      [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Return', onPress: () => returnCancelled.mutate({ eventId: item.eventId }) },
                      ],
                    );
                  }}
                  loading={returnCancelled.isPending}
                  style={{ marginTop: 10 }}
                />
              )}
            </Card>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
