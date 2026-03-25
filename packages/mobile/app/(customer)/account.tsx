import { useState } from 'react';
import {
  View, Text, ScrollView, Alert, TouchableOpacity, Modal, TextInput,
  KeyboardAvoidingView, Platform, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuthStore } from '../../src/stores/authStore';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { Button, Card, EmptyState } from '../../src/components/ui';
import { useTheme, formatINR } from '../../src/theme';

interface AccountData {
  customerName: string;
  businessName: string | null;
  gstin: string | null;
  phone: string;
  email: string | null;
  billingAddress: string | null;
  shippingAddress: string | null;
  creditPeriodDays: number;
  status: string;
  cylinderDiscounts: Array<{ cylinderTypeName: string; discountPerUnit: number }>;
}

interface DeliveredOrder {
  orderId: string;
  orderNumber: string;
  deliveryDate: string;
  totalAmount: number;
  status: string;
}

export default function CustomerAccountScreen() {
  const { dark, colors, accent } = useTheme();
  const router = useRouter();
  const { user, logout } = useAuthStore();

  const { data, refetch: refetchAccount } = useApiQuery<AccountData>(
    ['customer-account'],
    '/customer-portal/account',
  );

  const { data: deliveredOrders, isLoading: loadingDeliveries, refetch: refetchDeliveries } = useApiQuery<DeliveredOrder[]>(
    ['recent-deliveries'],
    '/customer-portal/orders',
    { status: 'delivered' },
  );

  // Edit profile state
  const [showEdit, setShowEdit] = useState(false);
  const [editPhone, setEditPhone] = useState('');
  const [editBillingAddress, setEditBillingAddress] = useState('');
  const [editShippingAddress, setEditShippingAddress] = useState('');

  // Dispute state
  const [showDispute, setShowDispute] = useState(false);
  const [disputeOrderId, setDisputeOrderId] = useState<string | null>(null);
  const [disputeReason, setDisputeReason] = useState('');

  const updateProfile = useApiMutation<AccountData, { phone: string; billingAddress: string; shippingAddress: string }>(
    'patch',
    '/customer-portal/account',
    {
      invalidateKeys: [['customer-account']],
      successMessage: 'Profile updated successfully!',
      onSuccess: () => setShowEdit(false),
    },
  );

  const confirmDelivery = useApiMutation<any, { orderId: string }>(
    'post',
    (vars) => `/customer-portal/orders/${vars.orderId}/confirm-delivery`,
    {
      invalidateKeys: [['recent-deliveries'], ['customer-orders']],
      successMessage: 'Delivery confirmed!',
    },
  );

  const disputeDelivery = useApiMutation<any, { orderId: string; reason: string }>(
    'post',
    (vars) => `/customer-portal/orders/${vars.orderId}/dispute`,
    {
      invalidateKeys: [['recent-deliveries'], ['customer-orders']],
      successMessage: 'Dispute submitted.',
      onSuccess: () => {
        setShowDispute(false);
        setDisputeOrderId(null);
        setDisputeReason('');
      },
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
    setEditBillingAddress(data?.billingAddress ?? '');
    setEditShippingAddress(data?.shippingAddress ?? '');
    setShowEdit(true);
  };

  const handleSaveProfile = () => {
    updateProfile.mutate({
      phone: editPhone,
      billingAddress: editBillingAddress,
      shippingAddress: editShippingAddress,
    });
  };

  const handleConfirmDelivery = (orderId: string, orderNumber: string) => {
    Alert.alert('Confirm Delivery', `Confirm delivery for ${orderNumber}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Confirm', onPress: () => confirmDelivery.mutate({ orderId }) },
    ]);
  };

  const openDisputeModal = (orderId: string) => {
    setDisputeOrderId(orderId);
    setDisputeReason('');
    setShowDispute(true);
  };

  const handleSubmitDispute = () => {
    if (!disputeOrderId) return;
    if (!disputeReason.trim()) {
      Alert.alert('Required', 'Please enter a reason for the dispute.');
      return;
    }
    disputeDelivery.mutate({ orderId: disputeOrderId, reason: disputeReason.trim() });
  };

  const InfoRow = ({ label, value }: { label: string; value: string | null | undefined }) => (
    <View style={{
      flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10,
      borderBottomWidth: 1, borderBottomColor: colors.divider,
    }}>
      <Text style={{ fontSize: 14, color: colors.textSecondary, flex: 1 }}>{label}</Text>
      <Text style={{ fontSize: 14, fontWeight: '500', color: colors.text, flex: 1.5, textAlign: 'right' }}>
        {value || '\u2014'}
      </Text>
    </View>
  );

  const isRefreshing = loadingDeliveries;

  const handleRefresh = () => {
    refetchAccount();
    refetchDeliveries();
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 16 }}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />}
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
          <InfoRow label="Name" value={data?.customerName} />
          <InfoRow label="Business" value={data?.businessName} />
          <InfoRow label="GSTIN" value={data?.gstin} />
          <InfoRow label="Phone" value={data?.phone} />
          <InfoRow label="Email" value={data?.email} />
          <InfoRow label="Billing Address" value={data?.billingAddress} />
          <InfoRow label="Shipping Address" value={data?.shippingAddress} />
          <InfoRow label="Credit Period" value={data?.creditPeriodDays ? `${data.creditPeriodDays} days` : undefined} />
          <InfoRow label="Status" value={data?.status?.toUpperCase()} />
        </Card>

        {/* Cylinder Discounts */}
        {data?.cylinderDiscounts && data.cylinderDiscounts.length > 0 && (
          <Card>
            <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: 8 }}>
              Your Cylinder Discounts
            </Text>
            {data.cylinderDiscounts.map((d, i) => (
              <InfoRow key={i} label={d.cylinderTypeName} value={`${formatINR(d.discountPerUnit)}/unit`} />
            ))}
          </Card>
        )}

        {/* Delivery Confirmation / Dispute */}
        <Card>
          <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: 12 }}>
            Recent Deliveries
          </Text>
          {(!deliveredOrders || deliveredOrders.length === 0) ? (
            <Text style={{ color: colors.textMuted, textAlign: 'center', paddingVertical: 16 }}>
              No recent deliveries to confirm
            </Text>
          ) : (
            deliveredOrders.map((order) => (
              <View
                key={order.orderId}
                style={{
                  paddingVertical: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.divider,
                }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontWeight: '600', fontSize: 14, color: colors.text }}>
                      {order.orderNumber}
                    </Text>
                    <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                      {order.deliveryDate} {'\u00B7'} {formatINR(order.totalAmount)}
                    </Text>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                  <TouchableOpacity
                    onPress={() => handleConfirmDelivery(order.orderId, order.orderNumber)}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 4,
                      paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8,
                      backgroundColor: dark ? 'rgba(16, 185, 129, 0.15)' : '#ecfdf5',
                    }}
                  >
                    <Ionicons name="checkmark-circle-outline" size={16} color={accent.green} />
                    <Text style={{ fontSize: 13, fontWeight: '600', color: accent.green }}>Confirm</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => openDisputeModal(order.orderId)}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 4,
                      paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8,
                      backgroundColor: dark ? 'rgba(220, 38, 38, 0.15)' : '#fef2f2',
                    }}
                  >
                    <Ionicons name="alert-circle-outline" size={16} color={accent.red} />
                    <Text style={{ fontSize: 13, fontWeight: '600', color: accent.red }}>Dispute</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))
          )}
        </Card>

        {/* Logout */}
        <Button title="Sign Out" variant="danger" onPress={handleLogout} style={{ marginTop: 8 }} />
      </ScrollView>

      {/* Edit Profile Modal */}
      <Modal visible={showEdit} animationType="slide" transparent>
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

                <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 6 }}>
                  Billing Address
                </Text>
                <TextInput
                  value={editBillingAddress}
                  onChangeText={setEditBillingAddress}
                  multiline
                  numberOfLines={3}
                  placeholder="Billing address"
                  placeholderTextColor={colors.textMuted}
                  style={{
                    backgroundColor: colors.inputBg, borderWidth: 1, borderColor: colors.inputBorder,
                    borderRadius: 10, padding: 12, fontSize: 15, color: colors.text, marginBottom: 16,
                    textAlignVertical: 'top', minHeight: 80,
                  }}
                />

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
      </Modal>

      {/* Dispute Modal */}
      <Modal visible={showDispute} animationType="slide" transparent>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}>
            <View style={{
              backgroundColor: dark ? colors.cardBg : colors.bg,
              borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24,
            }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 4 }}>
                Dispute Delivery
              </Text>
              <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 16 }}>
                Please describe the issue with this delivery.
              </Text>

              <TextInput
                value={disputeReason}
                onChangeText={setDisputeReason}
                multiline
                numberOfLines={4}
                placeholder="Reason for dispute..."
                placeholderTextColor={colors.textMuted}
                style={{
                  backgroundColor: colors.inputBg, borderWidth: 1, borderColor: colors.inputBorder,
                  borderRadius: 10, padding: 12, fontSize: 15, color: colors.text,
                  textAlignVertical: 'top', minHeight: 100,
                }}
              />

              <View style={{ flexDirection: 'row', gap: 12, marginTop: 16 }}>
                <View style={{ flex: 1 }}>
                  <Button
                    title="Cancel"
                    variant="secondary"
                    onPress={() => { setShowDispute(false); setDisputeOrderId(null); setDisputeReason(''); }}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    title="Submit Dispute"
                    variant="danger"
                    loading={disputeDelivery.isPending}
                    disabled={!disputeReason.trim()}
                    onPress={handleSubmitDispute}
                  />
                </View>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}
