import { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { getTabBarConfig } from '../../src/theme';
import { useIsDark } from '../../src/stores/themeStore';
import { AppHeader } from '../../src/components/AppHeader';
import { attachAutoSync, startNetworkListener, subscribePendingDeliveries } from '../../src/services/deliveryQueue';
import { connect as sseConnect, disconnect as sseDisconnect, onEvent as sseOnEvent } from '../../src/services/sseService';
import { tokenStorage } from '../../src/lib/api';

function PendingBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <View style={{
      position: 'absolute', top: -4, right: -10,
      minWidth: 16, height: 16, borderRadius: 8,
      backgroundColor: '#f59e0b',
      alignItems: 'center', justifyContent: 'center',
      paddingHorizontal: 4,
    }}>
      <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>{count > 9 ? '9+' : count}</Text>
    </View>
  );
}

export default function DriverLayout() {
  const dark = useIsDark();
  const queryClient = useQueryClient();
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    attachAutoSync();
    const unsubQueue = subscribePendingDeliveries((q) => setPendingCount(q.length));
    const unsubNet = startNetworkListener();

    // SSE — replaces the 30s polls in (driver)/orders.tsx and (driver)/trip.tsx
    // (see PENDING_ITEMS.md "Push Notifications" for context). The server
    // pushes a tiny `{type:'order_assigned'|'order_updated'|'trip_updated'}`
    // signal and we invalidate the relevant TanStack keys so the affected
    // screen refetches once. notifyDriver is fire-and-forget; if the socket
    // is down the screens still have their 5-minute fallback poll.
    let connected = false;
    tokenStorage
      .getAccessToken()
      .then((tok) => {
        if (!tok) return;
        sseConnect(tok);
        connected = true;
      })
      .catch(() => {
        // No token means the driver isn't authenticated yet; the layout
        // unmounts when they bounce to /(auth)/login anyway.
      });

    const unsubSse = sseOnEvent((evt) => {
      switch (evt.type) {
        case 'order_assigned':
        case 'order_updated':
          queryClient.invalidateQueries({ queryKey: ['driver-orders'] });
          break;
        case 'trip_updated':
          queryClient.invalidateQueries({ queryKey: ['driver-active-trip'] });
          queryClient.invalidateQueries({ queryKey: ['driver-trip-stock'] });
          queryClient.invalidateQueries({ queryKey: ['driver-trip-ewbs'] });
          queryClient.invalidateQueries({ queryKey: ['driver-orders'] });
          break;
        case 'connected':
          // Handshake — no UI action needed.
          break;
        default:
          // Unknown event type — ignore. Server can add new types without
          // a mobile rebuild and the client will just no-op.
          break;
      }
    });

    return () => {
      unsubQueue();
      unsubNet();
      unsubSse();
      if (connected) sseDisconnect();
    };
  }, [queryClient]);

  return (
    <Tabs screenOptions={{
      ...getTabBarConfig(dark),
      headerTitle: () => <AppHeader />,
      headerTitleAlign: 'center',
    }}>
      <Tabs.Screen name="analytics" options={{
        title: 'Analytics',
        tabBarIcon: ({ focused, color }) => (
          <Ionicons name={focused ? 'bar-chart' : 'bar-chart-outline'} size={22} color={color} />
        ),
      }} />
      <Tabs.Screen name="orders" options={{
        title: 'My Deliveries',
        tabBarIcon: ({ focused, color }) => (
          <View>
            <Ionicons name={focused ? 'receipt' : 'receipt-outline'} size={22} color={color} />
            <PendingBadge count={pendingCount} />
          </View>
        ),
      }} />
      <Tabs.Screen name="trip" options={{
        title: 'Trip',
        tabBarIcon: ({ focused, color }) => (
          <Ionicons name={focused ? 'navigate' : 'navigate-outline'} size={22} color={color} />
        ),
      }} />
      <Tabs.Screen name="inventory" options={{
        title: 'Vehicle Stock',
        tabBarIcon: ({ focused, color }) => (
          <Ionicons name={focused ? 'cube' : 'cube-outline'} size={22} color={color} />
        ),
      }} />
      <Tabs.Screen name="more" options={{
        title: 'More',
        tabBarIcon: ({ focused, color }) => (
          <Ionicons name={focused ? 'grid' : 'grid-outline'} size={22} color={color} />
        ),
      }} />
      {/* Profile is accessed from More menu, hide from tabs */}
      <Tabs.Screen name="profile" options={{ href: null }} />
    </Tabs>
  );
}
