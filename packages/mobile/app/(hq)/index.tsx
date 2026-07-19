/**
 * HQ Dashboard (2026-07-19) — read-only consolidated view for a
 * customer_hq user across all properties in their group. Web parity:
 * see packages/web/src/pages/hq/DashboardPage.tsx.
 *
 * Data source: GET /api/customer-group-portal/dashboard. The server
 * applies distributorId + visibleCustomerIds double-scoping (see
 * customerGroupPortalService.ts §Helpers). This screen never
 * constructs a URL with an arbitrary customerId — it only reads its
 * own group's rollup.
 *
 * 2026-07-19 filters — Property + From/To at top; the KPIs below
 * respect the filter. The property roster at the bottom always lists
 * every property regardless of filter so a HQ user can jump between
 * them. Tapping a property row locks the filter to that property; tap
 * again to clear.
 */
import { useMemo, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { localDateISO } from '@gaslink/shared';
import { useApiQuery } from '../../src/hooks/useApi';
import {
  MetricCard, Card, EmptyState, ScreenSkeleton, SelectField, DateInput,
  MIN_DATE_FLOOR, todayLocalIso,
} from '../../src/components/ui';
import { useTheme, formatINR } from '../../src/theme';
import { useAuthStore } from '../../src/stores/authStore';

interface Property {
  customerId: string;
  customerName: string;
  businessName: string | null;
  gstin: string | null;
  outstanding: number;
  lastDeliveryDate: string | null;
  lastInvoiceDate: string | null;
  isOverdue: boolean;
}
interface CylinderTypeQty {
  cylinderTypeId: string;
  cylinderTypeName: string;
  quantity: number;
}
interface EmptiesWithClientsRow extends CylinderTypeQty {
  capacity: number;
}
interface DashboardResponse {
  totalOutstanding: number;
  totalOverdue: number;
  aging: { bucket0_30: number; bucket31_60: number; bucket60plus: number };
  activity: {
    range: { from: string; to: string };
    fullsDelivered: CylinderTypeQty[];
    emptiesCollected: CylinderTypeQty[];
    amountBilled: number;
    paymentsReceived: number;
  };
  emptiesWithClients: EmptiesWithClientsRow[];
  properties: Property[];
  filters: { customerId: string | null; from: string; to: string };
}

interface HqProfileResponse {
  members: Array<{ customerId: string; customerName: string }>;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function firstOfMonth(): string {
  const d = new Date();
  return localDateISO(new Date(d.getFullYear(), d.getMonth(), 1));
}

function SectionHeader({ title, count }: { title: string; count?: number }) {
  const { colors } = useTheme();
  return (
    <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary, letterSpacing: 0.4, marginBottom: 8 }}>
      {title.toUpperCase()}{count != null && ` (${count})`}
    </Text>
  );
}

function TypeQtyList({ rows, emptyLabel }: { rows: CylinderTypeQty[]; emptyLabel: string }) {
  const { colors } = useTheme();
  if (rows.length === 0) {
    return (
      <Text style={{ color: colors.textMuted, fontSize: 13, paddingVertical: 8 }}>
        {emptyLabel}
      </Text>
    );
  }
  return (
    <>
      {rows.map((c, idx) => (
        <View
          key={c.cylinderTypeId}
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingVertical: 10,
            borderBottomWidth: idx === rows.length - 1 ? 0 : 1,
            borderBottomColor: colors.divider,
          }}
        >
          <Text style={{ color: colors.text, fontWeight: '500' }}>{c.cylinderTypeName}</Text>
          <Text style={{ color: colors.text, fontWeight: '700' }}>{c.quantity}</Text>
        </View>
      ))}
    </>
  );
}

