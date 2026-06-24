import { useState, useCallback } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { Card, Badge, EmptyState } from '../../src/components/ui';
import { useTheme } from '../../src/theme';
import { useDistributorStore } from '../../src/stores/distributorStore';
import type { Driver, Vehicle } from '@gaslink/shared';
import { localTodayISO } from '@gaslink/shared';

// The fleet endpoints can return a couple of legacy/aliased fields the screen
// reads defensively (e.g. `firstName`/`phoneNumber` vs `driverName`/`phone`).
// Model them as optional so the access sites stay typed without `any`.
type DriverRow = Partial<Driver> & {
  id?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  assignedVehicle?: string;
  availability?: boolean | string;
};

type VehicleRow = Partial<Vehicle> & {
  id?: string;
  registrationNumber?: string;
  type?: string;
  capacityUnit?: string;
  driverName?: string;
};

interface AssignmentMapping {
  assignmentId?: string;
  id?: string;
  driverName?: string;
  vehicleNumber?: string;
  registrationNumber?: string;
  status?: string;
  source?: string;
}

interface VehicleMappingsResponse {
  recommendations: AssignmentMapping[];
  confirmedCount?: number;
  recommendedCount?: number;
  unassignedCount?: number;
}

// ── Sub-tabs ─────────────────────────────────────────────────────────────────

type SubTab = 'drivers' | 'vehicles' | 'assignments';

const SUB_TABS: { label: string; value: SubTab }[] = [
  { label: 'Drivers', value: 'drivers' },
  { label: 'Vehicles', value: 'vehicles' },
  { label: 'Assignments', value: 'assignments' },
];

// ── Status config ────────────────────────────────────────────────────────────

const DRIVER_STATUS_VARIANT: Record<string, 'success' | 'danger' | 'neutral'> = {
  active: 'success',
  inactive: 'danger',
};

const VEHICLE_STATUS_VARIANT: Record<string, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = {
  idle: 'neutral',
  dispatched: 'info',
  returned: 'success',
  inactive: 'danger',
};

const ASSIGNMENT_STATUS_VARIANT: Record<string, 'success' | 'warning' | 'info' | 'neutral'> = {
  confirmed: 'success',
  recommended: 'warning',
};

// ── Pill ─────────────────────────────────────────────────────────────────────

