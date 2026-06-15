import { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  Modal,
  FlatList,
  TextInput,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { useTheme, ACCENT as ACCENT_COLORS } from '../../src/theme';
import { DateInput } from '../../src/components/ui';
import { useAuthStore } from '../../src/stores/authStore';
import { UserRole } from '@gaslink/shared';

const ACCENT = ACCENT_COLORS.red;

// STAGE-H: this screen replaces the in-modal FleetModal that used to live
// inside (admin)/more.tsx. Drivers / Vehicles / Assignments sub-tabs preserved;
// STEP-3D editable vehicle-mapping behaviour preserved.

interface Driver {
  driverId: string;
  driverName: string;
  phone: string;
  licenseNumber?: string;
  status: 'active' | 'inactive';
}

interface Vehicle {
  vehicleId: string;
  vehicleNumber: string;
  vehicleType: string;
  capacity?: number;
  status: 'idle' | 'dispatched' | 'returned' | 'inactive' | 'active';
}

interface VehicleMappingRow {
  driverId: string;
  driverName: string;
  available: boolean;
  vehicleId: string | null;
  vehicleNumber: string | null;
  assignmentId?: string;
  status: 'confirmed' | 'recommended' | 'unassigned';
  source: 'today' | 'previous_day' | 'none';
}

interface VehicleMappingsResponse {
  date: string;
  recommendations: VehicleMappingRow[];
  allDrivers: { id: string; driverName: string; availableToday: boolean }[];
  allVehicles: {
    id: string;
    vehicleNumber: string;
    vehicleType: string | null;
    capacity: number | null;
  }[];
  confirmedCount: number;
  recommendedCount: number;
  unassignedCount: number;
}

function StatusBadge({ label, color }: { label: string; color: string }) {
  return (
    <View
      style={{
        backgroundColor: color + '18',
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: '700', color, textTransform: 'uppercase' }}>
        {label}
      </Text>
    </View>
  );
}

function FAB({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      style={{
        position: 'absolute',
        bottom: 24,
        right: 24,
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: ACCENT,
        alignItems: 'center',
        justifyContent: 'center',
        elevation: 6,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.25,
        shadowRadius: 6,
      }}
    >
      <Ionicons name="add" size={28} color="#fff" />
    </TouchableOpacity>
  );
}

function EmptyList({ message, color }: { message: string; color: string }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 48 }}>
      <Ionicons name="file-tray-outline" size={48} color={color} />
      <Text style={{ fontSize: 14, color, marginTop: 12 }}>{message}</Text>
    </View>
  );
}

function FormInput({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoCapitalize,
  textColor,
  secondaryColor,
  mutedColor,
  inputBg,
  inputBorder,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'phone-pad' | 'email-address' | 'numeric';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  textColor: string;
  secondaryColor: string;
  mutedColor: string;
  inputBg: string;
  inputBorder: string;
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={{ fontSize: 13, fontWeight: '600', color: secondaryColor, marginBottom: 6 }}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={mutedColor}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize ?? 'sentences'}
        style={{
          backgroundColor: inputBg,
          borderWidth: 1,
          borderColor: inputBorder,
          borderRadius: 10,
          paddingHorizontal: 14,
          paddingVertical: 12,
          fontSize: 15,
          color: textColor,
        }}
      />
    </View>
  );
}