export default function HqDashboardScreen() {
  const { colors, dark, accent } = useTheme();
  const user = useAuthStore((s) => s.user);

  // Filters — persist to component state so page reloads on tap.
  const [customerId, setCustomerId] = useState('');
  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(todayLocalIso);

  const params = useMemo(() => {
    const p: Record<string, string> = { from, to };
    if (customerId) p.customerId = customerId;
    return p;
  }, [customerId, from, to]);

  const { data: profile } = useApiQuery<HqProfileResponse>(
    ['hq-profile-properties'],
    '/customer-group-portal/profile',
  );

  const propertyOptions = useMemo(() => {
    const opts = [{ label: 'All properties', value: '' }];
    for (const m of profile?.members ?? []) {
      opts.push({ label: m.customerName, value: m.customerId });
    }
    return opts;
  }, [profile?.members]);

  const { data, isLoading, refetch, isRefetching } = useApiQuery<DashboardResponse>(
    ['hq-dashboard', JSON.stringify(params)],
    '/customer-group-portal/dashboard',
    params,
  );

  const rawProperties = data?.properties;
  const propertiesSorted = useMemo(() => {
    if (!rawProperties) return [];
    return [...rawProperties].sort((a, b) => {
      if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
      if (a.outstanding !== b.outstanding) return b.outstanding - a.outstanding;
      return a.customerName.localeCompare(b.customerName);
    });
  }, [rawProperties]);

  const totalEmptiesWithClients = useMemo(
    () => (data?.emptiesWithClients ?? []).reduce((s, r) => s + r.quantity, 0),
    [data?.emptiesWithClients],
  );

  if (isLoading && !data) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScreenSkeleton />
      </SafeAreaView>
    );
  }

  const selectedPropertyName = customerId
    ? profile?.members.find((m) => m.customerId === customerId)?.customerName ?? 'Selected property'
    : 'All properties';

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => { void refetch(); }} />}
      >
        {/* Greeting */}
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 2 }}>
          Welcome, {user?.firstName || user?.email?.split('@')[0] || 'HQ'}
        </Text>
        <Text style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 6 }}>
          Viewing:{' '}
          <Text style={{ fontWeight: '600', color: colors.text }}>{selectedPropertyName}</Text>
          {'  ·  '}
          <Text>{from} to {to}</Text>
        </Text>

        {/* Filter row — property + date range. Reset restores defaults. */}
        <Card>
          <SelectField
            label="Property"
            options={propertyOptions}
            value={customerId}
            onChange={setCustomerId}
          />
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
            <View style={{ flex: 1 }}>
              <DateInput
                label="From"
                value={from}
                onChange={setFrom}
                minDate={MIN_DATE_FLOOR}
                maxDate={to || todayLocalIso()}
              />
            </View>
            <View style={{ flex: 1 }}>
              <DateInput
                label="To"
                value={to}
                onChange={setTo}
                minDate={from || MIN_DATE_FLOOR}
                maxDate={todayLocalIso()}
              />
            </View>
          </View>
          <TouchableOpacity
            onPress={() => { setCustomerId(''); setFrom(firstOfMonth()); setTo(todayLocalIso()); }}
            style={{
              marginTop: 10,
              alignSelf: 'flex-start',
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: colors.cardBorder,
            }}
          >
            <Text style={{ color: colors.textSecondary, fontSize: 12, fontWeight: '600' }}>Reset filters</Text>
          </TouchableOpacity>
        </Card>

        {/* Current Status — state-current, not date-filtered. */}
        <SectionHeader title="Current Status" />
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard
              title={customerId ? 'Outstanding' : 'Group Outstanding'}
              value={formatINR(data?.totalOutstanding ?? 0)}
              color={accent.orange}
              minHeight={104}
            />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard
              title="Overdue"
              value={formatINR(data?.totalOverdue ?? 0)}
              color={(data?.totalOverdue ?? 0) > 0 ? accent.red : accent.green}
              minHeight={104}
            />
          </View>
        </View>
        {/* Second Current Status row — Empties With Clients (state-current)
            + Payments Received (period). Replaced the Properties count
            + the redundant This Period 4-tile grid on 2026-07-19 — the
            per-cylinder-type breakdown cards below already show
            Fulls/Empties totals, and Amount Billed lives on the
            invoices tab. */}
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <MetricCard
              title={customerId ? 'Empties With Client' : 'Empties With Clients'}
              value={totalEmptiesWithClients}
              color={accent.blue}
              minHeight={104}
            />
          </View>
          <View style={{ flex: 1 }}>
            <MetricCard
              title="Payments Received"
              value={formatINR(data?.activity.paymentsReceived ?? 0)}
              color={accent.green}
              minHeight={104}
            />
          </View>
        </View>

        {/* Per-cylinder-type breakdowns */}
        <Card>
          <SectionHeader title="Fulls Delivered (period)" />
          <TypeQtyList rows={data?.activity.fullsDelivered ?? []} emptyLabel="No deliveries in this period." />
        </Card>
        <Card>
          <SectionHeader title="Empties Collected (period)" />
          <TypeQtyList rows={data?.activity.emptiesCollected ?? []} emptyLabel="No empties collected in this period." />
        </Card>

        {/* State-current empties held by clients */}
        <Card>
          <SectionHeader title={customerId ? 'Empties With Client' : 'Empties With Clients'} />
          {(data?.emptiesWithClients ?? []).length === 0 ? (
            <EmptyState title="No empties held" description="No empty cylinders currently held." />
          ) : (
            data!.emptiesWithClients.map((c, idx) => (
              <View
                key={c.cylinderTypeId}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  paddingVertical: 10,
                  borderBottomWidth: idx === data!.emptiesWithClients.length - 1 ? 0 : 1,
                  borderBottomColor: colors.divider,
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontWeight: '500' }}>{c.cylinderTypeName}</Text>
                  {c.capacity > 0 && (
                    <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>
                      {c.capacity} kg
                    </Text>
                  )}
                </View>
                <Text
                  style={{
                    color: c.quantity < 0 ? accent.green : colors.text,
                    fontWeight: '700',
                  }}
                >
                  {c.quantity}
                  {c.quantity < 0 ? ' (excess returned)' : ''}
                </Text>
              </View>
            ))
          )}
        </Card>

        {/* Aging summary */}
        <Card>
          <SectionHeader title="Aging Summary" />
          <View style={{ flexDirection: 'row', gap: 12 }}>
            {[
              { label: '0–30 days', value: data?.aging.bucket0_30 ?? 0, danger: false },
              { label: '31–60 days', value: data?.aging.bucket31_60 ?? 0, danger: false },
              { label: '60+ days', value: data?.aging.bucket60plus ?? 0, danger: true },
            ].map((b, i) => (
              <View
                key={i}
                style={{
                  flex: 1,
                  backgroundColor: dark ? 'rgba(148,163,184,0.08)' : '#f1f5f9',
                  borderRadius: 10,
                  padding: 12,
                  minHeight: 74,
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>{b.label}</Text>
                <Text
                  style={{
                    fontSize: 15,
                    fontWeight: '700',
                    color: b.danger && b.value > 0 ? '#dc2626' : colors.text,
                  }}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.6}
                >
                  {formatINR(b.value)}
                </Text>
              </View>
            ))}
          </View>
        </Card>

        {/* Property roster — always full list. Tap to toggle filter. */}
        <Card>
          <SectionHeader title="Properties" count={propertiesSorted.length} />
          {propertiesSorted.length === 0 ? (
            <EmptyState title="No properties" description="No customers linked to this group." />
          ) : (
            propertiesSorted.map((p, idx) => {
              const isSelected = customerId === p.customerId;
              return (
                <TouchableOpacity
                  key={p.customerId}
                  onPress={() => setCustomerId(isSelected ? '' : p.customerId)}
                  activeOpacity={0.7}
                  style={{
                    paddingVertical: 12,
                    paddingHorizontal: isSelected ? 8 : 0,
                    marginHorizontal: isSelected ? -8 : 0,
                    borderRadius: isSelected ? 8 : 0,
                    backgroundColor: isSelected
                      ? (dark ? 'rgba(220,38,38,0.10)' : 'rgba(220,38,38,0.06)')
                      : 'transparent',
                    borderBottomWidth: idx === propertiesSorted.length - 1 ? 0 : 1,
                    borderBottomColor: colors.divider,
                    gap: 6,
                  }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>
                        {p.customerName}
                      </Text>
                      {p.businessName && (
                        <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                          {p.businessName}
                        </Text>
                      )}
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ color: p.isOverdue ? '#dc2626' : colors.text, fontWeight: '700', fontSize: 14 }}>
                        {formatINR(p.outstanding)}
                      </Text>
                      {p.isOverdue && (
                        <Text style={{ color: '#dc2626', fontSize: 10, fontWeight: '600', marginTop: 2 }}>OVERDUE</Text>
                      )}
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
                    <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                      Last order: {fmtDate(p.lastDeliveryDate)}
                    </Text>
                    <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                      Last invoice: {fmtDate(p.lastInvoiceDate)}
                    </Text>
                    {isSelected && (
                      <Text style={{ color: '#dc2626', fontSize: 11, fontWeight: '600' }}>
                        Filter active — tap to clear
                      </Text>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </Card>

        <View style={{ height: 8 }} />
      </ScrollView>
    </SafeAreaView>
  );
}
