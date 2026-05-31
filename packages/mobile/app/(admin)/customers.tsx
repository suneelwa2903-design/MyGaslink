import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  FlatList,
  TextInput,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { useAuthStore } from '../../src/stores/authStore';
import { useTheme, ACCENT as ACCENT_COLORS } from '../../src/theme';
import type { Customer as SharedCustomer } from '@gaslink/shared';
import {
  CustomerFormModal,
  customerToFormInitial,
  type CustomerFormSubmit,
} from '../../src/screens/CustomerForm';

const ACCENT = ACCENT_COLORS.red;

// STAGE-H: this screen replaces the in-modal CustomersModal that used to live
// inside (admin)/more.tsx. It's a 1:1 extraction — same data wiring, same row
// behaviour, same Edit modal. The only changes:
//   1. No `<ModalHeader>` (we're now a tab, the system header renders the
//      title via _layout.tsx).
//   2. No `visible`/`onClose` props — TanStack Query simply fetches on mount.
//   3. CUSTOMERS_PAGE_SIZE + STAGE-A pill-row + STEP-3E edit/stop/resume
//      behaviour copied verbatim from the original modal.

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

const CUSTOMERS_PAGE_SIZE = 25;

type CustomerStatusFilter = '' | 'active' | 'suspended' | 'inactive';
const CUSTOMER_STATUS_FILTERS: { label: string; value: CustomerStatusFilter }[] = [
  { label: 'All', value: '' },
  { label: 'Active', value: 'active' },
  { label: 'Suspended', value: 'suspended' },
  { label: 'Inactive', value: 'inactive' },
];

const fmt = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const formatCurrency = (n: number) => fmt.format(n);

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