function TabBar({
  tabs,
  active,
  onSelect,
  dividerColor,
  textSecondary,
}: {
  tabs: string[];
  active: number;
  onSelect: (i: number) => void;
  dividerColor: string;
  textSecondary: string;
}) {
  return (
    <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: dividerColor }}>
      {tabs.map((t, i) => (
        <TouchableOpacity
          key={t}
          onPress={() => onSelect(i)}
          style={{
            flex: 1,
            paddingVertical: 12,
            alignItems: 'center',
            borderBottomWidth: 2,
            borderBottomColor: active === i ? ACCENT : 'transparent',
          }}
        >
          <Text
            style={{
              fontSize: 14,
              fontWeight: active === i ? '700' : '500',
              color: active === i ? ACCENT : textSecondary,
            }}
          >
            {t}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

export default function AdminFleetScreen() {
  const { colors } = useTheme();
  // canEdit gate: pattern mirrors (admin)/customer-detail.tsx:907-916.
  // Hides every mutation affordance for the finance role (which can read
  // drivers/vehicles/assignments but is blocked by the API on writes —
  // see driversVehicles.ts lines 159, 845). Inventory + dist-admin +
  // super-admin keep full edit access.
  const role = useAuthStore((s) => s.user?.role);
  const canEdit =
    role === UserRole.SUPER_ADMIN ||
    role === UserRole.DISTRIBUTOR_ADMIN ||
    role === UserRole.INVENTORY;
  const [activeTab, setActiveTab] = useState(0);
  const [showDriverForm, setShowDriverForm] = useState(false);
  const [showVehicleForm, setShowVehicleForm] = useState(false);

  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [driverLicense, setDriverLicense] = useState('');
  // Edit-mode: when set, the driver form is reusing PUT /drivers/:id
  // and pre-filled with the existing row's values.
  const [editingDriverId, setEditingDriverId] = useState<string | null>(null);

  const [vehNumber, setVehNumber] = useState('');
  const [vehType, setVehType] = useState('');
  const [vehCapacity, setVehCapacity] = useState('');
  // Only the user-editable statuses are exposed. `dispatched` and
  // `returned` are system-set (driver dispatch → reconcile flow) and
  // must not be reachable from a manual edit form.
  const [vehStatus, setVehStatus] = useState<'idle' | 'inactive'>('idle');
  const [editingVehicleId, setEditingVehicleId] = useState<string | null>(null);

  const {
    data: driversResponse,
    isLoading: driversLoading,
    refetch: refetchDrivers,
  } = useApiQuery<{ drivers: Driver[] }>(['drivers'], '/drivers');
  const drivers: Driver[] = driversResponse?.drivers ?? [];

  const {
    data: vehiclesResponse,
    isLoading: vehiclesLoading,
    refetch: refetchVehicles,
  } = useApiQuery<{ vehicles: Vehicle[] }>(['vehicles'], '/vehicles');
  const vehicles: Vehicle[] = vehiclesResponse?.vehicles ?? [];

  const [mappingDate, setMappingDate] = useState<string>(
    () => new Date().toISOString().split('T')[0],
  );
  const [pickerForDriverId, setPickerForDriverId] = useState<string | null>(null);

  const {
    data: mappingsResponse,
    isLoading: assignmentsLoading,
    refetch: refetchAssignments,
  } = useApiQuery<VehicleMappingsResponse>(
    ['admin-vehicle-mappings', mappingDate],
    '/assignments/vehicle-mappings',
    { date: mappingDate },
  );

  const upsertMappingMutation = useApiMutation<
    { assignmentId: string; driverId: string; vehicleId: string },
    { date: string; driverId: string; vehicleId: string }
  >('put', '/assignments/vehicle-mappings', {
    // P1-1: ['drivers-list'] feeds the Assign Driver modal on the Orders tab.
    // Its response shape includes each driver's vehicleNumber (resolved from
    // today's mapping). When a mapping is created here in Fleet, the
    // ['drivers-list'] cache stays stale for 30s — long enough for the user
    // to switch to Orders and see "no drivers have a vehicle today" on a
    // driver they just mapped. Invalidate it here so the Assign modal
    // reflects the new mapping immediately. Same fix below on the bulk
    // confirm mutation. The wider stale-cache risk was already called out
    // in (admin)/orders.tsx:260-264; the comment predates this fix.
    invalidateKeys: [
      ['admin-vehicle-mappings', mappingDate],
      ['assignments'],
      ['vehicles'],
      ['drivers-list'],
    ],
    onSuccess: () => setPickerForDriverId(null),
  });

  const bulkConfirmMutation = useApiMutation<
    { confirmed: number; date: string; message: string },
    { date: string }
  >('post', '/assignments/vehicle-mappings/confirm', {
    // P1-1: invalidate ['drivers-list'] for the same reason as the upsert
    // mutation above — bulk confirm is the more common path (copy
    // yesterday's mappings forward) and was the surface Suneel reported.
    invalidateKeys: [
      ['admin-vehicle-mappings', mappingDate],
      ['assignments'],
      ['vehicles'],
      ['drivers-list'],
    ],
    onSuccess: (data) => {
      if (data?.confirmed && data.confirmed > 0) {
        Alert.alert(
          'Confirmed',
          `Confirmed ${data.confirmed} driver-vehicle mapping${data.confirmed === 1 ? '' : 's'}.`,
        );
      } else {
        Alert.alert(
          'Nothing to confirm',
          data?.message ?? 'No previous-day assignments were found to copy forward.',
        );
      }
    },
  });

  const createDriverMutation = useApiMutation<
    Driver,
    { driverName: string; phone: string; licenseNumber?: string }
  >('post', '/drivers', {
    invalidateKeys: [['drivers']],
    successMessage: 'Driver added',
    onSuccess: () => {
      setDriverName('');
      setDriverPhone('');
      setDriverLicense('');
      setShowDriverForm(false);
      setEditingDriverId(null);
    },
  });

  const updateDriverMutation = useApiMutation<
    Driver,
    { driverName?: string; phone?: string; licenseNumber?: string | null }
  >('put', () => `/drivers/${editingDriverId}`, {
    invalidateKeys: [['drivers']],
    successMessage: 'Driver updated',
    onSuccess: () => {
      setDriverName('');
      setDriverPhone('');
      setDriverLicense('');
      setShowDriverForm(false);
      setEditingDriverId(null);
    },
  });

  const createVehicleMutation = useApiMutation<
    Vehicle,
    { vehicleNumber: string; vehicleType: string; capacity?: number }
  >('post', '/vehicles', {
    invalidateKeys: [['vehicles']],
    successMessage: 'Vehicle added',
    onSuccess: () => {
      setVehNumber('');
      setVehType('');
      setVehCapacity('');
      setShowVehicleForm(false);
      setEditingVehicleId(null);
    },
  });

  const updateVehicleMutation = useApiMutation<
    Vehicle,
    {
      vehicleNumber?: string;
      vehicleType?: string;
      capacity?: number;
      status?: 'idle' | 'inactive';
    }
  >('put', () => `/vehicles/${editingVehicleId}`, {
    invalidateKeys: [['vehicles']],
    successMessage: 'Vehicle updated',
    onSuccess: () => {
      setVehNumber('');
      setVehType('');
      setVehCapacity('');
      setVehStatus('idle');
      setShowVehicleForm(false);
      setEditingVehicleId(null);
    },
  });

  // Mark-as-returned for a dispatched vehicle. Hits the same endpoint
  // the driver app uses (POST /delivery/driver/vehicle-returned) so the
  // existing pending_delivery + reconciliation guards run consistently
  // (WI-087 / WI-100 Gap C). Invalidating both vehicles and the
  // reconciliation queue keeps the Inventory → Vehicle Return tab in
  // sync the moment a vehicle flips from dispatched → returned.
  const markReturnedMutation = useApiMutation<unknown, { vehicleId: string }>(
    'post',
    '/delivery/driver/vehicle-returned',
    {
      invalidateKeys: [['vehicles'], ['reconciliation-pending']],
      successMessage: 'Vehicle marked as returned',
    },
  );

  const handleMarkReturned = (v: Vehicle) => {
    Alert.alert(
      'Mark Returned',
      `Mark ${v.vehicleNumber} as returned to depot?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Mark Returned', onPress: () => markReturnedMutation.mutate({ vehicleId: v.vehicleId }) },
      ],
    );
  };

  const startEditDriver = (d: Driver) => {
    setEditingDriverId(d.driverId);
    setDriverName(d.driverName || '');
    setDriverPhone(d.phone || '');
    setDriverLicense(d.licenseNumber || '');
    setShowDriverForm(true);
  };

  const startEditVehicle = (v: Vehicle) => {
    setEditingVehicleId(v.vehicleId);
    setVehNumber(v.vehicleNumber || '');
    setVehType(v.vehicleType || '');
    setVehCapacity(v.capacity != null ? String(v.capacity) : '');
    // System-set statuses (dispatched, returned) fall back to 'idle' in
    // the picker so a save without changing the dropdown can't accidentally
    // POST a system-only value the API would also reject.
    setVehStatus(v.status === 'inactive' ? 'inactive' : 'idle');
    setShowVehicleForm(true);
  };

  const handleAddDriver = () => {
    if (!driverName.trim() || !driverPhone.trim()) {
      Alert.alert('Validation', 'Name and phone are required.');
      return;
    }
    if (editingDriverId) {
      updateDriverMutation.mutate({
        driverName: driverName.trim(),
        phone: driverPhone.trim(),
        licenseNumber: driverLicense.trim() || null,
      });
      return;
    }
    createDriverMutation.mutate({
      driverName: driverName.trim(),
      phone: driverPhone.trim(),
      licenseNumber: driverLicense.trim() || undefined,
    });
  };

  const handleAddVehicle = () => {
    if (!vehNumber.trim() || !vehType.trim()) {
      Alert.alert('Validation', 'Vehicle number and type are required.');
      return;
    }
    if (editingVehicleId) {
      updateVehicleMutation.mutate({
        vehicleNumber: vehNumber.trim(),
        vehicleType: vehType.trim(),
        capacity: vehCapacity ? parseInt(vehCapacity, 10) : undefined,
        status: vehStatus,
      });
      return;
    }
    createVehicleMutation.mutate({
      vehicleNumber: vehNumber.trim(),
      vehicleType: vehType.trim(),
      capacity: vehCapacity ? parseInt(vehCapacity, 10) : undefined,
    });
  };

  const isVehicleInactive = (v: Vehicle | undefined): boolean => !!v && v.status === 'inactive';

  const vehicleById = new Map(vehicles.map((v) => [v.vehicleId, v]));

  const recommendations = mappingsResponse?.recommendations ?? [];
  const takenByOtherDriver = new Map<string, string>();
  recommendations.forEach((r) => {
    if (r.status === 'confirmed' && r.vehicleId) {
      takenByOtherDriver.set(r.vehicleId, r.driverId);
    }
  });

  const optionsForDriver = (driverId: string, currentVehicleId: string | null): Vehicle[] =>
    vehicles
      .filter((v) => !isVehicleInactive(v))
      .filter((v) => {
        const taker = takenByOtherDriver.get(v.vehicleId);
        return !taker || taker === driverId || v.vehicleId === currentVehicleId;
      });

  const handleBulkConfirm = () => {
    Alert.alert(
      'Use Previous Day',
      `Copy yesterday's driver-vehicle mappings forward to ${mappingDate}? Existing mappings for this date will be replaced.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: () => bulkConfirmMutation.mutate({ date: mappingDate }),
        },
      ],
    );
  };

  const handlePickVehicle = (driverId: string, vehicleId: string) => {
    upsertMappingMutation.mutate({ date: mappingDate, driverId, vehicleId });
  };

  const statusVariant = (
    status: VehicleMappingRow['status'],
  ): 'success' | 'info' | 'warning' => {
    if (status === 'confirmed') return 'success';
    if (status === 'recommended') return 'info';
    return 'warning';
  };

  const renderDrivers = () => {
    if (showDriverForm) {
      return (
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 16 }}>
            {editingDriverId ? 'Edit Driver' : 'Add Driver'}
          </Text>
          <FormInput
            label="Name *"
            value={driverName}
            onChangeText={setDriverName}
            placeholder="Driver name"
            textColor={colors.text}
            secondaryColor={colors.textSecondary}
            mutedColor={colors.textMuted}
            inputBg={colors.inputBg}
            inputBorder={colors.inputBorder}
          />
          <FormInput
            label="Phone *"
            value={driverPhone}
            onChangeText={setDriverPhone}
            placeholder="Phone number"
            keyboardType="phone-pad"
            textColor={colors.text}
            secondaryColor={colors.textSecondary}
            mutedColor={colors.textMuted}
            inputBg={colors.inputBg}
            inputBorder={colors.inputBorder}
          />
          <FormInput
            label="License Number"
            value={driverLicense}
            onChangeText={setDriverLicense}
            placeholder="DL number (optional)"
            autoCapitalize="characters"
            textColor={colors.text}
            secondaryColor={colors.textSecondary}
            mutedColor={colors.textMuted}
            inputBg={colors.inputBg}
            inputBorder={colors.inputBorder}
          />

          <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
            <TouchableOpacity
              onPress={() => { setShowDriverForm(false); setEditingDriverId(null); }}
              style={{
                flex: 1,
                paddingVertical: 14,
                borderRadius: 10,
                backgroundColor: colors.cardBg,
                borderWidth: 1,
                borderColor: colors.cardBorder,
                alignItems: 'center',
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.textSecondary }}>
                Cancel
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleAddDriver}
              disabled={createDriverMutation.isPending}
              style={{
                flex: 1,
                paddingVertical: 14,
                borderRadius: 10,
                backgroundColor: ACCENT,
                alignItems: 'center',
                opacity: (createDriverMutation.isPending || updateDriverMutation.isPending) ? 0.6 : 1,
              }}
            >
              {(createDriverMutation.isPending || updateDriverMutation.isPending) ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>{editingDriverId ? 'Save' : 'Add Driver'}</Text>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      );
    }

    if (driversLoading) {
      return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      );
    }

    return (
      <View style={{ flex: 1 }}>
        <FlatList
          data={drivers}
          keyExtractor={(item) => item.driverId}
          /* UBB C2 U5 — FAB clearance, same rationale as vehicles list. */
          contentContainerStyle={{ paddingBottom: 96 }}
          renderItem={({ item }) => (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 16,
                paddingVertical: 14,
                gap: 12,
              }}
            >
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  backgroundColor: '#3b82f6' + '14',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ionicons name="person" size={18} color="#3b82f6" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>
                  {item.driverName}
                </Text>
                <Text style={{ fontSize: 12, color: colors.textMuted }}>{item.phone}</Text>
              </View>
              <StatusBadge
                label={item.status}
                color={item.status === 'active' ? '#10b981' : '#94a3b8'}
              />
              {canEdit && (
                <TouchableOpacity
                  onPress={() => startEditDriver(item)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={{ marginLeft: 8, padding: 4 }}
                >
                  <Ionicons name="create-outline" size={20} color={ACCENT} />
                </TouchableOpacity>
              )}
            </View>
          )}
          ItemSeparatorComponent={() => (
            <View style={{ height: 1, backgroundColor: colors.divider }} />
          )}
          ListEmptyComponent={<EmptyList message="No drivers added" color={colors.textMuted} />}
          refreshControl={
            <RefreshControl refreshing={false} onRefresh={refetchDrivers} tintColor={ACCENT} />
          }
        />
        {canEdit && (
          <FAB onPress={() => { setEditingDriverId(null); setDriverName(''); setDriverPhone(''); setDriverLicense(''); setShowDriverForm(true); }} />
        )}
      </View>
    );
  };

  const renderVehicles = () => {
    if (showVehicleForm) {
      return (
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 16 }}>
            {editingVehicleId ? 'Edit Vehicle' : 'Add Vehicle'}
          </Text>
          <FormInput
            label="Vehicle Number *"
            value={vehNumber}
            onChangeText={setVehNumber}
            placeholder="e.g. KA-01-AB-1234"
            autoCapitalize="characters"
            textColor={colors.text}
            secondaryColor={colors.textSecondary}
            mutedColor={colors.textMuted}
            inputBg={colors.inputBg}
            inputBorder={colors.inputBorder}
          />
          <FormInput
            label="Vehicle Type *"
            value={vehType}
            onChangeText={setVehType}
            placeholder="e.g. Mini Truck, Auto"
            textColor={colors.text}
            secondaryColor={colors.textSecondary}
            mutedColor={colors.textMuted}
            inputBg={colors.inputBg}
            inputBorder={colors.inputBorder}
          />
          <FormInput
            label="Capacity (cylinders)"
            value={vehCapacity}
            onChangeText={setVehCapacity}
            placeholder="e.g. 20"
            keyboardType="numeric"
            textColor={colors.text}
            secondaryColor={colors.textSecondary}
            mutedColor={colors.textMuted}
            inputBg={colors.inputBg}
            inputBorder={colors.inputBorder}
          />

          {/* Status — only exposed on Edit (Create defaults server-side
              to 'idle'). The two system-set statuses 'dispatched' and
              'returned' are deliberately NOT in this picker; they flip
              via the dispatch/reconcile flow. */}
          {editingVehicleId && (
            <View style={{ marginTop: 8, marginBottom: 14 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 8 }}>
                Status
              </Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {(['idle', 'inactive'] as const).map((s) => {
                  const selected = vehStatus === s;
                  const color = s === 'idle' ? '#10b981' : '#94a3b8';
                  return (
                    <TouchableOpacity
                      key={s}
                      onPress={() => setVehStatus(s)}
                      style={{
                        flex: 1, paddingVertical: 10, borderRadius: 8,
                        borderWidth: 1.5,
                        borderColor: selected ? color : colors.inputBorder,
                        backgroundColor: selected ? color + '14' : colors.inputBg,
                        alignItems: 'center',
                      }}
                    >
                      <Text style={{
                        fontSize: 13, fontWeight: '700',
                        color: selected ? color : colors.textSecondary,
                      }}>
                        {s === 'idle' ? 'Active' : 'Inactive'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}

          <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
            <TouchableOpacity
              onPress={() => { setShowVehicleForm(false); setEditingVehicleId(null); }}
              style={{
                flex: 1,
                paddingVertical: 14,
                borderRadius: 10,
                backgroundColor: colors.cardBg,
                borderWidth: 1,
                borderColor: colors.cardBorder,
                alignItems: 'center',
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.textSecondary }}>
                Cancel
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleAddVehicle}
              disabled={createVehicleMutation.isPending}
              style={{
                flex: 1,
                paddingVertical: 14,
                borderRadius: 10,
                backgroundColor: ACCENT,
                alignItems: 'center',
                opacity: (createVehicleMutation.isPending || updateVehicleMutation.isPending) ? 0.6 : 1,
              }}
            >
              {(createVehicleMutation.isPending || updateVehicleMutation.isPending) ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>{editingVehicleId ? 'Save' : 'Add Vehicle'}</Text>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      );
    }

    if (vehiclesLoading) {
      return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      );
    }

    return (
      <View style={{ flex: 1 }}>
        <FlatList
          data={vehicles}
          keyExtractor={(item) => item.vehicleId}
          /* UBB C2 U5 — bottom padding to keep the last vehicle row
             clear of the FAB (56×56 at bottom:24 = 80dp from the
             scroll-content bottom; 96dp gives a 16dp visual buffer). */
          contentContainerStyle={{ paddingBottom: 96 }}
          renderItem={({ item }) => {
            // NEW-6 (2026-06-09) — when status === 'dispatched' the row has
            // 5 inline children (avatar + flex:1 text + Badge + Mark Returned
            // button + Edit icon). On a 360dp Android screen the action
            // cluster eats ~226dp + 60dp of padding/gaps, leaving ~14dp for
            // the flex:1 text column — the vehicle number renders as "…" or
            // invisible. UBB C2 added numberOfLines={1} which stopped the
            // 3-4 line wrap on idle rows but didn't address the deeper
            // squeeze on dispatched rows because UBB C2's manual QA was on
            // idle rows only (see anti-pattern #20 candidate). Fix: on
            // dispatched rows ONLY, move the action cluster to a second
            // row below — text column gets the full width, all actions
            // stay reachable. Idle / returned / inactive rows keep the
            // single-row layout (no UX regression where the bug doesn't
            // live; only Badge + Edit fit comfortably on those).
            const isDispatched = item.status === 'dispatched';
            const badgeColor =
              item.status === 'idle' ? '#10b981'
              : item.status === 'dispatched' ? '#3b82f6'
              : item.status === 'returned' ? '#f59e0b'
              : '#94a3b8';

            return (
              <View
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                }}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <View
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 20,
                      backgroundColor: '#f59e0b' + '14',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Ionicons name="car" size={18} color="#f59e0b" />
                  </View>
                  <View style={{ flex: 1 }}>
                    {/* UBB C2 U3/U4 — numberOfLines={1} prevents 3-4 line
                        wrap when the column gets squeezed. Kept after
                        NEW-6 because long vehicle numbers (e.g.
                        "TEST-DISPATCH-TRIP-D2") still need ellipsis on
                        narrow screens even with the cluster moved below. */}
                    <Text
                      numberOfLines={1}
                      ellipsizeMode="tail"
                      style={{ fontSize: 15, fontWeight: '600', color: colors.text }}
                    >
                      {item.vehicleNumber}
                    </Text>
                    <Text
                      numberOfLines={1}
                      ellipsizeMode="tail"
                      style={{ fontSize: 12, color: colors.textMuted }}
                    >
                      {item.vehicleType}
                      {item.capacity ? ` - ${item.capacity} cyl` : ''}
                    </Text>
                  </View>
                  {/* Non-dispatched: Badge + Edit stay inline (unchanged). */}
                  {!isDispatched && (
                    <>
                      <StatusBadge label={item.status} color={badgeColor} />
                      <TouchableOpacity
                        onPress={() => startEditVehicle(item)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        style={{ marginLeft: 8, padding: 4 }}
                      >
                        <Ionicons name="create-outline" size={20} color={ACCENT} />
                      </TouchableOpacity>
                    </>
                  )}
                </View>
                {/* Dispatched: action cluster on its own row below, right-
                    aligned. The Mark Returned button mirrors the web
                    FleetPage button; hits the same driver-app endpoint so
                    WI-087/WI-100 guards run too. */}
                {isDispatched && (
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                      marginTop: 8,
                      justifyContent: 'flex-end',
                    }}
                  >
                    <StatusBadge label={item.status} color={badgeColor} />
                    {canEdit && (
                      <TouchableOpacity
                        onPress={() => handleMarkReturned(item)}
                        disabled={markReturnedMutation.isPending}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        style={{
                          paddingHorizontal: 10,
                          paddingVertical: 6,
                          borderRadius: 6,
                          backgroundColor: '#3b82f6' + '14',
                          borderWidth: 1,
                          borderColor: '#3b82f6',
                          opacity: markReturnedMutation.isPending ? 0.6 : 1,
                        }}
                      >
                        <Text style={{ fontSize: 11, fontWeight: '700', color: '#3b82f6' }}>
                          Mark Returned
                        </Text>
                      </TouchableOpacity>
                    )}
                    {canEdit && (
                      <TouchableOpacity
                        onPress={() => startEditVehicle(item)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        style={{ padding: 4 }}
                      >
                        <Ionicons name="create-outline" size={20} color={ACCENT} />
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </View>
            );
          }}
          ItemSeparatorComponent={() => (
            <View style={{ height: 1, backgroundColor: colors.divider }} />
          )}
          ListEmptyComponent={<EmptyList message="No vehicles added" color={colors.textMuted} />}
          refreshControl={
            <RefreshControl refreshing={false} onRefresh={refetchVehicles} tintColor={ACCENT} />
          }
        />
        {canEdit && (
          <FAB onPress={() => { setEditingVehicleId(null); setVehNumber(''); setVehType(''); setVehCapacity(''); setVehStatus('idle'); setShowVehicleForm(true); }} />
        )}
      </View>
    );
  };

  const renderAssignments = () => {
    return (
      <View style={{ flex: 1 }}>
        <View
          style={{
            flexDirection: 'row',
            gap: 10,
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: colors.divider,
            alignItems: 'center',
          }}
        >
          <View style={{ flex: 1 }}>
            <DateInput
              value={mappingDate || null}
              onChange={(v) => {
                setMappingDate(v);
                setPickerForDriverId(null);
              }}
              placeholder="Select date"
            />
          </View>
          {canEdit && (
            <TouchableOpacity
              onPress={handleBulkConfirm}
              disabled={bulkConfirmMutation.isPending}
              style={{
                paddingVertical: 10,
                paddingHorizontal: 14,
                borderRadius: 8,
                backgroundColor: ACCENT,
                opacity: bulkConfirmMutation.isPending ? 0.6 : 1,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {bulkConfirmMutation.isPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="checkmark-done" size={14} color="#fff" />
                  <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>
                    Use Previous Day
                  </Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </View>

        {assignmentsLoading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        ) : (
          <FlatList
            data={recommendations}
            keyExtractor={(item) => item.driverId}
            renderItem={({ item }) => {
              const mappedVehicle = item.vehicleId ? vehicleById.get(item.vehicleId) : undefined;
              const mappedVehicleInactive = isVehicleInactive(mappedVehicle);
              const saving =
                upsertMappingMutation.isPending &&
                upsertMappingMutation.variables?.driverId === item.driverId;
              const variant = statusVariant(item.status);
              const badgeColor =
                variant === 'success' ? '#10b981' : variant === 'info' ? '#3b82f6' : '#f59e0b';

              return (
                <View style={{ paddingHorizontal: 16, paddingVertical: 14, gap: 8 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <View
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 20,
                        backgroundColor: '#8b5cf6' + '14',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Ionicons name="link" size={18} color="#8b5cf6" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>
                        {item.driverName}
                      </Text>
                      <Text style={{ fontSize: 12, color: colors.textMuted }}>
                        Source: {item.source}
                      </Text>
                    </View>
                    <StatusBadge label={item.status} color={badgeColor} />
                  </View>

                  <TouchableOpacity
                    onPress={() => setPickerForDriverId(item.driverId)}
                    disabled={saving}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: mappedVehicleInactive ? '#ef4444' : colors.inputBorder,
                      backgroundColor: colors.inputBg,
                      opacity: saving ? 0.6 : 1,
                    }}
                  >
                    <View
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}
                    >
                      <Ionicons name="car-outline" size={14} color={colors.textMuted} />
                      <Text
                        style={{
                          fontSize: 14,
                          color: item.vehicleNumber ? colors.text : colors.textMuted,
                          fontWeight: item.vehicleNumber ? '600' : '400',
                        }}
                        numberOfLines={1}
                      >
                        {item.vehicleNumber ?? 'Unassigned — tap to assign'}
                      </Text>
                    </View>
                    {saving ? (
                      <ActivityIndicator size="small" color={ACCENT} />
                    ) : (
                      <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
                    )}
                  </TouchableOpacity>

                  {mappedVehicleInactive && (
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        borderRadius: 6,
                        backgroundColor: '#ef4444' + '14',
                      }}
                    >
                      <Ionicons name="warning" size={14} color="#ef4444" />
                      <Text style={{ fontSize: 12, color: '#ef4444', fontWeight: '600' }}>
                        Vehicle inactive — please reassign
                      </Text>
                      {item.vehicleNumber ? (
                        <Text style={{ fontSize: 12, color: colors.textMuted }}>
                          (was {item.vehicleNumber})
                        </Text>
                      ) : null}
                    </View>
                  )}
                </View>
              );
            }}
            ItemSeparatorComponent={() => (
              <View style={{ height: 1, backgroundColor: colors.divider }} />
            )}
            ListEmptyComponent={
              <EmptyList
                message={`No mappings for ${mappingDate}. Try changing the date or pull to refresh.`}
                color={colors.textMuted}
              />
            }
            ListFooterComponent={
              mappingsResponse ? (
                <View
                  style={{
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderTopWidth: 1,
                    borderTopColor: colors.divider,
                    backgroundColor: colors.cardBg,
                  }}
                >
                  <Text
                    style={{ fontSize: 13, color: colors.textSecondary, textAlign: 'center' }}
                  >
                    Confirmed: {mappingsResponse.confirmedCount} · Recommended:{' '}
                    {mappingsResponse.recommendedCount} · Unassigned:{' '}
                    {mappingsResponse.unassignedCount}
                  </Text>
                </View>
              ) : null
            }
            refreshControl={
              <RefreshControl
                refreshing={false}
                onRefresh={refetchAssignments}
                tintColor={ACCENT}
              />
            }
          />
        )}

        <Modal
          visible={pickerForDriverId !== null}
          animationType="slide"
          transparent
          onRequestClose={() => setPickerForDriverId(null)}
        >
          <View
            style={{
              flex: 1,
              backgroundColor: 'rgba(0,0,0,0.5)',
              justifyContent: 'flex-end',
            }}
          >
            <View
              style={{
                backgroundColor: colors.bg,
                borderTopLeftRadius: 20,
                borderTopRightRadius: 20,
                maxHeight: '80%',
                paddingBottom: 24,
              }}
            >
              <View
                style={{
                  alignSelf: 'center',
                  width: 40,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: colors.divider,
                  marginVertical: 10,
                }}
              />
              <Text
                style={{
                  fontSize: 16,
                  fontWeight: '700',
                  color: colors.text,
                  paddingHorizontal: 20,
                  paddingBottom: 12,
                }}
              >
                Select vehicle
              </Text>
              {(() => {
                if (pickerForDriverId === null) return null;
                const row = recommendations.find((r) => r.driverId === pickerForDriverId);
                if (!row) return null;
                const options = optionsForDriver(row.driverId, row.vehicleId);
                return (
                  <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 12 }}>
                    {options.length === 0 ? (
                      <Text
                        style={{
                          fontSize: 14,
                          color: colors.textMuted,
                          paddingVertical: 16,
                          textAlign: 'center',
                        }}
                      >
                        No vehicles available. All vehicles are either inactive or already
                        assigned.
                      </Text>
                    ) : (
                      options.map((v) => {
                        const isCurrent = row.vehicleId === v.vehicleId;
                        const inactive = isVehicleInactive(v);
                        return (
                          <TouchableOpacity
                            key={v.vehicleId}
                            onPress={() => handlePickVehicle(row.driverId, v.vehicleId)}
                            disabled={upsertMappingMutation.isPending}
                            style={{
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: 10,
                              paddingVertical: 12,
                              paddingHorizontal: 12,
                              borderRadius: 10,
                              borderWidth: 1,
                              borderColor: isCurrent ? ACCENT : colors.cardBorder,
                              backgroundColor: isCurrent ? ACCENT : colors.cardBg,
                              marginBottom: 8,
                              opacity: inactive ? 0.5 : 1,
                            }}
                          >
                            <Ionicons
                              name={isCurrent ? 'radio-button-on' : 'radio-button-off'}
                              size={18}
                              color={isCurrent ? '#fff' : colors.textSecondary}
                            />
                            <View style={{ flex: 1 }}>
                              <Text
                                style={{
                                  fontSize: 14,
                                  fontWeight: '600',
                                  color: isCurrent ? '#fff' : colors.text,
                                }}
                              >
                                {v.vehicleNumber}
                                {inactive ? ' (inactive)' : ''}
                              </Text>
                              {v.vehicleType ? (
                                <Text
                                  style={{
                                    fontSize: 12,
                                    color: isCurrent
                                      ? 'rgba(255,255,255,0.7)'
                                      : colors.textMuted,
                                  }}
                                >
                                  {v.vehicleType}
                                  {v.capacity ? ` · ${v.capacity} cyl` : ''}
                                </Text>
                              ) : null}
                            </View>
                          </TouchableOpacity>
                        );
                      })
                    )}
                  </ScrollView>
                );
              })()}
              <TouchableOpacity
                onPress={() => setPickerForDriverId(null)}
                style={{
                  marginHorizontal: 20,
                  marginTop: 4,
                  paddingVertical: 12,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: colors.cardBorder,
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary }}>
                  Cancel
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </View>
    );
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <TabBar
        tabs={['Drivers', 'Vehicles', 'Assignments']}
        active={activeTab}
        onSelect={setActiveTab}
        dividerColor={colors.divider}
        textSecondary={colors.textSecondary}
      />
      <View style={{ flex: 1 }}>
        {activeTab === 0 && renderDrivers()}
        {activeTab === 1 && renderVehicles()}
        {activeTab === 2 && renderAssignments()}
      </View>
    </SafeAreaView>
  );
}
