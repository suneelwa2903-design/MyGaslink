import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { getTabBarConfig } from '../../src/theme';
import { useIsDark } from '../../src/stores/themeStore';

export default function DriverLayout() {
  const dark = useIsDark();

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
          <Ionicons name={focused ? 'receipt' : 'receipt-outline'} size={22} color={color} />
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
