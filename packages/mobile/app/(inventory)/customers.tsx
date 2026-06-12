/**
 * Phase B2 (2026-06-12) — inventory customers (read-only, balance-focused).
 *
 * Mirrors the finance customers list structure (Phase A2) but with
 * inventory's specific focus: cylinder balances on the customer side
 * (how many empties each customer owes us). No FAB, no stop-supply,
 * no edit. Detail screen at (inventory)/customer-detail.tsx shows
 * only the overview + cylinder balances tab — financial tabs (ledger,
 * payments) are finance's domain per the Phase 6 audit and the
 * Suneel-locked spec.
 *
 * Reached from the inventory More tab → "Customers" menu item.
 */
import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useApiQuery } from '../../src/hooks/useApi';
import { useTheme, ACCENT as ACCENT_COLORS } from '../../src/theme';
import { EmptyState } from '../../src/components/ui';

const ACCENT = ACCENT_COLORS.red;
const PAGE_SIZE = 25;

interface Customer {
  customerId: string;
  customerName: string;
  businessName?: string;
  phone: string;
  customerType: 'B2B' | 'B2C';
  status: 'active' | 'suspended';
}

export default function InventoryCustomersScreen() {
  const router = useRouter();
  const { dark, colors } = useTheme();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const params: Record<string, unknown> = { page: page + 1, pageSize: PAGE_SIZE };
  if (search.trim()) params.search = search.trim();

  const { data, isLoading, isRefetching, refetch } = useApiQuery<{ customers: Customer[] }>(
    ['inv-customers', String(page), search.trim()],
    '/customers',
    params,
  );
  const customers = data?.customers ?? [];

  const renderItem = ({ item }: { item: Customer }) => (
    <TouchableOpacity
      onPress={() =>
        router.push({ pathname: '/(inventory)/customer-detail', params: { customerId: item.customerId } })
      }
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
          width: 40, height: 40, borderRadius: 20,
          backgroundColor: ACCENT + '14',
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Text style={{ fontSize: 16, fontWeight: '700', color: ACCENT }}>
          {item.customerName?.[0]?.toUpperCase() || '?'}
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>{item.customerName}</Text>
        <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 1 }}>{item.phone}</Text>
      </View>
      <View style={{
        paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
        backgroundColor: '#3b82f614',
      }}>
        <Text style={{ fontSize: 10, fontWeight: '700', color: '#3b82f6' }}>{item.customerType}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
    </TouchableOpacity>
  );

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 }}>
        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: 8,
          backgroundColor: dark ? colors.inputBg : '#f8fafc',
          borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
          borderWidth: 1, borderColor: colors.divider,
        }}>
          <Ionicons name="search" size={18} color={colors.textMuted} />
          <TextInput
            value={search}
            onChangeText={(t) => { setSearch(t); setPage(0); }}
            placeholder="Search by name, business, phone"
            placeholderTextColor={colors.textMuted}
            style={{ flex: 1, fontSize: 14, color: colors.text, paddingVertical: 0 }}
          />
        </View>
      </View>

      {isLoading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      ) : (
        <FlatList
          data={customers}
          keyExtractor={(c) => c.customerId}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: colors.divider, marginHorizontal: 16 }} />}
          contentContainerStyle={{ paddingBottom: 16 }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={ACCENT} />}
          ListEmptyComponent={<EmptyState title="No customers" description="No customers match the current search" />}
          ListFooterComponent={
            customers.length > 0 ? (
              <View style={{
                flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                paddingHorizontal: 16, paddingVertical: 12, gap: 12,
              }}>
                <TouchableOpacity
                  onPress={() => setPage(Math.max(0, page - 1))}
                  disabled={page === 0}
                  style={{
                    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
                    backgroundColor: colors.cardBg, borderWidth: 1, borderColor: colors.inputBorder,
                    opacity: page === 0 ? 0.5 : 1,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: '700', color: colors.text }}>Previous</Text>
                </TouchableOpacity>
                <Text style={{ fontSize: 12, color: colors.textMuted }}>
                  Page {page + 1} • {customers.length} rows
                </Text>
                <TouchableOpacity
                  onPress={() => setPage(page + 1)}
                  disabled={customers.length < PAGE_SIZE}
                  style={{
                    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
                    backgroundColor: colors.cardBg, borderWidth: 1, borderColor: colors.inputBorder,
                    opacity: customers.length < PAGE_SIZE ? 0.5 : 1,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: '700', color: colors.text }}>Next</Text>
                </TouchableOpacity>
              </View>
            ) : null
          }
        />
      )}
    </SafeAreaView>
  );
}
