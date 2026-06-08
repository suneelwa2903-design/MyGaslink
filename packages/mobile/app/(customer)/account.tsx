import { useState } from 'react';
import {
  View, Text, ScrollView, Alert, TouchableOpacity, Modal, TextInput,
  KeyboardAvoidingView, Platform, RefreshControl,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuthStore } from '../../src/stores/authStore';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { Button, Card } from '../../src/components/ui';
import { DeleteAccountButton } from '../../src/components/DeleteAccountButton';
import { useTheme, formatINR } from '../../src/theme';

type ThemeColors = ReturnType<typeof useTheme>['colors'];

interface AddressParts {
  billingAddressLine1?: string | null;
  billingAddressLine2?: string | null;
  billingCity?: string | null;
  billingState?: string | null;
  billingPincode?: string | null;
  shippingAddressLine1?: string | null;
  shippingAddressLine2?: string | null;
  shippingCity?: string | null;
  shippingState?: string | null;
  shippingPincode?: string | null;
}

interface CurrentPrice {
  cylinderTypeId: string;
  typeName: string;
  capacity: number;
  basePrice: number;
  discountPerUnit: number;
  customerPrice: number;
}

interface AccountData extends AddressParts {
  customerName: string;
  businessName: string | null;
  gstin: string | null;
  phone: string;
  email: string | null;
  creditPeriodDays: number;
  status: string;
  cylinderDiscounts: Array<{ cylinderTypeName: string; discountPerUnit: number }>;
  currentPrices: CurrentPrice[];
}

// Flatten the billing/shipping address parts into one readable line,
// skipping null/empty segments so the row never shows "undefined".
function flattenAddress(parts: Array<string | null | undefined>): string | undefined {
  const joined = parts.map((p) => (p ?? '').trim()).filter(Boolean).join(', ');
  return joined || undefined;
}

function InfoRow({ label, value, colors }: {
  label: string;
  value: string | null | undefined;
  colors: ThemeColors;
}) {
  return (
    <View style={{
      flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10,
      borderBottomWidth: 1, borderBottomColor: colors.divider,
    }}>
      <Text style={{ fontSize: 14, color: colors.textSecondary, flex: 1 }}>{label}</Text>
      <Text style={{ fontSize: 14, fontWeight: '500', color: colors.text, flex: 1.5, textAlign: 'right' }}>
        {value || '—'}
      </Text>
    </View>
  );
}

