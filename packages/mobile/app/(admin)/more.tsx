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
import { DeleteAccountButton } from '../../src/components/DeleteAccountButton';
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
  // Wire values come from shared VehicleStatus enum: idle | dispatched | returned | inactive.
  // Older code in this file treated it as 'active' | 'inactive' — that's a display convenience;
  // the only branch that matters operationally is 'inactive', which the API rejects for
  // dispatch and the mapping picker must surface as a warning.
  status: 'idle' | 'dispatched' | 'returned' | 'inactive' | 'active';
}

// STEP-3D: shape returned by GET /assignments/vehicle-mappings?date=...
// The endpoint returns an envelope; the rows are in `recommendations`.
// Per-row `status` is the synthetic confirmed | recommended | unassigned string
// from assignmentService.getRecommendedMappings — NOT the DVA AssignmentStatus.
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

// STEP-3E: minimal Customer shape for the Edit modal's lazy detail fetch.
// The list view returns a trimmed Customer (no transportChargePerCylinder
// etc.); the detail GET returns the full shape — we type that surface
// inline rather than importing the heavy shared Customer type just for
// these few fields.
interface CustomerDetailShape {
  customerId: string;
  customerName: string;
  businessName: string | null;
  phone: string;
  email: string | null;
  gstin: string | null;
  creditPeriodDays: number;
  transportChargePerCylinder: number;
}

