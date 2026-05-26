import { useState } from 'react';
import {
  View, Text, ScrollView, RefreshControl, TouchableOpacity, Alert,
  Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { Card, MetricCard, Badge, Button, EmptyState } from '../../src/components/ui';
import { useTheme } from '../../src/theme';
import type { InventorySummary, CylinderType, InventoryEvent, InventoryForecast, CancelledStock } from '@gaslink/shared';

// ─── Sub-tab types ──────────────────────────────────────────────────────────

type SubTab = 'summary' | 'actions' | 'reconciliation' | 'alerts';

const SUB_TABS: { label: string; value: SubTab }[] = [
  { label: 'Summary', value: 'summary' },
  { label: 'Actions', value: 'actions' },
  { label: 'Reconciliation', value: 'reconciliation' },
  { label: 'Alerts', value: 'alerts' },
];

// ─── Action types ───────────────────────────────────────────────────────────

type ActionType = 'incoming_fulls' | 'outgoing_empties' | 'manual_adjustment';

const ACTION_CARDS: { label: string; value: ActionType; icon: string; color: string; desc: string }[] = [
  { label: 'Incoming Fulls', value: 'incoming_fulls', icon: 'arrow-down-circle', color: '#10b981', desc: 'Record stock received from supplier' },
  { label: 'Outgoing Empties', value: 'outgoing_empties', icon: 'arrow-up-circle', color: '#3b82f6', desc: 'Record empty cylinders sent out' },
  { label: 'Manual Adjustment', value: 'manual_adjustment', icon: 'build', color: '#8b5cf6', desc: 'Adjust stock for corrections' },
];

// ─── Main Screen ────────────────────────────────────────────────────────────

export default function InventoryScreen() {
  const { dark, colors, accent } = useTheme();
  const [activeTab, setActiveTab] = useState<SubTab>('summary');

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Sub-tab pills */}
      <View style={{
        paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8,
        backgroundColor: dark ? colors.cardBg : '#fff',
        borderBottomWidth: 1, borderBottomColor: colors.divider,
      }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {SUB_TABS.map((tab) => {
            const isActive = activeTab === tab.value;
            return (
              <TouchableOpacity
                key={tab.value}
                onPress={() => setActiveTab(tab.value)}
                style={{
                  height: 36,
                  paddingHorizontal: 16,
                  borderRadius: 18,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: isActive ? accent.red : (dark ? colors.inputBg : '#f1f5f9'),
                }}
              >
                <Text style={{
                  fontSize: 13, fontWeight: '600',
                  color: isActive ? '#fff' : colors.textSecondary,
                }}>
                  {tab.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {activeTab === 'summary' && <SummaryContent />}
      {activeTab === 'actions' && <ActionsContent />}
      {activeTab === 'reconciliation' && <ReconciliationContent />}
      {activeTab === 'alerts' && <AlertsContent />}
    </SafeAreaView>
  );
}

// ─── SUMMARY ────────────────────────────────────────────────────────────────

function SummaryContent() {
  const { dark, colors, accent } = useTheme();
  const today = new Date().toISOString().split('T')[0];
  const [date, setDate] = useState(today);

  const { data: summaries, isLoading, refetch } = useApiQuery<InventorySummary[]>(
    ['inv-summary', date],
    '/inventory/summary',
    { date },
  );

  const lockMutation = useApiMutation<void, { date: string }>(
    'put', '/inventory/lock-summary',
    { invalidateKeys: [['inv-summary', date]], successMessage: 'Inventory locked for the day' },
  );

  const unlockMutation = useApiMutation<void, { date: string }>(
    'post', '/inventory/unlock',
    { invalidateKeys: [['inv-summary', date]], successMessage: 'Inventory unlocked' },
  );

  const totalFulls = summaries?.reduce((s, item) => s + (item.closingFulls ?? 0), 0) ?? 0;
  const totalEmpties = summaries?.reduce((s, item) => s + (item.closingEmpties ?? 0), 0) ?? 0;
  const isLocked = summaries?.some((s) => s.isLocked) ?? false;

  const navigateDate = (dir: -1 | 1) => {
    const d = new Date(date);
    d.setDate(d.getDate() + dir);
    setDate(d.toISOString().split('T')[0]);
  };

  const handleLock = () => {
    Alert.alert('Lock Inventory', `Lock inventory for ${date}? This prevents further changes.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Lock', onPress: () => lockMutation.mutate({ date }) },
    ]);
  };

  const handleUnlock = () => {
    Alert.alert('Unlock Inventory', `Unlock inventory for ${date}? This allows further changes.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unlock', style: 'destructive', onPress: () => unlockMutation.mutate({ date }) },
    ]);
  };

  return (
    <>
      {/* Date Navigation */}
      <View style={{
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        paddingVertical: 12, gap: 16,
        backgroundColor: dark ? colors.cardBg : '#fff',
        borderBottomWidth: 1, borderBottomColor: colors.divider,
      }}>
        <TouchableOpacity onPress={() => navigateDate(-1)} style={{ padding: 8 }}>
          <Ionicons name="chevron-back" size={22} color={accent.red} />
        </TouchableOpacity>
        <View style={{ alignItems: 'center' }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>{date}</Text>
          {date === today && <Text style={{ fontSize: 11, color: accent.green, fontWeight: '600' }}>Today</Text>}
        </View>
        <TouchableOpacity onPress={() => navigateDate(1)} style={{ padding: 8 }} disabled={date >= today}>
          <Ionicons name="chevron-forward" size={22} color={date >= today ? colors.textMuted : accent.red} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingTop: 12, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
      >
        {/* Top Metrics */}
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard title="Closing Full" value={totalFulls} color={accent.green} />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard title="Closing Empty" value={totalEmpties} color={accent.blue} />
          </View>
        </View>

        {/* Lock/Unlock Button */}
        {summaries && summaries.length > 0 && (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {isLocked ? (
              <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{
                  flex: 1, borderRadius: 12, padding: 12,
                  backgroundColor: dark ? 'rgba(16,185,129,0.15)' : '#ecfdf5',
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}>
                  <Ionicons name="lock-closed" size={16} color={accent.green} />
                  <Text style={{ fontSize: 13, fontWeight: '700', color: dark ? '#34d399' : '#059669' }}>Day Locked</Text>
                </View>
                <Button title="Unlock" variant="secondary" size="sm" onPress={handleUnlock} loading={unlockMutation.isPending} />
              </View>
            ) : (
              <View style={{ flex: 1 }}>
                <Button title="Lock Day" variant="accent" onPress={handleLock} loading={lockMutation.isPending} />
              </View>
            )}
          </View>
        )}

        {/* Per Cylinder Type */}
        <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 }}>
          By Cylinder Type
        </Text>

        {(!summaries || summaries.length === 0) ? (
          <EmptyState title="No inventory data" description="No inventory records for this date" />
        ) : (
          summaries.map((item) => {
            const isWarning = (item.thresholdWarning ?? 0) > 0 && (item.closingFulls ?? 0) <= (item.thresholdWarning ?? 0);
            const isCritical = (item.thresholdCritical ?? 0) > 0 && (item.closingFulls ?? 0) <= (item.thresholdCritical ?? 0);

            return (
              <Card key={item.cylinderTypeId}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <Text style={{ fontWeight: '700', fontSize: 16, color: colors.text }}>{item.cylinderTypeName}</Text>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    {item.isLocked && <Badge label="LOCKED" variant="success" />}
                    {isCritical ? (
                      <Badge label="CRITICAL" variant="danger" />
                    ) : isWarning ? (
                      <Badge label="LOW" variant="warning" />
                    ) : (
                      <Badge label="OK" variant="success" />
                    )}
                  </View>
                </View>

                {/* Full Cylinder Flow */}
                <View style={{ backgroundColor: dark ? colors.inputBg : '#f8fafc', borderRadius: 10, padding: 12, gap: 6 }}>
                  <FlowRow label="Opening Full" value={item.openingFulls} color={colors.textSecondary} dark={dark} />
                  <FlowRow label="+ Incoming" value={item.incomingFulls} color={accent.green} plus dark={dark} />
                  <FlowRow label="- Delivered" value={item.deliveredQty} color="#ef4444" minus dark={dark} />
                  <FlowRow label="+ Cancelled Return" value={item.cancelledStockQty} color={accent.orange} plus dark={dark} />
                  <FlowRow label="± Manual Adj." value={item.manualAdjustment} color={accent.purple} dark={dark} />
                  <View style={{ borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 6, marginTop: 2 }}>
                    <FlowRow label="= Closing Full" value={item.closingFulls} color={colors.text} bold dark={dark} />
                  </View>
                </View>

                {/* Empty Cylinder Flow */}
                <View style={{ flexDirection: 'row', gap: 12, marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: dark ? colors.divider : '#f1f5f9' }}>
                  <MiniStat label="Open Empty" value={item.openingEmpties} dark={dark} />
                  <MiniStat label="Collected" value={item.collectedEmpties} color={accent.green} prefix="+" dark={dark} />
                  <MiniStat label="Sent Out" value={item.outgoingEmpties} color="#ef4444" prefix="-" dark={dark} />
                  <MiniStat label="Close Empty" value={item.closingEmpties} bold dark={dark} />
                </View>
              </Card>
            );
          })
        )}
      </ScrollView>
    </>
  );
}

// ─── ACTIONS ────────────────────────────────────────────────────────────────

function ActionsContent() {
  const { dark, colors } = useTheme();
  const [activeAction, setActiveAction] = useState<ActionType | null>(null);

  const { data: cylinderTypes } = useApiQuery<CylinderType[]>(
    ['cylinder-types'],
    '/cylinder-types',
  );

  const { data: recentEvents, isLoading, refetch: refetchEvents } = useApiQuery<InventoryEvent[]>(
    ['depot-history-recent'],
    '/inventory/depot-history',
    { pageSize: 10 },
  );

  return (
    <>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetchEvents} />}
      >
        {/* Action Cards */}
        {ACTION_CARDS.map((action) => (
          <TouchableOpacity
            key={action.value}
            onPress={() => setActiveAction(action.value)}
            style={{
              backgroundColor: colors.cardBg, borderRadius: 16, padding: 18,
              borderWidth: 2, borderColor: colors.cardBorder,
              flexDirection: 'row', alignItems: 'center', gap: 14,
            }}
            activeOpacity={0.7}
          >
            <View style={{
              width: 48, height: 48, borderRadius: 14,
              backgroundColor: action.color + '15', alignItems: 'center', justifyContent: 'center',
            }}>
              <Ionicons name={action.icon as any} size={24} color={action.color} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '700', fontSize: 16, color: colors.text }}>{action.label}</Text>
              <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>{action.desc}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </TouchableOpacity>
        ))}

        {/* Recent Activity */}
        <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8 }}>
          Recent Activity
        </Text>

        {(!recentEvents || recentEvents.length === 0) ? (
          <Card>
            <Text style={{ textAlign: 'center', color: colors.textMuted, fontSize: 14 }}>No recent activity</Text>
          </Card>
        ) : (
          recentEvents.map((event) => (
            <Card key={event.eventId}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <Badge
                      label={(event.eventType || '').replace(/_/g, ' ')}
                      variant={
                        event.eventType === 'incoming_fulls' ? 'success' :
                        event.eventType === 'outgoing_empties' ? 'info' :
                        event.eventType === 'manual_adjustment' ? 'warning' : 'neutral'
                      }
                    />
                  </View>
                  <Text style={{ fontWeight: '600', fontSize: 14, color: colors.text }}>{event.cylinderTypeName}</Text>
                  {event.notes && <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>{event.notes}</Text>}
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={{ fontWeight: '700', fontSize: 18, color: (event.quantity ?? 0) >= 0 ? '#10b981' : '#ef4444' }}>
                    {(event.quantity ?? 0) >= 0 ? '+' : ''}{event.quantity ?? 0}
                  </Text>
                  <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 2 }}>{event.eventDate}</Text>
                </View>
              </View>
            </Card>
          ))
        )}
      </ScrollView>

      {/* Action Modal */}
      {activeAction && (
        <ActionModal
          type={activeAction}
          cylinderTypes={cylinderTypes ?? []}
          onClose={() => setActiveAction(null)}
          onSuccess={() => { refetchEvents(); setActiveAction(null); }}
          dark={dark}
          colors={colors}
        />
      )}
    </>
  );
}

