import { useState, useCallback } from 'react';
import { View, Text, ScrollView, RefreshControl, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { Card, Badge, EmptyState } from '../../src/components/ui';
import { useTheme, formatINR } from '../../src/theme';
import { useDistributorStore } from '../../src/stores/distributorStore';
import type { Customer, PaginationMeta } from '@gaslink/shared';

// ── Status config ────────────────────────────────────────────────────────────

const STATUS_MAP: Record<string, { variant: 'success' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  active: { variant: 'success', label: 'Active' },
  suspended: { variant: 'warning', label: 'Suspended' },
  inactive: { variant: 'danger', label: 'Inactive' },
};

// ── Main Screen ──────────────────────────────────────────────────────────────

export default function CustomersScreen() {
  const { dark, colors, accent } = useTheme();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const { selectedDistributorId } = useDistributorStore();

  const params: Record<string, unknown> = { page, limit: 25 };
  if (search.trim()) params.search = search.trim();
  if (statusFilter) params.status = statusFilter;
  if (selectedDistributorId) params.distributorId = selectedDistributorId;

  const { data, isLoading, refetch } = useApiQuery<
    { customers: Customer[]; pagination?: PaginationMeta } | Customer[]
  >(
    ['sa-customers', search, statusFilter, String(page), selectedDistributorId ?? 'all'],
    '/customers',
    params,
  );

  const customers: Customer[] = Array.isArray(data) ? data : (data as any)?.customers ?? [];
  const pagination: PaginationMeta | undefined = Array.isArray(data) ? undefined : (data as any)?.pagination;

  const handleRefresh = useCallback(() => {
    setPage(1);
    refetch();
  }, [refetch]);

  const STATUS_FILTERS = [
    { label: 'All', value: '' },
    { label: 'Active', value: 'active' },
    { label: 'Suspended', value: 'suspended' },
    { label: 'Inactive', value: 'inactive' },
  ];

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Search bar */}
      <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: dark ? colors.cardBg : colors.inputBg,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.inputBorder,
          paddingHorizontal: 12,
        }}>
          <Ionicons name="search-outline" size={18} color={colors.textMuted} />
          <TextInput
            placeholder="Search customers..."
            value={search}
            onChangeText={(v) => { setSearch(v); setPage(1); }}
            style={{
              flex: 1,
              paddingVertical: 12,
              paddingHorizontal: 8,
              fontSize: 15,
              color: colors.text,
            }}
            placeholderTextColor={colors.textMuted}
            returnKeyType="search"
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => { setSearch(''); setPage(1); }}>
              <Ionicons name="close-circle" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Status filter pills */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}
      >
        {STATUS_FILTERS.map((f) => (
          <TouchableOpacity
            key={f.value}
            onPress={() => { setStatusFilter(f.value); setPage(1); }}
            style={{
              height: 36,
              paddingHorizontal: 16,
              paddingVertical: 0,
              borderRadius: 18,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: statusFilter === f.value ? accent.red : (dark ? colors.cardBg : colors.inputBg),
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: '600', color: statusFilter === f.value ? '#fff' : colors.textSecondary }}>
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={handleRefresh} />}
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text }}>Customers</Text>
          <Text style={{ fontSize: 13, color: colors.textSecondary }}>
            {pagination ? `${pagination.total} total` : `${customers.length} shown`}
          </Text>
        </View>

        {isLoading && customers.length === 0 ? (
          <ActivityIndicator size="large" color={accent.red} style={{ marginTop: 40 }} />
        ) : customers.length === 0 ? (
          <EmptyState title="No customers found" description={search ? 'Try a different search' : 'No customers yet'} />
        ) : (
          <>
            {customers.map((customer) => {
              const status = STATUS_MAP[customer.status] ?? { variant: 'neutral' as const, label: customer.status };
              return (
                <Card key={customer.customerId} style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
                  {/* Header */}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <View style={{ flex: 1, marginRight: 8 }}>
                      <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text }} numberOfLines={1}>
                        {customer.businessName ?? customer.customerName}
                      </Text>
                      {(() => {
                        const primary = customer.contacts?.find((c) => c.isPrimary)?.name ?? customer.customerName;
                        return primary ? (
                          <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
                            {primary}
                          </Text>
                        ) : null;
                      })()}
                    </View>
                    <Badge label={status.label} variant={status.variant} />
                  </View>

                  {/* Details */}
                  <View style={{
                    flexDirection: 'row',
                    gap: 12,
                    marginTop: 10,
                    paddingTop: 10,
                    borderTopWidth: 1,
                    borderTopColor: colors.divider,
                  }}>
                    {customer.phone && (
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 11, color: colors.textSecondary }}>Phone</Text>
                        <Text style={{ fontWeight: '600', fontSize: 13, color: colors.text }}>{customer.phone}</Text>
                      </View>
                    )}
                    {customer.gstin && (
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 11, color: colors.textSecondary }}>GSTIN</Text>
                        <Text style={{ fontWeight: '600', fontSize: 13, color: colors.text }} numberOfLines={1}>{customer.gstin}</Text>
                      </View>
                    )}
                    {(customer as any).outstandingBalance != null && (
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 11, color: colors.textSecondary }}>Outstanding</Text>
                        <Text style={{
                          fontWeight: '700',
                          fontSize: 13,
                          color: (customer as any).outstandingBalance > 0 ? accent.orange : accent.green,
                        }}>
                          {formatINR((customer as any).outstandingBalance)}
                        </Text>
                      </View>
                    )}
                  </View>

                  {(() => {
                    const address = [customer.billingAddressLine1, customer.billingCity, customer.billingState]
                      .filter(Boolean)
                      .join(', ');
                    return address ? (
                      <View style={{ marginTop: 8 }}>
                        <Text style={{ fontSize: 12, color: colors.textMuted }} numberOfLines={2}>
                          {address}
                        </Text>
                      </View>
                    ) : null;
                  })()}
                </Card>
              );
            })}

            {/* Pagination */}
            {pagination && pagination.totalPages > 1 && (
              <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 16, marginTop: 8 }}>
                <TouchableOpacity
                  disabled={page <= 1}
                  onPress={() => setPage((p) => Math.max(1, p - 1))}
                  style={{ opacity: page <= 1 ? 0.3 : 1 }}
                >
                  <Ionicons name="chevron-back" size={24} color={colors.text} />
                </TouchableOpacity>
                <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>
                  Page {page} of {pagination.totalPages}
                </Text>
                <TouchableOpacity
                  disabled={page >= pagination.totalPages}
                  onPress={() => setPage((p) => p + 1)}
                  style={{ opacity: page >= pagination.totalPages ? 0.3 : 1 }}
                >
                  <Ionicons name="chevron-forward" size={24} color={colors.text} />
                </TouchableOpacity>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