function DetailRow({
  label,
  value,
  textColor,
  mutedColor,
}: {
  label: string;
  value: string;
  textColor: string;
  mutedColor: string;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={{ fontSize: 13, color: mutedColor }}>{label}</Text>
      <Text style={{ fontSize: 13, fontWeight: '600', color: textColor }}>{value}</Text>
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

// STAGE-H: Edit modal — same shape as more.tsx EditCustomerInlineModal. The
// shared CustomerForm body owns the actual form; here we only wire the lazy
// detail fetch + PUT mutation.
function EditCustomerInlineModal({
  visible,
  customer,
  canEditTransport,
  onClose,
  onSaved,
}: {
  visible: boolean;
  customer: Customer | null;
  canEditTransport: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const customerId = customer?.customerId ?? '';

  const { data: detail } = useApiQuery<SharedCustomer>(
    ['customer-detail-edit', customerId],
    `/customers/${customerId}`,
    undefined,
    { enabled: visible && !!customerId },
  );

  const updateMutation = useApiMutation<SharedCustomer, CustomerFormSubmit>(
    'put',
    () => `/customers/${customerId}`,
    {
      invalidateKeys: [
        ['customers'],
        ['customer-detail', customerId],
        ['customer-detail-edit', customerId],
      ],
      successMessage: 'Customer updated',
      onSuccess: () => {
        onSaved();
      },
    },
  );

  const initial = detail ? customerToFormInitial(detail) : undefined;

  return (
    <CustomerFormModal
      visible={visible}
      mode="edit"
      title="Edit Customer"
      accent={ACCENT}
      canEditTransport={canEditTransport}
      key={detail ? `loaded-${detail.customerId}` : `loading-${customerId}`}
      initial={initial}
      submitting={updateMutation.isPending}
      onClose={onClose}
      onSubmit={async (data) => {
        if (!customer) return;
        try {
          await updateMutation.mutateAsync(data);
        } catch {
          // handled by hook
        }
      }}
    />
  );
}

export default function AdminCustomersScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const auth = useAuthStore();
  const role = auth.user?.role;
  const canEditCustomer =
    role === 'super_admin' || role === 'distributor_admin' || role === 'inventory';
  const canEditTransport = role === 'super_admin' || role === 'distributor_admin';

  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<CustomerStatusFilter>('');
  const [customersPage, setCustomersPage] = useState(0);
  const [editTarget, setEditTarget] = useState<Customer | null>(null);

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
  );
  const customers: Customer[] = customersResponse?.customers ?? [];

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

  const handleToggleStatus = (customer: Customer) => {
    const isSuspending = customer.status === 'active';
    const label = isSuspending ? 'Stop Supply' : 'Resume Supply';
    Alert.alert(
      label,
      `Are you sure you want to ${label.toLowerCase()} for ${customer.customerName}?`,
      [
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
      ],
    );
  };

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
          onPress={() => handleViewAccount(item)}
          onLongPress={() => setExpandedId(expanded ? null : item.customerId)}
          activeOpacity={0.7}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingVertical: 14,
            gap: 12,
            backgroundColor: colors.cardBg,
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
            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>
              {item.customerName}
            </Text>
            <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 1 }}>
              {item.phone}
            </Text>
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
            color={colors.textMuted}
          />
        </TouchableOpacity>

        {expanded && (
          <View
            style={{
              backgroundColor: colors.bg,
              paddingHorizontal: 20,
              paddingVertical: 14,
              borderTopWidth: 1,
              borderTopColor: colors.divider,
              gap: 8,
            }}
          >
            {item.businessName ? (
              <DetailRow
                label="Business"
                value={item.businessName}
                textColor={colors.text}
                mutedColor={colors.textMuted}
              />
            ) : null}
            {item.email ? (
              <DetailRow
                label="Email"
                value={item.email}
                textColor={colors.text}
                mutedColor={colors.textMuted}
              />
            ) : null}
            {item.gstin ? (
              <DetailRow
                label="GSTIN"
                value={item.gstin}
                textColor={colors.text}
                mutedColor={colors.textMuted}
              />
            ) : null}
            {item.creditPeriodDays != null ? (
              <DetailRow
                label="Credit Period"
                value={`${item.creditPeriodDays} days`}
                textColor={colors.text}
                mutedColor={colors.textMuted}
              />
            ) : null}
            {item.totalOrders != null ? (
              <DetailRow
                label="Total Orders"
                value={`${item.totalOrders}`}
                textColor={colors.text}
                mutedColor={colors.textMuted}
              />
            ) : null}
            {item.outstandingBalance != null ? (
              <DetailRow
                label="Outstanding"
                value={formatCurrency(item.outstandingBalance)}
                textColor={colors.text}
                mutedColor={colors.textMuted}
              />
            ) : null}

            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
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
                  <Text style={{ fontSize: 13, fontWeight: '700', color: '#3b82f6' }}>Edit</Text>
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
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 10 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.inputBg,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.inputBorder,
            paddingHorizontal: 12,
            gap: 8,
          }}
        >
          <Ionicons name="search" size={18} color={colors.textMuted} />
          <TextInput
            value={search}
            onChangeText={(t) => {
              setSearch(t);
              setCustomersPage(0);
            }}
            placeholder="Search by name, phone, business..."
            placeholderTextColor={colors.textMuted}
            style={{ flex: 1, paddingVertical: 10, fontSize: 14, color: colors.text }}
          />
          {search.length > 0 && (
            <TouchableOpacity
              onPress={() => {
                setSearch('');
                setCustomersPage(0);
              }}
            >
              <Ionicons name="close-circle" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, marginTop: 10 }}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: 10,
          gap: 8,
          alignItems: 'center',
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
                height: 36,
                paddingHorizontal: 12,
                borderRadius: 18,
                flexShrink: 0,
                justifyContent: 'center',
                backgroundColor: active ? ACCENT : colors.inputBg,
                borderWidth: 1,
                borderColor: active ? ACCENT : colors.inputBorder,
              }}
            >
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: '600',
                  color: active ? '#ffffff' : colors.textSecondary,
                }}
              >
                {opt.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {isLoading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      ) : (
        <FlatList
          data={customers}
          keyExtractor={(item) => item.customerId}
          renderItem={renderCustomer}
          ItemSeparatorComponent={() => (
            <View style={{ height: 1, backgroundColor: colors.divider }} />
          )}
          ListEmptyComponent={<EmptyList message="No customers found" color={colors.textMuted} />}
          refreshControl={
            <RefreshControl refreshing={false} onRefresh={refetch} tintColor={ACCENT} />
          }
          ListFooterComponent={
            customersPage > 0 || customers.length === CUSTOMERS_PAGE_SIZE ? (
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
                    backgroundColor: colors.inputBg,
                    borderWidth: 1,
                    borderColor: colors.inputBorder,
                    opacity: customersPage === 0 ? 0.5 : 1,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: '700', color: colors.text }}>
                    Previous
                  </Text>
                </TouchableOpacity>
                <Text style={{ fontSize: 12, color: colors.textMuted }}>
                  Showing {customersPage * CUSTOMERS_PAGE_SIZE + 1}–
                  {customersPage * CUSTOMERS_PAGE_SIZE + customers.length}
                </Text>
                <TouchableOpacity
                  onPress={() => setCustomersPage((p) => p + 1)}
                  disabled={customers.length < CUSTOMERS_PAGE_SIZE}
                  style={{
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    borderRadius: 8,
                    backgroundColor: colors.inputBg,
                    borderWidth: 1,
                    borderColor: colors.inputBorder,
                    opacity: customers.length < CUSTOMERS_PAGE_SIZE ? 0.5 : 1,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: '700', color: colors.text }}>
                    Next
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null
          }
        />
      )}

      <FAB onPress={() => router.push('/(admin)/customer-create')} />

      <EditCustomerInlineModal
        visible={!!editTarget}
        customer={editTarget}
        canEditTransport={canEditTransport}
        onClose={() => setEditTarget(null)}
        onSaved={() => {
          refetch();
          setEditTarget(null);
        }}
      />
    </SafeAreaView>
  );
}