// ─── RECONCILIATION ─────────────────────────────────────────────────────────

function ReconciliationContent() {
  const { dark, colors, accent } = useTheme();

  const { data: pendingVehicles, isLoading: pendingLoading, refetch: refetchPending } = useApiQuery<any[]>(
    ['pending-reconciliation'],
    '/delivery/reconciliation/pending',
  );

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
    <ScrollView
      contentContainerStyle={{ padding: 16, gap: 12 }}
      refreshControl={<RefreshControl refreshing={isLoading} onRefresh={handleRefresh} />}
    >
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
        pendingVehicles?.map((vehicle: any) => {
          const totalFulls = vehicle.pendingItems?.reduce((s: number, item: any) => s + (item.fullCount ?? 0), 0) ?? 0;
          const totalEmpties = vehicle.pendingItems?.reduce((s: number, item: any) => s + (item.emptyCount ?? 0), 0) ?? 0;

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

              {vehicle.pendingItems && (
                <View style={{ backgroundColor: dark ? colors.inputBg : '#f8fafc', borderRadius: 10, padding: 12, gap: 4, marginBottom: 10 }}>
                  {vehicle.pendingItems.map((item: any, i: number) => (
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
                  Alert.alert('Confirm', `Confirm physical stock matches for ${vehicle.vehicleNumber || 'this vehicle'}?`, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Confirm', onPress: () => confirmReconciliation.mutate({ vehicleId: vehicle.vehicleId }) },
                  ]);
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
                  Alert.alert('Return Stock', `Return ${item.quantity} ${item.cylinderTypeName} to depot?`, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Return', onPress: () => returnCancelled.mutate({ eventId: item.eventId }) },
                  ]);
                }}
                loading={returnCancelled.isPending}
                style={{ marginTop: 10 }}
              />
            )}
          </Card>
        ))
      )}
    </ScrollView>
  );
}

