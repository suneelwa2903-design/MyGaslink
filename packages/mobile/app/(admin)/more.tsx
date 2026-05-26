import React, { useState, useMemo } from 'react';
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
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { useAuthStore } from '../../src/stores/authStore';
import type { UserProfile } from '@gaslink/shared';
import { useTheme, ACCENT as ACCENT_COLORS } from '../../src/theme';

const ACCENT = ACCENT_COLORS.red;

// ─── Types ──────────────────────────────────────────────────────────────────

interface Customer {
  customerId: string;
  customerName: string;
  businessName?: string;
  phone: string;
  email?: string;
  gstin?: string;
  customerType: 'B2B' | 'B2C';
  status: 'active' | 'suspended';
  creditPeriodDays?: number;
  outstandingBalance?: number;
  totalOrders?: number;
}

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
  status: 'active' | 'inactive';
}

interface VehicleMapping {
  id: string;
  driverName: string;
  vehicleNumber: string;
  assignedAt: string;
}

interface GstSettings {
  gstMode: 'disabled' | 'sandbox' | 'live' | null;
  gstCredentials?: {
    gstin?: string;
    clientId?: string;
    clientSecret?: string;
    username?: string;
  } | null;
}

type AuthUserWithDistributor = UserProfile & { distributorName?: string };

interface UserRecord {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  status?: string;
}

interface HeaderMetrics {
  totalRevenue?: number;
  totalOrders?: number;
  activeCustomers?: number;
  activeDrivers?: number;
  pendingDeliveries?: number;
  completedToday?: number;
  collectionRate?: number;
  avgOrderValue?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type Theme = {
  bg: string;
  cardBg: string;
  cardBorder: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  divider: string;
  inputBg: string;
  inputBorder: string;
};

function useMoreTheme(): Theme {
  const { colors } = useTheme();
  return colors;
}

const fmt = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

function formatCurrency(n: number): string {
  return fmt.format(n);
}

// ─── Reusable: Modal Header ─────────────────────────────────────────────────

function ModalHeader({
  title,
  onClose,
  theme,
}: {
  title: string;
  onClose: () => void;
  theme: Theme;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingVertical: 16,
        borderBottomWidth: 1,
        borderBottomColor: theme.divider,
      }}
    >
      <Text style={{ fontSize: 18, fontWeight: '700', color: theme.text }}>{title}</Text>
      <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
        <Ionicons name="close" size={24} color={theme.textSecondary} />
      </TouchableOpacity>
    </View>
  );
}

// ─── Reusable: Form Input ───────────────────────────────────────────────────

function FormInput({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  secureTextEntry,
  theme,
  autoCapitalize,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'phone-pad' | 'email-address' | 'numeric';
  secureTextEntry?: boolean;
  theme: Theme;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={{ fontSize: 13, fontWeight: '600', color: theme.textSecondary, marginBottom: 6 }}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.textMuted}
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize ?? 'sentences'}
        style={{
          backgroundColor: theme.inputBg,
          borderWidth: 1,
          borderColor: theme.inputBorder,
          borderRadius: 10,
          paddingHorizontal: 14,
          paddingVertical: 12,
          fontSize: 15,
          color: theme.text,
        }}
      />
    </View>
  );
}

// ─── Reusable: Status / Role Badge ──────────────────────────────────────────

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

// ─── Reusable: Section Row ──────────────────────────────────────────────────

function MenuRow({
  icon,
  label,
  subtitle,
  onPress,
  theme,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  subtitle?: string;
  onPress: () => void;
  theme: Theme;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 14,
        paddingHorizontal: 16,
        gap: 14,
      }}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          backgroundColor: ACCENT + '12',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name={icon} size={18} color={ACCENT} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontWeight: '600', color: theme.text }}>{label}</Text>
        {subtitle ? (
          <Text style={{ fontSize: 12, color: theme.textMuted, marginTop: 1 }}>{subtitle}</Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
    </TouchableOpacity>
  );
}

// ─── Reusable: Section Card ─────────────────────────────────────────────────

function SectionCard({
  title,
  children,
  theme,
}: {
  title: string;
  children: React.ReactNode;
  theme: Theme;
}) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text
        style={{
          fontSize: 13,
          fontWeight: '700',
          color: theme.textMuted,
          textTransform: 'uppercase',
          letterSpacing: 0.8,
          marginBottom: 8,
          marginLeft: 4,
        }}
      >
        {title}
      </Text>
      <View
        style={{
          backgroundColor: theme.cardBg,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: theme.cardBorder,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}

function Divider({ theme }: { theme: Theme }) {
  return <View style={{ height: 1, backgroundColor: theme.divider, marginLeft: 64 }} />;
}

// ─── Reusable: FAB ──────────────────────────────────────────────────────────

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

// ─── Reusable: Tab Bar ──────────────────────────────────────────────────────

function TabBar({
  tabs,
  active,
  onSelect,
  theme,
}: {
  tabs: string[];
  active: number;
  onSelect: (i: number) => void;
  theme: Theme;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        borderBottomWidth: 1,
        borderBottomColor: theme.divider,
      }}
    >
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
              color: active === i ? ACCENT : theme.textSecondary,
            }}
          >
            {t}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ─── Reusable: Empty State ──────────────────────────────────────────────────

function EmptyList({ message, theme }: { message: string; theme: Theme }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 48 }}>
      <Ionicons name="file-tray-outline" size={48} color={theme.textMuted} />
      <Text style={{ fontSize: 14, color: theme.textMuted, marginTop: 12 }}>{message}</Text>
    </View>
  );
}

// ─── Reusable: Loading ──────────────────────────────────────────────────────

