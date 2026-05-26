import { useState, useMemo } from 'react';
import { View, Text, ScrollView, RefreshControl, TextInput, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { Card, Badge, EmptyState } from '../../src/components/ui';
import { useTheme } from '../../src/theme';

// ── Types ────────────────────────────────────────────────────────────────────

type ProviderCatalogCylinderType = {
  id: string;
  providerCode: string;
  shortName: string;
  longName: string;
  weight: number;
  hsnCode: string;
  isActive: boolean;
};

// ── Provider config ──────────────────────────────────────────────────────────

const PROVIDERS = ['All', 'IOCL', 'HPCL', 'BPCL', 'GOGAS', 'SUPERGAS', 'TOTALGAS'] as const;

const providerBadgeVariant = (code: string): 'info' | 'success' | 'warning' | 'danger' | 'neutral' => {
  switch (code) {
    case 'IOCL': return 'info';
    case 'HPCL': return 'success';
    case 'BPCL': return 'warning';
    case 'GOGAS': return 'danger';
    case 'SUPERGAS': return 'neutral';
    case 'TOTALGAS': return 'info';
    default: return 'neutral';
  }
};

// ── Main Screen ──────────────────────────────────────────────────────────────

export default function ProviderCatalogScreen() {
  const router = useRouter();
  const { dark, colors, accent } = useTheme();
  const [search, setSearch] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<string>('All');

  const queryPath = selectedProvider === 'All'
    ? '/provider-catalog'
    : `/provider-catalog?provider=${selectedProvider}`;

  const { data: catalogData, isLoading, refetch } = useApiQuery<{ items: ProviderCatalogCylinderType[] }>(
    ['provider-catalog', selectedProvider],
    queryPath,
  );

  const items: ProviderCatalogCylinderType[] = (catalogData as any)?.items ?? [];

  const filtered = useMemo(() => {
    if (!search) return items;
    const q = search.toLowerCase();
    return items.filter((item) =>
      item.shortName.toLowerCase().includes(q) ||
      item.longName.toLowerCase().includes(q) ||
      item.providerCode.toLowerCase().includes(q),
    );
  }, [items, search]);

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Back header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.cardBorder }}>
        <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>Provider Catalog</Text>
      </View>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
      >

        {/* ── Search ────────────────────────────────────────────────── */}
        <TextInput
          placeholder="Search by name or provider..."
          value={search}
          onChangeText={setSearch}
          style={{
            borderWidth: 1,
            borderColor: colors.inputBorder,
            borderRadius: 12,
            paddingHorizontal: 16,
            paddingVertical: 12,
            fontSize: 15,
            backgroundColor: colors.inputBg,
            color: colors.text,
          }}
          placeholderTextColor={colors.textMuted}
        />

        {/* ── Provider Filter Pills ─────────────────────────────────── */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {PROVIDERS.map((provider) => {
            const isActive = selectedProvider === provider;
            return (
              <TouchableOpacity
                key={provider}
                onPress={() => setSelectedProvider(provider)}
                style={{
                  height: 36,
                  paddingHorizontal: 16,
                  borderRadius: 18,
                  backgroundColor: isActive ? accent.red : (dark ? colors.inputBg : colors.cardBg),
                  borderWidth: 1,
                  borderColor: isActive ? accent.red : colors.inputBorder,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                activeOpacity={0.7}
              >
                <Text style={{
                  fontSize: 13,
                  fontWeight: '600',
                  color: isActive ? '#fff' : colors.textSecondary,
                }}>
                  {provider}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* ── Count ──────────────────────────────────────────────────── */}
        <Text style={{ fontSize: 13, color: colors.textSecondary, fontWeight: '500' }}>
          {filtered.length} item{filtered.length !== 1 ? 's' : ''}
        </Text>

        {/* ── List ──────────────────────────────────────────────────── */}
        {filtered.length === 0 ? (
          <EmptyState
            title="No catalog items found"
            description={search || selectedProvider !== 'All' ? 'Try a different search or filter' : 'No cylinder types in catalog'}
          />
        ) : (
          filtered.map((item) => (
            <Card key={item.id} style={dark ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
              {/* Top row: Provider badge + Active/Inactive */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <Badge label={item.providerCode} variant={providerBadgeVariant(item.providerCode)} />
                <Badge
                  label={item.isActive ? 'Active' : 'Inactive'}
                  variant={item.isActive ? 'success' : 'danger'}
                />
              </View>

              {/* Name */}
              <Text style={{ fontWeight: '700', fontSize: 16, color: colors.text }}>{item.shortName}</Text>
              <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>{item.longName}</Text>

              {/* Details row */}
              <View style={{ flexDirection: 'row', gap: 16, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.divider }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, color: colors.textSecondary }}>Weight</Text>
                  <Text style={{ fontWeight: '600', fontSize: 13, color: colors.text }}>{item.weight} KG</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, color: colors.textSecondary }}>HSN Code</Text>
                  <Text style={{ fontWeight: '600', fontSize: 13, color: colors.text }}>{item.hsnCode}</Text>
                </View>
              </View>
            </Card>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