// ─── ALERTS ─────────────────────────────────────────────────────────────────

function AlertsContent() {
  const { dark, colors, accent } = useTheme();

  const { data: alerts, isLoading: alertsLoading, refetch: refetchAlerts } = useApiQuery<any[]>(
    ['threshold-alerts'],
    '/inventory/threshold-alerts',
  );

  const { data: forecasts, isLoading: forecastLoading, refetch: refetchForecasts } = useApiQuery<InventoryForecast[]>(
    ['inventory-forecast'],
    '/inventory/forecast',
  );

  const isLoading = alertsLoading || forecastLoading;
  const handleRefresh = () => { refetchAlerts(); refetchForecasts(); };

  const criticalAlerts = (alerts ?? []).filter((a) => a.severity === 'critical');
  const warningAlerts = (alerts ?? []).filter((a) => a.severity === 'warning' || a.severity !== 'critical');

  return (
    <ScrollView
      contentContainerStyle={{ padding: 16, gap: 12 }}
      refreshControl={<RefreshControl refreshing={isLoading} onRefresh={handleRefresh} />}
    >
      {/* Alert Summary */}
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <MetricCard title="Critical Alerts" value={criticalAlerts.length} color={criticalAlerts.length > 0 ? '#ef4444' : accent.green} />
        </View>
        <View style={{ flex: 1 }}>
          <MetricCard title="Warnings" value={warningAlerts.length} color={warningAlerts.length > 0 ? '#d97706' : accent.green} />
        </View>
      </View>

      {/* Threshold Alerts */}
      <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8 }}>
        Stock Alerts
      </Text>

      {(!alerts || alerts.length === 0) ? (
        <Card>
          <View style={{ alignItems: 'center', paddingVertical: 20 }}>
            <Ionicons name="checkmark-circle" size={40} color={accent.green} style={{ marginBottom: 8 }} />
            <Text style={{ fontSize: 15, fontWeight: '700', color: accent.green }}>All stock levels healthy</Text>
            <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>No threshold alerts</Text>
          </View>
        </Card>
      ) : (
        alerts.map((alert: any, i: number) => {
          const isCritical = alert.severity === 'critical';
          const alertBg = isCritical
            ? (dark ? 'rgba(220,38,38,0.12)' : '#fef2f2')
            : (dark ? 'rgba(245,158,11,0.12)' : '#fffbeb');

          return (
            <Card key={alert.cylinderTypeId || i}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>{alert.cylinderTypeName}</Text>
                <Badge label={isCritical ? 'CRITICAL' : 'WARNING'} variant={isCritical ? 'danger' : 'warning'} />
              </View>

              <View style={{ backgroundColor: alertBg, borderRadius: 10, padding: 12, gap: 6 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 13, color: colors.textSecondary }}>Current Stock</Text>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: isCritical ? '#ef4444' : '#d97706' }}>
                    {alert.currentStock ?? alert.closingFulls ?? 0}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 13, color: colors.textSecondary }}>Threshold</Text>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>
                    {alert.threshold ?? alert.thresholdLevel ?? 0}
                  </Text>
                </View>
                {alert.message && (
                  <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 4, fontStyle: 'italic' }}>{alert.message}</Text>
                )}
              </View>
            </Card>
          );
        })
      )}

      {/* Inventory Forecast */}
      <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 12 }}>
        Demand Forecast
      </Text>

      {(!forecasts || forecasts.length === 0) ? (
        <EmptyState title="No forecast data" description="Insufficient data to generate forecasts" />
      ) : (
        forecasts.map((fc) => {
          const daysRemaining = fc.daysOfStockRemaining ?? 0;
          const daysColor = daysRemaining < 3 ? '#ef4444' : daysRemaining < 7 ? '#d97706' : accent.green;

          return (
            <Card key={fc.cylinderTypeId}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <Text style={{ fontWeight: '700', fontSize: 16, color: colors.text }}>{fc.cylinderTypeName}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Ionicons
                    name={fc.trendDirection === 'increasing' ? 'trending-up' : fc.trendDirection === 'decreasing' ? 'trending-down' : 'remove'}
                    size={18}
                    color={fc.trendDirection === 'increasing' ? accent.green : fc.trendDirection === 'decreasing' ? '#ef4444' : colors.textMuted}
                  />
                  <Badge
                    label={`${daysRemaining.toFixed(0)}d left`}
                    variant={daysRemaining < 3 ? 'danger' : daysRemaining < 7 ? 'warning' : 'success'}
                  />
                </View>
              </View>

              {/* Days Progress Bar */}
              <View style={{ backgroundColor: dark ? colors.inputBg : '#f1f5f9', borderRadius: 6, height: 8, marginBottom: 12 }}>
                <View style={{
                  backgroundColor: daysColor, borderRadius: 6, height: 8,
                  width: `${Math.min((daysRemaining / 14) * 100, 100)}%`,
                }} />
              </View>

              {/* Metrics Grid */}
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <ForecastStat label="Avg Daily" value={(fc.averageDailyDemand ?? 0).toFixed(1)} dark={dark} colors={colors} />
                <ForecastStat label="7-Day" value={(fc.forecastedDemand7Days ?? 0).toFixed(0)} dark={dark} colors={colors} />
                <ForecastStat label="Reorder Qty" value={(fc.recommendedReorderQty ?? 0).toString()} highlight dark={dark} colors={colors} />
                <ForecastStat
                  label="Trend"
                  value={fc.trendDirection === 'increasing' ? 'Rising' : fc.trendDirection === 'decreasing' ? 'Falling' : 'Stable'}
                  valueColor={fc.trendDirection === 'increasing' ? accent.green : fc.trendDirection === 'decreasing' ? '#ef4444' : colors.textSecondary}
                  dark={dark}
                  colors={colors}
                />
              </View>
            </Card>
          );
        })
      )}
    </ScrollView>
  );
}

