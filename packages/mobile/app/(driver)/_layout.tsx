import { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { getTabBarConfig } from '../../src/theme';
import { useIsDark } from '../../src/stores/themeStore';
import { attachAutoSync, startNetworkListener, subscribePendingDeliveries } from '../../src/services/deliveryQueue';

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
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    attachAutoSync();
    const unsubQueue = subscribePendingDeliveries((q) => setPendingCount(q.length));
    const unsubNet = startNetworkListener();
    return () => { unsubQueue(); unsubNet(); };
  }, []);

  return (
    <Tabs screenOptions={getTabBarConfig(dark)}>
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
