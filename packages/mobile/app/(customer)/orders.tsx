import { useState } from 'react';
import {
  View, Text, ScrollView, RefreshControl, TouchableOpacity, Alert, Modal,
  TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { Button, Badge, EmptyState } from '../../src/components/ui';
import { useTheme, formatINR, formatDate } from '../../src/theme';
import type { Order } from '@gaslink/shared';

interface CylinderType {
  id: string;
  typeName: string;
  capacity: number;
  latestPrice?: number;
}

export default function CustomerOrdersScreen() {
  const { dark, colors, accent } = useTheme();

  const [showForm, setShowForm] = useState(false);
  const [orderItems, setOrderItems] = useState<Record<string, number>>({});

  // Modify order state
  const [modifyOrder, setModifyOrder] = useState<Order | null>(null);
  const [modifyItems, setModifyItems] = useState<Record<string, number>>({});

  const { data: ordersResponse, isLoading, refetch } = useApiQuery<{ orders: Order[] }>(
    ['customer-orders'],
    '/customer-portal/orders',
  );
  const orders: Order[] = ordersResponse?.orders ?? [];

  const { data: dashboard } = useApiQuery<any>(
    ['customer-dashboard'],
    '/customer-portal/dashboard',
  );

  const cylinderTypes: CylinderType[] = dashboard?.cylinderTypes || [];

  const createOrder = useApiMutation<Order>('post', '/customer-portal/orders', {
    invalidateKeys: [['customer-orders'], ['customer-dashboard']],
    successMessage: 'Order placed successfully!',
    onSuccess: () => {
      setShowForm(false);
      setOrderItems({});
    },
  });

  const updateOrder = useApiMutation<Order, { orderId: string; items: Array<{ cylinderTypeId: string; quantity: number }> }>(
    'patch',
    (vars) => `/customer-portal/orders/${vars.orderId}`,
    {
      invalidateKeys: [['customer-orders'], ['customer-dashboard']],
      successMessage: 'Order updated successfully!',
      onSuccess: () => {
        setModifyOrder(null);
        setModifyItems({});
      },
    },
  );

  const cancelOrder = useApiMutation<Order, { orderId: string }>(
    'patch',
    (vars) => `/customer-portal/orders/${vars.orderId}/cancel`,
    {
      invalidateKeys: [['customer-orders'], ['customer-dashboard']],
      successMessage: 'Order cancelled.',
    },
  );

  const statusColor = (status: string) => {
    switch (status) {
      case 'delivered': case 'modified_delivered': return 'success' as const;
      case 'cancelled': return 'danger' as const;
      case 'pending_delivery': return 'warning' as const;
      default: return 'info' as const;
    }
  };

  const isPending = (status: string) =>
    ['pending', 'pending_delivery', 'confirmed'].includes(status);

  const updateQuantity = (
    setter: React.Dispatch<React.SetStateAction<Record<string, number>>>,
    cylId: string,
    delta: number,
  ) => {
    setter((prev) => {
      const current = prev[cylId] || 0;
      const next = Math.max(0, current + delta);
      if (next === 0) {
        const { [cylId]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [cylId]: next };
    });
  };

  const handlePlaceOrder = () => {
    const items = Object.entries(orderItems)
      .filter(([, qty]) => qty > 0)
      .map(([cylinderTypeId, quantity]) => ({ cylinderTypeId, quantity }));

    if (items.length === 0) {
      Alert.alert('No items', 'Please select at least one cylinder type.');
      return;
    }

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const deliveryDate = tomorrow.toISOString().split('T')[0];

    createOrder.mutate({ deliveryDate, items });
  };

  const handleModifyOrder = () => {
    if (!modifyOrder) return;
    const items = Object.entries(modifyItems)
      .filter(([, qty]) => qty > 0)
      .map(([cylinderTypeId, quantity]) => ({ cylinderTypeId, quantity }));

    if (items.length === 0) {
      Alert.alert('No items', 'Please select at least one cylinder type.');
      return;
    }

    updateOrder.mutate({ orderId: modifyOrder.orderId, items });
  };

  const handleCancelOrder = (order: Order) => {
    Alert.alert('Cancel Order', `Are you sure you want to cancel ${order.orderNumber}?`, [
      { text: 'No', style: 'cancel' },
      {
        text: 'Yes, Cancel',
        style: 'destructive',
        onPress: () => cancelOrder.mutate({ orderId: order.orderId }),
      },
    ]);
  };

  const openModifyModal = (order: Order) => {
    const itemMap: Record<string, number> = {};
    order.items?.forEach((item) => {
      if (item.cylinderTypeId) itemMap[item.cylinderTypeId] = item.quantity;
    });
    setModifyItems(itemMap);
    setModifyOrder(order);
  };

  const renderQuantityPicker = (
    items: Record<string, number>,
    setter: React.Dispatch<React.SetStateAction<Record<string, number>>>,
  ) => (
    <ScrollView style={{ maxHeight: 300 }}>
      {cylinderTypes.length === 0 ? (
        <Text style={{ color: colors.textMuted, textAlign: 'center', paddingVertical: 24 }}>
          No cylinder types available. Contact your distributor.
        </Text>
      ) : (
        cylinderTypes.map((ct) => (
          <View
            key={ct.id}
            style={{
              flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
              paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.divider,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '600', fontSize: 15, color: colors.text }}>{ct.typeName}</Text>
              {ct.latestPrice != null && (
                <Text style={{ fontSize: 13, color: colors.textSecondary }}>
                  {formatINR(ct.latestPrice)} / unit
                </Text>
              )}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <TouchableOpacity
                onPress={() => updateQuantity(setter, ct.id, -1)}
                style={{
                  width: 36, height: 36, borderRadius: 18,
                  backgroundColor: colors.inputBg, alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Ionicons name="remove" size={20} color={colors.textSecondary} />
              </TouchableOpacity>
              <Text style={{ fontSize: 18, fontWeight: '700', width: 30, textAlign: 'center', color: colors.text }}>
                {items[ct.id] || 0}
              </Text>
              <TouchableOpacity
                onPress={() => updateQuantity(setter, ct.id, 1)}
                style={{
                  width: 36, height: 36, borderRadius: 18,
                  backgroundColor: accent.blue, alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Ionicons name="add" size={20} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>
        ))
      )}
    </ScrollView>
  );

  const totalSelected = (items: Record<string, number>) =>
    Object.values(items).reduce((a, b) => a + b, 0);

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 }}>
        <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>My Orders</Text>
        <Button title="+ New Order" size="sm" onPress={() => setShowForm(true)} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingTop: 0, gap: 10 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
      >
        {(!orders || orders.length === 0) ? (
          <EmptyState title="No orders yet" description="Place your first order to get started" />
        ) : (
          orders.map((order) => (
            <View
              key={order.orderId}
              style={{
                backgroundColor: colors.cardBg, borderRadius: 14, padding: 16,
                borderWidth: 1, borderColor: colors.cardBorder,
              }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>
                    {order.orderNumber}
                  </Text>
                  <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 4 }}>
                    Delivery: {formatDate(order.deliveryDate)}
                  </Text>
                </View>
                <Badge
                  label={(order.status || '').replace(/_/g, ' ')}
                  variant={statusColor(order.status || '')}
                />
              </View>

              {(order.items?.length ?? 0) > 0 && (
                <View style={{ marginTop: 10, gap: 4 }}>
                  {order.items.map((item, i) => {
                    // For delivered/modified orders show the DELIVERED quantity
                    // (what the customer actually received), not the ordered qty.
                    const delivered = ['delivered', 'modified_delivered'].includes(order.status || '');
                    const qty = delivered ? (item.deliveredQuantity ?? item.quantity) : item.quantity;
                    return (
                      <View key={i}>
                        <Text style={{ fontSize: 13, color: colors.textSecondary }}>
                          {item.cylinderTypeName} x {qty} @ {formatINR(item.unitPrice)}
                        </Text>
                        {delivered && (item.emptiesCollected ?? 0) > 0 && (
                          <Text style={{ fontSize: 12, color: colors.textMuted }}>
                            Empties collected: {item.emptiesCollected}
                          </Text>
                        )}
                      </View>
                    );
                  })}
                </View>
              )}

              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                {isPending(order.status || '') && (
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TouchableOpacity
                      onPress={() => openModifyModal(order)}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 4,
                        paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
                        backgroundColor: dark ? 'rgba(59, 130, 246, 0.15)' : '#eff6ff',
                      }}
                    >
                      <Ionicons name="create-outline" size={14} color={accent.blue} />
                      <Text style={{ fontSize: 12, fontWeight: '600', color: accent.blue }}>Modify</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => handleCancelOrder(order)}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 4,
                        paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
                        backgroundColor: dark ? 'rgba(220, 38, 38, 0.15)' : '#fef2f2',
                      }}
                    >
                      <Ionicons name="close-circle-outline" size={14} color={accent.red} />
                      <Text style={{ fontSize: 12, fontWeight: '600', color: accent.red }}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                )}
                <View style={{ flex: 1, alignItems: 'flex-end' }}>
                  <Text style={{ fontWeight: '700', fontSize: 16, color: colors.text }}>
                    {formatINR(order.totalAmount)}
                  </Text>
                </View>
              </View>
            </View>
          ))
        )}
      </ScrollView>

      {/* New Order Modal */}
      <Modal visible={showForm} animationType="slide" transparent presentationStyle="overFullScreen" statusBarTranslucent>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}>
            <View style={{
              backgroundColor: dark ? colors.cardBg : colors.bg,
              borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: '80%',
            }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 4 }}>
                New Order
              </Text>
              <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 16 }}>
                Select quantity for each cylinder type. Delivery will be scheduled for tomorrow.
              </Text>

              {renderQuantityPicker(orderItems, setOrderItems)}

              {totalSelected(orderItems) > 0 && (
                <View style={{
                  marginTop: 12, padding: 12, borderRadius: 10,
                  backgroundColor: dark ? 'rgba(59, 130, 246, 0.15)' : '#eff6ff',
                }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: accent.blue }}>
                    {totalSelected(orderItems)} cylinders selected
                  </Text>
                </View>
              )}

              <View style={{ flexDirection: 'row', gap: 12, marginTop: 16 }}>
                <View style={{ flex: 1 }}>
                  <Button
                    title="Cancel"
                    variant="secondary"
                    onPress={() => { setShowForm(false); setOrderItems({}); }}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    title="Place Order"
                    loading={createOrder.isPending}
                    disabled={totalSelected(orderItems) === 0}
                    onPress={handlePlaceOrder}
                  />
                </View>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Modify Order Modal */}
      <Modal visible={!!modifyOrder} animationType="slide" transparent presentationStyle="overFullScreen" statusBarTranslucent>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}>
            <View style={{
              backgroundColor: dark ? colors.cardBg : colors.bg,
              borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: '80%',
            }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 4 }}>
                Modify Order
              </Text>
              <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 16 }}>
                Update quantities for {modifyOrder?.orderNumber}
              </Text>

              {renderQuantityPicker(modifyItems, setModifyItems)}

              {totalSelected(modifyItems) > 0 && (
                <View style={{
                  marginTop: 12, padding: 12, borderRadius: 10,
                  backgroundColor: dark ? 'rgba(59, 130, 246, 0.15)' : '#eff6ff',
                }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: accent.blue }}>
                    {totalSelected(modifyItems)} cylinders selected
                  </Text>
                </View>
              )}

              <View style={{ flexDirection: 'row', gap: 12, marginTop: 16 }}>
                <View style={{ flex: 1 }}>
                  <Button
                    title="Cancel"
                    variant="secondary"
                    onPress={() => { setModifyOrder(null); setModifyItems({}); }}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    title="Update Order"
                    loading={updateOrder.isPending}
                    disabled={totalSelected(modifyItems) === 0}
                    onPress={handleModifyOrder}
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