function Pill({
  label,
  active,
  activeColor,
  inactiveBg,
  inactiveText,
  onPress,
}: {
  label: string;
  active: boolean;
  activeColor: string;
  inactiveBg: string;
  inactiveText: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{
        height: 36,
        paddingHorizontal: 16,
        paddingVertical: 0,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: active ? activeColor : inactiveBg,
      }}
    >
      <Text style={{ fontSize: 13, fontWeight: '600', color: active ? '#fff' : inactiveText }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ── Main Screen ──────────────────────────────────────────────────────────────

export default function FleetScreen() {
  const router = useRouter();
  const { dark, colors, accent } = useTheme();
  const [tab, setTab] = useState<SubTab>('drivers');
  const { selectedDistributorId } = useDistributorStore();

  const distParams = selectedDistributorId ? { distributorId: selectedDistributorId } : {};
  const today = localTodayISO();

  // Drivers
  const { data: driversData, isLoading: driversLoading, refetch: refetchDrivers } = useApiQuery<
    { drivers: DriverRow[] } | DriverRow[]
  >(
    ['sa-fleet-drivers', selectedDistributorId ?? 'all'],
    '/drivers',
    distParams,
    { enabled: tab === 'drivers' },
  );
  const drivers: DriverRow[] = Array.isArray(driversData)
    ? driversData
    : driversData?.drivers ?? [];

  // Vehicles
  const { data: vehiclesData, isLoading: vehiclesLoading, refetch: refetchVehicles } = useApiQuery<
    { vehicles: VehicleRow[] } | VehicleRow[]
  >(
    ['sa-fleet-vehicles', selectedDistributorId ?? 'all'],
    '/vehicles',
    distParams,
    { enabled: tab === 'vehicles' },
  );
  const vehicles: VehicleRow[] = Array.isArray(vehiclesData)
    ? vehiclesData
    : vehiclesData?.vehicles ?? [];

  // Assignments
  const { data: assignmentsData, isLoading: assignmentsLoading, refetch: refetchAssignments } = useApiQuery<
    VehicleMappingsResponse
  >(
    ['sa-fleet-assignments', selectedDistributorId ?? 'all', today],
    '/assignments/vehicle-mappings',
    { ...distParams, date: today },
    { enabled: tab === 'assignments' },
  );
  const assignments: AssignmentMapping[] = assignmentsData?.recommendations ?? [];
  const confirmedCount = assignmentsData?.confirmedCount ?? 0;
  const recommendedCount = assignmentsData?.recommendedCount ?? 0;
  const unassignedCount = assignmentsData?.unassignedCount ?? 0;

  const isLoading = tab === 'drivers' ? driversLoading : tab === 'vehicles' ? vehiclesLoading : assignmentsLoading;

  const handleRefresh = useCallback(() => {
    if (tab === 'drivers') refetchDrivers();
    if (tab === 'vehicles') refetchVehicles();
    if (tab === 'assignments') refetchAssignments();
  }, [tab, refetchDrivers, refetchVehicles, refetchAssignments]);

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Back header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.cardBorder }}>
        <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>Fleet Management</Text>
      </View>
      {/* Sub-tab pills */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}
      >
        {SUB_TABS.map((t) => (
          <Pill
            key={t.value}
            label={t.label}
            active={tab === t.value}
            activeColor={accent.red}
            inactiveBg={dark ? colors.cardBg : colors.inputBg}
            inactiveText={colors.textSecondary}
            onPress={() => setTab(t.value)}
          />
        ))}
      </ScrollView>

      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={handleRefresh} />}
      >
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
          Fleet
        </Text>

        {/* ════ DRIVERS TAB ════ */}
        {tab === 'drivers' && (
          <>
            {driversLoading && drivers.length === 0 ? (
              <ActivityIndicator size="large" color={accent.red} style={{ marginTop: 40 }} />
            ) : drivers.length === 0 ? (
              <EmptyState title="No drivers" description="No drivers found" />
            ) : (
              <>
                <Text style={{ fontSize: 13, color: colors.textSecondary, marginBottom: 4 }}>
                  {drivers.length} driver{drivers.length !== 1 ? 's' : ''}
                </Text>
                {drivers.map((driver: DriverRow, i: number) => (
                  <Card key={driver.driverId ?? driver.id ?? i} style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
                    {/* Header */}
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }} numberOfLines={1}>
                          {driver.name ?? (`${driver.firstName ?? ''} ${driver.lastName ?? ''}`.trim() || `Driver ${i + 1}`)}
                        </Text>
                        {(driver.phone || driver.phoneNumber) && (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                            <Ionicons name="call-outline" size={13} color={colors.textSecondary} />
                            <Text style={{ fontSize: 12, color: colors.textSecondary }}>
                              {driver.phone ?? driver.phoneNumber}
                            </Text>
                          </View>
                        )}
                      </View>
                      <Badge
                        label={driver.status ?? 'active'}
                        variant={DRIVER_STATUS_VARIANT[driver.status ?? 'active'] ?? 'neutral'}
                      />
                    </View>

                    {/* Details row */}
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                      {(driver.vehicleNumber || driver.assignedVehicle) && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <Ionicons name="car-outline" size={14} color={colors.textSecondary} />
                          <Text style={{ fontSize: 12, color: colors.textSecondary }}>
                            {driver.vehicleNumber ?? driver.assignedVehicle}
                          </Text>
                        </View>
                      )}
                      {driver.availability != null && (
                        <Badge
                          label={driver.availability === true || driver.availability === 'available' ? 'Available' : 'Unavailable'}
                          variant={driver.availability === true || driver.availability === 'available' ? 'success' : 'warning'}
                        />
                      )}
                    </View>
                  </Card>
                ))}
              </>
            )}
          </>
        )}

        {/* ════ VEHICLES TAB ════ */}
        {tab === 'vehicles' && (
          <>
            {vehiclesLoading && vehicles.length === 0 ? (
              <ActivityIndicator size="large" color={accent.red} style={{ marginTop: 40 }} />
            ) : vehicles.length === 0 ? (
              <EmptyState title="No vehicles" description="No vehicles found" />
            ) : (
              <>
                <Text style={{ fontSize: 13, color: colors.textSecondary, marginBottom: 4 }}>
                  {vehicles.length} vehicle{vehicles.length !== 1 ? 's' : ''}
                </Text>
                {vehicles.map((vehicle: VehicleRow, i: number) => (
                  <Card key={vehicle.vehicleId ?? vehicle.id ?? i} style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
                    {/* Header */}
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }} numberOfLines={1}>
                          {vehicle.vehicleNumber ?? vehicle.registrationNumber ?? `Vehicle ${i + 1}`}
                        </Text>
                        {vehicle.type && (
                          <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                            {vehicle.type}
                          </Text>
                        )}
                      </View>
                      <Badge
                        label={vehicle.status ?? 'idle'}
                        variant={VEHICLE_STATUS_VARIANT[vehicle.status ?? 'idle'] ?? 'neutral'}
                      />
                    </View>

                    {/* Details */}
                    <View style={{ backgroundColor: dark ? colors.inputBg : colors.cardBg, borderRadius: 10, padding: 10, gap: 6 }}>
                      {vehicle.capacity != null && (
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text style={{ fontSize: 13, color: colors.textSecondary }}>Capacity</Text>
                          <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>
                            {vehicle.capacity} {vehicle.capacityUnit ?? 'cylinders'}
                          </Text>
                        </View>
                      )}
                      {vehicle.driverName && (
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text style={{ fontSize: 13, color: colors.textSecondary }}>Driver</Text>
                          <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>
                            {vehicle.driverName}
                          </Text>
                        </View>
                      )}
                    </View>
                  </Card>
                ))}
              </>
            )}
          </>
        )}

        {/* ════ ASSIGNMENTS TAB ════ */}
        {tab === 'assignments' && (
          <>
            {/* Today's date */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <Ionicons name="calendar-outline" size={16} color={colors.textSecondary} />
              <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary }}>
                {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })}
              </Text>
            </View>

            {/* Summary badges */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
              <Badge label={`${confirmedCount} Confirmed`} variant="success" />
              <Badge label={`${recommendedCount} Recommended`} variant="warning" />
              <Badge label={`${unassignedCount} Unassigned`} variant="danger" />
            </View>

            {assignmentsLoading && assignments.length === 0 ? (
              <ActivityIndicator size="large" color={accent.red} style={{ marginTop: 40 }} />
            ) : assignments.length === 0 ? (
              <EmptyState title="No assignments" description="No driver-vehicle mappings for today" />
            ) : (
              assignments.map((mapping: AssignmentMapping, i: number) => (
                <Card key={mapping.assignmentId ?? mapping.id ?? i} style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
                  {/* Header */}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <View style={{ flex: 1, marginRight: 8 }}>
                      <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }} numberOfLines={1}>
                        {mapping.driverName ?? `Driver ${i + 1}`}
                      </Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                        <Ionicons name="car-outline" size={14} color={colors.textSecondary} />
                        <Text style={{ fontSize: 13, color: colors.textSecondary }}>
                          {mapping.vehicleNumber ?? mapping.registrationNumber ?? 'Unassigned'}
                        </Text>
                      </View>
                    </View>
                    <Badge
                      label={mapping.status ?? 'recommended'}
                      variant={ASSIGNMENT_STATUS_VARIANT[mapping.status ?? 'recommended'] ?? 'neutral'}
                    />
                  </View>

                  {/* Source */}
                  {mapping.source && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Ionicons name="information-circle-outline" size={14} color={colors.textMuted} />
                      <Text style={{ fontSize: 12, color: colors.textMuted }}>
                        Source: {mapping.source}
                      </Text>
                    </View>
                  )}
                </Card>
              ))
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