// STEP-3E: inline Edit modal for a single customer row in the CustomersModal.
// Lazily fetches the full Customer (GET /customers/:id) on open so we have
// transportChargePerCylinder, then submits PUT /customers/:id. This is
// intentionally duplicated with the EditCustomerModal in customer-detail.tsx
// (per the STEP-3E brief — extraction is out of scope).
function EditCustomerInlineModal({
  visible,
  customer,
  canEditTransport,
  theme,
  onClose,
  onSaved,
}: {
  visible: boolean;
  customer: Customer | null;
  canEditTransport: boolean;
  theme: Theme;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [formName, setFormName] = useState('');
  const [formBusiness, setFormBusiness] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formGstin, setFormGstin] = useState('');
  const [formCredit, setFormCredit] = useState('30');
  const [formTransport, setFormTransport] = useState('0');
  const [initializedFor, setInitializedFor] = useState<string | null>(null);

  const customerId = customer?.customerId ?? '';

  // Lazy fetch of the full Customer so the transport field has the right
  // initial value. The list payload doesn't carry transportChargePerCylinder.
  const { data: detail } = useApiQuery<CustomerDetailShape>(
    ['customer-detail-edit', customerId],
    `/customers/${customerId}`,
    undefined,
    { enabled: visible && !!customerId },
  );

  // Sync form fields with detail on first arrival per customer; reset when
  // modal closes. Render-time pattern (no extra effect render pass).
  if (visible && detail && initializedFor !== detail.customerId) {
    setInitializedFor(detail.customerId);
    setFormName(detail.customerName);
    setFormBusiness(detail.businessName ?? '');
    setFormPhone(detail.phone);
    setFormEmail(detail.email ?? '');
    setFormGstin(detail.gstin ?? '');
    setFormCredit(String(detail.creditPeriodDays ?? 30));
    setFormTransport(String(detail.transportChargePerCylinder ?? 0));
  }
  if (!visible && initializedFor !== null) {
    setInitializedFor(null);
  }

  const updateMutation = useApiMutation<
    Customer,
    {
      customerName: string;
      businessName?: string;
      phone: string;
      email?: string;
      gstin?: string;
      creditPeriodDays: number;
      transportChargePerCylinder?: number;
    }
  >('put', () => `/customers/${customerId}`, {
    invalidateKeys: [
      ['customers'],
      ['customer-detail', customerId],
      ['customer-detail-edit', customerId],
    ],
    successMessage: 'Customer updated',
    onSuccess: () => {
      onSaved();
    },
  });

  const handleSubmit = () => {
    if (!customer) return;
    if (!formName.trim() || !formPhone.trim()) {
      Alert.alert('Validation', 'Name and phone are required.');
      return;
    }
    const credit = parseInt(formCredit, 10);
    if (Number.isNaN(credit) || credit < 0) {
      Alert.alert('Validation', 'Credit period must be a non-negative number.');
      return;
    }
    const transport = parseFloat(formTransport);
    if (canEditTransport && Number.isNaN(transport)) {
      Alert.alert('Validation', 'Transport charge must be a number.');
      return;
    }
    updateMutation.mutate({
      customerName: formName.trim(),
      businessName: formBusiness.trim() || undefined,
      phone: formPhone.trim(),
      email: formEmail.trim() || undefined,
      gstin: formGstin.trim() || undefined,
      creditPeriodDays: credit,
      transportChargePerCylinder: canEditTransport ? transport : undefined,
    });
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
        <ModalHeader title="Edit Customer" onClose={onClose} theme={theme} />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
          <ScrollView contentContainerStyle={{ padding: 20 }}>
            <FormInput
              label="Name *"
              value={formName}
              onChangeText={setFormName}
              placeholder="Full name"
              theme={theme}
            />
            <FormInput
              label="Business Name"
              value={formBusiness}
              onChangeText={setFormBusiness}
              placeholder="Business name (optional)"
              theme={theme}
            />
            <FormInput
              label="Phone *"
              value={formPhone}
              onChangeText={setFormPhone}
              placeholder="10-digit mobile"
              keyboardType="phone-pad"
              theme={theme}
            />
            <FormInput
              label="Email"
              value={formEmail}
              onChangeText={setFormEmail}
              placeholder="Email (optional)"
              keyboardType="email-address"
              autoCapitalize="none"
              theme={theme}
            />
            <FormInput
              label="GSTIN"
              value={formGstin}
              onChangeText={setFormGstin}
              placeholder="22AAAAA0000A1Z5"
              autoCapitalize="characters"
              theme={theme}
            />
            <FormInput
              label="Credit Period (days)"
              value={formCredit}
              onChangeText={setFormCredit}
              placeholder="e.g. 30"
              keyboardType="numeric"
              theme={theme}
            />
            {canEditTransport && (
              <FormInput
                label="Transport Charge (per cylinder)"
                value={formTransport}
                onChangeText={setFormTransport}
                placeholder="0"
                keyboardType="numeric"
                theme={theme}
              />
            )}

            <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
              <TouchableOpacity
                onPress={onClose}
                disabled={updateMutation.isPending}
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
                <Text style={{ fontSize: 15, fontWeight: '600', color: theme.textSecondary }}>
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSubmit}
                disabled={updateMutation.isPending}
                style={{
                  flex: 1,
                  paddingVertical: 14,
                  borderRadius: 10,
                  backgroundColor: ACCENT,
                  alignItems: 'center',
                  opacity: updateMutation.isPending ? 0.6 : 1,
                }}
              >
                {updateMutation.isPending ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>
                    Save Changes
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

// STEP-3E: page size aligned with web CustomersPage (25/page) and the
// canonical mobile pagination pattern from (admin)/pending-actions.tsx.
const CUSTOMERS_PAGE_SIZE = 25;

// STEP-3E: status filter options surfaced as a horizontal pill row above the
// list — mirrors web CustomersPage Status select (CustomersPage.tsx:124-130).
type CustomerStatusFilter = '' | 'active' | 'suspended' | 'inactive';
const CUSTOMER_STATUS_FILTERS: { label: string; value: CustomerStatusFilter }[] = [
  { label: 'All', value: '' },
  { label: 'Active', value: 'active' },
  { label: 'Suspended', value: 'suspended' },
  { label: 'Inactive', value: 'inactive' },
];

function CustomersModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const theme = useMoreTheme();
  const auth = useAuthStore();
  // STEP-3E: role gate for the per-row Edit button. API restricts
  // PUT /customers/:id to super_admin / distributor_admin / inventory
  // (customers.ts:175). Hide the button for finance to avoid 403s.
  const role = auth.user?.role;
  const canEditCustomer =
    role === 'super_admin' || role === 'distributor_admin' || role === 'inventory';
  // STEP-3E: web parity — transport-charge edit further restricted to admins
  // (CustomersPage.tsx:286 canEditTransport). Inventory edits the rest of the
  // customer but not transport.
  const canEditTransport =
    role === 'super_admin' || role === 'distributor_admin';

  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // STEP-3E: status filter + page state.
  const [statusFilter, setStatusFilter] = useState<CustomerStatusFilter>('');
  const [customersPage, setCustomersPage] = useState(0);

  // STEP-3E: inline edit modal for a single customer row.
  const [editTarget, setEditTarget] = useState<Customer | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formBusiness, setFormBusiness] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formGstin, setFormGstin] = useState('');
  const [formType, setFormType] = useState<'B2B' | 'B2C'>('B2C');
  const [formCredit, setFormCredit] = useState('');

  // STEP-3E: paginated list. customerFilterSchema (shared/schemas) requires
  // `page` + `pageSize` (NOT `limit`) — the previous `?limit=200` quietly fell
  // through Zod defaults and capped the response at pageSize=25 anyway.
  const customerListParams: Record<string, unknown> = {
    page: customersPage + 1,
    pageSize: CUSTOMERS_PAGE_SIZE,
  };
  if (statusFilter) customerListParams.status = statusFilter;
  if (search.trim()) customerListParams.search = search.trim();

  const { data: customersResponse, isLoading, refetch } = useApiQuery<{ customers: Customer[] }>(
    ['customers', statusFilter, String(customersPage), search.trim()],
    '/customers',
    customerListParams,
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

  // STEP-3E: search is now server-side (customerFilterSchema supports
  // ?search=), so the in-memory filter just re-exposes the server-paged list
  // as-is. Status filter is also server-side.
  const filtered = customers;

  // STEP-3E: route to the new customer-detail screen instead of the legacy
  // inline expansion. We keep the chevron + long-press expansion as a
  // secondary affordance for inventory-style use, but the primary tap goes
  // to the detail screen.
  const handleViewAccount = (customer: Customer) => {
    router.push({
      pathname: '/(admin)/customer-detail',
      params: { customerId: customer.customerId },
    });
  };

  const renderCustomer = ({ item }: { item: Customer }) => {
    const expanded = expandedId === item.customerId;
    return (
      <View>
        <TouchableOpacity
          // STEP-3E: primary tap routes to the full Customer Detail screen.
          // Long-press still toggles the inline expansion for inventory who
          // wants a quick glance without leaving the modal.
          onPress={() => handleViewAccount(item)}
          onLongPress={() => setExpandedId(expanded ? null : item.customerId)}
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

            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              {/* STEP-3E: View Account routes to the full Customer Detail screen. */}
              <TouchableOpacity
                onPress={() => handleViewAccount(item)}
                style={{
                  flex: 1,
                  minWidth: 120,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor: ACCENT + '14',
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: '700', color: ACCENT }}>
                  View Account
                </Text>
              </TouchableOpacity>
              {/* STEP-3E: Edit gated to roles whose API mutations succeed. */}
              {canEditCustomer && (
                <TouchableOpacity
                  onPress={() => setEditTarget(item)}
                  style={{
                    flex: 1,
                    minWidth: 120,
                    paddingVertical: 10,
                    borderRadius: 8,
                    backgroundColor: '#3b82f6' + '14',
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: '700', color: '#3b82f6' }}>
                    Edit
                  </Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={() => handleToggleStatus(item)}
                style={{
                  flex: 1,
                  minWidth: 120,
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
                  onChangeText={(t) => {
                    setSearch(t);
                    setCustomersPage(0);
                  }}
                  placeholder="Search by name, phone, business..."
                  placeholderTextColor={theme.textMuted}
                  style={{ flex: 1, paddingVertical: 10, fontSize: 14, color: theme.text }}
                />
                {search.length > 0 && (
                  <TouchableOpacity onPress={() => { setSearch(''); setCustomersPage(0); }}>
                    <Ionicons name="close-circle" size={18} color={theme.textMuted} />
                  </TouchableOpacity>
                )}
              </View>
            </View>

            {/* STEP-3E: status filter pill row — web parity with the
                "All Statuses" Select on CustomersPage. */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{
                paddingHorizontal: 16,
                paddingBottom: 10,
                gap: 6,
              }}
            >
              {CUSTOMER_STATUS_FILTERS.map((opt) => {
                const active = opt.value === statusFilter;
                return (
                  <TouchableOpacity
                    key={opt.value || 'all'}
                    onPress={() => {
                      setStatusFilter(opt.value);
                      setCustomersPage(0);
                    }}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderRadius: 16,
                      backgroundColor: active ? ACCENT : theme.inputBg,
                      borderWidth: 1,
                      borderColor: active ? ACCENT : theme.inputBorder,
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 12,
                        fontWeight: '600',
                        color: active ? '#ffffff' : theme.textSecondary,
                      }}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

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
                ListFooterComponent={
                  // STEP-3E: Previous / Next pagination — same shape as
                  // (admin)/pending-actions.tsx. Show only when the current
                  // page has the full PAGE_SIZE or we're past page 0.
                  customersPage > 0 || filtered.length === CUSTOMERS_PAGE_SIZE ? (
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingHorizontal: 16,
                        paddingVertical: 16,
                      }}
                    >
                      <TouchableOpacity
                        onPress={() => setCustomersPage((p) => Math.max(0, p - 1))}
                        disabled={customersPage === 0}
                        style={{
                          paddingHorizontal: 14,
                          paddingVertical: 8,
                          borderRadius: 8,
                          backgroundColor: theme.inputBg,
                          borderWidth: 1,
                          borderColor: theme.inputBorder,
                          opacity: customersPage === 0 ? 0.5 : 1,
                        }}
                      >
                        <Text style={{ fontSize: 12, fontWeight: '700', color: theme.text }}>
                          Previous
                        </Text>
                      </TouchableOpacity>
                      <Text style={{ fontSize: 12, color: theme.textMuted }}>
                        Showing {customersPage * CUSTOMERS_PAGE_SIZE + 1}–
                        {customersPage * CUSTOMERS_PAGE_SIZE + filtered.length}
                      </Text>
                      <TouchableOpacity
                        onPress={() => setCustomersPage((p) => p + 1)}
                        disabled={filtered.length < CUSTOMERS_PAGE_SIZE}
                        style={{
                          paddingHorizontal: 14,
                          paddingVertical: 8,
                          borderRadius: 8,
                          backgroundColor: theme.inputBg,
                          borderWidth: 1,
                          borderColor: theme.inputBorder,
                          opacity: filtered.length < CUSTOMERS_PAGE_SIZE ? 0.5 : 1,
                        }}
                      >
                        <Text style={{ fontSize: 12, fontWeight: '700', color: theme.text }}>
                          Next
                        </Text>
                      </TouchableOpacity>
                    </View>
                  ) : null
                }
              />
            )}

            <FAB onPress={() => setShowCreate(true)} />

            {/* STEP-3E: per-row Edit modal. Mounted at the modal level so it
                appears above the customer list. Initialized from the row but
                the full Customer (including transportChargePerCylinder) is
                lazily fetched inside the modal — the list payload only
                includes the trimmed local Customer shape. */}
            <EditCustomerInlineModal
              visible={!!editTarget}
              customer={editTarget}
              canEditTransport={canEditTransport}
              theme={theme}
              onClose={() => setEditTarget(null)}
              onSaved={() => {
                refetch();
                setEditTarget(null);
              }}
            />
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

  // STEP-3D: editable vehicle-mapping screen.
  // Date drives both the GET and the Bulk Confirm POST. Default = today's ISO date.
  const [mappingDate, setMappingDate] = useState<string>(() => new Date().toISOString().split('T')[0]);
  const [pickerForDriverId, setPickerForDriverId] = useState<string | null>(null);

  const {
    data: mappingsResponse,
    isLoading: assignmentsLoading,
    refetch: refetchAssignments,
  } = useApiQuery<VehicleMappingsResponse>(
    ['admin-vehicle-mappings', mappingDate],
    '/assignments/vehicle-mappings',
    { date: mappingDate },
    { enabled: visible },
  );

  // STEP-3D: per-row single-row upsert. PUT /assignments/vehicle-mappings
  // with { date, driverId, vehicleId } — idempotent, touches only that row.
  const upsertMappingMutation = useApiMutation<
    { assignmentId: string; driverId: string; vehicleId: string },
    { date: string; driverId: string; vehicleId: string }
  >('put', '/assignments/vehicle-mappings', {
    invalidateKeys: [['admin-vehicle-mappings', mappingDate], ['assignments'], ['vehicles']],
    onSuccess: () => setPickerForDriverId(null),
  });

  // STEP-3D: "Bulk Confirm — Use Previous Day". Single POST with body { date }
  // (mappings omitted) — server copies yesterday's DVAs forward in one txn.
  const bulkConfirmMutation = useApiMutation<
    { confirmed: number; date: string; message: string },
    { date: string }
  >('post', '/assignments/vehicle-mappings/confirm', {
    invalidateKeys: [['admin-vehicle-mappings', mappingDate], ['assignments'], ['vehicles']],
    onSuccess: (data) => {
      if (data?.confirmed && data.confirmed > 0) {
        Alert.alert('Confirmed', `Confirmed ${data.confirmed} driver-vehicle mapping${data.confirmed === 1 ? '' : 's'}.`);
      } else {
        Alert.alert('Nothing to confirm', data?.message ?? 'No previous-day assignments were found to copy forward.');
      }
    },
  });

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

  // STEP-3D: Vehicle status helper. Wire value 'inactive' is the trigger for
  // the warning treatment; legacy 'active' and the other VehicleStatus values
  // (idle/dispatched/returned) are all considered valid pick targets.
  const isVehicleInactive = (v: Vehicle | undefined): boolean => !!v && v.status === 'inactive';

  // STEP-3D: lookup tables for the per-row picker. allVehicles is the
  // full /vehicles list (so we can detect inactive AFTER the API stripped
  // them from the recommendations envelope — see anti-pattern note in the
  // contract about historical recommendations becoming inactive).
  const vehicleById = new Map(vehicles.map((v) => [v.vehicleId, v]));

  // STEP-3D: web-parity exclusion of vehicles already confirmed to other
  // drivers (the dropdown should hide them, except for the row that owns
  // that vehicle and the row currently being edited).
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

  const statusVariant = (status: VehicleMappingRow['status']): 'success' | 'info' | 'warning' => {
    if (status === 'confirmed') return 'success';
    if (status === 'recommended') return 'info';
    return 'warning';
  };

  const renderAssignments = () => {
    return (
      <View style={{ flex: 1 }}>
        {/* Date + Bulk Confirm header. YYYY-MM-DD text input keeps parity
            with the (admin)/orders.tsx date range pattern (STEP-3A) — no
            native picker dependency. */}
        <View
          style={{
            flexDirection: 'row',
            gap: 10,
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: theme.divider,
            alignItems: 'center',
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              flex: 1,
              backgroundColor: theme.inputBg,
              borderColor: theme.inputBorder,
              borderWidth: 1,
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 8,
            }}
          >
            <Ionicons name="calendar-outline" size={14} color={theme.textMuted} />
            <TextInput
              style={{ flex: 1, color: theme.text, fontSize: 14, padding: 0 }}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={theme.textMuted}
              value={mappingDate}
              onChangeText={(t) => {
                setMappingDate(t);
                setPickerForDriverId(null);
              }}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
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
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>Use Previous Day</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {assignmentsLoading ? (
          <Loading theme={theme} />
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
                <View
                  style={{
                    paddingHorizontal: 16,
                    paddingVertical: 14,
                    gap: 8,
                  }}
                >
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
                      <Text style={{ fontSize: 15, fontWeight: '600', color: theme.text }}>
                        {item.driverName}
                      </Text>
                      <Text style={{ fontSize: 12, color: theme.textMuted }}>
                        Source: {item.source}
                      </Text>
                    </View>
                    <StatusBadge label={item.status} color={badgeColor} />
                  </View>

                  {/* Vehicle picker trigger */}
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
                      borderColor: mappedVehicleInactive ? '#ef4444' : theme.inputBorder,
                      backgroundColor: theme.inputBg,
                      opacity: saving ? 0.6 : 1,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                      <Ionicons name="car-outline" size={14} color={theme.textMuted} />
                      <Text
                        style={{
                          fontSize: 14,
                          color: item.vehicleNumber ? theme.text : theme.textMuted,
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
                      <Ionicons name="chevron-down" size={16} color={theme.textMuted} />
                    )}
                  </TouchableOpacity>

                  {/* Inline inactive-vehicle warning (mirrors web FleetPage). */}
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
                        <Text style={{ fontSize: 12, color: theme.textMuted }}>
                          (was {item.vehicleNumber})
                        </Text>
                      ) : null}
                    </View>
                  )}
                </View>
              );
            }}
            ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: theme.divider }} />}
            ListEmptyComponent={
              <EmptyList
                message={`No mappings for ${mappingDate}. Try changing the date or pull to refresh.`}
                theme={theme}
              />
            }
            ListFooterComponent={
              mappingsResponse ? (
                <View
                  style={{
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderTopWidth: 1,
                    borderTopColor: theme.divider,
                    backgroundColor: theme.cardBg,
                  }}
                >
                  <Text style={{ fontSize: 13, color: theme.textSecondary, textAlign: 'center' }}>
                    Confirmed: {mappingsResponse.confirmedCount} · Recommended: {mappingsResponse.recommendedCount} · Unassigned: {mappingsResponse.unassignedCount}
                  </Text>
                </View>
              ) : null
            }
            refreshControl={
              <RefreshControl refreshing={false} onRefresh={refetchAssignments} tintColor={ACCENT} />
            }
          />
        )}

        {/* STEP-3D: bottom-sheet vehicle picker, modeled on the
            (admin)/orders.tsx assign-dispatch modal (lines 1287-1383). */}
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
                backgroundColor: theme.bg,
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
                  backgroundColor: theme.divider,
                  marginVertical: 10,
                }}
              />
              <Text
                style={{
                  fontSize: 16,
                  fontWeight: '700',
                  color: theme.text,
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
                      <Text style={{ fontSize: 14, color: theme.textMuted, paddingVertical: 16, textAlign: 'center' }}>
                        No vehicles available. All vehicles are either inactive or already assigned.
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
                              borderColor: isCurrent ? ACCENT : theme.cardBorder,
                              backgroundColor: isCurrent ? ACCENT : theme.cardBg,
                              marginBottom: 8,
                              opacity: inactive ? 0.5 : 1,
                            }}
                          >
                            <Ionicons
                              name={isCurrent ? 'radio-button-on' : 'radio-button-off'}
                              size={18}
                              color={isCurrent ? '#fff' : theme.textSecondary}
                            />
                            <View style={{ flex: 1 }}>
                              <Text
                                style={{
                                  fontSize: 14,
                                  fontWeight: '600',
                                  color: isCurrent ? '#fff' : theme.text,
                                }}
                              >
                                {v.vehicleNumber}
                                {inactive ? ' (inactive)' : ''}
                              </Text>
                              {v.vehicleType ? (
                                <Text
                                  style={{
                                    fontSize: 12,
                                    color: isCurrent ? 'rgba(255,255,255,0.7)' : theme.textMuted,
                                  }}
                                >
                                  {v.vehicleType}{v.capacity ? ` · ${v.capacity} cyl` : ''}
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
                  borderColor: theme.cardBorder,
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: '600', color: theme.textSecondary }}>
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

