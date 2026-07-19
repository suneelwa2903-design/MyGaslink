/**
 * HQ Aging (2026-07-19) — outstanding-aging report scoped to the
 * group's members with per-customer drill-down. Web parity:
 * packages/web/src/pages/hq/AgingPage.tsx.
 *
 * Security: GET /api/customer-group-portal/aging. The server delegates
 * to outstandingAging(distributorId, { customerIds: visibleCustomerIds })
 * which the reports service already scopes tenant-side. See customer
 * GroupPortalService.getGroupAging + reportsService.outstandingAging.
 */
import { useMemo, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApiQuery } from '../../src/hooks/useApi';
import { Card, EmptyState, ScreenSkeleton } from '../../src/components/ui';
import { useTheme, formatINR } from '../../src/theme';

interface AgingRow {
  customer: string;
  total: number;
  b0_30: number;
  b31_60: number;
  b60plus: number;
  lastPayment: string;
}
interface AgingResponse {
  rows: AgingRow[];
  totals?: AgingRow;
}

type BucketKey = 'all' | '0_30' | '31_60' | '60plus';

const BUCKETS: Array<{ key: BucketKey; label: string; short: string; danger: boolean }> = [
  { key: 'all', label: 'Total Outstanding', short: 'All', danger: false },
  { key: '0_30', label: '0–30 days', short: '0–30', danger: false },
  { key: '31_60', label: '31–60 days', short: '31–60', danger: false },
  { key: '60plus', label: '60+ days', short: '60+', danger: true },
];

function bucketAmount(row: AgingRow, key: BucketKey): number {
  switch (key) {
    case 'all': return row.total;
    case '0_30': return row.b0_30;
    case '31_60': return row.b31_60;
    case '60plus': return row.b60plus;
  }
}

export default function HqAgingScreen() {
  const { colors } = useTheme();
  const [activeBucket, setActiveBucket] = useState<BucketKey>('all');

  const { data, isLoading, refetch, isRefetching } = useApiQuery<AgingResponse>(
    ['hq-aging'],
    '/customer-group-portal/aging',
  );

  const rows = data?.rows ?? [];
  const totals = data?.totals;

  // Filter by active bucket + sort by bucket amount descending. When
  // "all" is selected, keep the server order (already sorted by total
  // desc in reportsService.outstandingAging).
  const filteredRows = useMemo(() => {
    if (activeBucket === 'all') return rows.filter((r) => r.total > 0);
    return rows
      .filter((r) => bucketAmount(r, activeBucket) > 0)
      .sort((a, b) => bucketAmount(b, activeBucket) - bucketAmount(a, activeBucket));
  }, [rows, activeBucket]);

  if (isLoading && !data) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScreenSkeleton />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => { void refetch(); }} />}
      >
        {/* Bucket tiles — tap to drill down. When the "60+ days" bucket
            is non-zero, its tile turns red so the overdue signal reads
            at a glance. */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {BUCKETS.map((b) => {
            const total = totals ? bucketAmount(totals, b.key) : 0;
            const isActive = activeBucket === b.key;
            const showDanger = b.danger && total > 0;
            return (
              <TouchableOpacity
                key={b.key}
                onPress={() => setActiveBucket(b.key)}
                style={{
                  flexGrow: 1,
                  flexBasis: '47%',
                  padding: 12,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: isActive ? '#dc2626' : colors.cardBorder,
                  backgroundColor: isActive ? 'rgba(220,38,38,0.08)' : colors.cardBg,
                  minHeight: 80,
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 11, color: colors.textSecondary, fontWeight: '600' }}>
                  {b.label.toUpperCase()}
                </Text>
                <Text
                  style={{
                    fontSize: 17,
                    fontWeight: '700',
                    color: showDanger ? '#dc2626' : colors.text,
                    marginTop: 4,
                  }}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.6}
                >
                  {formatINR(total)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Drill-down list */}
        <Card>
          <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary, letterSpacing: 0.4, marginBottom: 8 }}>
            {activeBucket === 'all'
              ? `PROPERTIES WITH OUTSTANDING (${filteredRows.length})`
              : `PROPERTIES IN ${BUCKETS.find((b) => b.key === activeBucket)?.label.toUpperCase()} (${filteredRows.length})`}
          </Text>
          {filteredRows.length === 0 ? (
            <EmptyState
              title="No entries"
              description={
                activeBucket === 'all'
                  ? 'No outstanding balances across your group properties.'
                  : 'No properties fall in this bucket.'
              }
            />
          ) : (
            filteredRows.map((r, idx) => {
              const bucketVal = bucketAmount(r, activeBucket);
              const isOverdue = r.b60plus > 0;
              return (
                <View
                  key={idx}
                  style={{
                    paddingVertical: 12,
                    borderBottomWidth: idx === filteredRows.length - 1 ? 0 : 1,
                    borderBottomColor: colors.divider,
                    gap: 6,
                  }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>
                        {r.customer}
                      </Text>
                      {r.lastPayment && (
                        <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 2 }}>
                          Last payment: {r.lastPayment}
                        </Text>
                      )}
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{
                        color: (activeBucket === '60plus' || (activeBucket === 'all' && isOverdue)) ? '#dc2626' : colors.text,
                        fontWeight: '700',
                        fontSize: 14,
                      }}>
                        {formatINR(bucketVal)}
                      </Text>
                      {activeBucket !== 'all' && (
                        <Text style={{ color: colors.textSecondary, fontSize: 10, marginTop: 2 }}>
                          of {formatINR(r.total)}
                        </Text>
                      )}
                    </View>
                  </View>
                  {/* Mini breakdown when viewing the "all" bucket — shows how
                      the total splits across the 3 age windows. */}
                  {activeBucket === 'all' && r.total > 0 && (
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 2 }}>
                      {r.b0_30 > 0 && (
                        <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                          0–30: {formatINR(r.b0_30)}
                        </Text>
                      )}
                      {r.b31_60 > 0 && (
                        <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                          31–60: {formatINR(r.b31_60)}
                        </Text>
                      )}
                      {r.b60plus > 0 && (
                        <Text style={{ color: '#dc2626', fontSize: 11, fontWeight: '600' }}>
                          60+: {formatINR(r.b60plus)}
                        </Text>
                      )}
                    </View>
                  )}
                </View>
              );
            })
          )}
        </Card>

        <View style={{ height: 8 }} />
      </ScrollView>
    </SafeAreaView>
  );
}
