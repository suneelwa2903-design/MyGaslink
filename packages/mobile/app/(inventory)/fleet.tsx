import { useState, useMemo } from 'react';
import { View, Text, FlatList, TouchableOpacity, RefreshControl, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { Card, Badge, EmptyState } from '../../src/components/ui';
import { useTheme } from '../../src/theme';

// ─── Types ──────────────────────────────────────────────────────────────────

interface DriverVehicle {
  driverId: string;
  driverName: string;
  phone?: string;
  vehicleId?: string;
  vehicleNumber?: string;
  vehicleType?: string;
  status: string;
  activeOrders?: number;
  lastActivity?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const FILTER_TABS = [
  { label: 'All', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Inactive', value: 'inactive' },
] as const;

// ─── Main Screen ────────────────────────────────────────────────────────────

export default function FleetScreen() {
  const { dark, colors, accent } = useTheme();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const { data: driversData, isLoading, refetch, isRefetching } = useApiQuery<DriverVehicle[] | { drivers: DriverVehicle[] }>(
    ['inv-fleet'],
    '/drivers-vehicles',
  );

  // Handle both array and object response shapes
  const drivers: DriverVehicle[] = useMemo(() => {
    if (!driversData) return [];
    if (Array.isArray(driversData)) return driversData;
    if ('drivers' in driversData && Array.isArray(driversData.drivers)) return driversData.drivers;
    return [];
  }, [driversData]);

  const filtered = useMemo(() => {
    let list = drivers;

    // Filter by status
    if (filter !== 'all') {
      list = list.filter((d) => d.status === filter);
    }

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((d) =>
        d.driverName?.toLowerCase().includes(q) ||
        d.vehicleNumber?.toLowerCase().includes(q) ||
        d.phone?.includes(q)
      );
    }

    return list;
  }, [drivers, filter, search]);

  const activeCount = drivers.filter((d) => d.status === 'active').length;
  const totalCount = drivers.length;

  const renderDriver = ({ item }: { item: DriverVehicle }) => {
    const isActive = item.status === 'active';

    return (
      <View style={{ marginHorizontal: 16, marginBottom: 10 }}>
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            {/* Avatar */}
            <View style={{
              width: 48, height: 48, borderRadius: 14,
              backgroundColor: isActive
                ? (dark ? 'rgba(16,185,129,0.12)' : '#ecfdf5')
                : (dark ? 'rgba(100,116,139,0.12)' : '#f1f5f9'),
              alignItems: 'center', justifyContent: 'center',
            }}>
              <Ionicons
                name="person"
                size={22}
                color={isActive ? accent.green : colors.textMuted}
              />
            </View>

            {/* Info */}
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }}>{item.driverName}</Text>
                <Badge label={isActive ? 'Active' : 'Inactive'} variant={isActive ? 'success' : 'neutral'} />
              </View>

              {item.vehicleNumber && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                  <Ionicons name="car-outline" size={14} color={colors.textSecondary} />
                  <Text style={{ fontSize: 13, color: colors.textSecondary }}>
                    {item.vehicleNumber}
                    {item.vehicleType ? ` (${item.vehicleType})` : ''}
                  </Text>
                </View>
              )}

              {item.phone && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                  <Ionicons name="call-outline" size={13} color={colors.textMuted} />
                  <Text style={{ fontSize: 12, color: colors.textMuted }}>{item.phone}</Text>
                </View>
              )}
            </View>

            {/* Right side stats */}
            <View style={{ alignItems: 'flex-end' }}>
              {(item.activeOrders ?? 0) > 0 && (
                <View style={{
                  backgroundColor: dark ? 'rgba(59,130,246,0.12)' : '#eff6ff',
                  borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3,
                }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: accent.blue }}>
                    {item.activeOrders} order{(item.activeOrders ?? 0) !== 1 ? 's' : ''}
                  </Text>
                </View>
              )}
              {item.lastActivity && (
                <Text style={{ fontSize: 10, color: colors.textMuted, marginTop: 4 }}>
                  {formatLastActivity(item.lastActivity)}
                </Text>
              )}
            </View>
          </View>
        </Card>
      </View>
    );
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Search */}
      <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 }}>
        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: 8,
          backgroundColor: colors.inputBg, borderRadius: 12, borderWidth: 1, borderColor: colors.inputBorder,
          paddingHorizontal: 12, height: 42,
        }}>
          <Ionicons name="search-outline" size={18} color={colors.textMuted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search drivers or vehicles..."
            placeholderTextColor={colors.textMuted}
            style={{ flex: 1, fontSize: 14, color: colors.text, padding: 0 }}
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')}>
              <Ionicons name="close-circle" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Filter Pills */}
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {FILTER_TABS.map((tab) => {
            const isActive = filter === tab.value;
            return (
              <TouchableOpacity
                key={tab.value}
                onPress={() => setFilter(tab.value)}
                style={{
                  height: 36,
                  paddingHorizontal: 16,
                  borderRadius: 18,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: isActive ? accent.red : (dark ? colors.inputBg : '#f1f5f9'),
                }}
              >
                <Text style={{
                  fontSize: 13, fontWeight: '600',
                  color: isActive ? '#fff' : colors.textSecondary,
                }}>
                  {tab.label}
                </Text>
              </TouchableOpacity>
            );
          })}

          {/* Counter */}
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'flex-end' }}>
            <Text style={{ fontSize: 12, color: colors.textMuted, fontWeight: '600' }}>
              {activeCount}/{totalCount} active
            </Text>
          </View>
        </View>
      </View>

      {/* Fleet List */}
      <FlatList
        data={filtered}
        renderItem={renderDriver}
        keyExtractor={(item) => item.driverId}
        contentContainerStyle={{ paddingBottom: 20 }}
        refreshControl={<RefreshControl refreshing={isLoading || isRefetching} onRefresh={refetch} />}
        ListEmptyComponent={
          <View style={{ padding: 16 }}>
            <EmptyState
              title={isLoading ? 'Loading fleet...' : 'No drivers found'}
              description={search ? 'Try a different search term' : 'Drivers and vehicles will appear here'}
            />
          </View>
        }
      />
    </SafeAreaView>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatLastActivity(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  } catch {
    return dateStr;
  }
}