// ─── ACTION MODAL ───────────────────────────────────────────────────────────

function ActionModal({ type, cylinderTypes, onClose, onSuccess, dark, colors }: {
  type: ActionType;
  cylinderTypes: CylinderType[];
  onClose: () => void;
  onSuccess: () => void;
  dark: boolean;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const [selectedType, setSelectedType] = useState<string>('');
  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [documentNumber, setDocumentNumber] = useState('');

  const endpoint =
    type === 'incoming_fulls' ? '/inventory/incoming-fulls' :
    type === 'outgoing_empties' ? '/inventory/outgoing-empties' :
    '/inventory/manual-adjustment';

  const mutation = useApiMutation<void, any>(
    'post', endpoint,
    {
      invalidateKeys: [['inv-summary'], ['depot-history-recent']],
      successMessage: 'Inventory updated successfully',
      onSuccess,
    },
  );

  const config = ACTION_CARDS.find((a) => a.value === type)!;

  const handleSubmit = () => {
    if (!selectedType) { Alert.alert('Required', 'Select a cylinder type'); return; }
    if (!quantity || parseInt(quantity) === 0) { Alert.alert('Required', 'Enter a valid quantity'); return; }

    const payload: Record<string, unknown> = {
      cylinderTypeId: selectedType,
      quantity: parseInt(quantity),
      notes: notes.trim() || undefined,
    };

    if (type !== 'manual_adjustment') {
      payload.vehicleNumber = vehicleNumber.trim() || undefined;
      payload.documentNumber = documentNumber.trim() || undefined;
    }

    mutation.mutate(payload);
  };

  const inputStyle = {
    borderWidth: 1,
    borderColor: colors.inputBorder,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    backgroundColor: colors.inputBg,
    color: colors.text,
  };

  return (
    <Modal visible animationType="slide" transparent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
          <View style={{
            backgroundColor: dark ? colors.cardBg : '#fff',
            borderTopLeftRadius: 24, borderTopRightRadius: 24,
            padding: 24, maxHeight: '85%',
          }}>
            {/* Header */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Ionicons name={config.icon as any} size={24} color={config.color} />
                <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text }}>{config.label}</Text>
              </View>
              <TouchableOpacity onPress={onClose}>
                <Ionicons name="close" size={28} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 16 }}>
              {/* Cylinder Type Selector */}
              <View>
                <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 8 }}>Cylinder Type *</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {cylinderTypes.map((ct) => {
                    const isSelected = selectedType === ct.cylinderTypeId;
                    return (
                      <TouchableOpacity
                        key={ct.cylinderTypeId}
                        onPress={() => setSelectedType(ct.cylinderTypeId)}
                        style={{
                          paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12,
                          backgroundColor: isSelected ? config.color : colors.inputBg,
                          borderWidth: 1, borderColor: isSelected ? config.color : colors.inputBorder,
                        }}
                      >
                        <Text style={{
                          fontSize: 14, fontWeight: '600',
                          color: isSelected ? '#fff' : colors.textSecondary,
                        }}>
                          {ct.typeName}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* Quantity */}
              <View>
                <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>
                  Quantity *{type === 'manual_adjustment' ? ' (negative to reduce)' : ''}
                </Text>
                <TextInput
                  value={quantity}
                  onChangeText={setQuantity}
                  keyboardType={type === 'manual_adjustment' ? 'number-pad' : 'numeric'}
                  placeholder="0"
                  style={{ ...inputStyle, fontSize: 20, fontWeight: '700', textAlign: 'center' }}
                  placeholderTextColor={colors.textMuted}
                />
              </View>

              {/* Vehicle Number */}
              {type !== 'manual_adjustment' && (
                <View>
                  <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>Vehicle Number</Text>
                  <TextInput
                    value={vehicleNumber}
                    onChangeText={setVehicleNumber}
                    placeholder="e.g., KA-01-AB-1234"
                    autoCapitalize="characters"
                    style={inputStyle}
                    placeholderTextColor={colors.textMuted}
                  />
                </View>
              )}

              {/* Document Number */}
              {type !== 'manual_adjustment' && (
                <View>
                  <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>Document / Invoice No.</Text>
                  <TextInput
                    value={documentNumber}
                    onChangeText={setDocumentNumber}
                    placeholder="Optional reference"
                    style={inputStyle}
                    placeholderTextColor={colors.textMuted}
                  />
                </View>
              )}

              {/* Notes */}
              <View>
                <Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>Notes</Text>
                <TextInput
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Optional notes..."
                  multiline
                  style={{ ...inputStyle, minHeight: 80, textAlignVertical: 'top' }}
                  placeholderTextColor={colors.textMuted}
                />
              </View>

              <Button
                title={`Record ${config.label}`}
                onPress={handleSubmit}
                loading={mutation.isPending}
                style={{ marginTop: 4, backgroundColor: config.color }}
              />
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── Shared sub-components ──────────────────────────────────────────────────

function FlowRow({ label, value, color, bold, plus, minus, dark }: {
  label: string; value: number; color: string; bold?: boolean; plus?: boolean; minus?: boolean; dark: boolean;
}) {
  const prefix = plus ? '+' : minus ? '-' : '';
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={{ fontSize: 13, color: dark ? '#94a3b8' : '#64748b' }}>{label}</Text>
      <Text style={{ fontSize: 13, fontWeight: bold ? '700' : '500', color }}>
        {prefix}{Math.abs(value)}
      </Text>
    </View>
  );
}

function MiniStat({ label, value, color, prefix, bold, dark }: {
  label: string; value: number; color?: string; prefix?: string; bold?: boolean; dark: boolean;
}) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ fontSize: 11, color: dark ? '#94a3b8' : '#64748b' }}>{label}</Text>
      <Text style={{ fontWeight: bold ? '700' : '600', color: color || (dark ? '#f1f5f9' : '#0f172a') }}>
        {prefix || ''}{Math.abs(value)}
      </Text>
    </View>
  );
}

function ForecastStat({ label, value, highlight, valueColor, dark, colors }: {
  label: string; value: string; highlight?: boolean; valueColor?: string;
  dark: boolean; colors: ReturnType<typeof useTheme>['colors'];
}) {
  const bgColor = highlight
    ? (dark ? 'rgba(59,130,246,0.12)' : '#eef7ff')
    : (dark ? colors.inputBg : '#f8fafc');

  return (
    <View style={{
      flex: 1, minWidth: '45%', backgroundColor: bgColor,
      borderRadius: 10, padding: 10, alignItems: 'center',
    }}>
      <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 2 }}>{label}</Text>
      <Text style={{ fontSize: 16, fontWeight: '700', color: valueColor || (highlight ? '#3b82f6' : colors.text) }}>
        {value}
      </Text>
    </View>
  );
}