// STEP-3C: CollectionsModal removed. Collections is now a full screen at
// app/(admin)/collections.tsx, reached via More → Collections → router.push.

// STEP-3C: MetricBox helper removed alongside CollectionsModal — it was its
// only consumer. AnalyticsOverviewModal uses its own card layout.

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

// ═══════════════════════════════════════════════════════════════════════════
// CYLINDER TYPES MODAL  (STEP-3F)
// ═══════════════════════════════════════════════════════════════════════════
//
// Mirrors the web Settings → Cylinder Types tab: list / create / edit / delete.
// API: GET /cylinder-types → { cylinderTypes: CylinderType[] }
//      POST /cylinder-types { typeName, capacity, unit }
//      PUT  /cylinder-types/:id { typeName?, capacity?, unit? }
//      DELETE /cylinder-types/:id  (soft-delete; service marks isActive=false)
//
// Role gates were widened by STEP-1A: all four routes accept
// super_admin | distributor_admin | finance | inventory.

interface CylinderTypeRow {
  cylinderTypeId: string;
  typeName: string;
  capacity: number;
  unit: string;
}

function CylinderTypeFormModal({
  visible,
  mode,
  initial,
  theme,
  onClose,
  onSubmit,
  submitting,
}: {
  visible: boolean;
  mode: 'create' | 'edit';
  initial: { typeName: string; capacity: string; unit: string };
  theme: Theme;
  onClose: () => void;
  onSubmit: (values: { typeName: string; capacity: number; unit: string }) => void;
  submitting: boolean;
}) {
  const [typeName, setTypeName] = useState(initial.typeName);
  const [capacity, setCapacity] = useState(initial.capacity);
  const [unit, setUnit] = useState(initial.unit);
  const [initializedFor, setInitializedFor] = useState<string | null>(null);

  // Re-sync form fields with `initial` each time the modal opens for a
  // (potentially) different row. Keyed off a coarse "open snapshot" string.
  const openKey = visible ? `${mode}:${initial.typeName}:${initial.capacity}:${initial.unit}` : null;
  if (openKey && initializedFor !== openKey) {
    setInitializedFor(openKey);
    setTypeName(initial.typeName);
    setCapacity(initial.capacity);
    setUnit(initial.unit);
  }
  if (!visible && initializedFor !== null) {
    setInitializedFor(null);
  }

  const handleSave = () => {
    const trimmedName = typeName.trim();
    const capacityNum = Number(capacity);
    const trimmedUnit = unit.trim() || 'kg';
    if (!trimmedName) {
      Alert.alert('Validation', 'Type name is required.');
      return;
    }
    if (!Number.isFinite(capacityNum) || capacityNum <= 0) {
      Alert.alert('Validation', 'Capacity must be a positive number.');
      return;
    }
    onSubmit({ typeName: trimmedName, capacity: capacityNum, unit: trimmedUnit });
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet">
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
        <ModalHeader title={mode === 'create' ? 'Add Cylinder Type' : 'Edit Cylinder Type'} onClose={onClose} theme={theme} />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
          <ScrollView contentContainerStyle={{ padding: 20 }}>
            <FormInput
              label="Type Name *"
              value={typeName}
              onChangeText={setTypeName}
              placeholder="e.g. 14.2 kg Domestic"
              theme={theme}
            />
            <FormInput
              label="Capacity *"
              value={capacity}
              onChangeText={setCapacity}
              placeholder="e.g. 14.2"
              keyboardType="numeric"
              theme={theme}
            />
            <FormInput
              label="Unit"
              value={unit}
              onChangeText={setUnit}
              placeholder="kg"
              autoCapitalize="none"
              theme={theme}
            />
            <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
              <TouchableOpacity
                onPress={onClose}
                disabled={submitting}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 10,
                  backgroundColor: theme.cardBg, borderWidth: 1, borderColor: theme.cardBorder,
                  alignItems: 'center',
                  opacity: submitting ? 0.6 : 1,
                }}
              >
                <Text style={{ fontSize: 15, fontWeight: '600', color: theme.textSecondary }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSave}
                disabled={submitting}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 10,
                  backgroundColor: ACCENT, alignItems: 'center',
                  opacity: submitting ? 0.6 : 1,
                }}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>
                    {mode === 'create' ? 'Create' : 'Save'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function CylinderTypesModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useMoreTheme();
  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<CylinderTypeRow | null>(null);

  const { data, isLoading, refetch, isRefetching } = useApiQuery<{ cylinderTypes: CylinderTypeRow[] }>(
    ['cylinder-types'],
    '/cylinder-types',
    undefined,
    { enabled: visible },
  );
  const cylinderTypes: CylinderTypeRow[] = data?.cylinderTypes ?? [];

  const createMutation = useApiMutation<
    CylinderTypeRow,
    { typeName: string; capacity: number; unit: string }
  >('post', '/cylinder-types', {
    invalidateKeys: [['cylinder-types']],
    successMessage: 'Cylinder type created',
    onSuccess: () => {
      setFormMode(null);
      setEditing(null);
    },
  });

  const updateMutation = useApiMutation<
    CylinderTypeRow,
    { typeName: string; capacity: number; unit: string }
  >('put', () => `/cylinder-types/${editing?.cylinderTypeId ?? ''}`, {
    invalidateKeys: [['cylinder-types']],
    successMessage: 'Cylinder type updated',
    onSuccess: () => {
      setFormMode(null);
      setEditing(null);
    },
  });

  const deleteMutation = useApiMutation<{ message: string }, void>(
    'delete',
    (_vars) => `/cylinder-types/${pendingDeleteId.current ?? ''}`,
    {
      invalidateKeys: [['cylinder-types']],
      successMessage: 'Cylinder type deleted',
    },
  );
  // Tiny ref-style holder so the delete URL can resolve at call time without
  // making it part of the mutation variables.
  const pendingDeleteId = React.useRef<string | null>(null);

  const handleDelete = (row: CylinderTypeRow) => {
    Alert.alert(
      'Delete cylinder type',
      `Delete "${row.typeName}"? This cannot be undone if it has no historical inventory.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            pendingDeleteId.current = row.cylinderTypeId;
            deleteMutation.mutate(undefined);
          },
        },
      ],
    );
  };

  const handleSubmit = (values: { typeName: string; capacity: number; unit: string }) => {
    if (formMode === 'create') {
      createMutation.mutate(values);
    } else if (formMode === 'edit' && editing) {
      updateMutation.mutate(values);
    }
  };

  const formInitial = useMemo(() => {
    if (formMode === 'edit' && editing) {
      return {
        typeName: editing.typeName,
        capacity: String(editing.capacity),
        unit: editing.unit || 'kg',
      };
    }
    return { typeName: '', capacity: '', unit: 'kg' };
  }, [formMode, editing]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
        <ModalHeader title="Cylinder Types" onClose={onClose} theme={theme} />
        {isLoading ? (
          <Loading theme={theme} />
        ) : (
          <View style={{ flex: 1 }}>
            <FlatList
              data={cylinderTypes}
              keyExtractor={(item) => item.cylinderTypeId}
              contentContainerStyle={cylinderTypes.length === 0 ? { flex: 1 } : { paddingVertical: 8 }}
              renderItem={({ item }) => (
                <View
                  style={{
                    flexDirection: 'row', alignItems: 'center',
                    paddingHorizontal: 16, paddingVertical: 14, gap: 12,
                  }}
                >
                  <View
                    style={{
                      width: 40, height: 40, borderRadius: 10,
                      backgroundColor: ACCENT + '14',
                      alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <Ionicons name="cube" size={18} color={ACCENT} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: theme.text }}>
                      {item.typeName}
                    </Text>
                    <Text style={{ fontSize: 12, color: theme.textMuted, marginTop: 2 }}>
                      {item.capacity} {item.unit || 'kg'}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => { setEditing(item); setFormMode('edit'); }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={{
                      paddingHorizontal: 10, paddingVertical: 6,
                      borderRadius: 8, backgroundColor: ACCENT + '14',
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '700', color: ACCENT }}>Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => handleDelete(item)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={{
                      paddingHorizontal: 10, paddingVertical: 6,
                      borderRadius: 8, backgroundColor: '#dc262614',
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '700', color: '#dc2626' }}>Delete</Text>
                  </TouchableOpacity>
                </View>
              )}
              ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: theme.divider }} />}
              ListEmptyComponent={
                <EmptyList
                  message="No cylinder types defined. Add one to get started."
                  theme={theme}
                />
              }
              refreshControl={
                <RefreshControl
                  refreshing={isRefetching}
                  onRefresh={refetch}
                  tintColor={ACCENT}
                />
              }
            />
            <FAB onPress={() => { setEditing(null); setFormMode('create'); }} />
          </View>
        )}

        <CylinderTypeFormModal
          visible={formMode !== null}
          mode={formMode ?? 'create'}
          initial={formInitial}
          theme={theme}
          onClose={() => { setFormMode(null); setEditing(null); }}
          onSubmit={handleSubmit}
          submitting={createMutation.isPending || updateMutation.isPending}
        />
      </SafeAreaView>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CYLINDER PRICES MODAL
// ═══════════════════════════════════════════════════════════════════════════

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
  const [showOverview, setShowOverview] = useState(false);
  const [showReports, setShowReports] = useState(false);
  const [showGst, setShowGst] = useState(false);
  const [showCylinderTypes, setShowCylinderTypes] = useState(false);
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
          <MenuRow icon="wallet" label="Collections" subtitle="Payment collection dashboard" onPress={() => router.push('/(admin)/collections')} theme={theme} />
        </SectionCard>

        {/* ── Section 2: Analytics ─────────────────────────────────── */}
        <SectionCard title="Analytics" theme={theme}>
          <MenuRow icon="stats-chart" label="Overview" subtitle="Key business metrics" onPress={() => setShowOverview(true)} theme={theme} />
          <Divider theme={theme} />
          <MenuRow icon="bar-chart" label="Reports" subtitle="Revenue, customers & driver performance" onPress={() => setShowReports(true)} theme={theme} />
        </SectionCard>

        {/* ── Section 3: Settings ──────────────────────────────────── */}
        <SectionCard title="Settings" theme={theme}>
          <MenuRow icon="document-text" label="GST" subtitle="Mode, credentials & GSP setup" onPress={() => setShowGst(true)} theme={theme} />
          <Divider theme={theme} />
          <MenuRow icon="cube" label="Cylinder Types" subtitle="Add, edit & remove cylinder types" onPress={() => setShowCylinderTypes(true)} theme={theme} />
          <Divider theme={theme} />
          <MenuRow icon="pricetag" label="Cylinder Prices" subtitle="Price list per cylinder type" onPress={() => setShowPrices(true)} theme={theme} />
          <Divider theme={theme} />
          <MenuRow icon="alert-circle" label="Thresholds" subtitle="Warning & critical levels" onPress={() => setShowThresholds(true)} theme={theme} />
          <Divider theme={theme} />
          <MenuRow icon="person-add" label="Users" subtitle="Users, roles & access" onPress={() => setShowUsers(true)} theme={theme} />
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
          <Divider theme={theme} />
          <DeleteAccountButton variant="inline" />
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
      <AnalyticsOverviewModal visible={showOverview} onClose={() => setShowOverview(false)} />
      <ReportsModal visible={showReports} onClose={() => setShowReports(false)} />
      <GstConfigModal visible={showGst} onClose={() => setShowGst(false)} />
      <CylinderTypesModal visible={showCylinderTypes} onClose={() => setShowCylinderTypes(false)} />
      <CylinderPricesModal visible={showPrices} onClose={() => setShowPrices(false)} />
      <InventoryThresholdsModal visible={showThresholds} onClose={() => setShowThresholds(false)} />
      <UserManagementModal visible={showUsers} onClose={() => setShowUsers(false)} />
    </SafeAreaView>
  );
}