function Loading({ theme: _theme }: { theme: Theme }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator size="large" color={ACCENT} />
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOMERS MODAL
// ═══════════════════════════════════════════════════════════════════════════

function CustomersModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const theme = useMoreTheme();
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formBusiness, setFormBusiness] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formGstin, setFormGstin] = useState('');
  const [formType, setFormType] = useState<'B2B' | 'B2C'>('B2C');
  const [formCredit, setFormCredit] = useState('');

  const { data: customersResponse, isLoading, refetch } = useApiQuery<{ customers: Customer[] }>(
    ['customers'],
    '/customers?limit=200',
    undefined,
    { enabled: visible },
  );
  const customers: Customer[] = customersResponse?.customers ?? [];

  const createMutation = useApiMutation<Customer, {
    customerName: string;
    businessName?: string;
    phone: string;
    email?: string;
    gstin?: string;
    customerType: 'B2B' | 'B2C';
    creditPeriodDays?: number;
  }>(
    'post',
    '/customers',
    {
      invalidateKeys: [['customers']],
      successMessage: 'Customer created successfully',
      onSuccess: () => {
        resetForm();
        setShowCreate(false);
      },
    },
  );

  const stopSupplyMutation = useApiMutation<Customer, { id: string }>(
    'post',
    (vars) => `/customers/${vars.id}/stop-supply`,
    {
      invalidateKeys: [['customers']],
      successMessage: 'Supply stopped',
    },
  );

  const resumeSupplyMutation = useApiMutation<Customer, { id: string }>(
    'post',
    (vars) => `/customers/${vars.id}/resume-supply`,
    {
      invalidateKeys: [['customers']],
      successMessage: 'Supply resumed',
    },
  );

  const resetForm = () => {
    setFormName('');
    setFormBusiness('');
    setFormPhone('');
    setFormEmail('');
    setFormGstin('');
    setFormType('B2C');
    setFormCredit('');
  };

  const handleCreate = () => {
    if (!formName.trim() || !formPhone.trim()) {
      Alert.alert('Validation', 'Name and phone are required.');
      return;
    }
    createMutation.mutate({
      customerName: formName.trim(),
      businessName: formBusiness.trim() || undefined,
      phone: formPhone.trim(),
      email: formEmail.trim() || undefined,
      gstin: formGstin.trim() || undefined,
      customerType: formType,
      creditPeriodDays: formCredit ? parseInt(formCredit, 10) : undefined,
    });
  };

  const handleToggleStatus = (customer: Customer) => {
    const isSuspending = customer.status === 'active';
    const label = isSuspending ? 'Stop Supply' : 'Resume Supply';
    Alert.alert(label, `Are you sure you want to ${label.toLowerCase()} for ${customer.customerName}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: label,
        style: isSuspending ? 'destructive' : 'default',
        onPress: () => {
          if (isSuspending) {
            stopSupplyMutation.mutate({ id: customer.customerId });
          } else {
            resumeSupplyMutation.mutate({ id: customer.customerId });
          }
        },
      },
    ]);
  };

  const filtered = useMemo(() => {
    if (!customers) return [];
    if (!search.trim()) return customers;
    const q = search.toLowerCase();
    return customers.filter(
      (c) =>
        c.customerName?.toLowerCase().includes(q) ||
        c.phone?.includes(q) ||
        c.businessName?.toLowerCase().includes(q),
    );
  }, [customers, search]);

  const renderCustomer = ({ item }: { item: Customer }) => {
    const expanded = expandedId === item.customerId;
    return (
      <View>
        <TouchableOpacity
          onPress={() => setExpandedId(expanded ? null : item.customerId)}
          activeOpacity={0.7}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingVertical: 14,
            gap: 12,
            backgroundColor: theme.cardBg,
          }}
        >
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: ACCENT + '14',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 16, fontWeight: '700', color: ACCENT }}>
              {item.customerName?.[0]?.toUpperCase() || '?'}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: theme.text }}>{item.customerName}</Text>
            <Text style={{ fontSize: 12, color: theme.textMuted, marginTop: 1 }}>{item.phone}</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
            <StatusBadge label={item.customerType} color="#3b82f6" />
            <StatusBadge
              label={item.status}
              color={item.status === 'active' ? '#10b981' : '#ef4444'}
            />
          </View>
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={theme.textMuted}
          />
        </TouchableOpacity>

        {expanded && (
          <View
            style={{
              backgroundColor: theme.bg,
              paddingHorizontal: 20,
              paddingVertical: 14,
              borderTopWidth: 1,
              borderTopColor: theme.divider,
              gap: 8,
            }}
          >
            {item.businessName ? (
              <DetailRow label="Business" value={item.businessName} theme={theme} />
            ) : null}
            {item.email ? <DetailRow label="Email" value={item.email} theme={theme} /> : null}
            {item.gstin ? <DetailRow label="GSTIN" value={item.gstin} theme={theme} /> : null}
            {item.creditPeriodDays != null ? (
              <DetailRow label="Credit Period" value={`${item.creditPeriodDays} days`} theme={theme} />
            ) : null}
            {item.totalOrders != null ? (
              <DetailRow label="Total Orders" value={`${item.totalOrders}`} theme={theme} />
            ) : null}
            {item.outstandingBalance != null ? (
              <DetailRow
                label="Outstanding"
                value={formatCurrency(item.outstandingBalance)}
                theme={theme}
              />
            ) : null}

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
              <TouchableOpacity
                onPress={() => handleToggleStatus(item)}
                style={{
                  flex: 1,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor:
                    item.status === 'active' ? '#ef4444' + '14' : '#10b981' + '14',
                  alignItems: 'center',
                }}
              >
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: '700',
                    color: item.status === 'active' ? '#ef4444' : '#10b981',
                  }}
                >
                  {item.status === 'active' ? 'Stop Supply' : 'Resume Supply'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
        <ModalHeader title="Customers" onClose={onClose} theme={theme} />

        {showCreate ? (
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={{ flex: 1 }}
          >
            <ScrollView contentContainerStyle={{ padding: 20 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: theme.text, marginBottom: 16 }}>
                New Customer
              </Text>
              <FormInput label="Name *" value={formName} onChangeText={setFormName} placeholder="Full name" theme={theme} />
              <FormInput label="Business Name" value={formBusiness} onChangeText={setFormBusiness} placeholder="Business name (optional)" theme={theme} />
              <FormInput label="Phone *" value={formPhone} onChangeText={setFormPhone} placeholder="10-digit mobile" keyboardType="phone-pad" theme={theme} />
              <FormInput label="Email" value={formEmail} onChangeText={setFormEmail} placeholder="Email (optional)" keyboardType="email-address" autoCapitalize="none" theme={theme} />
              <FormInput label="GSTIN" value={formGstin} onChangeText={setFormGstin} placeholder="GSTIN (optional)" autoCapitalize="characters" theme={theme} />

              <Text style={{ fontSize: 13, fontWeight: '600', color: theme.textSecondary, marginBottom: 8 }}>
                Customer Type
              </Text>
              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
                {(['B2C', 'B2B'] as const).map((t) => (
                  <TouchableOpacity
                    key={t}
                    onPress={() => setFormType(t)}
                    style={{
                      flex: 1,
                      paddingVertical: 10,
                      borderRadius: 8,
                      borderWidth: 2,
                      borderColor: formType === t ? ACCENT : theme.inputBorder,
                      backgroundColor: formType === t ? ACCENT + '10' : theme.inputBg,
                      alignItems: 'center',
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 14,
                        fontWeight: '700',
                        color: formType === t ? ACCENT : theme.textSecondary,
                      }}
                    >
                      {t}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <FormInput label="Credit Period (days)" value={formCredit} onChangeText={setFormCredit} placeholder="e.g. 30" keyboardType="numeric" theme={theme} />

              <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
                <TouchableOpacity
                  onPress={() => { resetForm(); setShowCreate(false); }}
                  style={{
                    flex: 1,
                    paddingVertical: 14,
                    borderRadius: 10,
                    backgroundColor: theme.cardBg,
                    borderWidth: 1,
                    borderColor: theme.cardBorder,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ fontSize: 15, fontWeight: '600', color: theme.textSecondary }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleCreate}
                  disabled={createMutation.isPending}
                  style={{
                    flex: 1,
                    paddingVertical: 14,
                    borderRadius: 10,
                    backgroundColor: ACCENT,
                    alignItems: 'center',
                    opacity: createMutation.isPending ? 0.6 : 1,
                  }}
                >
                  {createMutation.isPending ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>Create Customer</Text>
                  )}
                </TouchableOpacity>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        ) : (
          <View style={{ flex: 1 }}>
            {/* Search Bar */}
            <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: theme.inputBg,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: theme.inputBorder,
                  paddingHorizontal: 12,
                  gap: 8,
                }}
              >
                <Ionicons name="search" size={18} color={theme.textMuted} />
                <TextInput
                  value={search}
                  onChangeText={setSearch}
                  placeholder="Search by name, phone, business..."
                  placeholderTextColor={theme.textMuted}
                  style={{ flex: 1, paddingVertical: 10, fontSize: 14, color: theme.text }}
                />
                {search.length > 0 && (
                  <TouchableOpacity onPress={() => setSearch('')}>
                    <Ionicons name="close-circle" size={18} color={theme.textMuted} />
                  </TouchableOpacity>
                )}
              </View>
            </View>

            {isLoading ? (
              <Loading theme={theme} />
            ) : (
              <FlatList
                data={filtered}
                keyExtractor={(item) => item.customerId}
                renderItem={renderCustomer}
                ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: theme.divider }} />}
                ListEmptyComponent={<EmptyList message="No customers found" theme={theme} />}
                refreshControl={<RefreshControl refreshing={false} onRefresh={refetch} tintColor={ACCENT} />}
              />
            )}

            <FAB onPress={() => setShowCreate(true)} />
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

// ─── Detail Row helper ──────────────────────────────────────────────────────

function DetailRow({
  label,
  value,
  theme,
}: {
  label: string;
  value: string;
  theme: Theme;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={{ fontSize: 13, color: theme.textMuted }}>{label}</Text>
      <Text style={{ fontSize: 13, fontWeight: '600', color: theme.text }}>{value}</Text>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// FLEET MODAL
// ═══════════════════════════════════════════════════════════════════════════

function FleetModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useMoreTheme();
  const [activeTab, setActiveTab] = useState(0);
  const [showDriverForm, setShowDriverForm] = useState(false);
  const [showVehicleForm, setShowVehicleForm] = useState(false);

  // Driver form
  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [driverLicense, setDriverLicense] = useState('');

  // Vehicle form
  const [vehNumber, setVehNumber] = useState('');
  const [vehType, setVehType] = useState('');
  const [vehCapacity, setVehCapacity] = useState('');

  const { data: driversResponse, isLoading: driversLoading, refetch: refetchDrivers } = useApiQuery<{ drivers: Driver[] }>(
    ['drivers'],
    '/drivers',
    undefined,
    { enabled: visible },
  );
  const drivers: Driver[] = driversResponse?.drivers ?? [];

  const { data: vehiclesResponse, isLoading: vehiclesLoading, refetch: refetchVehicles } = useApiQuery<{ vehicles: Vehicle[] }>(
    ['vehicles'],
    '/vehicles',
    undefined,
    { enabled: visible },
  );
  const vehicles: Vehicle[] = vehiclesResponse?.vehicles ?? [];

  const { data: assignments, isLoading: assignmentsLoading, refetch: refetchAssignments } = useApiQuery<VehicleMapping[]>(
    ['assignments'],
    '/assignments/vehicle-mappings',
    undefined,
    { enabled: visible },
  );

  const createDriverMutation = useApiMutation<Driver, { driverName: string; phone: string; licenseNumber?: string }>('post', '/drivers', {
    invalidateKeys: [['drivers']],
    successMessage: 'Driver added',
    onSuccess: () => {
      setDriverName('');
      setDriverPhone('');
      setDriverLicense('');
      setShowDriverForm(false);
    },
  });

  const createVehicleMutation = useApiMutation<Vehicle, { vehicleNumber: string; vehicleType: string; capacity?: number }>('post', '/vehicles', {
    invalidateKeys: [['vehicles']],
    successMessage: 'Vehicle added',
    onSuccess: () => {
      setVehNumber('');
      setVehType('');
      setVehCapacity('');
      setShowVehicleForm(false);
    },
  });

  const handleAddDriver = () => {
    if (!driverName.trim() || !driverPhone.trim()) {
      Alert.alert('Validation', 'Name and phone are required.');
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
    createVehicleMutation.mutate({
      vehicleNumber: vehNumber.trim(),
      vehicleType: vehType.trim(),
      capacity: vehCapacity ? parseInt(vehCapacity, 10) : undefined,
    });
  };

  const renderDrivers = () => {
    if (showDriverForm) {
      return (
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: theme.text, marginBottom: 16 }}>
            Add Driver
          </Text>
          <FormInput label="Name *" value={driverName} onChangeText={setDriverName} placeholder="Driver name" theme={theme} />
          <FormInput label="Phone *" value={driverPhone} onChangeText={setDriverPhone} placeholder="Phone number" keyboardType="phone-pad" theme={theme} />
          <FormInput label="License Number" value={driverLicense} onChangeText={setDriverLicense} placeholder="DL number (optional)" autoCapitalize="characters" theme={theme} />

          <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
            <TouchableOpacity
              onPress={() => setShowDriverForm(false)}
              style={{
                flex: 1, paddingVertical: 14, borderRadius: 10,
                backgroundColor: theme.cardBg, borderWidth: 1, borderColor: theme.cardBorder,
                alignItems: 'center',
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: '600', color: theme.textSecondary }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleAddDriver}
              disabled={createDriverMutation.isPending}
              style={{
                flex: 1, paddingVertical: 14, borderRadius: 10,
                backgroundColor: ACCENT, alignItems: 'center',
                opacity: createDriverMutation.isPending ? 0.6 : 1,
              }}
            >
              {createDriverMutation.isPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>Add Driver</Text>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      );
    }

    if (driversLoading) return <Loading theme={theme} />;

    return (
      <View style={{ flex: 1 }}>
        <FlatList
          data={drivers || []}
          keyExtractor={(item) => item.driverId}
          renderItem={({ item }) => (
            <View
              style={{
                flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
                paddingVertical: 14, gap: 12,
              }}
            >
              <View
                style={{
                  width: 40, height: 40, borderRadius: 20,
                  backgroundColor: '#3b82f6' + '14', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Ionicons name="person" size={18} color="#3b82f6" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: '600', color: theme.text }}>{item.driverName}</Text>
                <Text style={{ fontSize: 12, color: theme.textMuted }}>{item.phone}</Text>
              </View>
              <StatusBadge label={item.status} color={item.status === 'active' ? '#10b981' : '#94a3b8'} />
            </View>
          )}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: theme.divider }} />}
          ListEmptyComponent={<EmptyList message="No drivers added" theme={theme} />}
          refreshControl={<RefreshControl refreshing={false} onRefresh={refetchDrivers} tintColor={ACCENT} />}
        />
        <FAB onPress={() => setShowDriverForm(true)} />
      </View>
    );
  };

  const renderVehicles = () => {
    if (showVehicleForm) {
      return (
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: theme.text, marginBottom: 16 }}>
            Add Vehicle
          </Text>
          <FormInput label="Vehicle Number *" value={vehNumber} onChangeText={setVehNumber} placeholder="e.g. KA-01-AB-1234" autoCapitalize="characters" theme={theme} />
          <FormInput label="Vehicle Type *" value={vehType} onChangeText={setVehType} placeholder="e.g. Mini Truck, Auto" theme={theme} />
          <FormInput label="Capacity (cylinders)" value={vehCapacity} onChangeText={setVehCapacity} placeholder="e.g. 20" keyboardType="numeric" theme={theme} />

          <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
            <TouchableOpacity
              onPress={() => setShowVehicleForm(false)}
              style={{
                flex: 1, paddingVertical: 14, borderRadius: 10,
                backgroundColor: theme.cardBg, borderWidth: 1, borderColor: theme.cardBorder,
                alignItems: 'center',
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: '600', color: theme.textSecondary }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleAddVehicle}
              disabled={createVehicleMutation.isPending}
              style={{
                flex: 1, paddingVertical: 14, borderRadius: 10,
                backgroundColor: ACCENT, alignItems: 'center',
                opacity: createVehicleMutation.isPending ? 0.6 : 1,
              }}
            >
              {createVehicleMutation.isPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>Add Vehicle</Text>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      );
    }

    if (vehiclesLoading) return <Loading theme={theme} />;

    return (
      <View style={{ flex: 1 }}>
        <FlatList
          data={vehicles || []}
          keyExtractor={(item) => item.vehicleId}
          renderItem={({ item }) => (
            <View
              style={{
                flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
                paddingVertical: 14, gap: 12,
              }}
            >
              <View
                style={{
                  width: 40, height: 40, borderRadius: 20,
                  backgroundColor: '#f59e0b' + '14', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Ionicons name="car" size={18} color="#f59e0b" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: '600', color: theme.text }}>{item.vehicleNumber}</Text>
                <Text style={{ fontSize: 12, color: theme.textMuted }}>
                  {item.vehicleType}{item.capacity ? ` - ${item.capacity} cyl` : ''}
                </Text>
              </View>
              <StatusBadge label={item.status} color={item.status === 'active' ? '#10b981' : '#94a3b8'} />
            </View>
          )}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: theme.divider }} />}
          ListEmptyComponent={<EmptyList message="No vehicles added" theme={theme} />}
          refreshControl={<RefreshControl refreshing={false} onRefresh={refetchVehicles} tintColor={ACCENT} />}
        />
        <FAB onPress={() => setShowVehicleForm(true)} />
      </View>
    );
  };

  const renderAssignments = () => {
    if (assignmentsLoading) return <Loading theme={theme} />;

    return (
      <FlatList
        data={assignments || []}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View
            style={{
              flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
              paddingVertical: 14, gap: 12,
            }}
          >
            <View
              style={{
                width: 40, height: 40, borderRadius: 20,
                backgroundColor: '#8b5cf6' + '14', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <Ionicons name="link" size={18} color="#8b5cf6" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: theme.text }}>{item.driverName}</Text>
              <Text style={{ fontSize: 12, color: theme.textMuted }}>{item.vehicleNumber}</Text>
            </View>
            <Text style={{ fontSize: 11, color: theme.textMuted }}>
              {item.assignedAt ? new Date(item.assignedAt).toLocaleDateString('en-IN') : ''}
            </Text>
          </View>
        )}
        ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: theme.divider }} />}
        ListEmptyComponent={<EmptyList message="No active assignments" theme={theme} />}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refetchAssignments} tintColor={ACCENT} />}
      />
    );
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
        <ModalHeader title="Fleet Management" onClose={onClose} theme={theme} />
        <TabBar tabs={['Drivers', 'Vehicles', 'Assignments']} active={activeTab} onSelect={setActiveTab} theme={theme} />
        <View style={{ flex: 1 }}>
          {activeTab === 0 && renderDrivers()}
          {activeTab === 1 && renderVehicles()}
          {activeTab === 2 && renderAssignments()}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// COLLECTIONS MODAL
// ═══════════════════════════════════════════════════════════════════════════

interface CollectionRecent {
  id?: string;
  customerName?: string;
  date?: string;
  amount?: number;
}

interface CollectionsData {
  totalCollected?: number;
  totalPending?: number;
  collectionRate?: number;
  overdue?: number;
  recent?: CollectionRecent[];
}

function CollectionsModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useMoreTheme();

  const { data: collections, isLoading, refetch } = useApiQuery<CollectionsData>(
    ['collections'],
    '/analytics/collections',
    undefined,
    { enabled: visible },
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
        <ModalHeader title="Collections" onClose={onClose} theme={theme} />
        {isLoading ? (
          <Loading theme={theme} />
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: 20, gap: 16 }}
            refreshControl={<RefreshControl refreshing={false} onRefresh={refetch} tintColor={ACCENT} />}
          >
            {/* Summary Cards */}
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <MetricBox
                label="Total Collected"
                value={formatCurrency(collections?.totalCollected || 0)}
                color="#10b981"
                theme={theme}
              />
              <MetricBox
                label="Pending"
                value={formatCurrency(collections?.totalPending || 0)}
                color="#f59e0b"
                theme={theme}
              />
            </View>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <MetricBox
                label="Collection Rate"
                value={`${collections?.collectionRate?.toFixed(1) || 0}%`}
                color="#3b82f6"
                theme={theme}
              />
              <MetricBox
                label="Overdue"
                value={formatCurrency(collections?.overdue || 0)}
                color="#ef4444"
                theme={theme}
              />
            </View>

            {/* Recent collections list */}
            {collections?.recent && collections.recent.length > 0 && (
              <View>
                <Text style={{ fontSize: 15, fontWeight: '700', color: theme.text, marginBottom: 10 }}>
                  Recent Collections
                </Text>
                <View
                  style={{
                    backgroundColor: theme.cardBg, borderRadius: 12,
                    borderWidth: 1, borderColor: theme.cardBorder, overflow: 'hidden',
                  }}
                >
                  {collections.recent.map((c: CollectionRecent, i: number) => (
                    <View key={c.id || i}>
                      {i > 0 && <View style={{ height: 1, backgroundColor: theme.divider }} />}
                      <View style={{ flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 12, alignItems: 'center' }}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 14, fontWeight: '600', color: theme.text }}>{c.customerName || 'Customer'}</Text>
                          <Text style={{ fontSize: 11, color: theme.textMuted }}>
                            {c.date ? new Date(c.date).toLocaleDateString('en-IN') : ''}
                          </Text>
                        </View>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: '#10b981' }}>
                          {formatCurrency(c.amount || 0)}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {!collections?.recent?.length && !isLoading && (
              <EmptyList message="No collection data available" theme={theme} />
            )}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

// ─── Metric Box helper ──────────────────────────────────────────────────────

function MetricBox({
  label,
  value,
  color,
  theme,
}: {
  label: string;
  value: string;
  color: string;
  theme: Theme;
}) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.cardBg,
        borderRadius: 12,
        padding: 16,
        borderWidth: 1,
        borderColor: theme.cardBorder,
      }}
    >
      <Text style={{ fontSize: 12, color: theme.textMuted, marginBottom: 6 }}>{label}</Text>
      <Text style={{ fontSize: 20, fontWeight: '800', color }}>{value}</Text>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ANALYTICS OVERVIEW MODAL
// ═══════════════════════════════════════════════════════════════════════════

function AnalyticsOverviewModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useMoreTheme();

  const { data: metrics, isLoading, refetch } = useApiQuery<HeaderMetrics>(
    ['header-metrics'],
    '/analytics/header-metrics',
    undefined,
    { enabled: visible },
  );

  const metricItems = [
    { label: 'Total Revenue', value: formatCurrency(metrics?.totalRevenue || 0), icon: 'cash-outline' as const, color: '#10b981' },
    { label: 'Total Orders', value: `${metrics?.totalOrders || 0}`, icon: 'receipt-outline' as const, color: '#3b82f6' },
    { label: 'Active Customers', value: `${metrics?.activeCustomers || 0}`, icon: 'people-outline' as const, color: '#8b5cf6' },
    { label: 'Active Drivers', value: `${metrics?.activeDrivers || 0}`, icon: 'car-outline' as const, color: '#f59e0b' },
    { label: 'Pending Deliveries', value: `${metrics?.pendingDeliveries || 0}`, icon: 'time-outline' as const, color: '#ef4444' },
    { label: 'Completed Today', value: `${metrics?.completedToday || 0}`, icon: 'checkmark-circle-outline' as const, color: '#10b981' },
    { label: 'Collection Rate', value: `${(metrics?.collectionRate || 0).toFixed(1)}%`, icon: 'trending-up-outline' as const, color: '#3b82f6' },
    { label: 'Avg Order Value', value: formatCurrency(metrics?.avgOrderValue || 0), icon: 'stats-chart-outline' as const, color: '#8b5cf6' },
  ];

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
        <ModalHeader title="Overview" onClose={onClose} theme={theme} />
        {isLoading ? (
          <Loading theme={theme} />
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: 16, gap: 12 }}
            refreshControl={<RefreshControl refreshing={false} onRefresh={refetch} tintColor={ACCENT} />}
          >
            {/* 2-column grid */}
            {Array.from({ length: Math.ceil(metricItems.length / 2) }).map((_, rowIdx) => (
              <View key={rowIdx} style={{ flexDirection: 'row', gap: 12 }}>
                {metricItems.slice(rowIdx * 2, rowIdx * 2 + 2).map((m) => (
                  <View
                    key={m.label}
                    style={{
                      flex: 1,
                      backgroundColor: theme.cardBg,
                      borderRadius: 14,
                      padding: 16,
                      borderWidth: 1,
                      borderColor: theme.cardBorder,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <View
                        style={{
                          width: 32, height: 32, borderRadius: 8,
                          backgroundColor: m.color + '14', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <Ionicons name={m.icon} size={16} color={m.color} />
                      </View>
                    </View>
                    <Text style={{ fontSize: 22, fontWeight: '800', color: theme.text }}>{m.value}</Text>
                    <Text style={{ fontSize: 12, color: theme.textMuted, marginTop: 4 }}>{m.label}</Text>
                  </View>
                ))}
              </View>
            ))}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORTS MODAL
// ═══════════════════════════════════════════════════════════════════════════

function ReportsModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useMoreTheme();
  const [activeTab, setActiveTab] = useState(0);

  const { data: metrics, isLoading } = useApiQuery<HeaderMetrics>(
    ['analytics-reports'],
    '/analytics/header-metrics',
    undefined,
    { enabled: visible },
  );

  const { data: customersResponse } = useApiQuery<{ customers: Customer[] }>(
    ['customers-reports'],
    '/customers?limit=200',
    undefined,
    { enabled: visible },
  );
  const customers: Customer[] = customersResponse?.customers ?? [];

  const { data: driversResponse } = useApiQuery<{ drivers: Driver[] }>(
    ['drivers-reports'],
    '/drivers',
    undefined,
    { enabled: visible },
  );
  const drivers: Driver[] = driversResponse?.drivers ?? [];

  const topCustomers = useMemo(() => {
    if (!customers) return [];
    return [...customers]
      .filter((c) => c.totalOrders != null)
      .sort((a, b) => (b.totalOrders || 0) - (a.totalOrders || 0))
      .slice(0, 10);
  }, [customers]);

  const renderRevenueTrends = () => (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
      <Text style={{ fontSize: 16, fontWeight: '700', color: theme.text }}>Revenue Summary</Text>
      <View
        style={{
          backgroundColor: theme.cardBg, borderRadius: 14, padding: 20,
          borderWidth: 1, borderColor: theme.cardBorder, gap: 14,
        }}
      >
        <DetailRow label="Total Revenue" value={formatCurrency(metrics?.totalRevenue || 0)} theme={theme} />
        <DetailRow label="Total Orders" value={`${metrics?.totalOrders || 0}`} theme={theme} />
        <DetailRow label="Avg Order Value" value={formatCurrency(metrics?.avgOrderValue || 0)} theme={theme} />
        <DetailRow label="Collection Rate" value={`${(metrics?.collectionRate || 0).toFixed(1)}%`} theme={theme} />
      </View>
    </ScrollView>
  );

  const renderTopCustomers = () => (
    <ScrollView contentContainerStyle={{ padding: 20 }}>
      <Text style={{ fontSize: 16, fontWeight: '700', color: theme.text, marginBottom: 12 }}>
        Top Customers by Orders
      </Text>
      <View
        style={{
          backgroundColor: theme.cardBg, borderRadius: 14,
          borderWidth: 1, borderColor: theme.cardBorder, overflow: 'hidden',
        }}
      >
        {/* Table Header */}
        <View
          style={{
            flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 10,
            borderBottomWidth: 1, borderBottomColor: theme.divider,
          }}
        >
          <Text style={{ flex: 1, fontSize: 11, fontWeight: '700', color: theme.textMuted, textTransform: 'uppercase' }}>Customer</Text>
          <Text style={{ width: 60, fontSize: 11, fontWeight: '700', color: theme.textMuted, textTransform: 'uppercase', textAlign: 'right' }}>Orders</Text>
          <Text style={{ width: 90, fontSize: 11, fontWeight: '700', color: theme.textMuted, textTransform: 'uppercase', textAlign: 'right' }}>Outstanding</Text>
        </View>
        {topCustomers.length === 0 && (
          <View style={{ padding: 20, alignItems: 'center' }}>
            <Text style={{ fontSize: 13, color: theme.textMuted }}>No data available</Text>
          </View>
        )}
        {topCustomers.map((c, i) => (
          <View key={c.customerId}>
            {i > 0 && <View style={{ height: 1, backgroundColor: theme.divider }} />}
            <View style={{ flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 12, alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: theme.text }} numberOfLines={1}>{c.customerName}</Text>
                <Text style={{ fontSize: 11, color: theme.textMuted }}>{c.customerType}</Text>
              </View>
              <Text style={{ width: 60, fontSize: 14, fontWeight: '700', color: theme.text, textAlign: 'right' }}>
                {c.totalOrders || 0}
              </Text>
              <Text style={{ width: 90, fontSize: 13, fontWeight: '600', color: (c.outstandingBalance || 0) > 0 ? '#ef4444' : theme.textMuted, textAlign: 'right' }}>
                {formatCurrency(c.outstandingBalance || 0)}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  );

  const renderDriverPerformance = () => (
    <ScrollView contentContainerStyle={{ padding: 20 }}>
      <Text style={{ fontSize: 16, fontWeight: '700', color: theme.text, marginBottom: 12 }}>
        Driver Performance
      </Text>
      <View
        style={{
          backgroundColor: theme.cardBg, borderRadius: 14,
          borderWidth: 1, borderColor: theme.cardBorder, overflow: 'hidden',
        }}
      >
        <View
          style={{
            flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 10,
            borderBottomWidth: 1, borderBottomColor: theme.divider,
          }}
        >
          <Text style={{ flex: 1, fontSize: 11, fontWeight: '700', color: theme.textMuted, textTransform: 'uppercase' }}>Driver</Text>
          <Text style={{ width: 70, fontSize: 11, fontWeight: '700', color: theme.textMuted, textTransform: 'uppercase', textAlign: 'right' }}>Status</Text>
        </View>
        {(!drivers || drivers.length === 0) && (
          <View style={{ padding: 20, alignItems: 'center' }}>
            <Text style={{ fontSize: 13, color: theme.textMuted }}>No driver data available</Text>
          </View>
        )}
        {drivers?.map((d, i) => (
          <View key={d.driverId}>
            {i > 0 && <View style={{ height: 1, backgroundColor: theme.divider }} />}
            <View style={{ flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 12, alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: theme.text }}>{d.driverName}</Text>
                <Text style={{ fontSize: 11, color: theme.textMuted }}>{d.phone}</Text>
              </View>
              <StatusBadge label={d.status} color={d.status === 'active' ? '#10b981' : '#94a3b8'} />
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
        <ModalHeader title="Reports" onClose={onClose} theme={theme} />
        <TabBar tabs={['Revenue', 'Top Customers', 'Drivers']} active={activeTab} onSelect={setActiveTab} theme={theme} />
        {isLoading ? (
          <Loading theme={theme} />
        ) : (
          <View style={{ flex: 1 }}>
            {activeTab === 0 && renderRevenueTrends()}
            {activeTab === 1 && renderTopCustomers()}
            {activeTab === 2 && renderDriverPerformance()}
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// GST CONFIGURATION MODAL
// ═══════════════════════════════════════════════════════════════════════════

function GstConfigModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useMoreTheme();

  const { data: gstSettings, isLoading } = useApiQuery<GstSettings>(
    ['gst-settings'],
    '/settings',
    undefined,
    { enabled: visible },
  );

  const [gstin, setGstin] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [username, setUsername] = useState('');
  const [initialized, setInitialized] = useState(false);

  // Sync form fields with fetched GST settings once per modal open, and reset
  // the guard when the modal closes. Done during render (React's "adjust state
  // when a value changes" pattern) instead of in an effect, which would trigger
  // an extra render pass / cascading update.
  if (visible && gstSettings && !initialized) {
    setInitialized(true);
    setGstin(gstSettings.gstCredentials?.gstin || '');
    setClientId(gstSettings.gstCredentials?.clientId || '');
    setClientSecret(gstSettings.gstCredentials?.clientSecret || '');
    setUsername(gstSettings.gstCredentials?.username || '');
  }
  if (!visible && initialized) {
    setInitialized(false);
  }

  const modeMutation = useApiMutation<GstSettings, { mode: string }>('put', '/settings/gst/mode', {
    invalidateKeys: [['gst-settings']],
    successMessage: 'GST mode updated',
  });

  const credentialsMutation = useApiMutation<GstSettings, {
    gstin: string;
    clientId?: string;
    clientSecret?: string;
    username?: string;
  }>('put', '/settings/gst/credentials', {
    invalidateKeys: [['gst-settings']],
    successMessage: 'GST credentials saved',
  });

  const handleModeChange = (mode: 'disabled' | 'sandbox' | 'live') => {
    if (mode === 'live') {
      Alert.alert('Switch to Live', 'Are you sure you want to enable live GST filing?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Enable Live', style: 'destructive', onPress: () => modeMutation.mutate({ mode }) },
      ]);
    } else {
      modeMutation.mutate({ mode });
    }
  };

  const handleSaveCredentials = () => {
    if (!gstin.trim()) {
      Alert.alert('Validation', 'GSTIN is required.');
      return;
    }
    credentialsMutation.mutate({
      gstin: gstin.trim(),
      clientId: clientId.trim() || undefined,
      clientSecret: clientSecret.trim() || undefined,
      username: username.trim() || undefined,
    });
  };

  const currentMode = gstSettings?.gstMode || 'disabled';

  const modeColors: Record<string, string> = {
    disabled: '#94a3b8',
    sandbox: '#f59e0b',
    live: '#10b981',
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
        <ModalHeader title="GST Configuration" onClose={onClose} theme={theme} />
        {isLoading ? (
          <Loading theme={theme} />
        ) : (
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={{ flex: 1 }}
          >
            <ScrollView contentContainerStyle={{ padding: 20, gap: 20 }}>
              {/* Current Mode */}
              <View style={{ alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 13, color: theme.textMuted }}>Current Mode</Text>
                <StatusBadge label={currentMode} color={modeColors[currentMode]} />
              </View>

              {/* Mode Buttons */}
              <View>
                <Text style={{ fontSize: 13, fontWeight: '600', color: theme.textSecondary, marginBottom: 10 }}>
                  GST Mode
                </Text>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  {(['disabled', 'sandbox', 'live'] as const).map((mode) => {
                    const isActive = currentMode === mode;
                    return (
                      <TouchableOpacity
                        key={mode}
                        onPress={() => handleModeChange(mode)}
                        disabled={modeMutation.isPending}
                        style={{
                          flex: 1,
                          paddingVertical: 12,
                          borderRadius: 10,
                          borderWidth: 2,
                          borderColor: isActive ? modeColors[mode] : theme.inputBorder,
                          backgroundColor: isActive ? modeColors[mode] + '14' : theme.inputBg,
                          alignItems: 'center',
                        }}
                      >
                        <Text
                          style={{
                            fontSize: 13,
                            fontWeight: '700',
                            color: isActive ? modeColors[mode] : theme.textSecondary,
                            textTransform: 'capitalize',
                          }}
                        >
                          {mode}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* Credentials */}
              <View>
                <Text style={{ fontSize: 15, fontWeight: '700', color: theme.text, marginBottom: 14 }}>
                  GSP Credentials
                </Text>
                <FormInput label="GSTIN *" value={gstin} onChangeText={setGstin} placeholder="22AAAAA0000A1Z5" autoCapitalize="characters" theme={theme} />
                <FormInput label="Client ID" value={clientId} onChangeText={setClientId} placeholder="Client ID" autoCapitalize="none" theme={theme} />
                <FormInput label="Client Secret" value={clientSecret} onChangeText={setClientSecret} placeholder="Client Secret" secureTextEntry autoCapitalize="none" theme={theme} />
                <FormInput label="Username" value={username} onChangeText={setUsername} placeholder="GSP username" autoCapitalize="none" theme={theme} />

                <TouchableOpacity
                  onPress={handleSaveCredentials}
                  disabled={credentialsMutation.isPending}
                  style={{
                    paddingVertical: 14,
                    borderRadius: 10,
                    backgroundColor: ACCENT,
                    alignItems: 'center',
                    marginTop: 4,
                    opacity: credentialsMutation.isPending ? 0.6 : 1,
                  }}
                >
                  {credentialsMutation.isPending ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>Save Credentials</Text>
                  )}
                </TouchableOpacity>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CYLINDER PRICES MODAL
// ═══════════════════════════════════════════════════════════════════════════

interface CylinderPriceRow {
  id?: string;
  cylinderType?: string;
  name?: string;
  weight?: number;
  price?: number;
  sellingPrice?: number;
}

function CylinderPricesModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useMoreTheme();

  const { data: prices, isLoading, refetch } = useApiQuery<CylinderPriceRow[]>(
    ['cylinder-prices'],
    '/cylinder-types/prices/list',
    undefined,
    { enabled: visible },
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
        <ModalHeader title="Cylinder Prices" onClose={onClose} theme={theme} />
        {isLoading ? (
          <Loading theme={theme} />
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: 20 }}
            refreshControl={<RefreshControl refreshing={false} onRefresh={refetch} tintColor={ACCENT} />}
          >
            <View
              style={{
                backgroundColor: theme.cardBg, borderRadius: 14,
                borderWidth: 1, borderColor: theme.cardBorder, overflow: 'hidden',
              }}
            >
              {/* Table Header */}
              <View
                style={{
                  flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 10,
                  borderBottomWidth: 1, borderBottomColor: theme.divider,
                }}
              >
                <Text style={{ flex: 1, fontSize: 11, fontWeight: '700', color: theme.textMuted, textTransform: 'uppercase' }}>
                  Cylinder Type
                </Text>
                <Text style={{ width: 80, fontSize: 11, fontWeight: '700', color: theme.textMuted, textTransform: 'uppercase', textAlign: 'right' }}>
                  Price
                </Text>
              </View>
              {(!prices || prices.length === 0) && (
                <View style={{ padding: 20, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, color: theme.textMuted }}>No prices configured</Text>
                </View>
              )}
              {prices?.map((p: CylinderPriceRow, i: number) => (
                <View key={p.id || i}>
                  {i > 0 && <View style={{ height: 1, backgroundColor: theme.divider }} />}
                  <View style={{ flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 14, alignItems: 'center' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '600', color: theme.text }}>
                        {p.cylinderType || p.name || `Type ${i + 1}`}
                      </Text>
                      {p.weight && (
                        <Text style={{ fontSize: 11, color: theme.textMuted }}>{p.weight} kg</Text>
                      )}
                    </View>
                    <Text style={{ width: 80, fontSize: 15, fontWeight: '700', color: theme.text, textAlign: 'right' }}>
                      {formatCurrency(p.price || p.sellingPrice || 0)}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// INVENTORY THRESHOLDS MODAL
// ═══════════════════════════════════════════════════════════════════════════

interface ThresholdRow {
  id?: string;
  cylinderType?: string;
  name?: string;
  warningThreshold?: number;
  warning?: number;
  criticalThreshold?: number;
  critical?: number;
}

function InventoryThresholdsModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useMoreTheme();

  const { data: thresholds, isLoading, refetch } = useApiQuery<ThresholdRow[]>(
    ['inventory-thresholds'],
    '/settings/cylinder-thresholds/list',
    undefined,
    { enabled: visible },
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
        <ModalHeader title="Inventory Thresholds" onClose={onClose} theme={theme} />
        {isLoading ? (
          <Loading theme={theme} />
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: 20 }}
            refreshControl={<RefreshControl refreshing={false} onRefresh={refetch} tintColor={ACCENT} />}
          >
            <View
              style={{
                backgroundColor: theme.cardBg, borderRadius: 14,
                borderWidth: 1, borderColor: theme.cardBorder, overflow: 'hidden',
              }}
            >
              {/* Header */}
              <View
                style={{
                  flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 10,
                  borderBottomWidth: 1, borderBottomColor: theme.divider,
                }}
              >
                <Text style={{ flex: 1, fontSize: 11, fontWeight: '700', color: theme.textMuted, textTransform: 'uppercase' }}>
                  Type
                </Text>
                <Text style={{ width: 70, fontSize: 11, fontWeight: '700', color: theme.textMuted, textTransform: 'uppercase', textAlign: 'center' }}>
                  Warning
                </Text>
                <Text style={{ width: 70, fontSize: 11, fontWeight: '700', color: theme.textMuted, textTransform: 'uppercase', textAlign: 'center' }}>
                  Critical
                </Text>
              </View>
              {(!thresholds || thresholds.length === 0) && (
                <View style={{ padding: 20, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, color: theme.textMuted }}>No thresholds configured</Text>
                </View>
              )}
              {thresholds?.map((t: ThresholdRow, i: number) => (
                <View key={t.id || i}>
                  {i > 0 && <View style={{ height: 1, backgroundColor: theme.divider }} />}
                  <View style={{ flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 14, alignItems: 'center' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '600', color: theme.text }}>
                        {t.cylinderType || t.name || `Type ${i + 1}`}
                      </Text>
                    </View>
                    <View style={{ width: 70, alignItems: 'center' }}>
                      <View style={{ backgroundColor: '#f59e0b' + '18', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: '#f59e0b' }}>
                          {t.warningThreshold ?? t.warning ?? '-'}
                        </Text>
                      </View>
                    </View>
                    <View style={{ width: 70, alignItems: 'center' }}>
                      <View style={{ backgroundColor: '#ef4444' + '18', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: '#ef4444' }}>
                          {t.criticalThreshold ?? t.critical ?? '-'}
                        </Text>
                      </View>
                    </View>
                  </View>
                </View>
              ))}
            </View>
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// USER MANAGEMENT MODAL
// ═══════════════════════════════════════════════════════════════════════════

function UserManagementModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useMoreTheme();
  const [showCreate, setShowCreate] = useState(false);

  const [formFirst, setFormFirst] = useState('');
  const [formLast, setFormLast] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formRole, setFormRole] = useState('distributor_admin');

  const ROLES = ['distributor_admin', 'finance', 'inventory', 'driver', 'customer'];

  const { data: usersResponse, isLoading, refetch } = useApiQuery<{ users: UserRecord[] }>(
    ['users'],
    '/users',
    undefined,
    { enabled: visible },
  );
  const users: UserRecord[] = usersResponse?.users ?? [];

  const createMutation = useApiMutation<UserRecord, {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
    role: string;
  }>('post', '/users', {
    invalidateKeys: [['users']],
    successMessage: 'User created successfully',
    onSuccess: () => {
      resetForm();
      setShowCreate(false);
    },
  });

  const resetForm = () => {
    setFormFirst('');
    setFormLast('');
    setFormEmail('');
    setFormPassword('');
    setFormRole('distributor_admin');
  };

  const handleCreate = () => {
    if (!formFirst.trim() || !formLast.trim() || !formEmail.trim() || !formPassword.trim()) {
      Alert.alert('Validation', 'First name, last name, email, and password are required.');
      return;
    }
    createMutation.mutate({
      firstName: formFirst.trim(),
      lastName: formLast.trim(),
      email: formEmail.trim(),
      password: formPassword,
      role: formRole,
    });
  };

  const roleColors: Record<string, string> = {
    super_admin: '#dc2626',
    distributor_admin: '#3b82f6',
    finance: '#8b5cf6',
    inventory: '#06b6d4',
    driver: '#f59e0b',
    customer: '#10b981',
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
        <ModalHeader title="User Management" onClose={onClose} theme={theme} />

        {showCreate ? (
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={{ flex: 1 }}
          >
            <ScrollView contentContainerStyle={{ padding: 20 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: theme.text, marginBottom: 16 }}>
                Add User
              </Text>
              <FormInput label="First Name *" value={formFirst} onChangeText={setFormFirst} placeholder="First name" theme={theme} />
              <FormInput label="Last Name *" value={formLast} onChangeText={setFormLast} placeholder="Last name" theme={theme} />
              <FormInput label="Email *" value={formEmail} onChangeText={setFormEmail} placeholder="Email address" keyboardType="email-address" autoCapitalize="none" theme={theme} />
              <FormInput label="Password *" value={formPassword} onChangeText={setFormPassword} placeholder="Minimum 8 characters" secureTextEntry autoCapitalize="none" theme={theme} />

              <Text style={{ fontSize: 13, fontWeight: '600', color: theme.textSecondary, marginBottom: 8 }}>
                Role
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
                {ROLES.map((r) => (
                  <TouchableOpacity
                    key={r}
                    onPress={() => setFormRole(r)}
                    style={{
                      paddingHorizontal: 14,
                      paddingVertical: 8,
                      borderRadius: 8,
                      borderWidth: 2,
                      borderColor: formRole === r ? (roleColors[r] || '#3b82f6') : theme.inputBorder,
                      backgroundColor: formRole === r ? (roleColors[r] || '#3b82f6') + '14' : theme.inputBg,
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 13,
                        fontWeight: '700',
                        color: formRole === r ? (roleColors[r] || '#3b82f6') : theme.textSecondary,
                        textTransform: 'capitalize',
                      }}
                    >
                      {r}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
                <TouchableOpacity
                  onPress={() => { resetForm(); setShowCreate(false); }}
                  style={{
                    flex: 1, paddingVertical: 14, borderRadius: 10,
                    backgroundColor: theme.cardBg, borderWidth: 1, borderColor: theme.cardBorder,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ fontSize: 15, fontWeight: '600', color: theme.textSecondary }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleCreate}
                  disabled={createMutation.isPending}
                  style={{
                    flex: 1, paddingVertical: 14, borderRadius: 10,
                    backgroundColor: ACCENT, alignItems: 'center',
                    opacity: createMutation.isPending ? 0.6 : 1,
                  }}
                >
                  {createMutation.isPending ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>Create User</Text>
                  )}
                </TouchableOpacity>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        ) : (
          <View style={{ flex: 1 }}>
            {isLoading ? (
              <Loading theme={theme} />
            ) : (
              <FlatList
                data={users || []}
                keyExtractor={(item) => item.userId}
                renderItem={({ item }) => (
                  <View
                    style={{
                      flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
                      paddingVertical: 14, gap: 12,
                    }}
                  >
                    <View
                      style={{
                        width: 40, height: 40, borderRadius: 20,
                        backgroundColor: (roleColors[item.role] || '#3b82f6') + '14',
                        alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      <Text style={{ fontSize: 16, fontWeight: '700', color: roleColors[item.role] || '#3b82f6' }}>
                        {item.firstName?.[0]?.toUpperCase() || '?'}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontWeight: '600', color: theme.text }}>
                        {item.firstName} {item.lastName}
                      </Text>
                      <Text style={{ fontSize: 12, color: theme.textMuted }}>{item.email}</Text>
                    </View>
                    <StatusBadge label={item.role?.replace(/_/g, ' ')} color={roleColors[item.role] || '#3b82f6'} />
                  </View>
                )}
                ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: theme.divider }} />}
                ListEmptyComponent={<EmptyList message="No users found" theme={theme} />}
                refreshControl={<RefreshControl refreshing={false} onRefresh={refetch} tintColor={ACCENT} />}
              />
            )}
            <FAB onPress={() => setShowCreate(true)} />
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SCREEN
// ═══════════════════════════════════════════════════════════════════════════

export default function AdminMoreScreen() {
  const router = useRouter();
  const theme = useMoreTheme();
  const { user: authUser, logout } = useAuthStore();
  // The auth profile may carry a `distributorName` the backend attaches but the
  // shared UserProfile type doesn't declare; model it as an optional extension.
  const user: AuthUserWithDistributor | null = authUser;

  // Modal visibility state
  const [showCustomers, setShowCustomers] = useState(false);
  const [showFleet, setShowFleet] = useState(false);
  const [showCollections, setShowCollections] = useState(false);
  const [showOverview, setShowOverview] = useState(false);
  const [showReports, setShowReports] = useState(false);
  const [showGst, setShowGst] = useState(false);
  const [showPrices, setShowPrices] = useState(false);
  const [showThresholds, setShowThresholds] = useState(false);
  const [showUsers, setShowUsers] = useState(false);

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Logout',
        style: 'destructive',
        onPress: async () => {
          await logout();
          router.replace('/(auth)/login');
        },
      },
    ]);
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* ── Section 1: Operations ────────────────────────────────── */}
        <SectionCard title="Operations" theme={theme}>
          <MenuRow icon="people" label="Customers" subtitle="Manage customer database" onPress={() => setShowCustomers(true)} theme={theme} />
          <Divider theme={theme} />
          <MenuRow icon="car-sport" label="Fleet" subtitle="Drivers, vehicles & assignments" onPress={() => setShowFleet(true)} theme={theme} />
          <Divider theme={theme} />
          <MenuRow icon="wallet" label="Collections" subtitle="Payment collection dashboard" onPress={() => setShowCollections(true)} theme={theme} />
        </SectionCard>

        {/* ── Section 2: Analytics ─────────────────────────────────── */}
        <SectionCard title="Analytics" theme={theme}>
          <MenuRow icon="stats-chart" label="Overview" subtitle="Key business metrics" onPress={() => setShowOverview(true)} theme={theme} />
          <Divider theme={theme} />
          <MenuRow icon="bar-chart" label="Reports" subtitle="Revenue, customers & driver performance" onPress={() => setShowReports(true)} theme={theme} />
        </SectionCard>

        {/* ── Section 3: Settings ──────────────────────────────────── */}
        <SectionCard title="Settings" theme={theme}>
          <MenuRow icon="document-text" label="GST Configuration" subtitle="Mode, credentials & GSP setup" onPress={() => setShowGst(true)} theme={theme} />
          <Divider theme={theme} />
          <MenuRow icon="pricetag" label="Cylinder Prices" subtitle="Price list per cylinder type" onPress={() => setShowPrices(true)} theme={theme} />
          <Divider theme={theme} />
          <MenuRow icon="alert-circle" label="Inventory Thresholds" subtitle="Warning & critical levels" onPress={() => setShowThresholds(true)} theme={theme} />
          <Divider theme={theme} />
          <MenuRow icon="person-add" label="User Management" subtitle="Users, roles & access" onPress={() => setShowUsers(true)} theme={theme} />
        </SectionCard>

        {/* ── Section 4: Account ───────────────────────────────────── */}
        <SectionCard title="Account" theme={theme}>
          <View style={{ padding: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <View
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  backgroundColor: ACCENT + '14',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 22, fontWeight: '800', color: ACCENT }}>
                  {user?.firstName?.[0]?.toUpperCase() || 'A'}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 17, fontWeight: '700', color: theme.text }}>
                  {user?.firstName} {user?.lastName}
                </Text>
                <Text style={{ fontSize: 13, color: theme.textSecondary, marginTop: 2 }}>
                  {user?.email}
                </Text>
                <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
                  <StatusBadge
                    label={user?.role?.replace(/_/g, ' ') || 'user'}
                    color="#3b82f6"
                  />
                  {user?.distributorName && (
                    <StatusBadge label={user.distributorName} color="#8b5cf6" />
                  )}
                </View>
              </View>
            </View>
          </View>
        </SectionCard>

        {/* ── Logout ──────────────────────────────────────────────── */}
        <TouchableOpacity
          onPress={handleLogout}
          activeOpacity={0.7}
          style={{
            backgroundColor: ACCENT + '10',
            borderRadius: 14,
            borderWidth: 1,
            borderColor: ACCENT + '30',
            paddingVertical: 16,
            alignItems: 'center',
            flexDirection: 'row',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <Ionicons name="log-out-outline" size={20} color={ACCENT} />
          <Text style={{ fontSize: 16, fontWeight: '700', color: ACCENT }}>Sign Out</Text>
        </TouchableOpacity>

        {/* ── Version ─────────────────────────────────────────────── */}
        <Text
          style={{
            textAlign: 'center',
            fontSize: 11,
            color: theme.textMuted,
            marginTop: 16,
          }}
        >
          MyGasLink v1.0.0
        </Text>
      </ScrollView>

      {/* ── All Modals ──────────────────────────────────────────── */}
      <CustomersModal visible={showCustomers} onClose={() => setShowCustomers(false)} />
      <FleetModal visible={showFleet} onClose={() => setShowFleet(false)} />
      <CollectionsModal visible={showCollections} onClose={() => setShowCollections(false)} />
      <AnalyticsOverviewModal visible={showOverview} onClose={() => setShowOverview(false)} />
      <ReportsModal visible={showReports} onClose={() => setShowReports(false)} />
      <GstConfigModal visible={showGst} onClose={() => setShowGst(false)} />
      <CylinderPricesModal visible={showPrices} onClose={() => setShowPrices(false)} />
      <InventoryThresholdsModal visible={showThresholds} onClose={() => setShowThresholds(false)} />
      <UserManagementModal visible={showUsers} onClose={() => setShowUsers(false)} />
    </SafeAreaView>
  );
}
