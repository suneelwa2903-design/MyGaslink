import { useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, Alert, Modal, TextInput, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApiQuery, useApiMutation } from '../../src/hooks/useApi';
import { Button, Badge, EmptyState } from '../../src/components/ui';
import { DeliveryProofCamera } from '../../src/components/DeliveryProofCamera';
import { useTheme, ACCENT, formatINR } from '../../src/theme';
import type { Order } from '@gaslink/shared';

export default function DriverOrdersScreen() {
  const { dark, colors } = useTheme();
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [deliveryNotes, setDeliveryNotes] = useState('');
  const [showCamera, setShowCamera] = useState(false);
  const [proofPhoto, setProofPhoto] = useState<string | null>(null);

  const { data: orders, isLoading, refetch } = useApiQuery<Order[]>(
    ['driver-orders'],
    '/orders',
    { status: 'pending_delivery' },
  );

  const confirmDelivery = useApiMutation<Order, { orderId: string; items: unknown[] }>('post',
    (vars) => `/orders/${vars.orderId}/deliver`,
    {
      invalidateKeys: [['driver-orders']],
      successMessage: 'Delivery confirmed!',
      onSuccess: () => setSelectedOrder(null),
    },
  );

  const statusColor = (status: string) => {
    switch (status) {
      case 'pending_delivery': return 'warning' as const;
      case 'pending_dispatch': return 'info' as const;
      case 'delivered': return 'success' as const;
      default: return 'neutral' as const;
    }
  };

  const handleDelivery = (order: Order) => {
    Alert.alert(
      'Confirm Delivery',
      `Mark order ${order.orderNumber} as delivered?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm', onPress: () => {
            confirmDelivery.mutate({
              orderId: order.orderId,
              items: (order.items ?? []).map((item) => ({
                cylinderTypeId: item.cylinderTypeId,
                deliveredQuantity: item.quantity,
                emptiesCollected: 0,
              })),
            });
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 10 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>
            {orders?.length ?? 0} deliveries pending
          </Text>
        </View>

        {(!orders || orders.length === 0) ? (
          <EmptyState title="No pending deliveries" description="You're all caught up! Check back later." />
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
                  <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>{order.orderNumber}</Text>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: ACCENT.blue, marginTop: 2 }}>
                    {order.customerName}
                  </Text>
                </View>
                <Badge label={(order.status || '').replace(/_/g, ' ')} variant={statusColor(order.status || '')} />
              </View>

              <View style={{ marginTop: 10, gap: 4 }}>
                {order.items?.map((item, i) => (
                  <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 13, color: colors.textSecondary }}>{item.cylinderTypeName}</Text>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>x {item.quantity}</Text>
                  </View>
                ))}
              </View>

              {order.specialInstructions && (
                <View style={{
                  marginTop: 8,
                  backgroundColor: dark ? 'rgba(245,158,11,0.12)' : '#fffbeb',
                  padding: 8,
                  borderRadius: 8,
                }}>
                  <Text style={{ fontSize: 12, color: dark ? '#fbbf24' : '#92400e' }}>
                    Note: {order.specialInstructions}
                  </Text>
                </View>
              )}

              <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                <View style={{ flex: 1 }}>
                  <Button title="View Details" variant="secondary" size="sm" onPress={() => setSelectedOrder(order)} />
                </View>
                {order.status === 'pending_delivery' && (
                  <View style={{ flex: 1 }}>
                    <Button title="Deliver" variant="accent" size="sm" onPress={() => handleDelivery(order)} />
                  </View>
                )}
              </View>
            </View>
          ))
        )}
      </ScrollView>

      {/* Delivery Detail Modal */}
      <Modal visible={!!selectedOrder} animationType="slide" transparent>
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <View style={{
            backgroundColor: colors.cardBg,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            padding: 24,
          }}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 16 }}>
              Order: {selectedOrder?.orderNumber}
            </Text>

            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.textSecondary }}>Customer</Text>
                <Text style={{ fontWeight: '600', color: colors.text }}>{selectedOrder?.customerName}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.textSecondary }}>Delivery Date</Text>
                <Text style={{ fontWeight: '600', color: colors.text }}>{selectedOrder?.deliveryDate}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.textSecondary }}>Total</Text>
                <Text style={{ fontWeight: '700', color: colors.text }}>
                  {formatINR(selectedOrder?.totalAmount)}
                </Text>
              </View>
            </View>

            <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text, marginTop: 16, marginBottom: 8 }}>Items</Text>
            {selectedOrder?.items?.map((item, i) => (
              <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}>
                <Text style={{ color: colors.textSecondary }}>{item.cylinderTypeName}</Text>
                <Text style={{ fontWeight: '600', color: colors.text }}>
                  Qty: {item.quantity} | {formatINR(item.unitPrice)}/unit
                </Text>
              </View>
            ))}

            {/* Delivery Proof Photo */}
            <View style={{ marginTop: 16 }}>
              <Text style={{ fontSize: 13, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>Delivery Proof Photo</Text>
              {proofPhoto ? (
                <View>
                  <Image source={{ uri: proofPhoto }} style={{ width: '100%', height: 180, borderRadius: 12 }} resizeMode="cover" />
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                    <Button title="Retake" variant="secondary" size="sm" onPress={() => setShowCamera(true)} style={{ flex: 1 }} />
                    <Button title="Remove" variant="ghost" size="sm" onPress={() => setProofPhoto(null)} style={{ flex: 1 }} />
                  </View>
                </View>
              ) : (
                <TouchableOpacity
                  onPress={() => setShowCamera(true)}
                  style={{
                    borderWidth: 2, borderColor: colors.cardBorder, borderStyle: 'dashed',
                    borderRadius: 12, padding: 24, alignItems: 'center',
                    backgroundColor: dark ? colors.inputBg : undefined,
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={{ fontSize: 32, marginBottom: 4 }}>📸</Text>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: ACCENT.blue }}>Take Photo</Text>
                  <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>Optional proof of delivery</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={{ marginTop: 12 }}>
              <Text style={{ fontSize: 13, fontWeight: '500', color: colors.textSecondary, marginBottom: 6 }}>Delivery Notes</Text>
              <TextInput
                value={deliveryNotes}
                onChangeText={setDeliveryNotes}
                placeholder="Optional delivery notes..."
                placeholderTextColor={colors.textMuted}
                multiline
                numberOfLines={3}
                style={{
                  borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 12,
                  padding: 12, fontSize: 14, textAlignVertical: 'top',
                  backgroundColor: colors.inputBg, color: colors.text,
                }}
              />
            </View>

            <View style={{ flexDirection: 'row', gap: 12, marginTop: 16 }}>
              <View style={{ flex: 1 }}>
                <Button title="Close" variant="secondary" onPress={() => { setSelectedOrder(null); setDeliveryNotes(''); setProofPhoto(null); }} />
              </View>
              {selectedOrder?.status === 'pending_delivery' && (
                <View style={{ flex: 1 }}>
                  <Button title="Confirm Delivery" variant="accent" onPress={() => {
                    if (selectedOrder) handleDelivery(selectedOrder);
                  }} />
                </View>
              )}
            </View>
          </View>
        </View>
      </Modal>

      {/* Camera Modal */}
      <DeliveryProofCamera
        visible={showCamera}
        onCapture={(uri) => { setProofPhoto(uri); setShowCamera(false); }}
        onClose={() => setShowCamera(false)}
      />
    </SafeAreaView>
  );
}