export default function CustomerAccountScreen() {
  const { dark, colors, accent } = useTheme();
  const router = useRouter();
  const { user, logout } = useAuthStore();

  const { data, isLoading, refetch: refetchAccount } = useApiQuery<AccountData>(
    ['customer-account'],
    '/customer-portal/account',
  );

  // Edit profile state
  const [showEdit, setShowEdit] = useState(false);
  const [editPhone, setEditPhone] = useState('');
  const [editShippingAddress, setEditShippingAddress] = useState('');

  const updateProfile = useApiMutation<AccountData, { phone: string; shippingAddressLine1: string }>(
    'put',
    '/customer-portal/account',
    {
      invalidateKeys: [['customer-account']],
      successMessage: 'Profile updated successfully!',
      onSuccess: () => setShowEdit(false),
    },
  );

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to log out?', [
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

  const openEditModal = () => {
    setEditPhone(data?.phone ?? '');
    setEditShippingAddress(data?.shippingAddressLine1 ?? '');
    setShowEdit(true);
  };

  const handleSaveProfile = () => {
    // PUT /customer-portal/account accepts phone + shipping* fields only
    // (billing is not customer-editable via the portal). Map the single
    // shipping textarea to shippingAddressLine1.
    updateProfile.mutate({
      phone: editPhone,
      shippingAddressLine1: editShippingAddress,
    });
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 16 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetchAccount} />}
      >
        {/* User info */}
        <Card>
          <View style={{ alignItems: 'center', paddingVertical: 8 }}>
            <View style={{
              width: 64, height: 64, borderRadius: 32,
              backgroundColor: dark ? 'rgba(220, 38, 38, 0.15)' : '#fef2f2',
              alignItems: 'center', justifyContent: 'center', marginBottom: 8,
            }}>
              <Text style={{ fontSize: 28, fontWeight: '700', color: accent.red }}>
                {user?.firstName?.[0]?.toUpperCase() || 'U'}
              </Text>
            </View>
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>
              {user?.firstName} {user?.lastName}
            </Text>
            <Text style={{ fontSize: 14, color: colors.textSecondary }}>{user?.email}</Text>
          </View>
        </Card>

        {/* Business details */}
        <Card>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>Business Details</Text>
            <TouchableOpacity onPress={openEditModal} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="create-outline" size={20} color={accent.blue} />
            </TouchableOpacity>
          </View>
          <InfoRow label="Name" value={data?.customerName} colors={colors} />
          <InfoRow label="Business" value={data?.businessName} colors={colors} />
          <InfoRow label="GSTIN" value={data?.gstin} colors={colors} />
          <InfoRow label="Phone" value={data?.phone} colors={colors} />
          <InfoRow label="Email" value={data?.email} colors={colors} />
          <InfoRow
            label="Billing Address"
            colors={colors}
            value={flattenAddress([
              data?.billingAddressLine1, data?.billingAddressLine2,
              data?.billingCity, data?.billingState, data?.billingPincode,
            ])}
          />
          <InfoRow
            label="Shipping Address"
            colors={colors}
            value={flattenAddress([
              data?.shippingAddressLine1, data?.shippingAddressLine2,
              data?.shippingCity, data?.shippingState, data?.shippingPincode,
            ])}
          />
          <InfoRow label="Credit Period" value={data?.creditPeriodDays ? `${data.creditPeriodDays} days` : undefined} colors={colors} />
          <InfoRow label="Status" value={data?.status?.toUpperCase()} colors={colors} />
        </Card>

        {/* My Discounts — always shown so the customer sees their terms (or
            that none apply). */}
        <Card>
          <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: 8 }}>
            My Discounts
          </Text>
          {data?.cylinderDiscounts && data.cylinderDiscounts.length > 0 ? (
            data.cylinderDiscounts.map((d, i) => (
              <InfoRow key={i} label={d.cylinderTypeName} value={`${formatINR(d.discountPerUnit)}/unit`} colors={colors} />
            ))
          ) : (
            <Text style={{ fontSize: 13, color: colors.textMuted }}>No discounts applied</Text>
          )}
        </Card>

        {/* Current Prices — live distributor catalog, net of my discount */}
        {data?.currentPrices && data.currentPrices.length > 0 && (
          <Card>
            <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: 8 }}>
              Current Prices
            </Text>
            {data.currentPrices.map((p) => (
              <View
                key={p.cylinderTypeId}
                style={{
                  flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                  paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.divider,
                }}
              >
                <Text style={{ fontSize: 14, color: colors.textSecondary, flex: 1 }}>{p.typeName}</Text>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>
                    {formatINR(p.customerPrice)}/unit
                  </Text>
                  {p.discountPerUnit > 0 && (
                    <Text style={{ fontSize: 11, color: colors.textMuted }}>
                      {formatINR(p.basePrice)} − {formatINR(p.discountPerUnit)} disc.
                    </Text>
                  )}
                </View>
              </View>
            ))}
          </Card>
        )}

        {/* Logout */}
        <Button title="Sign Out" variant="danger" onPress={handleLogout} style={{ marginTop: 8 }} />
        <DeleteAccountButton />
      </ScrollView>

      {/* Edit Profile Modal */}
      <Modal visible={showEdit} animationType="slide" transparent presentationStyle="overFullScreen" statusBarTranslucent>
        <SafeAreaProvider>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}>
            <View style={{
              backgroundColor: dark ? colors.cardBg : colors.bg,
              borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: '80%',
            }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 16 }}>
                Edit Profile
              </Text>

              <ScrollView style={{ maxHeight: 400 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 6 }}>
                  Phone Number
                </Text>
                <TextInput
                  value={editPhone}
                  onChangeText={setEditPhone}
                  keyboardType="phone-pad"
                  placeholder="Phone number"
                  placeholderTextColor={colors.textMuted}
                  style={{
                    backgroundColor: colors.inputBg, borderWidth: 1, borderColor: colors.inputBorder,
                    borderRadius: 10, padding: 12, fontSize: 15, color: colors.text, marginBottom: 16,
                  }}
                />

                {/* Billing address is not customer-editable via the portal
                    (PUT /customer-portal/account accepts shipping* only). */}
                <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 6 }}>
                  Shipping Address
                </Text>
                <TextInput
                  value={editShippingAddress}
                  onChangeText={setEditShippingAddress}
                  multiline
                  numberOfLines={3}
                  placeholder="Shipping address"
                  placeholderTextColor={colors.textMuted}
                  style={{
                    backgroundColor: colors.inputBg, borderWidth: 1, borderColor: colors.inputBorder,
                    borderRadius: 10, padding: 12, fontSize: 15, color: colors.text, marginBottom: 16,
                    textAlignVertical: 'top', minHeight: 80,
                  }}
                />
              </ScrollView>

              <View style={{ flexDirection: 'row', gap: 12, marginTop: 16 }}>
                <View style={{ flex: 1 }}>
                  <Button title="Cancel" variant="secondary" onPress={() => setShowEdit(false)} />
                </View>
                <View style={{ flex: 1 }}>
                  <Button title="Save" loading={updateProfile.isPending} onPress={handleSaveProfile} />
                </View>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
        </SafeAreaProvider>
      </Modal>
    </SafeAreaView>
  );
}
